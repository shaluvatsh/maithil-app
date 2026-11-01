import { ulid } from 'ulid';
import { eq, and, gte, lte, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import {
  panchangDays, panchangIntervals, panchangTerms, muhuratFlags, cities, rituals,
  festivalDates,
} from '../../db/schema/index';
import {
  sunTimes, intervalsBetween, tithiIndex, tithiKey, julianDay, nakshatraIndex,
  NAKSHATRA_KEYS,
} from '../../domain/astronomy';
import { abhijitWindow, rahuKaalWindow, annotateSlot } from '../../domain/panchang';
import { DomainError, ErrorCode } from '@themaithil/contracts';
import type { PanjikaSchool, Locale, IsoDate } from '@themaithil/contracts';
import {
  getRegion, formatEraDate, slotInstant, computableSchool,
  festivalsFor, festivalById, festivalName, notableTithiKey, FESTIVALS, type Region,
} from '@themaithil/region';

/**
 * Nothing in this service knows what city it is in.
 *
 * Coordinates, UTC offset, era calendar and which almanacs are computable all come
 * from the region config, so adding a city is a config entry rather than an edit
 * here. See packages/region and docs/UI-ARCHITECTURE.md.
 */

const offsetMs = (r: Region) => r.utcOffsetMinutes * 60_000;

/**
 * The weekday in IST, for Rahu Kaal.
 *
 * `sunrise.getUTCDay()` gives the wrong weekday: a 05:00 IST sunrise is 23:30 UTC
 * on the previous day, which would shift Rahu Kaal by a full segment.
 */
const localWeekday = (d: Date, r: Region): number =>
  new Date(d.getTime() + offsetMs(r)).getUTCDay();

const addDaysIso = (date: IsoDate, n: number): IsoDate => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10) as IsoDate;
};

/**
 * Tithis considered auspicious for general ceremonies. Rikta tithis (4th, 9th, 14th)
 * and amavasya are avoided; purnima and the ekadashi/dwadashi pair are favoured.
 *
 * This is a STARTING TABLE, not scripture. It is the single most important thing for
 * the consulting purohit to correct before launch, and it is deliberately data rather
 * than logic so correcting it is an edit, not a deploy.
 */
const INAUSPICIOUS_TITHI = new Set([3, 8, 13, 18, 23, 28, 29]);   // rikta + amavasya
const AUSPICIOUS_NAKSHATRA = new Set([
  'rohini', 'mrigashira', 'pushya', 'uttara_phalguni', 'hasta', 'swati',
  'anuradha', 'uttara_ashadha', 'shravana', 'revati',
]);

/** Rituals fixed to their own occasion, where "auspicious day" is not our call. */
const FIXED_OCCASION = new Set([
  'durga-puja-ghot', 'kali-puja', 'lakshmi-puja', 'saraswati-puja', 'jagaddhatri-puja',
  'kartik-puja', 'bishwakarma-puja', 'janmashtami-puja', 'shiva-ratri-puja',
  'halkhata', 'bipodtarini-puja', 'tarpan', 'sraddha', 'annapurna-puja',
]);

export class PanchangService {
  constructor(private readonly db: Db) {}

