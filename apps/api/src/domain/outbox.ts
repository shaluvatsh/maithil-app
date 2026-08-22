import { ulid } from 'ulid';
import { sql, eq, and, isNull, inArray } from 'drizzle-orm';
import type { Db, Executor } from '../db/client';
import { outbox, processedEvents } from '../db/schema/index';

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
   * Relay batch. SKIP LOCKED lets multiple relay instances run without contending,
   * and without the ordering guarantees we do not actually need.
   */
  async claimBatch(db: Executor, limit = 100) {
    return db
      .select({
        id: outbox.id,
        aggregateType: outbox.aggregateType,
        aggregateId: outbox.aggregateId,
        eventType: outbox.eventType,
        payload: outbox.payload,
        attempts: outbox.attempts,
      })
      .from(outbox)
      .where(isNull(outbox.publishedAt))
      .orderBy(outbox.id)
      .limit(limit)
      .for('update', { skipLocked: true });
  }

  async markPublished(db: Executor, ids: string[]) {
    if (ids.length === 0) return;
    await db.update(outbox)
      .set({ publishedAt: new Date().toISOString() })
      .where(inArray(outbox.id, ids));
  }

  async markFailed(db: Executor, id: string, error: string) {
    await db.update(outbox)
      .set({ attempts: sql`${outbox.attempts} + 1`, lastError: error })
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
