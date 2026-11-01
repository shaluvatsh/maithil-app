import { Logger } from '@nestjs/common';
import type { Db } from '../db/client';
import { OutboxService } from '../domain/outbox';

/**
 * Outbox relay. Polls for unpublished events and hands them to the queue.
 *
 * Polling rather than LISTEN/NOTIFY: at launch volume a 1-second poll on a partial
 * index is free, and it survives connection drops without extra machinery. Swap for
 * NOTIFY when the poll shows up in a flame graph, not before.
 */
export interface EventPublisher {
  publish(event: {
    id: string; eventType: string; aggregateId: string; payload: unknown;
  }): Promise<void>;
}

const MAX_ATTEMPTS = 10;

export class OutboxRelay {
  private readonly log = new Logger('outbox');
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly db: Db,
    private readonly outbox: OutboxService,
    private readonly publisher: EventPublisher,
    private readonly intervalMs = 1000,
  ) {}

  start() {
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
  }
  stop() { if (this.timer) clearInterval(this.timer); }

  async tick(): Promise<number> {
    if (this.running) return 0;          // no overlapping runs
    this.running = true;
    try {
      return await this.drainOnce();
    } catch (e) {
      this.log.error('relay tick failed', e instanceof Error ? e.stack : String(e));
      return 0;
    } finally {
      this.running = false;
    }
  }

  /**
   * Claim, then publish and mark OUTSIDE any transaction.
   *
   * This used to do all three inside ONE transaction, holding one of only ten
   * pooled connections - shared with every request the API serves - open across up
   * to 100 sequential, awaited publish() calls, each one a real HTTP round trip to
   * the WhatsApp BSP. A slow or briefly-unavailable BSP (routine in production)
   * stalled that connection, and everything else competing for the pool, for the
   * whole batch.
   *
   * `claimBatch` is now a single fast UPDATE that commits and releases its
   * connection before the first publish() call runs (see `claimedAt` on the outbox
   * schema and migration 0016). Two relay instances can no longer double-publish by
   * racing a lock that released early, because the claim itself is what is raced:
   * whichever instance's UPDATE commits first, the other's `WHERE claimed_at IS NULL
   * OR claimed_at < staleBefore` no longer matches that row.
   */
  async drainOnce(limit = 100): Promise<number> {
    const rows = await this.outbox.claimBatch(this.db, limit);
    if (rows.length === 0) return 0;

    const published: string[] = [];
    for (const row of rows) {
      try {
        await this.publisher.publish({
          id: row.id,
          eventType: row.eventType,
          aggregateId: row.aggregateId,
          payload: row.payload,
        });
        published.push(row.id);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await this.outbox.markFailed(this.db, row.id, msg);
        if (row.attempts + 1 >= MAX_ATTEMPTS) {
          // Give up publishing but leave the row: it is the audit trail of
          // intent, and an operator can replay it once the downstream is healthy.
          this.log.error(`event ${row.id} (${row.eventType}) parked after ${MAX_ATTEMPTS} attempts`);
        }
      }
    }
    await this.outbox.markPublished(this.db, published);
    return published.length;
  }
}

/** Dev/test publisher: logs and drops. BullMQ implementation lands with P1-8. */
export class LoggingPublisher implements EventPublisher {
  private readonly log = new Logger('events');
  readonly seen: Array<{ eventType: string; aggregateId: string }> = [];
  async publish(event: { id: string; eventType: string; aggregateId: string }) {
    this.seen.push({ eventType: event.eventType, aggregateId: event.aggregateId });
    this.log.debug(`${event.eventType} ${event.aggregateId}`);
  }
}

/**
 * Delivers every event to several consumers.
 *
 * The relay took ONE publisher, which was fine while notifications were the only
 * thing listening. Refunds are the second, and they must not be bolted onto the
 * notification consumer — they are a different concern with a different failure
 * mode, and `processed_events` is already keyed by consumer precisely so that two
 * of them can claim the same event independently.
 *
 * Runs them in sequence and swallows per-consumer failures: one consumer throwing
 * must never stop the others from seeing the event, and must never stall the relay.
 * Each consumer owns its own retry by releasing its own claim.
 */
export class FanOutPublisher implements EventPublisher {
  private readonly log = new Logger('events.fanout');

  constructor(private readonly publishers: readonly EventPublisher[]) {}

  async publish(event: { id: string; eventType: string; aggregateId: string; payload: unknown }) {
    for (const p of this.publishers) {
      try {
        await p.publish(event);
      } catch (e) {
        this.log.error(
          `consumer threw on ${event.eventType} ${event.aggregateId}`,
          e instanceof Error ? e.stack : String(e),
        );
      }
    }
  }
}