  /**
   * Nightly job. Computes and upserts a rolling window for one city and school.
   *
   * Only DRIK schools are computed — observed planetary positions, ordinary
   * astronomy. Kolkata calls its drik almanac Bisuddha Siddhanta; most other cities
   * call theirs Drik Panchang. Gupta Press and the other traditional panjikas follow
   * Surya Siddhanta with their own corrections and are entered by hand. See ADR 0003.
   *
   * The default used to be the literal `'bisuddha_siddhanta'`, which is Kolkata's
   * name for its drik almanac and nobody else's. Every other city's panchang was
   * therefore written under a school its own region config does not offer, the read
   * path found no match, and twelve cities showed a blank almanac with data sitting
   * in the table. The default now comes from the region.
   */
  async materialise(args: {
    citySlug: string; from: IsoDate; days: number;
    school?: PanjikaSchool;
  }): Promise<{ days: number; intervals: number }> {
    const cityRegion = getRegion(args.citySlug);
    const school = args.school ?? (computableSchool(cityRegion) as PanjikaSchool);

    // Which almanacs we can compute is a property of the almanac, declared in region
    // config - drik schools are ordinary astronomy, traditional ones are not. ADR 0003.
    const declared = cityRegion.panjikas.find((p) => p.id === school);
    if (!declared) throw new Error(`${school} is not offered in ${args.citySlug}`);
    if (!declared.computable) {
      throw new Error(
        `${school} is not computable and is entered by hand (ADR 0003)`,
      );
    }

    const city = (await this.db.select().from(cities)
      .where(eq(cities.slug, args.citySlug)).limit(1))[0];
    if (!city) throw new Error(`unknown city: ${args.citySlug}`);

    const region = getRegion(args.citySlug);
    const start = slotInstant(args.from, '00:00', region);
    const end = new Date(start.getTime() + args.days * 86400_000);

    // --- intervals -------------------------------------------------------------
    // Replace the window wholesale: the exclusion constraint forbids overlaps, and
    // recomputing is cheaper than reconciling.
    await this.db.delete(panchangIntervals).where(and(
      eq(panchangIntervals.cityId, city.id),
      eq(panchangIntervals.school, school),
      gte(panchangIntervals.startsAt, start.toISOString()),
      lte(panchangIntervals.endsAt, end.toISOString()),
    ));

    let intervalCount = 0;
    for (const kind of ['tithi', 'nakshatra'] as const) {
      const list = intervalsBetween(kind, start, end);
      const rows = list.map((i) => ({
        id: ulid(), cityId: city.id, school, kind,
        valueKey: i.key,
        startsAt: i.startsAt.toISOString(),
        endsAt: i.endsAt.toISOString(),
        source: 'api' as const,
      }));
      for (let i = 0; i < rows.length; i += 200) {
        await this.db.insert(panchangIntervals).values(rows.slice(i, i + 200))
          .onConflictDoNothing();
      }
      intervalCount += rows.length;
    }

    // --- day summaries ---------------------------------------------------------
    const ritualRows = await this.db.select({ id: rituals.id, slug: rituals.slug })
      .from(rituals).where(eq(rituals.active, true));

    /*
     * Computed in memory, written in two batches.
     *
     * This inserted one row per day and then one row per ritual per day, awaited
     * individually — for a 120-day window over 28 rituals that is 3,480 round trips
     * for ONE city. It was survivable while the job only ever ran for Kolkata. Now
     * that it covers all fourteen it is roughly 49,000 sequential statements at
     * every boot, which is the difference between a job that finishes before anyone
     * notices and one that competes with live traffic for minutes.
     *
     * The arithmetic is pure and already fast; only the writes were the cost.
     */
    const dayRows: Array<typeof panchangDays.$inferInsert> = [];
    const flagRows: Array<typeof muhuratFlags.$inferInsert> = [];

    for (let d = 0; d < args.days; d++) {
      const date = addDaysIso(args.from, d);
      // Local noon, so sunTimes() resolves the right calendar day regardless of zone.
      const localNoon = slotInstant(date, '12:00', region);

      const { sunrise, sunset } = sunTimes(localNoon, region.coords.lat, region.coords.lng);
      const jdSunrise = julianDay(sunrise);

      const tIdx = tithiIndex(jdSunrise);
      const nIdx = nakshatraIndex(jdSunrise);
      const abhijit = abhijitWindow(sunrise, sunset);
      const rahu = rahuKaalWindow(sunrise, sunset, localWeekday(sunrise, region));

      dayRows.push({
        id: ulid(), cityId: city.id, school, date,
        bengaliDate: formatEraDate(date, region),
        sunrise: sunrise.toISOString(),
        sunset: sunset.toISOString(),
        tithiAtSunrise: tithiKey(tIdx),
        nakshatraAtSunrise: NAKSHATRA_KEYS[nIdx] ?? 'unknown',
        abhijitStart: abhijit.startsAt.toISOString(),
        abhijitEnd: abhijit.endsAt.toISOString(),
        rahuStart: rahu.startsAt.toISOString(),
        rahuEnd: rahu.endsAt.toISOString(),
        // Set by reconcileSchools() once the Gupta Press dates are entered.
        schoolsDisagree: false,
      });

      // --- per-ritual muhurat flags -------------------------------------------
      const generallyGood =
        !INAUSPICIOUS_TITHI.has(tIdx) &&
        AUSPICIOUS_NAKSHATRA.has(NAKSHATRA_KEYS[nIdx] ?? '');

      for (const r of ritualRows) {
        const auspicious = FIXED_OCCASION.has(r.slug) ? false : generallyGood;
        flagRows.push({
          id: ulid(), cityId: city.id, school, date, ritualId: r.id,
          isAuspicious: auspicious,
          windowStart: auspicious ? abhijit.startsAt.toISOString() : null,
          windowEnd: auspicious ? abhijit.endsAt.toISOString() : null,
          source: 'api',
        });
      }
    }

    /*
     * Chunked at 500. Postgres caps a statement at 65,535 bind parameters, and a
     * muhurat flag carries nine columns — so an unchunked 3,360-row insert would
     * exceed the limit and fail at exactly the window size that matters. 500 rows
     * is ~4,500 parameters, comfortably inside it, and matches the chunk the
     * availability job already uses.
     */
    const CHUNK = 500;
    for (let i = 0; i < dayRows.length; i += CHUNK) {
      await this.db.insert(panchangDays).values(dayRows.slice(i, i + CHUNK))
        .onConflictDoNothing();
    }
    for (let i = 0; i < flagRows.length; i += CHUNK) {
      await this.db.insert(muhuratFlags).values(flagRows.slice(i, i + CHUNK))
        .onConflictDoNothing();
    }

    const dayCount = dayRows.length;

    return { days: dayCount, intervals: intervalCount };
  }

