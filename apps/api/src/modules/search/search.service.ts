import { sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Db } from '../../db/client';
import { matchDecisions } from '../../db/schema/index';
import type { PanditCard } from '@themaithil/contracts';
import { isLocale, getRegion } from '@themaithil/region';
import { isFreeForWindow } from '../../domain/availability-window';

/** The city's IANA zone, stated explicitly so the SERVER's TimeZone never decides. */
const TZ_OF = (citySlug: string) => getRegion(citySlug).timezone;

/**
 * Purohit search and ranking.
 *
 * Two things here are deliberate answers to problems flagged in the review:
 *
 * 1. PROXIMITY IS COMPUTED IN SQL, not by calling a Maps API. The original design
 *    wired the search path to the Distance Matrix, which bills per origin-destination
 *    element - 50 results re-ranked on every filter change is a cost bomb. Haversine
 *    is accurate enough to rank by, and we call the Maps API exactly once, at
 *    confirmation, for the travel fee and buffer.
 *
 * 2. RATING IS BAYESIAN-SMOOTHED. A raw average lets a purohit with two 5-star
 *    reviews outrank one with forty at 4.7. We pull each rating towards the platform
 *    mean with a prior worth PRIOR_WEIGHT reviews.
 *
 * 3. NEW SUPPLY GETS A BOOST. Without it a new purohit never ranks, never earns a
 *    rating, and churns - the standard marketplace cold-start death spiral. The boost
 *    is a decaying bonus over their first N requests, and it is visible in the UI as
 *    a "new" badge rather than hidden.
 */
const PRIOR_WEIGHT = 10;      // reviews' worth of prior
const PRIOR_MEAN = 4.3;       // platform mean until we have real data
const EARTH_KM = 6371;

/**
 * Weights sum to 1.0.
 *
 * `experience` was not a term at all until auto-matching made this ranking the
 * thing that actually assigns work — when a devotee was choosing from a list they
 * could read "18 years" themselves, but nobody reads it now.
 *
 * Deliberately small at 0.10, and taken from `acceptance` and `priceFit` rather
 * than from rating or proximity: years served is a weak proxy for quality next to
 * a real rating, and over-weighting it would freeze new purohits out of the
 * marketplace permanently.
 */
const W = {
  rating: 0.40, proximity: 0.25, acceptance: 0.15, priceFit: 0.10, experience: 0.10,
};
const NEW_SUPPLY_BONUS = 0.15;

/**
 * A penalty for work already held, which is what stops one purohit taking
 * everything.
 *
 * Matching is not a sort order any more — since ADR 0012 it ALLOCATES work, and a
 * pure score maximiser hands every booking in an area to whoever edges the top.
 * That is not hypothetical: with four seeded purohits, rating (no reviews yet),
 * proximity (no coordinates reach `matchPandit`) and acceptance (never written)
 * are IDENTICAL for all of them, so 80% of the weight cancels and a 0.17% gap in
 * price and experience decided every single booking. One purohit had all of them.
 *
 * ADR 0012 predicted precisely this and called for a round-robin tiebreak. This is
 * that, expressed as a continuous penalty rather than a special case: each
 * upcoming job makes the next one slightly less likely, so work rotates on its own
 * and keeps rotating as the roster grows.
 *
 * Sized against the real spread. Those four sit within 0.06 of each other, so a
 * penalty of 0.06 per job is enough to move the winner after a single booking.
 * Capped at 0.30 so it can rebalance a busy week without ever outweighing `rating`
 * (0.40) — a genuinely better purohit should still win against someone idle, which
 * is the line between fairness and dispatching work to whoever is free.
 */
/**
 * Speaking the family's language, as a bonus rather than a filter.
 *
 * The booking screen has always promised a purohit "matched for your family's vidhi
 * and language", and `matchPandit` was passed neither — `languages` only ever
 * arrived from the browse UI's own filter chips, so on the allocation path the
 * promise was simply untrue.
 *
 * A filter is the wrong instrument: it can empty the candidate set and turn a
 * language preference into "no purohit is free", which is a worse outcome for the
 * devotee than someone who speaks their second language. Additive, so it can only
 * ever reorder — and at 0.05 it outweighs the price and experience terms that
 * currently decide close calls, without touching rating or proximity.
 */
const LANGUAGE_BONUS = 0.05;

const LOAD_PENALTY_PER_JOB = 0.06;
const LOAD_PENALTY_CAP = 0.30;

