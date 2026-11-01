import { ulid } from 'ulid';
import { eq, ne, and, or, gte, lte, inArray, sql } from 'drizzle-orm';
import type { Db, Executor } from '../../db/client';
import {
  availability, slotDefs, panditProfiles, users, panditWeeklyPatterns, cities,
} from '../../db/schema/index';
import { DomainError, ErrorCode, type IsoDate, type SlotView } from '@themaithil/contracts';

import { getRegion, slotInstant as regionSlotInstant } from '@themaithil/region';

/**
 * Offsets come from region config, never a constant - India is +05:30 today but Nepal
 * is +05:45, and hardcoding it is the kind of thing that only breaks in a new market.
 */
export const slotInstant = (date: IsoDate, time: string, citySlug = 'kolkata'): Date =>
  regionSlotInstant(date, time.slice(0, 5), getRegion(citySlug));

export const addDays = (date: IsoDate, n: number): IsoDate => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10) as IsoDate;
};

export const today = (citySlug = 'kolkata'): IsoDate => {
  const region = getRegion(citySlug);
  return new Date(Date.now() + region.utcOffsetMinutes * 60_000)
    .toISOString().slice(0, 10) as IsoDate;
};

export class AvailabilityService {
  constructor(
    private readonly db: Db,
    private readonly horizonDays: number,
  ) {}

  /**
   * `slotInstant` needs a city SLUG to pick the right UTC offset, and everything
   * that writes availability rows carries a city ID. Without this the slug
   * defaulted to Kolkata's, so every materialised row in every other city was
   * timestamped against the wrong offset — the parameter existed and no caller
   * could reach it.
   *
   * Cached for the process: a city's slug never changes, and materialise runs per
   * purohit, so re-reading it would be a query per call for a constant.
   */
  private readonly slugByCityId = new Map<string, string>();

  private async citySlugFor(cityId: string): Promise<string> {
    const cached = this.slugByCityId.get(cityId);
    if (cached) return cached;
    const row = (await this.db.select({ slug: cities.slug })
      .from(cities).where(eq(cities.id, cityId)).limit(1))[0];
    if (!row) throw new DomainError(ErrorCode.NOT_FOUND, 'unknown city');
    this.slugByCityId.set(cityId, row.slug);
    return row.slug;
  }

  /**
   * Materialise availability rows out to the booking horizon.
   *
   * Materialised rather than lazy because the FOR UPDATE lock in SlotService needs
   * rows to lock, and because travel buffers need somewhere to live.
   *
   * The horizon is the SAME constant the panchang job uses. In the original design
   * availability ran 60 days and panchang 90, so for a month devotees could see
   * auspicious dates with no bookable slots behind them.
   */
  /**
   * Declares the purohit's working hours, once, from their city's own day.
   *
   * Under ADR 0013 a devotee's time picker and `matchPandit` both answer "is this
   * window inside their declared hours" from `pandit_working_hours`. A purohit with
   * no rows there is offered at NO time at all — invisible in the picker and never
   * matched — so onboarding has to write them or every new purohit completes the
   * wizard into silence. Existing purohits were covered by a one-off backfill; this
   * is the same rule, applied to everyone who signs up after it.
   *
   * The city's first slot start to its last slot end, on every weekday. The
   * 30-minute gaps between the old slots are deliberately NOT carried across: they
   * were a fixed guess at travel, and travel is now estimated per pair of bookings.
   *
   * Never overwrites. A purohit who has set their own hours — including night hours
   * for a midnight Kali Puja — keeps them, and re-running this changes nothing.
   */
  async ensureWorkingHours(args: { panditId: string; cityId: string }): Promise<number> {
    const res = await this.db.execute(sql`
      WITH city_day AS (
        SELECT MIN(start_time) AS opens, MAX(end_time) AS closes
          FROM slot_defs WHERE city_id = ${args.cityId} AND active
      )
      INSERT INTO pandit_working_hours (pandit_id, weekday, starts_at, ends_at)
      SELECT ${args.panditId}, d.weekday, cd.opens, cd.closes
        FROM city_day cd CROSS JOIN generate_series(0, 6) AS d(weekday)
       WHERE cd.opens IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM pandit_working_hours w WHERE w.pandit_id = ${args.panditId}
         )
      ON CONFLICT (pandit_id, weekday, starts_at) DO NOTHING
      RETURNING weekday`);
    return (((res as { rows?: unknown[] }).rows ?? res) as unknown[]).length;
  }

