import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { makeHarness, daysFromNow, type Harness } from '../../../test/harness';
import { BookableTimesService } from '../bookable-times.service';

let h: Harness;
let svc: BookableTimesService;
const DATE = daysFromNow(12);
const IST_MIN = 330;

beforeEach(async () => {
  h = await makeHarness();
  svc = new BookableTimesService(h.db);
}, 60_000);
afterEach(async () => { await h?.pg.close(); });

/** Local HH:MM in the city's zone, which is what a devotee actually reads. */
const local = (iso: string) =>
  new Date(new Date(iso).getTime() + IST_MIN * 60_000).toISOString().slice(11, 16);

const hours = (startsAt: string, endsAt: string) => h.db.execute(sql`
  INSERT INTO pandit_working_hours (pandit_id, weekday, starts_at, ends_at)
  SELECT ${h.ids.panditId}, d, ${startsAt}::time, ${endsAt}::time
    FROM generate_series(0, 6) AS d
  ON CONFLICT (pandit_id, weekday, starts_at) DO UPDATE SET ends_at = EXCLUDED.ends_at`);

const times = (durationMin = 90) => svc.forDate({
  ritualId: h.ids.ritualId, citySlug: 'kolkata', date: DATE, durationMin,
});
const available = async (durationMin = 90) =>
  (await times(durationMin)).filter((t) => t.available);

/**
 * The devotee's picker, replacing four fixed slots that could not express a
 * muhurat starting at 11:15, the 04:00 Brahma muhurta, or the midnight Kali Puja
 * the catalogue already sells. See ADR 0013.
 */
describe('bookable start times', () => {
  it('offers the whole day in 30-minute steps', async () => {
    await hours('06:00', '19:30');
    const all = await times();
    expect(all).toHaveLength(48);           // 24h / 30min
  });

  /**
   * The window must fit ENTIRELY inside working hours: a 90-minute ritual starting
   * at 18:30 would run to 20:00, past a 19:30 finish.
   */
  it('only offers times whose whole window fits the working day', async () => {
    await hours('06:00', '19:30');
    const av = await available(90);
    expect(local(av[0]!.startsAt)).toBe('06:00');
    expect(local(av[av.length - 1]!.startsAt)).toBe('18:00');
    expect(local(av[av.length - 1]!.endsAt)).toBe('19:30');
  });

  /** A longer ritual is offerable at fewer start times, from the same hours. */
  it('narrows the offer as the ritual gets longer', async () => {
    await hours('06:00', '19:30');
    const short = await available(60);
    const long = await available(300);
    expect(long.length).toBeLessThan(short.length);
  });

  /**
   * The case the slot grid could not represent at all. `ends_at <= starts_at`
   * means the window runs into the next day.
   */
  it('offers night hours when the purohit works across midnight', async () => {
    await h.db.execute(sql`DELETE FROM pandit_working_hours WHERE pandit_id = ${h.ids.panditId}`);
    await hours('22:00', '03:00');
    const av = await available(90);
    const at = av.map((t) => local(t.startsAt));
    expect(at).toContain('23:00');          // a midnight Kali Puja
    expect(at).not.toContain('09:00');      // and nothing in the working day
  });

  it('offers the Brahma muhurta when the purohit starts before dawn', async () => {
    await h.db.execute(sql`DELETE FROM pandit_working_hours WHERE pandit_id = ${h.ids.panditId}`);
    await hours('04:00', '12:00');
    expect((await available(90)).map((t) => local(t.startsAt))).toContain('04:00');
  });

  it('offers nothing when the purohit has declared no hours', async () => {
    await h.db.execute(sql`DELETE FROM pandit_working_hours WHERE pandit_id = ${h.ids.panditId}`);
    expect(await available()).toHaveLength(0);
  });

  /** A committed booking removes every window that overlaps it, not just its start. */
  it('withdraws times a booking already covers', async () => {
    await hours('06:00', '19:30');
    const before = (await available(90)).map((t) => local(t.startsAt));
    expect(before).toContain('10:00');

    await h.db.execute(sql`
      INSERT INTO bookings (
        id, devotee_id, pandit_id, ritual_id, city_id, address_id, date,
        slot_idx, slot_span, slot_start_at, slot_end_at, state, panjika_school,
        attendee_count, samagri_option, bom_snapshot, price, payment_mode
      ) VALUES (
        'BUSY', ${h.ids.devoteeId}, ${h.ids.panditId}, ${h.ids.ritualId}, ${h.ids.cityId},
        ${h.ids.addressId}, ${DATE}, 1, 1,
        ${`${DATE}T10:00:00+05:30`}::timestamptz,
        ${`${DATE}T13:00:00+05:30`}::timestamptz,
        'confirmed', 'gupta_press', 10, 'pandit_brings', '[]'::jsonb,
        '{"totalPaise":100000}'::jsonb, 'cash'
      )`);

    const after = (await available(90)).map((t) => local(t.startsAt));
    expect(after).not.toContain('10:00');
    expect(after).not.toContain('12:00');   // would run into the booked window
    expect(after).toContain('13:00');       // free the moment it ends
  });
});