/**
 * These are compile-time constants, so they are inlined into the SQL rather than
 * bound as parameters. A bound numeric literal arrives as type `unknown`, and
 * Postgres then refuses `unknown * unknown` as ambiguous.
 */
const n = (x: number) => sql.raw(x.toString());

/**
 * A ranked candidate, exactly as the scoring query emits it.
 *
 * Numerics arrive as strings from the driver, which is why `bayes_rating`, `price_paise`
 * and `score` are typed that way rather than coerced at the boundary and silently
 * rounded somewhere else.
 */
export interface RankedRow {
  id: string; name: string | null; experience_years: number;
  languages: string[]; traditions: string[]; rating_count: number;
  bayes_rating: string; price_paise: string; distance_km: number | null;
  new_supply_boost_remaining: number;
  chanting_sample_url: string | null;
  chanting_sample_label: string | null;
  photo_key: string | null;
  kyc_status: string | null;
  score: string;
}

/**
 * How many candidates are kept per decision.
 *
 * Eight rather than all twenty-five: the question a purohit asks is "was I close",
 * and beyond the first handful the answer is no. Keeping every candidate would make
 * this table grow with roster size times bookings for information nobody reads.
 */
const CANDIDATES_LOGGED = 8;

export interface SearchArgs {
  ritualId: string;
  citySlug: string;
  date?: string | undefined;
  slotIdx?: number | undefined;
  /** How many contiguous slots the ritual needs, starting at slotIdx. Default 1. */
  slotSpan?: number | undefined;
  /**
   * The requested window as instants (ADR 0013). When present these supersede
   * `date`+`slotIdx`: availability is judged against the purohit's declared
   * working hours and their actual bookings, not against slot rows — which is
   * what allows a time the slot grid has no index for.
   */
  startsAt?: string | undefined;
  endsAt?: string | undefined;
  lat?: number | undefined;
  lng?: number | undefined;
  /**
   * How much `lat`/`lng` can be trusted. `city` means the city centroid — the same
   * point for every devotee in that city — so distance from it ranks purohits by
   * how central they live rather than how near they are to this family. Treated as
   * no location at all, which scores every candidate the same neutral 0.5 instead
   * of acting confidently on a coordinate nobody measured.
   */
  geoPrecision?: string | undefined;
  /** Preferred language. SCORED, never filtered — see the bonus below. */
  devoteeLocale?: string | undefined;
  maxPricePaise?: number | undefined;
  languages?: string[] | undefined;
  sort?: 'relevance' | 'price_asc' | 'rating_desc' | 'distance' | undefined;
  limit?: number | undefined;
}

export class SearchService {
  /**
   * The store signs the purohit's photo URL.
   *
   * Optional because search must keep working without object storage configured —
   * the photo is the one field that degrades to null rather than failing the whole
   * result, and a devotee with no photograph is a worse outcome than a devotee with
   * no purohit only if the search still returns one.
   */
  constructor(
    private readonly db: Db,
    private readonly store?: { presignDownload(a: { key: string }): Promise<string> },
  ) {}

  /**
   * Picks the purohit for a booking.
   *
   * The devotee no longer chooses from a grid. They could not evaluate those names
   * — "18 years" against "22 years" is not a decision a family can make about a
   * ceremony — so the choice added anxiety without adding information. The same
   * ranking that ordered the list now assigns the work: rating, proximity,
   * acceptance rate, price fit and experience, with a boost for new supply.
   *
   * Returns null rather than throwing, because "nobody is free then" is an ordinary
   * answer the booking flow has to render, not an error.
   *
   * `exclude` carries the purohits who have already declined this booking, so
   * re-match walks down the ranking instead of re-offering the same person.
   */
  async matchPandit(
    args: SearchArgs & { exclude?: string[]; bookingId?: string | undefined },
  ): Promise<PanditCard | null> {
    const ranked = await this.rankPandits({ ...args, limit: 25 });
    const skip = new Set(args.exclude ?? []);
    const chosen = ranked.find((p) => !skip.has(p.id)) ?? null;

    /*
     * Record what was decided, and what came close.
     *
     * ADR 0012: *"Matching is now load-bearing… A bug in the weights is a bug in
     * someone's livelihood. The weights need to be observable — log the chosen
     * purohit and the runner-up per booking."* This is that, and it is what lets a
     * purohit be told why they did or did not get work instead of guessing.
     *
     * Deliberately best-effort: a failure to write the audit row must never fail the
     * allocation. A booking that happened and was not logged is a gap in a diary;
     * a booking that did not happen because the diary was full is an outage.
     */
    if (args.bookingId) {
      try { await this.recordDecision(args, ranked, chosen?.id ?? null, skip); }
      catch { /* audit only — see above */ }
    }

    return chosen ? this.toCard(chosen) : null;
  }