  /**
   * Marks dates where the two schools disagree about a ritual's auspiciousness.
   * Runs after Gupta Press entry; with no manual rows present it is a no-op.
   */
  async reconcileSchools(citySlug: string): Promise<number> {
    const city = (await this.db.select().from(cities)
      .where(eq(cities.slug, citySlug)).limit(1))[0];
    if (!city) return 0;

    const res = await this.db.execute(sql`
      UPDATE panchang_days pd
         SET schools_disagree = TRUE
       WHERE pd.city_id = ${city.id}
         AND EXISTS (
           SELECT 1
             FROM muhurat_flags a
             JOIN muhurat_flags b
               ON b.city_id = a.city_id AND b.date = a.date AND b.ritual_id = a.ritual_id
              AND b.school <> a.school
            WHERE a.city_id = pd.city_id
              AND a.date = pd.date
              AND a.is_auspicious <> b.is_auspicious
         )`);
    return (res as unknown as { count?: number }).count ?? 0;
  }

  /**
   * Which of the city's declared almanacs are actually published.
   *
   * A school can be offered in the region config and still hold no rows: under ADR
   * 0003 the traditional panjikas are transcribed by hand once a year, and until a
   * purohit does that there is nothing to serve. Every caller previously assumed the
   * configured default had data, so `/panchang` and the home page both requested
   * Gupta Press, received `[]`, and rendered an empty state — the panchang was
   * invisible in the launch city and nothing said why.
   *
   * One grouped query, not one per school: the list is short today but this is the
   * shape that stays correct when a region declares five.
   */
  async schools(citySlug: string) {
    const city = (await this.db.select().from(cities)
      .where(eq(cities.slug, citySlug)).limit(1))[0];
    if (!city) return [];

    const coverage = await this.db.select({
      school: panchangDays.school,
      from: sql<string>`min(${panchangDays.date})`,
      to: sql<string>`max(${panchangDays.date})`,
      days: sql<number>`count(*)::int`,
    })
      .from(panchangDays)
      .where(eq(panchangDays.cityId, city.id))
      .groupBy(panchangDays.school);

    const byId = new Map(coverage.map((c) => [c.school, c]));

    // Driven by the region's declared list, so a school with stray rows and no
    // config entry never appears as an option.
    return getRegion(citySlug).panjikas.map((p) => {
      const got = byId.get(p.id as PanjikaSchool);
      return {
        id: p.id,
        english: p.english,
        native: p.native,
        note: p.note,
        computable: p.computable,
        published: Boolean(got && got.days > 0),
        from: got?.from ?? null,
        to: got?.to ?? null,
      };
    });
  }

