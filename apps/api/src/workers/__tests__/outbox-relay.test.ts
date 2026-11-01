import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isNull, sql } from 'drizzle-orm';
import { makeHarness, type Harness } from '../../test/harness';
import { outbox } from '../../db/schema/index';
import { OutboxRelay, LoggingPublisher, type EventPublisher } from '../outbox-relay';

let h: Harness;
beforeEach(async () => { h = await makeHarness(); }, 60_000);
afterEach(async () => { await h?.pg.close(); });

const seed = async (n: number) => {
  for (let i = 0; i < n; i++) {
    await h.outbox.emit(h.db, {
      aggregateType: 'booking', aggregateId: `B${i}`,
      eventType: 'booking.confirmed', payload: { i },
    });
  }
};

describe('outbox relay', () => {
  it('publishes pending events and marks them done', async () => {
    await seed(3);
    const pub = new LoggingPublisher();
    const relay = new OutboxRelay(h.db, h.outbox, pub);

    expect(await relay.drainOnce()).toBe(3);
    expect(pub.seen).toHaveLength(3);
    const pending = await h.db.select().from(outbox).where(isNull(outbox.publishedAt));
    expect(pending).toHaveLength(0);
  });

  it('does not republish what it already published', async () => {
    await seed(2);
    const pub = new LoggingPublisher();
    const relay = new OutboxRelay(h.db, h.outbox, pub);
    await relay.drainOnce();
    expect(await relay.drainOnce()).toBe(0);
    expect(pub.seen).toHaveLength(2);
  });

  it('leaves a failed event pending and records the error, so nothing is lost', async () => {
    await seed(1);
    const failing: EventPublisher = {
      publish: async () => { throw new Error('queue unreachable'); },
    };
    const relay = new OutboxRelay(h.db, h.outbox, failing);
    expect(await relay.drainOnce()).toBe(0);

    const rows = await h.db.select().from(outbox);
    expect(rows[0]!.publishedAt).toBeNull();
    expect(rows[0]!.attempts).toBe(1);
    expect(rows[0]!.lastError).toMatch(/queue unreachable/);

    // and it goes out once the downstream recovers
    const pub = new LoggingPublisher();
    expect(await new OutboxRelay(h.db, h.outbox, pub).drainOnce()).toBe(1);
  });

  it('dedupes consumers, because delivery is at-least-once', async () => {
    const first = await h.outbox.claimForConsumer(h.db, 'notifications', 'EVT1');
    const second = await h.outbox.claimForConsumer(h.db, 'notifications', 'EVT1');
    const other = await h.outbox.claimForConsumer(h.db, 'ledger-projection', 'EVT1');
    expect([first, second, other]).toEqual([true, false, true]);
  });

  /**
   * The property the whole claim/lease redesign exists to preserve without holding
   * a transaction open across publish(): two relay instances racing the same rows
   * must still never both deliver the same event. `claimBatch` now commits and
   * releases its connection immediately, so this is exercised by actually racing
   * two `drainOnce()` calls rather than by inspecting lock state.
   */
  it('never double-publishes when two relay instances race the same batch', async () => {
    await seed(20);
    const pubA = new LoggingPublisher();
    const pubB = new LoggingPublisher();
    const relayA = new OutboxRelay(h.db, h.outbox, pubA);
    const relayB = new OutboxRelay(h.db, h.outbox, pubB);

    const [countA, countB] = await Promise.all([relayA.drainOnce(), relayB.drainOnce()]);
    expect(countA + countB).toBe(20);

    const seen = [...pubA.seen, ...pubB.seen].map((e) => e.aggregateId);
    expect(new Set(seen).size).toBe(20);   // every event delivered exactly once

    const pending = await h.db.select().from(outbox).where(isNull(outbox.publishedAt));
    expect(pending).toHaveLength(0);
  });

  it('reclaims a batch whose claimant never marked it published, once the lease is stale', async () => {
    await seed(1);
    // Simulate a crash mid-batch: claim it, but never publish or mark it.
    const abandoned = await h.outbox.claimBatch(h.db, 10);
    expect(abandoned).toHaveLength(1);

    const pub = new LoggingPublisher();
    const relay = new OutboxRelay(h.db, h.outbox, pub);
    // The lease has not gone stale yet - nothing to claim.
    expect(await relay.drainOnce()).toBe(0);

    // Backdate the lease past the visibility timeout, as if it were claimed a while ago.
    await h.db.execute(
      sql`UPDATE "outbox" SET claimed_at = now() - interval '1 minute' WHERE id = ${abandoned[0]!.id}`,
    );
    expect(await relay.drainOnce()).toBe(1);
    expect(pub.seen).toHaveLength(1);
  });
});