  /**
   * One row per allocation, holding every candidate's score.
   *
   * The weights are snapshotted with it. They are constants today, but a decision
   * explained with today's weights against last month's allocation is a wrong
   * explanation — and the whole point of this table is to be able to answer "why".
   */
  private async recordDecision(
    args: SearchArgs & { bookingId?: string | undefined },
    ranked: RankedRow[],
    chosenId: string | null,
    skipped: Set<string>,
  ) {
    await this.db.insert(matchDecisions).values({
      id: ulid(),
      bookingId: args.bookingId!,
      ritualId: args.ritualId,
      chosenPanditId: chosenId,
      chosenScore: chosenId
        ? String(ranked.find((r) => r.id === chosenId)?.score ?? '')
        : null,
      weights: { ...W, newSupplyBonus: NEW_SUPPLY_BONUS, loadPenaltyPerJob: LOAD_PENALTY_PER_JOB },
      candidates: ranked.slice(0, CANDIDATES_LOGGED).map((r) => ({
        panditId: r.id,
        score: Number(r.score),
        bayesRating: Number(r.bayes_rating),
        distanceKm: r.distance_km,
        pricePaise: Number(r.price_paise),
        experienceYears: r.experience_years,
        newSupplyBoost: r.new_supply_boost_remaining > 0,
        // Declined this booking already, so they lost it to their own answer rather
        // than to their score — a distinction the dashboard has to be able to draw.
        declined: skipped.has(r.id),
      })),
    });
  }

  /** The devotee-facing projection. Unchanged; only its input moved. */
  private async toCard(r: RankedRow): Promise<PanditCard> {
    return (await this.cards([r]))[0]!;
  }

