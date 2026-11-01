import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { makeHarness, daysFromNow, type Harness } from '../../../test/harness';
import { SearchService } from '../search.service';
import { SearchController } from '../search.controller';
import { AvailabilityService } from '../../availability/availability.service';
import { BookableTimesService } from '../../availability/bookable-times.service';

let h: Harness;
let ctl: SearchController;
let times: BookableTimesService;

const DATE = daysFromNow(12);
const IST_MIN = 330;

/** An instant from a local HH:MM on DATE, in Kolkata's zone. */
const at = (hhmm: string) => {
  const [hh = '0', mm = '0'] = hhmm.split(':');
  const ms = Date.parse(`${DATE}T00:00:00Z`)
    + (Number(hh) * 60 + Number(mm) - IST_MIN) * 60_000;
  return new Date(ms).toISOString();
};

const hours = (startsAt: string, endsAt: string, panditId = h.ids.panditId) => h.db.execute(sql`
  INSERT INTO pandit_working_hours (pandit_id, weekday, starts_at, ends_at)
  SELECT ${panditId}, d, ${startsAt}::time, ${endsAt}::time
    FROM generate_series(0, 6) AS d
  ON CONFLICT (pandit_id, weekday, starts_at) DO UPDATE SET ends_at = EXCLUDED.ends_at`);

beforeEach(async () => {
  h = await makeHarness();
  times = new BookableTimesService(h.db);
  ctl = new SearchController(
    // Availability is not on the path under test; it is a constructor dependency.
    new SearchService(h.db), new AvailabilityService(h.db, 120), times, h.db,
  );
  await hours('06:00', '19:30');
}, 60_000);
afterEach(async () => { await h?.pg.close(); });

/** The query the booking page actually builds, as raw strings off the wire. */
const search = (over: Record<string, string> = {}) => ctl.pandits({
  citySlug: 'kolkata',
  ritualId: h.ids.ritualId,
  date: DATE,
  ...over,
});

/**
 * THE BUG THIS COVERS, and why it needs the CONTROLLER rather than the service.
 *
 * `SearchArgs` has declared `startsAt`/`endsAt` since ADR 0013, `rankPandits`
 * branches on them before anything else, and its comment says they "supersede
 * `date`+`slotIdx`". The booking flow was migrated accordingly: `findPandits` stopped
 * sending `slotIdx` and started sending the window.
 *
 * They were never added to `SearchQuery`. A Zod object STRIPS unknown keys instead of
 * rejecting them, so both fell silently off the parsed query before reaching the
 * service — and `rankPandits`, seeing neither a window nor a `slotIdx`, fell through
 * both availability branches to the empty-`sql` default. No availability filter ran
 * at all.
 *
 * Every test in this directory drives `SearchService` directly and so could not see
 * it: the service was always correct. The defect lived entirely in the one line of
 * schema between the wire and the service, which is why these go through `pandits()`.
 *
 * Measured against the dev database before the fix: a window at midnight IST, when
 * no purohit has working hours at all, returned all four seeded purohits; and with
 * one of four booked across a window, `/v1/availability/times` reported 3 free while
 * search returned 4, the booked one included. The screen's "4 pandits are free at
 * this time" meant only "4 verified purohits exist in this city".
 */
describe('searching by window actually filters by the window', () => {
  it('offers nobody for a window outside every purohit\'s working hours', async () => {
    // 02:00–03:30 IST. Working hours are 06:00–19:30, so this is nobody's.
    const res = await search({ startsAt: at('02:00'), endsAt: at('03:30') });
    expect(res.results).toHaveLength(0);
  });

  it('offers the purohit for a window inside their working hours', async () => {
    const res = await search({ startsAt: at('09:00'), endsAt: at('10:30') });
    expect(res.results).toHaveLength(1);
  });

  /**
   * The window must fit ENTIRELY inside the working day — a 90-minute ritual
   * starting at 18:30 runs to 20:00, past a 19:30 finish. This is the boundary the
   * stripped parameters meant was never tested end to end.
   */
  it('refuses a window that starts inside the working day but ends after it', async () => {
    const res = await search({ startsAt: at('18:30'), endsAt: at('20:00') });
    expect(res.results).toHaveLength(0);
  });

  /**
   * The case a devotee actually hits: someone else booked the purohit for that
   * window between the time picker loading and this search running.
   */
  it('drops a purohit already booked across the window', async () => {
    const startsAt = at('09:00');
    const endsAt = at('10:30');
    expect((await search({ startsAt, endsAt })).results).toHaveLength(1);

    await h.db.execute(sql`
      INSERT INTO bookings (id, devotee_id, pandit_id, ritual_id, city_id, address_id,
                            date, slot_idx, slot_start_at, slot_end_at, state,
                            samagri_option, payment_mode, panjika_school, price)
      VALUES ('bk_window_probe', ${h.ids.devoteeId}, ${h.ids.panditId}, ${h.ids.ritualId},
              ${h.ids.cityId}, ${h.ids.addressId}, ${DATE}, 0,
              ${startsAt}::timestamptz, ${endsAt}::timestamptz, 'confirmed',
              'pandit_brings', 'cash', 'gupta_press',
              '{"totalPaise":100000,"tokenPaise":10000}'::jsonb)`);

    expect((await search({ startsAt, endsAt })).results).toHaveLength(0);
  });

  /**
   * The search screen and the time picker must not disagree about who is free —
   * they are two reads of one fact, shown one tap apart. `purohitCount` is what the
   * picker renders; `results.length` is what the next screen counts.
   */
  it('agrees with the time picker about how many purohits are free', async () => {
    const all = await times.forDate({
      ritualId: h.ids.ritualId, citySlug: 'kolkata', date: DATE, durationMin: 90,
    });
    const open = all.find((t) => t.available);
    expect(open).toBeDefined();

    const res = await search({ startsAt: open!.startsAt, endsAt: open!.endsAt });
    expect(res.results).toHaveLength(open!.purohitCount);
  });
});

/**
 * `rankPandits` tests `startsAt && endsAt` together, so one without the other does
 * not half-filter — it falls through to the slot branch, or to no filter at all.
 * That is the same quiet wrong-branch failure as above, so it is rejected at the
 * edge rather than silently changing which filter runs.
 */
describe('a half-specified window is refused rather than ignored', () => {
  it('rejects startsAt without endsAt', async () => {
    await expect(search({ startsAt: at('09:00') })).rejects.toThrow(/together/);
  });

  it('rejects endsAt without startsAt', async () => {
    await expect(search({ endsAt: at('10:30') })).rejects.toThrow(/together/);
  });

  it('rejects a window that ends before it starts', async () => {
    await expect(search({ startsAt: at('10:30'), endsAt: at('09:00') }))
      .rejects.toThrow(/after/);
  });

  /**
   * Unparseable datetimes are interpolated into `::timestamptz` casts, so they must
   * fail as a 422 naming the field rather than as a Postgres error from inside a CTE.
   */
  it('rejects a malformed instant at the edge, not in the query', async () => {
    await expect(search({ startsAt: 'tomorrow morning', endsAt: at('10:30') }))
      .rejects.toThrow();
  });

  /** With neither, this is still the browse path: no window, no window filter. */
  it('still allows a plain browse with no window at all', async () => {
    const res = await search();
    expect(res.results.length).toBeGreaterThan(0);
  });
});