  /** Devotee view: simple, localised, one school. */
  async forDevotee(args: {
    citySlug: string; from: IsoDate; to: IsoDate;
    school: PanjikaSchool; locale: Locale;
  }) {
    const city = (await this.db.select().from(cities)
      .where(eq(cities.slug, args.citySlug)).limit(1))[0];
    if (!city) return [];

    const days = await this.db.select().from(panchangDays)
      .where(and(
        eq(panchangDays.cityId, city.id),
        eq(panchangDays.school, args.school),
        gte(panchangDays.date, args.from),
        lte(panchangDays.date, args.to),
      ))
      .orderBy(panchangDays.date);

    const labels = await this.labels(args.locale);

    const flags = await this.db.select({
      date: muhuratFlags.date, ritualId: muhuratFlags.ritualId,
    })
      .from(muhuratFlags)
      .where(and(
        eq(muhuratFlags.cityId, city.id),
        eq(muhuratFlags.school, args.school),
        eq(muhuratFlags.isAuspicious, true),
        gte(muhuratFlags.date, args.from),
        lte(muhuratFlags.date, args.to),
      ));

    const byDate = new Map<string, string[]>();
    for (const f of flags) {
      byDate.set(f.date, [...(byDate.get(f.date) ?? []), f.ritualId]);
    }

    return days.map((d) => ({
      date: d.date as IsoDate,
      school: d.school,
      bengaliDate: d.bengaliDate,
      tithiAtSunrise: labels.get(d.tithiAtSunrise) ?? d.tithiAtSunrise,
      nakshatraAtSunrise: labels.get(d.nakshatraAtSunrise) ?? d.nakshatraAtSunrise,
      sunrise: d.sunrise,
      sunset: d.sunset,
      abhijit: d.abhijitStart && d.abhijitEnd
        ? { startsAt: d.abhijitStart, endsAt: d.abhijitEnd } : null,
      rahuKaal: d.rahuStart && d.rahuEnd
        ? { startsAt: d.rahuStart, endsAt: d.rahuEnd } : null,
      auspiciousForRitualIds: byDate.get(d.date) ?? [],
      schoolsDisagree: d.schoolsDisagree,
    }));
  }

  /** Purohit view adds the transition times, which is what they actually check. */
  async forPandit(args: {
    citySlug: string; from: IsoDate; to: IsoDate; school: PanjikaSchool; locale: Locale;
  }) {
    const base = await this.forDevotee(args);
    const region = getRegion(args.citySlug);
    const city = (await this.db.select().from(cities)
      .where(eq(cities.slug, args.citySlug)).limit(1))[0];
    // Keep the shape stable whatever happens - callers should never have to narrow a
    // union to find out whether `intervals` exists.
    if (!city) return base.map((d) => ({ ...d, intervals: [] }));

    const intervals = await this.db.select().from(panchangIntervals)
      .where(and(
        eq(panchangIntervals.cityId, city.id),
        eq(panchangIntervals.school, args.school),
        gte(panchangIntervals.endsAt, slotInstant(args.from, '00:00', region).toISOString()),
        lte(panchangIntervals.startsAt, slotInstant(args.to, '23:59', region).toISOString()),
      ))
      .orderBy(panchangIntervals.startsAt);

    const labels = await this.labels(args.locale);
    return base.map((d) => ({
      ...d,
      intervals: intervals
        .filter((i) => i.startsAt.slice(0, 10) === d.date || i.endsAt.slice(0, 10) === d.date)
        .map((i) => ({
          kind: i.kind, valueKey: i.valueKey,
          label: labels.get(i.valueKey) ?? i.valueKey,
          startsAt: i.startsAt, endsAt: i.endsAt,
        })),
    }));
  }

  /** Slot annotations, computed by real interval intersection. */
  async annotateSlots(args: {
    citySlug: string; date: IsoDate; school: PanjikaSchool;
    slots: Array<{ slotIdx: number; startsAt: string; endsAt: string }>;
  }) {
    const city = (await this.db.select().from(cities)
      .where(eq(cities.slug, args.citySlug)).limit(1))[0];
    if (!city) return args.slots.map((s) => ({ ...s, containsAbhijit: false, overlapsRahuKaal: false }));

    const day = (await this.db.select().from(panchangDays)
      .where(and(
        eq(panchangDays.cityId, city.id),
        eq(panchangDays.school, args.school),
        eq(panchangDays.date, args.date),
      )).limit(1))[0];

    const abhijit = day?.abhijitStart && day.abhijitEnd
      ? { startsAt: new Date(day.abhijitStart), endsAt: new Date(day.abhijitEnd) } : null;
    const rahu = day?.rahuStart && day.rahuEnd
      ? { startsAt: new Date(day.rahuStart), endsAt: new Date(day.rahuEnd) } : null;

    return args.slots.map((s) => {
      const a = annotateSlot(
        { startsAt: new Date(s.startsAt), endsAt: new Date(s.endsAt) }, abhijit, rahu,
      );
      return { ...s, containsAbhijit: a.containsAbhijit, overlapsRahuKaal: a.overlapsRahuKaal };
    });
  }