  async materialise(args: { panditId: string; cityId: string; from?: IsoDate }): Promise<number> {
    const citySlug = await this.citySlugFor(args.cityId);
    // "Today" is also the city's, not the launch city's - the horizon must start on
    // the purohit's own calendar day.
    const start = args.from ?? today(citySlug);
    const defs = await this.db.select().from(slotDefs)
      .where(and(eq(slotDefs.cityId, args.cityId), eq(slotDefs.active, true)))
      .orderBy(slotDefs.idx);
    if (defs.length === 0) {
      throw new DomainError(ErrorCode.NOT_FOUND, 'no slot definitions for this city');
    }

    const rows = [];
    for (let d = 0; d < this.horizonDays; d++) {
      const date = addDays(start, d);
      for (const def of defs) {
        rows.push({
          id: ulid(),
          panditId: args.panditId,
          date,
          slotIdx: def.idx,
          status: 'open' as const,
          source: 'default' as const,
          startsAt: slotInstant(date, def.startTime, citySlug).toISOString(),
          endsAt: slotInstant(date, def.endTime, citySlug).toISOString(),
        });
      }
    }

    // Chunked so a 120-day x 4-slot materialisation does not build one enormous
    // statement. onConflictDoNothing makes re-running the job free.
    let written = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const res = await this.db.insert(availability).values(rows.slice(i, i + 500))
        .onConflictDoNothing().returning({ id: availability.id });
      written += res.length;
    }
    return written;
  }

  async forRange(args: { panditId: string; from: IsoDate; to: IsoDate }) {
    const rows = await this.db.select().from(availability)
      .where(and(
        eq(availability.panditId, args.panditId),
        gte(availability.date, args.from),
        lte(availability.date, args.to),
      ))
      .orderBy(availability.date, availability.slotIdx);

    const byDate = new Map<string, SlotView[]>();
    for (const r of rows) {
      const list = byDate.get(r.date) ?? [];
      list.push({
        slotIdx: r.slotIdx,
        startsAt: r.startsAt,
        endsAt: r.endsAt,
        status: r.status,
        // Panchang annotations are layered on by PanchangService, which needs the
        // purohit's panjika school - so they are not this service's business.
        containsAbhijit: false,
        overlapsRahuKaal: false,
        bookingId: r.bookingId,
      });
      byDate.set(r.date, list);
    }
    return [...byDate.entries()].map(([date, slots]) => ({ date: date as IsoDate, slots }));
  }

  /**
   * A purohit declaring when they will work.
   *
   * This only ever UPDATED rows that already existed, because the only way a slot
   * came into being was `materialise()` — an all-or-nothing "open my whole
   * calendar for the next 30 days". So a purohit looking at a date outside that
   * window, or at a day whose rows had never been written, was told their calendar
   * was not open and given nowhere to open it. The one thing supply most needs to
   * say — "I am free on the 20th, morning only" — had no expression.
   *
   * Opening now creates the row if it is missing. Closing deliberately does not:
   * there is nothing to close, and writing a `closed` row for every date a purohit
   * merely looked at would fill the table with declarations of absence.
   *
   * The `inArray(['open','closed'])` filter is the safety rule and stays. A slot
   * that is `booked` or `buffer` must not be reopened or closed underneath the
   * devotee holding it, which is why the count returned is what actually changed
   * rather than what was asked for.
   */
  async setSlots(args: {
    panditId: string;
    cityId?: string;
    changes: Array<{ date: IsoDate; slotIdx: number; status: 'open' | 'closed' }>;
    /**
     * Who is asking. Defaults to 'manual' - a purohit editing their own calendar
     * directly. `applyWeeklyPattern` passes 'recurring' for its OWN writes, so a
     * later pattern edit can tell "the pattern opened this last time it ran" apart
     * from "the purohit opened this by hand as a one-off exception" - both used to
     * write 'manual' unconditionally, which made them indistinguishable and let a
     * routine pattern edit silently reopen or reclose whatever the pattern itself
     * had most recently touched.
     */
    source?: 'manual' | 'recurring';
  }): Promise<number> {
    let updated = 0;
    const source = args.source ?? 'manual';

    // Two statements regardless of how many slots changed. This ran one UPDATE per
    // change, so a purohit closing a week made 28 sequential round trips from a
    // phone on a village connection.
    for (const status of ['open', 'closed'] as const) {
      const wanted = args.changes.filter((c) => c.status === status);
      if (wanted.length === 0) continue;

      const res = await this.db.update(availability)
        .set({ status, source })
        .where(and(
          eq(availability.panditId, args.panditId),
          inArray(availability.status, ['open', 'closed']),
          /*
           * Only rows that are actually changing.
           *
           * Without this the UPDATE matched every row already in the target state,
           * so re-applying a weekly pattern rewrote 120 rows to the values they
           * already held — and reported "120 slots closed" to a purohit who had
           * changed nothing. Write amplification is the smaller half; the count is
           * shown to a human, and a number that overstates what happened is worse
           * than no number.
           */
          ne(availability.status, status),
          // (date, slotIdx) pairs, so closing slot 2 on Tuesday does not also close
          // slot 2 on every other day in the batch.
          or(...wanted.map((c) => and(
            eq(availability.date, c.date),
            eq(availability.slotIdx, c.slotIdx),
          ))),
        ))
        .returning({ date: availability.date, slotIdx: availability.slotIdx });
      updated += res.length;

      if (status === 'open' && args.cityId) {
        const touched = new Set(res.map((r) => `${r.date}:${r.slotIdx}`));
        const missing = wanted.filter((c) => !touched.has(`${c.date}:${c.slotIdx}`));
        if (missing.length > 0) {
          updated += await this.createSlots(args.panditId, args.cityId, missing, source);
        }
      }
    }
    return updated;
  }

  /**
   * Writes slots that did not exist yet.
   *
   * `startsAt`/`endsAt` come from the city's own `slot_defs`, not from the client:
   * a purohit may only offer the hours the city publishes, and letting the request
   * name its own times would put arbitrary windows into the column the booking
   * engine locks on.
   */
  private async createSlots(
    panditId: string,
    cityId: string,
    slots: Array<{ date: IsoDate; slotIdx: number }>,
    source: 'manual' | 'recurring' = 'manual',
  ): Promise<number> {
    const [defs, citySlug] = await Promise.all([
      this.db.select().from(slotDefs)
        .where(and(eq(slotDefs.cityId, cityId), eq(slotDefs.active, true))),
      this.citySlugFor(cityId),
    ]);
    const byIdx = new Map(defs.map((d) => [d.idx, d]));

    const rows = slots.flatMap((s) => {
      const def = byIdx.get(s.slotIdx);
      // An unknown slot index is silently skipped rather than inserted with
      // invented times — a row the engine could lock is worse than a missing one.
      if (!def) return [];
      return [{
        id: ulid(),
        panditId,
        date: s.date,
        slotIdx: s.slotIdx,
        status: 'open' as const,
        source,
        startsAt: slotInstant(s.date, def.startTime, citySlug).toISOString(),
        endsAt: slotInstant(s.date, def.endTime, citySlug).toISOString(),
      }];
    });
    if (rows.length === 0) return 0;

    const res = await this.db.insert(availability).values(rows)
      // A concurrent materialise may have written it between the update and here.
      .onConflictDoNothing().returning({ id: availability.id });
    return res.length;
  }

  /**
   * Travel buffer. On confirmation we mark the neighbouring slot unavailable when
   * the gap is too small to cross the city.
   *
   * Note the published slot boundaries leave only 30 minutes between slots, which
   * cross-Kolkata travel routinely exceeds. So this fires often, and effective
   * capacity is 2-3 slots/day rather than 4. That is expected, not a bug - but the
   * purohit income model has to use the real number. See ADR 0006.
   */
  async applyTravelBuffer(tx: Executor, args: {
    panditId: string; date: IsoDate; slotIdx: number; slotSpan: number;
    travelMinutes: number; citySlug?: string;
  }): Promise<void> {
    // The gap that works in Kolkata does not work in Bengaluru; both are declared.
    const region = getRegion(args.citySlug ?? 'kolkata');
    if (args.travelMinutes <= region.travelGapMinutes) return;

    const lastSlot = region.slots.length - 1;
    const neighbours = [args.slotIdx - 1, args.slotIdx + args.slotSpan]
      .filter((i) => i >= 0 && i <= lastSlot);
    if (neighbours.length === 0) return;

    await tx.update(availability)
      .set({ status: 'buffer', source: 'travel_buffer' })
      .where(and(
        eq(availability.panditId, args.panditId),
        eq(availability.date, args.date),
        inArray(availability.slotIdx, neighbours),
        eq(availability.status, 'open'),
      ));
  }

  /** Release buffers when the booking that caused them goes away. */
  async releaseBuffers(tx: Executor, args: { panditId: string; date: IsoDate }): Promise<void> {
    await tx.update(availability)
      .set({ status: 'open', source: 'manual' })
      .where(and(
        eq(availability.panditId, args.panditId),
        eq(availability.date, args.date),
        eq(availability.status, 'buffer'),
      ));
  }

  /**
   * Supply coverage per day, for one city.
   *
   * The admin console shows bookings and a ledger — both records of what already
   * happened. Nothing showed what is ABOUT to fail: a Saturday in Durga Puja week
   * with four open slots across the whole city is a day of rejected bookings, and
   * it is only visible while there is still time to call purohits and ask them to
   * open more. Reading the same calendar the other two roles read, aggregated.
   *
   * One grouped query rather than a query per day: a 31-day window over fourteen
   * cities is the shape this has to survive.
   */
  async coverage(args: { cityId: string; from: IsoDate; to: IsoDate }) {
    const rows = await this.db
      .select({
        date: availability.date,
        openSlots: sql<number>`count(*) FILTER (WHERE ${availability.status} = 'open')::int`,
        bookedSlots: sql<number>`count(*) FILTER (WHERE ${availability.status} = 'booked')::int`,
        blockedSlots: sql<number>`count(*) FILTER (WHERE ${availability.status} NOT IN ('open','booked'))::int`,
        purohits: sql<number>`count(DISTINCT ${availability.panditId})::int`,
      })
      .from(availability)
      .innerJoin(panditProfiles, eq(panditProfiles.userId, availability.panditId))
      .innerJoin(users, eq(users.id, panditProfiles.userId))
      .where(and(
        eq(users.cityId, args.cityId),
        // Only purohits a devotee could actually be matched with. Counting pending
        // KYC as supply is how a city looks covered and then cannot fulfil.
        eq(panditProfiles.kycStatus, 'verified'),
        gte(availability.date, args.from),
        lte(availability.date, args.to),
      ))
      .groupBy(availability.date)
      .orderBy(availability.date);

    return rows.map((r) => ({
      date: r.date,
      openSlots: Number(r.openSlots),
      bookedSlots: Number(r.bookedSlots),
      blockedSlots: Number(r.blockedSlots),
      purohits: Number(r.purohits),
      /** Share of sellable capacity already taken. Null when there is none. */
      utilisation: Number(r.openSlots) + Number(r.bookedSlots) > 0
        ? Number(r.bookedSlots) / (Number(r.openSlots) + Number(r.bookedSlots))
        : null,
    }));
  }

  /**
   * Read a purohit's usual week.
   *
   * Returned as (weekday, slotIdx) pairs rather than a matrix: the number of slots
   * is per-city config, so a fixed 7x4 grid would be wrong the day a city publishes
   * five.
   */
  async weeklyPattern(panditId: string): Promise<Array<{ weekday: number; slotIdx: number }>> {
    return this.db.select({
      weekday: panditWeeklyPatterns.weekday,
      slotIdx: panditWeeklyPatterns.slotIdx,
    })
      .from(panditWeeklyPatterns)
      .where(eq(panditWeeklyPatterns.panditId, panditId))
      .orderBy(panditWeeklyPatterns.weekday, panditWeeklyPatterns.slotIdx);
  }

  /**
   * Set the usual week, and project it across the horizon.
   *
   * The gig-work shape: state a repeating shift once, let the system fill the
   * calendar, override individual days by exception. Saying "I work Tuesday and
   * Thursday mornings" through the per-date model meant 120 taps to express one
   * sentence.
   *
   * Two rules make this safe to re-run, and both matter:
   *
   *   - A BOOKED or buffered slot is never touched. Regenerating from a pattern
   *     that has since changed would otherwise release a confirmed puja out from
   *     under a devotee — the worst thing this codebase could do.
   *   - Only slots the pattern speaks about are changed. A purohit who closed next
   *     Tuesday by hand and then edits their Thursday pattern must not find Tuesday
   *     silently reopened; that is the exception overriding the rule, which is the
   *     entire point of having both.
   *   - The same rule the other direction: a purohit who OPENED an extra Saturday
   *     by hand — a favour, a one-off — must not find it silently closed the next
   *     time they touch their pattern. This half was missing: `closes` covered
   *     every (weekday, slot) the pattern was silent about with no regard for HOW
   *     a currently-open row got that way, so a manual exception outside the
   *     pattern was supply that vanished on the purohit's next unrelated edit,
   *     with nothing telling them it happened.
   */
  async setWeeklyPattern(args: {
    panditId: string;
    cityId: string;
    /** The complete desired pattern. Anything absent is treated as "not working". */
    pattern: Array<{ weekday: number; slotIdx: number }>;
    from?: IsoDate;
  }): Promise<{ opened: number; closed: number }> {
    await this.db.transaction(async (tx) => {
      await tx.delete(panditWeeklyPatterns)
        .where(eq(panditWeeklyPatterns.panditId, args.panditId));
      if (args.pattern.length > 0) {
        await tx.insert(panditWeeklyPatterns).values(args.pattern.map((p) => ({
          panditId: args.panditId, weekday: p.weekday, slotIdx: p.slotIdx,
        }))).onConflictDoNothing();
      }
    });

    // `exactOptionalPropertyTypes` is on: passing `from: undefined` is not the same
    // as omitting it, and the default belongs in one place.
    return this.applyWeeklyPattern(
      args.from
        ? { panditId: args.panditId, cityId: args.cityId, from: args.from }
        : { panditId: args.panditId, cityId: args.cityId },
    );
  }

  /**
   * Project the stored pattern forward over the booking horizon.
   *
   * Separate from `setWeeklyPattern` so the roll-forward can be re-run — as the
   * horizon advances, days that were beyond it come into range and need the same
   * rule applied without the purohit re-saving anything.
   */
  async applyWeeklyPattern(args: {
    panditId: string; cityId: string; from?: IsoDate;
  }): Promise<{ opened: number; closed: number }> {
    const pattern = await this.weeklyPattern(args.panditId);
    const wanted = new Set(pattern.map((p) => `${p.weekday}:${p.slotIdx}`));

    const defs = await this.db.select().from(slotDefs)
      .where(and(eq(slotDefs.cityId, args.cityId), eq(slotDefs.active, true)));
    if (defs.length === 0) {
      throw new DomainError(ErrorCode.NOT_FOUND, 'no slot definitions for this city');
    }

    const start = args.from ?? today();
    const end = addDays(start, this.horizonDays - 1);

    // Manually opened slots the pattern doesn't know about - the exception, not
    // the rule - must survive regeneration. `source` is how a row remembers HOW
    // it came to be open; `status` alone cannot tell a purohit's deliberate
    // one-off from a slot the pattern itself opened last time it ran.
    const manualOpens = await this.db.select({
      date: availability.date, slotIdx: availability.slotIdx,
    }).from(availability).where(and(
      eq(availability.panditId, args.panditId),
      eq(availability.status, 'open'),
      eq(availability.source, 'manual'),
      gte(availability.date, start),
      lte(availability.date, end),
    ));
    const manualOpenSet = new Set(manualOpens.map((r) => `${r.date}:${r.slotIdx}`));

    const opens: Array<{ date: IsoDate; slotIdx: number; status: 'open' }> = [];
    const closes: Array<{ date: IsoDate; slotIdx: number; status: 'closed' }> = [];

    for (let d = 0; d < this.horizonDays; d++) {
      const date = addDays(start, d);
      // Midday avoids a DST-style edge deciding the weekday; IST has none, but the
      // habit costs nothing and the bug it prevents is invisible when it happens.
      const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();

      for (const def of defs) {
        const key = `${weekday}:${def.idx}`;
        if (wanted.has(key)) opens.push({ date, slotIdx: def.idx, status: 'open' });
        // A weekday the pattern is silent about is a weekday they do not normally
        // work - UNLESS this specific date was opened by hand, in which case the
        // exception stands and the pattern leaves it alone.
        else if (!manualOpenSet.has(`${date}:${def.idx}`)) {
          closes.push({ date, slotIdx: def.idx, status: 'closed' });
        }
      }
    }

    // `setSlots` already refuses booked and buffered rows, and creates the ones a
    // purohit is opening for the first time. Tagged 'recurring' so THIS engine's
    // own writes never masquerade as a purohit's manual exception on the next run.
    const opened = await this.setSlots({
      panditId: args.panditId, cityId: args.cityId, changes: opens, source: 'recurring',
    });
    const closed = await this.setSlots({
      panditId: args.panditId, changes: closes, source: 'recurring',
    });

    return { opened, closed };
  }
}
