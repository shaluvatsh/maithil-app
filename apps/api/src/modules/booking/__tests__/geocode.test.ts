import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeHarness, type Harness } from '../../../test/harness';
import { pincodeCentroids } from '../../../db/schema/index';
import { GeocodeService } from '../geocode.service';
import { getRegion } from '@themaithil/region';

let h: Harness;
let geo: GeocodeService;

beforeEach(async () => {
  h = await makeHarness();
  geo = new GeocodeService(h.db);
}, 60_000);
afterEach(async () => { await h?.pg.close(); });

/**
 * Every address created through the product landed on its city's centroid, because
 * the API accepted an optional lat/lng and no client ever sent one. Survivable for
 * ranking; fatal for ADR 0013, where travel time between two addresses drives
 * scheduling — two addresses in one city are the SAME point, so travel between them
 * is zero and any buffer computed from it is a fiction.
 */
describe('an address resolves to the most precise point available', () => {
  it('uses the devotee\'s own coordinate when they shared one', async () => {
    const p = await geo.resolve({
      citySlug: 'kolkata', pincode: '700029', lat: 22.5148, lng: 88.3639,
    });
    expect(p).toEqual({ lat: 22.5148, lng: 88.3639, precision: 'exact' });
  });

  it('falls back to the pincode centroid when one is loaded', async () => {
    await h.db.insert(pincodeCentroids).values({
      pincode: '700029', lat: 22.5148, lng: 88.3639, source: 'test',
    });
    const p = await geo.resolve({ citySlug: 'kolkata', pincode: '700029' });
    expect(p.precision).toBe('pincode');
    expect(p.lat).toBeCloseTo(22.5148, 4);
  });

  /** The floor. Correct, coarse, and it says so rather than pretending. */
  it('falls back to the city centroid when the pincode is unknown', async () => {
    const p = await geo.resolve({ citySlug: 'kolkata', pincode: '700099' });
    expect(p.precision).toBe('city');
    expect(p.lat).toBeCloseTo(getRegion('kolkata').coords.lat, 4);
  });

  /**
   * The whole reason precision is recorded: at `city` precision two different
   * addresses are indistinguishable, so a travel estimate between them is zero.
   * Downstream has to be able to tell that apart from "they really are neighbours".
   */
  it('gives two different addresses in one city the SAME point at city precision', async () => {
    const a = await geo.resolve({ citySlug: 'kolkata', pincode: '700029' });
    const b = await geo.resolve({ citySlug: 'kolkata', pincode: '700019' });
    expect(a.precision).toBe('city');
    expect([a.lat, a.lng]).toEqual([b.lat, b.lng]);
  });

  it('separates those same two addresses once their pincodes are loaded', async () => {
    await h.db.insert(pincodeCentroids).values([
      { pincode: '700029', lat: 22.5148, lng: 88.3639, source: 'test' },
      { pincode: '700019', lat: 22.5300, lng: 88.3700, source: 'test' },
    ]);
    const a = await geo.resolve({ citySlug: 'kolkata', pincode: '700029' });
    const b = await geo.resolve({ citySlug: 'kolkata', pincode: '700019' });
    expect(a.precision).toBe('pincode');
    expect([a.lat, a.lng]).not.toEqual([b.lat, b.lng]);
  });

  /** A partial coordinate is not a coordinate; it must not be read as `exact`. */
  it('ignores a half-supplied coordinate rather than trusting it', async () => {
    const p = await geo.resolve({ citySlug: 'kolkata', pincode: '700099', lat: 22.5 });
    expect(p.precision).toBe('city');
  });
});
