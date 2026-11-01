import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { makeHarness, daysFromNow, type Harness } from '../../../test/harness';
import { SearchService } from '../search.service';

let h: Harness;
let search: SearchService;

/**
 * The harness seeds a single purohit, which cannot demonstrate anything about
 * spreading work — `matchPandit` returning the only candidate is correct. These
 * add three more, all verified and all offering the same ritual, priced close
 * together so the scores land within a hair of each other. That closeness IS the
 * condition under test: it is what a young roster looks like before anyone has
 * reviews, and it is what made a 0.17% gap decide every booking.
 */
const addPurohits = async (prices: number[]) => {
  for (const [i, pricePaise] of prices.entries()) {
    const id = `pandit_extra_${i}`;
    await h.db.execute(sql`
      INSERT INTO users (id, phone, role, city_id, referral_code)
      VALUES (${id}, ${`+9198300100${i}`}, 'pandit', ${h.ids.cityId}, ${`REF${i}`})`);
    await h.db.execute(sql`
      INSERT INTO pandit_profiles (user_id, kyc_status, cash_jobs_enabled,
        base_lat, base_lng, experience_years)
      VALUES (${id}, 'verified', true, 22.5726, 88.3639, ${20 + i})`);
    await h.db.execute(sql`
      INSERT INTO pandit_rituals (pandit_id, ritual_id, price_paise, active)
      VALUES (${id}, ${h.ids.ritualId}, ${pricePaise}, true)`);
  }
};

beforeEach(async () => {
  h = await makeHarness();
  search = new SearchService(h.db);
  await addPurohits([148000, 152000, 155000]);
}, 60_000);
afterEach(async () => { await h?.pg.close(); });

/**
 * Allocation must spread across the roster.
 *
 * Since ADR 0012 matching does not sort a list the devotee then chooses from — it
 * ALLOCATES the work and therefore the income. A pure score maximiser gives every
 * booking in an area to whoever edges the top, and the ADR predicted exactly that:
 * the starved purohits stop maintaining their calendars, which concentrates the
 * ranking further.
 *
 * It was not hypothetical. On the seeded roster, rating (no reviews), proximity
 * (no coordinates reach `matchPandit`) and acceptance (never written) are identical
 * for every purohit, so 80% of the score cancels and a 0.17% gap in price and
 * experience handed one purohit every single booking.
 */
const bookFor = (panditId: string, id: string, hoursFromNow: number) => h.db.execute(sql`
  INSERT INTO bookings (
    id, devotee_id, pandit_id, ritual_id, city_id, address_id, date,
    slot_idx, slot_span, slot_start_at, slot_end_at, state, panjika_school,
    attendee_count, samagri_option, bom_snapshot, price, payment_mode
  ) VALUES (
    ${id}, ${h.ids.devoteeId}, ${panditId}, ${h.ids.ritualId}, ${h.ids.cityId},
    ${h.ids.addressId}, ${daysFromNow(3)}, 1, 1,
    now() + ${`${hoursFromNow} hours`}::interval,
    now() + ${`${hoursFromNow + 2} hours`}::interval,
    'confirmed', 'gupta_press', 10, 'pandit_brings', '[]'::jsonb,
    '{"totalPaise":100000}'::jsonb, 'cash'
  )`);

const match = () => search.matchPandit({ ritualId: h.ids.ritualId, citySlug: 'kolkata' });

describe('work is spread across the roster, not given to one purohit', () => {
  it('does not return the same purohit once they are carrying work', async () => {
    const first = await match();
    expect(first).not.toBeNull();

    await bookFor(first!.id, 'J1', 24);
    const second = await match();

    expect(second).not.toBeNull();
    expect(second!.id, 'the same purohit won again despite already holding a job')
      .not.toBe(first!.id);
  });

  /**
   * The real shape of the bug: not one repeat, but every booking forever. Four
   * purohits should see the work reach more than one of them.
   */
  it('reaches several purohits over consecutive bookings', async () => {
    const picked: string[] = [];
    for (let i = 0; i < 4; i++) {
      const p = await match();
      if (!p) break;
      picked.push(p.id);
      await bookFor(p.id, `J${i}`, 24 + i * 6);
    }
    expect(new Set(picked).size, `all ${picked.length} bookings went to one purohit`)
      .toBeGreaterThan(1);
  });

  /**
   * Past work is not a reason to withhold the next job — only a full calendar
   * ahead is. A booking that has already happened must not keep penalising them.
   */
  it('counts only upcoming work, not history', async () => {
    const first = await match();
    await bookFor(first!.id, 'PAST', -48);      // finished two days ago
    expect((await match())!.id).toBe(first!.id);
  });

  /** A cancelled booking releases the purohit; it must stop counting against them. */
  it('stops penalising a purohit once a booking is cancelled', async () => {
    const first = await match();
    await bookFor(first!.id, 'C1', 24);
    expect((await match())!.id).not.toBe(first!.id);

    await h.db.execute(sql`UPDATE bookings SET state='cancelled_devotee' WHERE id='C1'`);
    expect((await match())!.id).toBe(first!.id);
  });
});
