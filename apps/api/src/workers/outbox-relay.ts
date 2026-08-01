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

  async drainOnce(limit = 100): Promise<number> {
    // SKIP LOCKED, so several relay instances can run without contending.
    const rows = await this.db.transaction((tx) => this.outbox.claimBatch(tx, limit));
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
          // Give up publishing but leave the row: it is the audit trail of intent,
          // and an operator can replay it once the downstream is healthy.
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