  /**
   * The ranked rows, scores included.
   *
   * Extracted from `searchPandits` so the allocation path can see the numbers it
   * decided on. ADR 0012 asked for exactly this and it was never built: *"the
   * weights need to be observable — log the chosen purohit and the runner-up per
   * booking"*. Without the scores leaving this method there is nothing to log, and a
   * bug in the weights is a bug in somebody's livelihood that nobody can see.
   *
   * `searchPandits` maps from this and its contract is unchanged, so the devotee
   * path is untouched.
   */
  async rankPandits(args: SearchArgs): Promise<RankedRow[]> {
    const limit = args.limit ?? 20;
    // A city-precision point is not a location for ranking purposes: see the field.
    const usable = args.geoPrecision === undefined || args.geoPrecision !== 'city';
    const lat = usable ? (args.lat ?? null) : null;
    const lng = usable ? (args.lng ?? null) : null;

    /*
     * Narrowed to codes the region package knows, then bound as a parameter.
     *
     * `languages` arrives off the query string as free text. Anything unrecognised
     * is dropped rather than passed to Postgres, which also means the filter is now
     * consistent with the column: profiles store locale codes, so a display name
     * like "Bengali" cannot match and should not be sent.
     */
    const langs = (args.languages ?? []).map((l) => l.trim().toLowerCase()).filter(isLocale);

    // Haversine in SQL. Null coordinates degrade to "no distance term" rather than
    // excluding the purohit, so a devotee without a saved address still gets results.
    const distanceKm = sql<number | null>`
      CASE WHEN ${lat}::float8 IS NULL OR pp.base_lat IS NULL THEN NULL ELSE
        ${n(EARTH_KM)} * 2 * asin(sqrt(
          power(sin(radians(pp.base_lat - ${lat}::float8) / 2), 2)
          + cos(radians(${lat}::float8)) * cos(radians(pp.base_lat))
          * power(sin(radians(pp.base_lng - ${lng}::float8) / 2), 2)
        ))
      END`;

    const bayesRating = sql<number>`
      (pp.rating_sum + ${n(PRIOR_MEAN)} * ${n(PRIOR_WEIGHT)})
      / NULLIF(pp.rating_count + ${n(PRIOR_WEIGHT)}, 0)`;

    const rows = await this.db.execute(sql`
      WITH candidates AS (
        SELECT
          u.id, u.name,
          pp.experience_years, pp.languages, pp.traditions,
          pp.rating_count, pp.service_radius_km,
          pp.new_supply_boost_remaining,
          pp.chanting_sample_url, pp.chanting_sample_label, pp.photo_key,
          pp.kyc_status,
          /*
           * Work already held, and when it was last handed out. Both are about
           * SPREADING allocation rather than ranking quality: the first pushes a
           * busy purohit down, the second decides ties without letting the planner's
           * row order quietly pick the same person every time.
           *
           * Only UPCOMING jobs count. Past work is not a reason to withhold the next
           * one; a full calendar this week is.
           */
          (SELECT count(*) FROM bookings b
            WHERE b.pandit_id = pp.user_id
              AND b.state IN ('pending_accept','confirmed','in_progress')
              AND b.slot_start_at >= now())::float8 AS upcoming_jobs,
          (SELECT max(b.created_at) FROM bookings b
            WHERE b.pandit_id = pp.user_id) AS last_assigned_at,
          ${bayesRating} AS bayes_rating,
          COALESCE(pp.acceptance_rate, 0.8)::float8 AS acceptance,
          pr.price_paise,
          ${distanceKm} AS distance_km
        FROM pandit_rituals pr
        JOIN pandit_profiles pp ON pp.user_id = pr.pandit_id
        JOIN users u ON u.id = pp.user_id
        JOIN cities c ON c.id = u.city_id AND c.slug = ${args.citySlug}
        WHERE pr.ritual_id = ${args.ritualId}
          AND pr.active
          AND pp.kyc_status = 'verified'
          AND u.deleted_at IS NULL
          ${args.maxPricePaise ? sql`AND pr.price_paise <= ${args.maxPricePaise}` : sql``}
          ${langs.length
            /*
             * Bound, not interpolated.
             *
             * This built the array with `sql.raw` and a hand-rolled sanitiser that
             * stripped single quotes from a value arriving straight off the query
             * string. It was probably safe — probably, resting on one `.replace`
             * that any future edit could weaken, in the one query that reads the
             * whole supply table. A bound parameter needs no argument about whether
             * it is safe. The values are also narrowed to known locales above, so
             * an unrecognised code is now an empty filter rather than a literal
             * spliced into SQL.
             */
            ? sql`AND pp.languages && ${langs}::text[]`
            : sql``}
      ),
      filtered AS (
        SELECT c.* FROM candidates c
        WHERE (c.distance_km IS NULL OR c.distance_km <= c.service_radius_km)
        ${args.startsAt && args.endsAt ? sql`
          /*
           * Time-based availability, from the one definition shared with
           * BookableTimesService - see domain/availability-window.ts. These two
           * answers are shown to the devotee one tap apart and must agree.
           */
          AND ${isFreeForWindow({
    panditId: sql`c.id`,
    startsAt: sql`${args.startsAt}::timestamptz`,
    endsAt: sql`${args.endsAt}::timestamptz`,
    tz: TZ_OF(args.citySlug),
  })}
        ` : args.date && args.slotIdx !== undefined ? sql`
          /*
           * Every slot in the span must be open, not just the first one. This
           * checked slot_idx alone, so a 2-slot ritual matched a purohit free for
           * only the FIRST slot - the booking then failed at lockAndBook after the
           * devotee had already paid attention to a name, a price and a promise.
           * Relational division: no slot in [slotIdx, slotIdx+span) may be without
           * an open row.
           */
          AND NOT EXISTS (
            SELECT 1 FROM generate_series(
              ${args.slotIdx}::int, ${args.slotIdx + (args.slotSpan ?? 1) - 1}::int
            ) AS need(idx)
            WHERE NOT EXISTS (
              SELECT 1 FROM availability a
               WHERE a.pandit_id = c.id
                 AND a.date = ${args.date}
                 AND a.slot_idx = need.idx
                 AND a.status = 'open'
            )
          )` : sql``}
      ),
      bounds AS (
        SELECT NULLIF(MAX(price_paise) - MIN(price_paise), 0)::float8 AS price_range,
               MIN(price_paise)::float8 AS price_min,
               NULLIF(MAX(COALESCE(distance_km, 0)), 0)::float8 AS max_dist
          FROM filtered
      )
      SELECT f.*,
        (
          ${n(W.rating)}      * (f.bayes_rating / 5.0)
        + ${n(W.proximity)}   * (CASE WHEN f.distance_km IS NULL OR b.max_dist IS NULL THEN 0.5
                                   ELSE 1 - (f.distance_km / b.max_dist) END)
        + ${n(W.acceptance)}  * f.acceptance
        + ${n(W.priceFit)}    * (CASE WHEN b.price_range IS NULL THEN 0.5
                                   ELSE 1 - ((f.price_paise - b.price_min) / b.price_range) END)
        -- Saturating at 25 years: the difference between 2 and 12 years matters,
        -- between 28 and 38 it does not, and a linear term would hand the whole
        -- marketplace to whoever has been doing this longest.
        + ${n(W.experience)}  * LEAST(f.experience_years::float8 / 25.0, 1.0)
        + CASE WHEN f.new_supply_boost_remaining > 0 THEN ${n(NEW_SUPPLY_BONUS)} ELSE 0 END
        -- Each upcoming job makes the next one a little less likely. See the
        -- comment on LOAD_PENALTY_PER_JOB: without this one purohit takes everything.
        - LEAST(f.upcoming_jobs * ${n(LOAD_PENALTY_PER_JOB)}, ${n(LOAD_PENALTY_CAP)})
        ${args.devoteeLocale
          ? sql`+ CASE WHEN ${args.devoteeLocale} = ANY(f.languages)
                       THEN ${n(LANGUAGE_BONUS)} ELSE 0 END`
          : sql``}
        ) AS score
      FROM filtered f CROSS JOIN bounds b
      ORDER BY ${sql.raw(
        args.sort === 'price_asc' ? 'f.price_paise ASC'
        : args.sort === 'rating_desc' ? 'f.bayes_rating DESC'
        : args.sort === 'distance' ? 'f.distance_km ASC NULLS LAST'
        /*
         * Ties are broken by who has waited longest, never by row order.
         *
         * `ORDER BY score DESC` alone leaves equal scores to the planner, which is
         * stable enough in practice to hand the same purohit every booking — and
         * with most of the weight identical across a young roster, exact ties are
         * the normal case rather than the edge one. `NULLS FIRST` puts a purohit
         * who has never been allocated anything at the front, which is also how a
         * new joiner gets a first booking at all.
         */
        : 'score DESC, last_assigned_at ASC NULLS FIRST, id',
      )}
      LIMIT ${limit}
    `);

    return ((rows as unknown as { rows?: unknown[] }).rows ?? rows) as RankedRow[];
  }

