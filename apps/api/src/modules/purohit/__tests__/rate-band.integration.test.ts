import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { makeHarness, type Harness } from '../../../test/harness';
import { PurohitController } from '../purohit.controller';
import { PricingService } from '../../booking/pricing.service';
import { CatalogService } from '../../catalog/catalog.service';
import { ErrorCode } from '@themaithil/contracts';
import { InMemoryObjectStore } from '../../storage/object-store';

let h: Harness;
let ctl: PurohitController;

/** The band the harness seeds for this ritual: ₹1,100 – ₹2,500. */
const BAND_LO = 110000, BAND_HI = 250000;

beforeEach(async () => {
  h = await makeHarness();
  // The dashboard is a separate read surface; this suite exercises rate bands, so
  // it is passed as null the way the gateway and availability already are.
  ctl = new PurohitController(
    h.db, null as never, null as never, new InMemoryObjectStore(), null as never,
  );
}, 60_000);
afterEach(async () => { await h?.pg.close(); });

const save = (pricePaise: number, ritualId = h.ids.ritualId) => ctl.saveServices(
  { sub: h.ids.panditId } as never, { services: [{ ritualId, pricePaise }] },
);

/**
 * A purohit's rate has to be one the devotee was actually shown.
 *
 * `ritual_city_prices` carries a per-city band, the catalog advertises it as the
 * price of the ritual, and the onboarding screen prints it under the input — and
 * nothing enforced it. The only bound was the schema's ₹100–₹500,000 sanity range.
 *
 * Since ADR 0012 the platform ASSIGNS the purohit, so an out-of-band rate is not
 * an outlier the devotee can route around by picking someone else: they meet it
 * for the first time at the payment screen, after giving their address.
 */
describe('a purohit rate stays inside the advertised band', () => {
  it('accepts a rate inside the band', async () => {
    expect(await save(150000)).toEqual({ count: 1 });
  });

  it('accepts both edges — the band is inclusive', async () => {
    expect(await save(BAND_LO)).toEqual({ count: 1 });
    expect(await save(BAND_HI)).toEqual({ count: 1 });
  });

  it('refuses a rate above the band', async () => {
    await expect(save(4_000_000)).rejects.toMatchObject({
      code: ErrorCode.RATE_OUT_OF_BAND,
    });
  });

  it('refuses a rate below the band', async () => {
    await expect(save(10000)).rejects.toMatchObject({
      code: ErrorCode.RATE_OUT_OF_BAND,
    });
  });

  /** The screen has to point at the one rate that is wrong out of forty. */
  it('says which service and which range', async () => {
    await expect(save(4_000_000)).rejects.toMatchObject({
      meta: {
        ritualId: h.ids.ritualId, pricePaise: 4_000_000,
        bandMinPaise: BAND_LO, bandMaxPaise: BAND_HI,
      },
    });
  });

  /**
   * The rejection has to be complete, not partial. `saveServices` deactivates every
   * existing row before inserting, so a check that ran after that would leave a
   * purohit with nothing active — silently unbookable for rejecting one bad number.
   */
  it('leaves the existing rates untouched when it refuses', async () => {
    await save(150000);
    await expect(save(4_000_000)).rejects.toThrow();

    const r = await h.db.execute(sql`
      SELECT price_paise::int AS p, active FROM pandit_rituals
       WHERE pandit_id = ${h.ids.panditId} AND ritual_id = ${h.ids.ritualId}`);
    const rows = ((r as { rows?: Array<{ p: number; active: boolean }> }).rows ?? r) as
      Array<{ p: number; active: boolean }>;
    expect(rows[0]).toMatchObject({ p: 150000, active: true });
  });

  /**
   * A city we have not priced has advertised nothing to contradict, so there is
   * nothing to enforce — and blocking there would lock a purohit out of onboarding
   * in every city before ops finishes the price sheet.
   */
  it('allows any rate for a ritual with no band in this city', async () => {
    await h.db.execute(sql`
      DELETE FROM ritual_city_prices WHERE ritual_id = ${h.ids.ritualId}`);
    expect(await save(4_000_000)).toEqual({ count: 1 });
  });

  /** The end the devotee actually feels: the quote can no longer exceed the listing. */
  it('keeps the quote within what the listing promised', async () => {
    await expect(save(4_000_000)).rejects.toThrow();
    await save(BAND_HI);

    const pricing = new PricingService(h.db, new CatalogService(h.db));
    const quote = await pricing.quote({
      panditId: h.ids.panditId, ritualId: h.ids.ritualId, cityId: h.ids.cityId,
      date: '2026-09-09', samagriOption: 'none', paymentMode: 'digital_full',
    });
    // Taxes and fees sit on top of the dakshina; the dakshina itself is what the
    // band governs, and it is now the ceiling rather than eighteen times it.
    expect(Number(quote.dakshinaPaise)).toBeLessThanOrEqual(BAND_HI);
  });
});
