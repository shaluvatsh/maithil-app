import { ulid } from 'ulid';
import { sql, eq, and, inArray } from 'drizzle-orm';
import type { Db, Executor } from '../db/client';
import { outbox, processedEvents } from '../db/schema/index';

/**
 * A claim is a lease, not a lock held for the life of the batch. See the comment on
 * `outbox.claimedAt` (db/schema/ops.ts) and migration 0016 for why: the relay used to
 * hold one Postgres transaction open across an entire batch's publish() calls so a
 * row's `FOR UPDATE` lock would keep a second instance off it too, which meant up to
 * 100 sequential, awaited external HTTP calls ran while pinning one of only ten
 * pooled connections shared with every other request the API serves.
 *
 * Generous on purpose: publish() should finish in well under this, but a stalled BSP
 * call must not livelock a row forever either - once a claim is this old, it is
 * treated as abandoned (the claimant crashed or hung) and becomes reclaimable again.
 */
export const CLAIM_VISIBILITY_MS = 30_000;

/**
 * Transactional outbox. See ADR 0005.
 *
 * `emit` MUST be called with the same `tx` as the state change it describes.
 * That is the entire point: the event and the state change commit together or
 * neither does.
 */
export class OutboxService {
  async emit(tx: Executor, args: {
    aggregateType: string;
    aggregateId: string;
    eventType: string;
    payload: Record<string, unknown>;
  }): Promise<string> {
    const id = ulid();
    await tx.insert(outbox).values({
      id,
      aggregateType: args.aggregateType,
      aggregateId: args.aggregateId,
      eventType: args.eventType,
      payload: args.payload,
    });
    return id;
  }

  /**
   * Claim a batch to publish. A single UPDATE ... RETURNING, not wrapped in a
   * caller-supplied transaction - it commits and releases its connection the moment
   * it completes, before the relay makes its first publish() call. SKIP LOCKED still
   * lets multiple relay instances claim different rows without contending; the
   * `claimedAt` filter is what stops them claiming the SAME row twice once the first
   * claim has already committed, which a lock released this fast no longer can.
   *
   * Takes `Db` specifically, never `Executor` - calling this from inside an open
   * transaction would hold exactly the connection this exists to free.
   */
  async claimBatch(db: Db, limit = 100) {
    const staleBefore = new Date(Date.now() - CLAIM_VISIBILITY_MS).toISOString();
    const rows = await db.execute(sql`
      UPDATE "outbox" SET claimed_at = now()
      WHERE id IN (
        SELECT id FROM "outbox"
        WHERE published_at IS NULL
          AND (claimed_at IS NULL OR claimed_at < ${staleBefore})
        ORDER BY id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, aggregate_type AS "aggregateType", aggregate_id AS "aggregateId",
        event_type AS "eventType", payload, attempts
    `);
    return ((rows as unknown as { rows?: unknown[] }).rows ?? rows) as Array<{
      id: string; aggregateType: string; aggregateId: string;
      eventType: string; payload: unknown; attempts: number;
    }>;
  }

  async markPublished(db: Db, ids: string[]) {
    if (ids.length === 0) return;
    await db.update(outbox)
      .set({ publishedAt: new Date().toISOString() })
      .where(inArray(outbox.id, ids));
  }

  /** Failed for real (not a crash): clear the lease so the next tick retries it
   *  immediately rather than waiting out the full visibility timeout. */
  async markFailed(db: Db, id: string, error: string) {
    await db.update(outbox)
      .set({ attempts: sql`${outbox.attempts} + 1`, lastError: error, claimedAt: null })
      .where(eq(outbox.id, id));
  }

  /**
   * Consumer-side dedupe. Delivery is at-least-once, so every consumer calls this
   * first and skips if it returns false. Not optional - it is a review checklist item.
   */
  async claimForConsumer(db: Executor, consumer: string, eventId: string): Promise<boolean> {
    const res = await db.insert(processedEvents)
      .values({ consumer, eventId })
      .onConflictDoNothing()
      .returning({ eventId: processedEvents.eventId });
    return res.length > 0;
  }

  /**
   * Reverses `claimForConsumer` after a failed handler, so the event is retryable
   * on the next delivery instead of permanently marked done.
   *
   * The claim used to be the only record of "processing this" and it was written
   * BEFORE the handler ran - so a crash, or any thrown error, between the claim and
   * a successful send left the row claimed forever with nothing actually sent. A
   * notification failure is explicitly swallowed rather than propagated (it must
   * never block the relay), which made that failure mode silent: no error surfaced
   * anywhere, and the devotee or purohit simply never got the message.
   */
  async unclaimForConsumer(db: Executor, consumer: string, eventId: string): Promise<void> {
    await db.delete(processedEvents)
      .where(and(eq(processedEvents.consumer, consumer), eq(processedEvents.eventId, eventId)));
  }
}