  async searchPandits(args: SearchArgs): Promise<PanditCard[]> {
    const list = await this.rankPandits(args);

    /*
     * `photoUrl` was hardcoded to null: the field has been on the contract since the
     * first commit and nothing ever filled it, so the booking screen fell back to
     * rendering the first letter of the purohit's name in a circle. Since ADR 0012
     * the devotee did not choose this person, so that letter was the only thing they
     * saw before the door opened.
     */
    return this.cards(list);
  }

  private async cards(list: RankedRow[]): Promise<PanditCard[]> {
    return Promise.all(list.map(async (r) => ({
      id: r.id,
      name: r.name ?? 'Purohit',
      photoUrl: r.photo_key && this.store
        ? await this.store.presignDownload({ key: r.photo_key })
        : null,
      /*
       * Derived from the row, not asserted.
       *
       * This was the literal `['id_verified']`, which is true for every result only
       * because the query filters `pp.kyc_status = 'verified'` two hundred lines
       * above. A claim about a purohit's verification that holds by coincidence of a
       * distant WHERE clause is one that starts lying the day the filter is relaxed —
       * to show `changes_requested` purohits, say — and it lies on the most
       * trust-bearing field a devotee sees.
       *
       * The ladder in `dashboard.service.ts` derives the same facts the same way, so
       * a purohit and a devotee are shown one answer rather than two.
       */
      badges: [
        ...(r.kyc_status === 'verified' ? ['id_verified'] : []),
        ...(r.chanting_sample_url ? ['chanting_sample'] : []),
        ...(r.photo_key ? ['photo'] : []),
      ],
      chantingSampleUrl: r.chanting_sample_url ?? null,
      chantingSampleLabel: r.chanting_sample_label ?? null,
      experienceYears: r.experience_years,
      languages: r.languages ?? [],
      traditions: r.traditions ?? [],
      // Show the raw count so a devotee can judge for themselves how much the
      // smoothed number is worth.
      rating: r.rating_count > 0 ? Math.round(Number(r.bayes_rating) * 10) / 10 : null,
      ratingCount: r.rating_count,
      pricePaise: Number(r.price_paise),
      distanceKm: r.distance_km === null ? null : Math.round(r.distance_km * 10) / 10,
      isNewPandit: r.new_supply_boost_remaining > 0,
      nextAvailable: null,
    })));
  }
}
