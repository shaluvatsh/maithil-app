import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import type { PanditCard } from '@themaithil/contracts';
import { isLocale } from '@themaithil/region';

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
 * These are compile-time constants, so they are inlined into the SQL rather than
 * bound as parameters. A bound numeric literal arrives as type `unknown`, and
 * Postgres then refuses `unknown * unknown` as ambiguous.
 */
const n = (x: number) => sql.raw(x.toString());

export interface SearchArgs {
  ritualId: string;
  citySlug: string;
  date?: string | undefined;
  slotIdx?: number | undefined;
  /** How many contiguous slots the ritual needs, starting at slotIdx. Default 1. */
  slotSpan?: number | undefined;
  lat?: number | undefined;
  lng?: number | undefined;
  maxPricePaise?: number | undefined;
  languages?: string[] | undefined;
  sort?: 'relevance' | 'price_asc' | 'rating_desc' | 'distance' | undefined;
  limit?: number | undefined;
}

export class SearchService {
  constructor(private readonly db: Db) {}

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
    args: SearchArgs & { exclude?: string[] },
  ): Promise<PanditCard | null> {
    const ranked = await this.searchPandits({ ...args, limit: 25 });
    const skip = new Set(args.exclude ?? []);
    return ranked.find((p) => !skip.has(p.id)) ?? null;
  }

  async searchPandits(args: SearchArgs): Promise<PanditCard[]> {
    const limit = args.limit ?? 20;
    const lat = args.lat ?? null;
    const lng = args.lng ?? null;

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
          pp.chanting_sample_url, pp.chanting_sample_label,
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
        ${args.date && args.slotIdx !== undefined ? sql`
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
        ) AS score
      FROM filtered f CROSS JOIN bounds b
      ORDER BY ${sql.raw(
        args.sort === 'price_asc' ? 'f.price_paise ASC'
        : args.sort === 'rating_desc' ? 'f.bayes_rating DESC'
        : args.sort === 'distance' ? 'f.distance_km ASC NULLS LAST'
        : 'score DESC',
      )}
      LIMIT ${limit}
    `);

    const list = ((rows as unknown as { rows?: unknown[] }).rows ?? rows) as Array<{
      id: string; name: string | null; experience_years: number;
      languages: string[]; traditions: string[]; rating_count: number;
      bayes_rating: string; price_paise: string; distance_km: number | null;
      new_supply_boost_remaining: number;
      chanting_sample_url: string | null;
      chanting_sample_label: string | null;
    }>;

    return list.map((r) => ({
      id: r.id,
      name: r.name ?? 'Purohit',
      photoUrl: null,
      badges: ['id_verified'],
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
    }));
  }
}
