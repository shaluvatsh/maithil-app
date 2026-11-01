import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { makeHarness, daysFromNow, type Harness } from '../../test/harness';
import { assertFeasible, lockPurohit } from '../feasibility';

let h: Harness;
beforeEach(async () => { h = await makeHarness(); }, 60_000);
afterEach(async () => { await h?.pg.close(); });

const DATE = daysFromNow(11);
const at = (hhmm: string) => new Date(`${DATE}T${hhmm}:00+05:30`);

/** Gariahat — where the harness's devotee address sits. */
const GARIAHAT = { lat: 22.5148, lng: 88.3639, precision: 'exact' as const };
/** ~12 km north-east, across the city. */
const SALTLAKE = { lat: 22.5800, lng: 88.4200, precision: 'exact' as const };

/**
 * Puts a live booking on the purohit's day at a given venue, bypassing the booking
 * flow — the point here is the feasibility rule, not the state machine.
 */
const commit = async (id: string, startHH: string, hours: number, venue: typeof GARIAHAT) => {
  const addr = `addr_${id}`;
  await h.db.execute(sql`
    INSERT INTO addresses (id, user_id, label, line1, city_id, pincode, lat, lng, geo_precision)
    VALUES (${addr}, ${h.ids.devoteeId}, ${id}, 'test', ${h.ids.cityId}, '700029',
            ${venue.lat}, ${venue.lng}, ${venue.precision})`);
  await h.db.execute(sql`
    INSERT INTO bookings (
      id, devotee_id, pandit_id, ritual_id, city_id, address_id, date,
      slot_idx, slot_span, slot_start_at, slot_end_at, state, panjika_school,
      attendee_count, samagri_option, bom_snapshot, price, payment_mode
    ) VALUES (
      ${id}, ${h.ids.devoteeId}, ${h.ids.panditId}, ${h.ids.ritualId}, ${h.ids.cityId},
      ${addr}, ${DATE}, 1, 1,
      ${at(startHH).toISOString()},
      ${new Date(at(startHH).getTime() + hours * 3600_000).toISOString()},
      'confirmed', 'gupta_press', 10, 'pandit_brings', '[]'::jsonb,
      '{"totalPaise":100000}'::jsonb, 'cash'
    )`);
};

const check = (startHH: string, hours: number, venue: typeof GARIAHAT) =>
  h.db.transaction(async (tx) => {
    await lockPurohit(tx, h.ids.panditId);
    await assertFeasible(tx, {
      panditId: h.ids.panditId,
      startsAt: at(startHH),
      endsAt: new Date(at(startHH).getTime() + hours * 3600_000),
      venue,
      citySlug: 'kolkata',
    });
  });

/**
 * The question the slot grid never asked: can this purohit actually get here?
 *
 * `applyTravelBuffer` was supposed to answer it and never fires — guarded by
 * `travelMinutes <= region.travelGapMinutes` with a caller passing a hardcoded 25,
 * below every city's gap. So a purohit was bookable back-to-back whether the homes
 * were next door or 25 km apart.
 */
describe('a purohit must be able to reach the job', () => {
  it('accepts a booking with room to travel from the previous one', async () => {
    await commit('PREV', '09:00', 2, GARIAHAT);          // ends 11:00 in Gariahat
    // 12:30 across town: 90 minutes for a ~12 km hop. Comfortable.
    await expect(check('12:30', 2, SALTLAKE)).resolves.toBeUndefined();
  });

  it('refuses one that leaves no time to cross the city', async () => {
    await commit('PREV', '09:00', 2, GARIAHAT);          // ends 11:00 in Gariahat
    // 11:15 in Salt Lake: 15 minutes for a 12 km hop. Not possible.
    await expect(check('11:15', 2, SALTLAKE)).rejects.toThrow(/cannot reach you in time/);
  });

  /** Same street still needs turnaround — packing up, being let in. */
  it('still enforces the minimum turnaround at zero distance', async () => {
    await commit('PREV', '09:00', 2, GARIAHAT);          // ends 11:00
    await expect(check('11:10', 2, GARIAHAT)).rejects.toThrow(/cannot reach you in time/);
    await expect(check('11:40', 2, GARIAHAT)).resolves.toBeUndefined();
  });

  it('protects the NEXT booking as well as the previous one', async () => {
    await commit('NEXT', '14:00', 2, SALTLAKE);          // starts 14:00 in Salt Lake
    // Finishing in Gariahat at 13:45 leaves 15 minutes to cross the city.
    await expect(check('11:45', 2, GARIAHAT)).rejects.toThrow(/could not reach their next/);
  });

  it('says how much time was actually needed', async () => {
    await commit('PREV', '09:00', 2, GARIAHAT);
    await expect(check('11:15', 2, SALTLAKE)).rejects.toMatchObject({
      code: 'SLOT_UNAVAILABLE',
      meta: { reason: 'travel_from_previous' },
    });
  });

  /**
   * A cancelled booking has released the purohit's time; it must not keep
   * blocking travel around a slot nobody holds.
   */
  it('ignores a cancelled neighbour', async () => {
    await commit('PREV', '09:00', 2, GARIAHAT);
    await h.db.execute(sql`UPDATE bookings SET state='cancelled_devotee' WHERE id='PREV'`);
    await expect(check('11:15', 2, SALTLAKE)).resolves.toBeUndefined();
  });

  it('is fine on an empty day', async () => {
    await expect(check('11:00', 2, SALTLAKE)).resolves.toBeUndefined();
  });
});
