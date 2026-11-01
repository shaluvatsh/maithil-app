import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeHarness, type Harness } from '../../../test/harness';
import { PayoutService } from '../payouts.service';

let h: Harness;
let payouts: PayoutService;

beforeEach(async () => {
  h = await makeHarness();
  payouts = new PayoutService(h.db, h.ledger);
}, 60_000);
afterEach(async () => { await h?.pg.close(); });

/**
 * WHO HAS BEEN PAID AND WHO HAS NOT.
 *
 * The admin console's `ledger` tab returns raw double-entry rows — the truth, and
 * the wrong shape for the one question ops asks about money. Answering "is this
 * purohit settled?" from them meant summing four entry types across two directions,
 * per purohit, by hand.
 *
 * It matters more because payouts are run BY HAND from this console rather than on a
 * schedule. Without a view of what is outstanding, running them manually is guessing
 * who is due.
 */
describe('the settlement overview', () => {
  it('answers with nothing owed when nothing has been earned', async () => {
    const res = await payouts.settlementOverview();
    expect(res.outstandingPaise).toBe(0);
    expect(res.owedCount).toBe(0);
  });

  /**
   * ONE QUERY, not one per purohit — the obvious loop-and-`preview` version is a
   * query per row on a screen that grows with the roster. That means the SQL here
   * and the JS in `preview` are two expressions of one calculation, and the only
   * thing stopping them drifting is this.
   */
  it('agrees with the per-purohit earnings preview', async () => {
    const overview = await payouts.settlementOverview();
    for (const row of overview.settlements) {
      const preview = await payouts.preview(row.panditId);
      expect(row.grossPaise).toBe(preview.grossPaise);
      expect(row.duesPaise).toBe(preview.duesPaise);
      expect(row.tdsCarryPaise).toBe(preview.tdsCarryPaise);
      expect(row.alreadyPaidPaise).toBe(preview.alreadyPaidPaise);
      expect(row.netPayablePaise).toBe(preview.netPayablePaise);
    }
  });

  /** `settled` is precomputed so the screen and the total cannot disagree. */
  it('marks a purohit settled exactly when nothing is payable', async () => {
    const res = await payouts.settlementOverview();
    for (const row of res.settlements) {
      expect(row.settled).toBe(row.netPayablePaise === 0);
    }
    expect(res.owedCount).toBe(res.settlements.filter((r) => !r.settled).length);
  });

  it('totals the outstanding across everyone', async () => {
    const res = await payouts.settlementOverview();
    const sum = res.settlements.reduce((s, r) => s + r.netPayablePaise, 0);
    expect(res.outstandingPaise).toBe(sum);
  });
});
