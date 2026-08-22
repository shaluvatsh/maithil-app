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
   * Claim, publish and mark - all inside ONE transaction, not three.
   *
   * The claim used `FOR UPDATE SKIP LOCKED` and then committed immediately, which
   * releases every row lock before a single event is published. A second relay
   * instance's claim then sees those same rows as unlocked and unpublished, and
   * claims and publishes them again - the exact double-publish SKIP LOCKED exists
   * to prevent, and the opposite of what the code comment and
   * `docs/ARCHITECTURE-REVIEW.md` both claimed happens. Holding the locks for the
   * whole batch is what actually makes concurrent relay instances safe: a second
   * instance's `claimBatch` now blocks-then-skips these rows until this
   * transaction commits, by which point they are already marked published.
   */
  async drainOnce(limit = 100): Promise<number> {
    return this.db.transaction(async (tx) => {
      const rows = await this.outbox.claimBatch(tx, limit);
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
          await this.outbox.markFailed(tx, row.id, msg);
          if (row.attempts + 1 >= MAX_ATTEMPTS) {
            // Give up publishing but leave the row: it is the audit trail of
            // intent, and an operator can replay it once the downstream is healthy.
            this.log.error(`event ${row.id} (${row.eventType}) parked after ${MAX_ATTEMPTS} attempts`);
          }
        }
      }
      await this.outbox.markPublished(tx, published);
      return published.length;
    });
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
