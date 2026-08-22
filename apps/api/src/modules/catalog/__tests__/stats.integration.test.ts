import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeHarness, type Harness } from '../../../test/harness';
import { panditProfiles } from '../../../db/schema/index';
import { StatsService } from '../stats.service';

let h: Harness;
let stats: StatsService;

beforeEach(async () => {
  h = await makeHarness();
  stats = new StatsService(h.db);
}, 60_000);
afterEach(async () => { await h?.pg.close(); });

/**
 * The hero read "4.8★ average · 500 verified pandits · 50,000+ families served".
 * There were no reviews in the database, so the average was of nothing; the pandit
 * count was a round number somebody liked; and nobody had been served, because
 * nothing has launched.
 *
 * Inventing social proof is a worse category of wrong than inventing a price. A
 * wrong price is corrected at checkout — the devotee finds out. A fabricated rating
 * is never corrected, and it is the specific claim a marketplace does not recover
 * from being caught on.
 */
describe('the numbers under the hero are counted', () => {
  it('counts only pandits who have actually been verified', async () => {
    // The fixture seeds one verified purohit.
    expect((await stats.summary()).verifiedPandits).toBe(1);

    // Anyone still awaiting KYC drops out of the count — the whole point of the
    // word "verified" in a claim a devotee is being asked to trust.
    await h.db.update(panditProfiles).set({ kycStatus: 'pending' });
    expect((await stats.summary()).verifiedPandits).toBe(0);

    await h.db.update(panditProfiles).set({ kycStatus: 'rejected' });
    expect((await stats.summary()).verifiedPandits).toBe(0);
  });

  it('counts the catalogue and the cities it is priced in', async () => {
    const s = await stats.summary();
    expect(s.rituals).toBeGreaterThan(0);
    expect(s.cities).toBeGreaterThan(0);
  });

  /**
   * "Families served" has to mean a puja that happened. Counting registrations, or
   * bookings in any state, is a signup counter wearing a trustworthy word.
   */
  it('counts families served as completed bookings, not signups', async () => {
    expect((await stats.summary()).familiesServed).toBe(0);
  });

  it('returns zero rather than omitting a figure it cannot produce', async () => {
    const s = await stats.summary();
    for (const [k, v] of Object.entries(s)) {
      expect(typeof v, `${k} is not a number`).toBe('number');
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});
