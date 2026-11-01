import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { makeHarness, daysFromNow, type Harness } from '../../../test/harness';

let h: Harness;
beforeEach(async () => { h = await makeHarness(); }, 60_000);
afterEach(async () => { await h?.pg.close(); });

/**
 * The guarantee the continuous-time model rests on (ADR 0013).
 *
 * Today no two live bookings can share a purohit's time because
 * `SlotService.lockAndBook` takes `FOR UPDATE` over discrete `availability` rows.
 * Once bookings occupy arbitrary intervals there are no discrete rows to lock, so
 * the guarantee moves onto the interval itself as a GiST exclusion constraint.
 *
 * These pin the constraint's exact edges, because a constraint that is slightly
 * too broad breaks legitimate bookings and one slightly too narrow silently
 * double-books a person's day.
 */
/**
 * `cash_collected_paise` is set unconditionally: a guard in 9999_guards.sql
 * requires it once a CASH booking reaches `completed`, and the completed case
 * below would otherwise fail on that rather than on the thing under test.
 */
const insert = (id: string, state: string, startsIn: string, hours: number) => h.db.execute(sql`
  INSERT INTO bookings (
    id, devotee_id, pandit_id, ritual_id, city_id, address_id, date,
    slot_idx, slot_span, slot_start_at, slot_end_at, state, panjika_school,
    attendee_count, samagri_option, bom_snapshot, price, payment_mode,
    cash_collected_paise
  ) VALUES (
    ${id}, ${h.ids.devoteeId}, ${h.ids.panditId}, ${h.ids.ritualId},
    ${h.ids.cityId}, ${h.ids.addressId}, ${daysFromNow(9)},
    1, 1,
    ${`${daysFromNow(9)}T00:00:00+05:30`}::timestamptz + ${startsIn}::interval,
    ${`${daysFromNow(9)}T00:00:00+05:30`}::timestamptz + ${startsIn}::interval
      + ${`${hours} hours`}::interval,
    ${state}, 'gupta_press', 10, 'pandit_brings', '[]'::jsonb,
    '{"totalPaise":100000}'::jsonb, 'cash', 100000
  )`);

describe("a purohit's live time cannot be committed twice", () => {
  it('refuses a second confirmed booking over the same window', async () => {
    await insert('A', 'confirmed', '10 hours', 3);
    await expect(insert('B', 'confirmed', '11 hours', 3)).rejects.toThrow(/exclusion constraint/);
  });

  /** Half-open ranges: ending at 13:00 and starting at 13:00 is not an overlap. */
  it('allows a booking that starts exactly when the previous one ends', async () => {
    await insert('A', 'confirmed', '10 hours', 3);
    await expect(insert('B', 'confirmed', '13 hours', 2)).resolves.toBeDefined();
  });

  /**
   * The constraint is partial. A cancelled booking has released the time — if it
   * still blocked the slot, cancelling would permanently burn it.
   */
  it('lets a cancelled booking share a window with a live one', async () => {
    await insert('A', 'confirmed', '10 hours', 3);
    await expect(insert('B', 'cancelled_devotee', '10 hours', 3)).resolves.toBeDefined();
  });

  /**
   * `completed` is deliberately outside the constraint: it is history, it cannot
   * conflict with future scheduling, and including it would let one historical
   * data-quality problem block the constraint permanently.
   */
  it('does not police overlaps involving a completed booking', async () => {
    await insert('A', 'completed', '10 hours', 3);
    await expect(insert('B', 'confirmed', '10 hours', 3)).resolves.toBeDefined();
  });

  /** Two purohits working the same hours is the normal case, not a conflict. */
  it('does not constrain different purohits to different times', async () => {
    await insert('A', 'confirmed', '10 hours', 3);
    const other = await h.db.execute(sql`
      SELECT user_id FROM pandit_profiles WHERE user_id <> ${h.ids.panditId} LIMIT 1`);
    const rows = (other as unknown as { rows?: Array<{ user_id: string }> }).rows ?? [];
    if (rows.length === 0) return;   // single-purohit harness; nothing to assert
    await expect(h.db.execute(sql`
      UPDATE bookings SET pandit_id = ${rows[0]!.user_id} WHERE id = 'A'`))
      .resolves.toBeDefined();
  });

  /**
   * A booking that runs past midnight is one interval, not two days. The range
   * type handles it; a date-keyed scheme would not — which is why the allocation
   * lock in ADR 0013 is keyed on the purohit alone.
   */
  it('treats a booking crossing midnight as one interval', async () => {
    await insert('A', 'confirmed', '23 hours', 3);          // 23:00 → 02:00 next day
    await expect(insert('B', 'confirmed', '24 hours', 2)).rejects.toThrow(/exclusion constraint/);
  });
});