  /**
   * What is coming up, for a household in this city keeping this almanac.
   *
   * ONE list from TWO sources, because the reader does not care which:
   *
   *   TRANSCRIBED festivals, read out of a panjika into `festival_dates`. Named
   *   annual dates — Durga Puja, Diwali — cannot be derived here, because a lunar
   *   date needs the lunar month and `panchang_days` holds neither it nor anything
   *   it can be recovered from. See the migration for why we do not compute them.
   *
   *   DERIVED monthly observances, from the tithi already stored. Ekadashi, Purnima,
   *   Amavasya and Shivaratri repeat every lunar month and depend on the tithi
   *   ALONE, so they need no transcription and work in every city from day one.
   *
   * The catalogue filters by city (`festivalsFor`), the dates come by school, and
   * the two are joined here — so a Chennai reader is never counted down to Durga
   * Puja and a Kolkata reader never to Pongal, without either fact being written
   * into a query.
   */
  async upcoming(args: {
    citySlug: string; school: PanjikaSchool; locale: Locale;
    from: IsoDate; days: number;
  }) {
    const region = getRegion(args.citySlug);
    const city = (await this.db.select().from(cities)
      .where(eq(cities.slug, args.citySlug)).limit(1))[0];
    if (!city) return [];

    const to = addDaysIso(args.from, args.days);

    // Only the festivals this city actually marks, so the date lookup never has to
    // know about observance and the observance list never has to know about dates.
    const catalogue = festivalsFor(region.slug);
    const wanted = new Set(catalogue.map((f) => f.id));

    const [dated, days, labels] = await Promise.all([
      this.db.select().from(festivalDates).where(and(
        eq(festivalDates.school, args.school),
        gte(festivalDates.date, args.from),
        lte(festivalDates.date, to),
      )).orderBy(festivalDates.date),
      this.db.select({
        date: panchangDays.date, tithi: panchangDays.tithiAtSunrise,
      }).from(panchangDays).where(and(
        eq(panchangDays.cityId, city.id),
        eq(panchangDays.school, args.school),
        gte(panchangDays.date, args.from),
        lte(panchangDays.date, to),
      )).orderBy(panchangDays.date),
      this.labels(args.locale),
    ]);

    const festivals = dated
      .filter((d) => wanted.has(d.festivalId))
      .map((d) => {
        const f = festivalById(d.festivalId)!;
        return {
          kind: 'festival' as const,
          id: d.festivalId,
          name: festivalName(f, args.locale),
          blurb: f.blurb,
          date: d.date as IsoDate,
          endsOn: (d.endsOn ?? null) as IsoDate | null,
          ritualSlug: f.ritualSlug ?? null,
        };
      });

    /*
     * ONE ENTRY PER OBSERVANCE: THE NEXT ONE.
     *
     * A notable tithi recurs every lunar month BY DEFINITION — that is what makes it
     * a monthly observance rather than a festival. Emitting one row per matching day
     * meant a three-month window produced Amavasya three times, Krishna Ekadashi
     * three times, and so on, so a list headed "what is coming up" read as the same
     * handful of names cycling over and over.
     *
     * It was worse than merely repetitive. The named festivals this list is supposed
     * to lead with are transcribed by hand per school (ADR 0003) and Gupta Press has
     * none entered yet, so the festival tier is currently EMPTY — which left the
     * whole feed as nothing but recurring tithis, repeating. Durga Puja, Kali Puja
     * and Diwali were nowhere in it.
     *
     * Deduplicated on the tithi itself, keeping the earliest date, because `days` is
     * already ordered by date. Festivals are deliberately NOT deduplicated: each is a
     * specific dated event, and two of them sharing a name inside one window would be
     * a transcription error worth seeing rather than hiding.
     */
    const seenObservance = new Set<string>();
    const observances = days.flatMap((d) => {
      const key = notableTithiKey(d.tithi);
      if (!key) return [];
      if (seenObservance.has(d.tithi)) return [];
      seenObservance.add(d.tithi);
      return [{
        kind: 'observance' as const,
        id: d.tithi,
        // The localised tithi name where `panchang_terms` has one, and the
        // catalogue's English label otherwise. Never the raw value key.
        name: labels.get(d.tithi) ?? key,
        blurb: key,
        date: d.date as IsoDate,
        endsOn: null,
        ritualSlug: null,
      }];
    });

    /*
     * Festivals first on a shared date.
     *
     * Kali Puja falls on Amavasya and Lakshmi Puja on Purnima, so both tiers
     * produce an entry for the same day. The named festival is what the household
     * is actually marking; the tithi is how it is defined. Showing "Amavasya" above
     * "Kali Puja" would be technically true and useless.
     */
    return [...festivals, ...observances].sort((a, b) =>
      a.date === b.date
        ? (a.kind === b.kind ? 0 : a.kind === 'festival' ? -1 : 1)
        : a.date.localeCompare(b.date));
  }

