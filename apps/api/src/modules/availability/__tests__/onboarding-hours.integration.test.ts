import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { makeHarness, type Harness } from '../../../test/harness';
import { AvailabilityService } from '../availability.service';
import { BookableTimesService } from '../bookable-times.service';

let h: Harness;
let availability: AvailabilityService;
let times: BookableTimesService;

beforeEach(async () => {
  h = await makeHarness();
  availability = new AvailabilityService(h.db, 120);
  times = new BookableTimesService(h.db);
  // A purohit who has just signed up: no hours declared yet.
  await h.db.execute(sql`DELETE FROM pandit_working_hours WHERE pandit_id = ${h.ids.panditId}`);
}, 60_000);
afterEach(async () => { await h?.pg.close(); });

const hoursCount = async () => {
  const r = await h.db.execute(sql`
    SELECT count(*)::int AS n FROM pandit_working_hours WHERE pandit_id = ${h.ids.panditId}`);
  return (((r as { rows?: Array<{ n: number }> }).rows ?? r) as Array<{ n: number }>)[0]!.n;
};

/**
 * A purohit who finishes onboarding must be bookable.
 *
 * The devotee's time picker and `matchPandit` both answer "is this window inside
 * their declared hours" from `pandit_working_hours` (ADR 0013). Existing purohits
 * were given rows by a one-off backfill; a purohit signing up AFTER it had none,
 * so they completed the whole wizard and were offered at no time at all — invisible
 * in the picker and never matched. Silent, and on the supply side, where nobody
 * would have noticed until a purohit asked why they never get work.
 */
describe('onboarding leaves a purohit actually bookable', () => {
  it('declares working hours for every weekday', async () => {
    expect(await hoursCount()).toBe(0);
    await availability.ensureWorkingHours({ panditId: h.ids.panditId, cityId: h.ids.cityId });
    expect(await hoursCount()).toBe(7);
  });

  it('makes them offerable at real times', async () => {
    const before = await times.forDate({
      ritualId: h.ids.ritualId, citySlug: 'kolkata',
      date: '2026-09-09', durationMin: 90,
    });
    expect(before.filter((t) => t.available)).toHaveLength(0);

    await availability.ensureWorkingHours({ panditId: h.ids.panditId, cityId: h.ids.cityId });

    const after = await times.forDate({
      ritualId: h.ids.ritualId, citySlug: 'kolkata',
      date: '2026-09-09', durationMin: 90,
    });
    expect(after.filter((t) => t.available).length).toBeGreaterThan(0);
  });

  /** Re-running onboarding, or clicking the button twice, must change nothing. */
  it('is idempotent', async () => {
    await availability.ensureWorkingHours({ panditId: h.ids.panditId, cityId: h.ids.cityId });
    await availability.ensureWorkingHours({ panditId: h.ids.panditId, cityId: h.ids.cityId });
    expect(await hoursCount()).toBe(7);
  });

  /**
   * A purohit who has set their own hours owns them. Overwriting would quietly
   * revoke the night availability a midnight Kali Puja depends on.
   */
  it('never overwrites hours the purohit set themselves', async () => {
    await h.db.execute(sql`
      INSERT INTO pandit_working_hours (pandit_id, weekday, starts_at, ends_at)
      SELECT ${h.ids.panditId}, d, '22:00'::time, '03:00'::time
        FROM generate_series(0, 6) AS d`);

    await availability.ensureWorkingHours({ panditId: h.ids.panditId, cityId: h.ids.cityId });

    const r = await h.db.execute(sql`
      SELECT DISTINCT starts_at::text AS s FROM pandit_working_hours
       WHERE pandit_id = ${h.ids.panditId}`);
    const rows = ((r as { rows?: Array<{ s: string }> }).rows ?? r) as Array<{ s: string }>;
    expect(rows.map((x) => x.s)).toEqual(['22:00:00']);
  });
});