  /**
   * The worksheet: every festival a school could carry, and what has been entered.
   *
   * Built as one list rather than "the dates we have", because the person using it is
   * working through a physical panjika and needs to see the GAPS. A screen that shows
   * only what exists cannot tell them what is left, which is the single thing that
   * matters when you are transcribing seventeen festivals by hand.
   *
   * Not filtered by city. A panjika's Vijaya Dashami is the same date wherever its
   * households live, which is why `festival_dates` is school-scoped — so the worksheet
   * is per SCHOOL, and the question of who observes what stays in `festivalsFor`.
   */
  async festivalWorksheet(args: { school: PanjikaSchool; from: IsoDate; to: IsoDate }) {
    const entered = await this.db.select().from(festivalDates).where(and(
      eq(festivalDates.school, args.school),
      gte(festivalDates.date, args.from),
      lte(festivalDates.date, args.to),
    ));

    const byFestival = new Map(entered.map((e) => [e.festivalId, e]));

    return {
      school: args.school,
      from: args.from,
      to: args.to,
      rows: FESTIVALS.map((f) => {
        const row = byFestival.get(f.id);
        return {
          festivalId: f.id,
          en: f.en,
          blurb: f.blurb,
          /** Consecutive days, so the form knows whether to ask for an end date. */
          days: f.days ?? 1,
          /** Region slugs that mark it — empty means everywhere we serve. */
          regions: f.regions ?? [],
          /** Null when nothing has been transcribed for this festival yet. */
          id: row?.id ?? null,
          date: row?.date ?? null,
          endsOn: row?.endsOn ?? null,
        };
      }),
      /** How many still need a date, so the screen can say how much is left. */
      remaining: FESTIVALS.filter((f) => !byFestival.has(f.id)).length,
    };
  }

  /**
   * Remove a transcription.
   *
   * Needed because `festival_dates` is unique on (school, festival, date): correcting
   * a date somebody read wrong means removing the old row, not updating it in place —
   * an upsert keyed on the date cannot change the date. A hard delete rather than a
   * tombstone, because a wrong almanac reading has no history worth keeping and a
   * soft-deleted date that a read path forgot to filter is a wrong festival on
   * somebody's calendar.
   */
  async removeFestivalDate(id: string) {
    const existing = (await this.db.select().from(festivalDates)
      .where(eq(festivalDates.id, id)).limit(1))[0];
    if (!existing) throw new DomainError(ErrorCode.NOT_FOUND, 'no such entry');
    await this.db.delete(festivalDates).where(eq(festivalDates.id, id));
    return { removed: id, festivalId: existing.festivalId };
  }

  /** Transcribing a date from an almanac. Ops only — nothing here is computed. */
  async recordFestival(args: {
    school: PanjikaSchool; festivalId: string; date: IsoDate;
    endsOn?: IsoDate | null | undefined; enteredBy: string;
  }) {
    if (!festivalById(args.festivalId)) {
      // A date for a festival the catalogue does not know is a typo, and it would
      // sit in the table for ever being filtered out of every read.
      throw new DomainError(ErrorCode.NOT_FOUND, `unknown festival: ${args.festivalId}`);
    }
    await this.db.insert(festivalDates).values({
      id: ulid(),
      school: args.school,
      festivalId: args.festivalId,
      date: args.date,
      endsOn: args.endsOn ?? null,
      source: 'manual_panjika',
      enteredBy: args.enteredBy,
    }).onConflictDoNothing();
    return { festivalId: args.festivalId, date: args.date };
  }

  private async labels(locale: Locale): Promise<Map<string, string>> {
    const rows = await this.db.select().from(panchangTerms)
      .where(eq(panchangTerms.locale, locale));
    return new Map(rows.map((r) => [r.valueKey, r.label]));
  }

}
