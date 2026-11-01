import { eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { panditProfiles } from '../../db/schema/index';
import { DomainError, ErrorCode } from '@themaithil/contracts';

/**
 * The purohit's own view of their practice.
 *
 * NOT A LEADERBOARD, and that is a decision rather than an omission. Since ADR 0012
 * the platform ALLOCATES work: a purohit cannot win a ranking against their peers
 * because they do not compete for the booking, the matcher assigns it. Publishing
 * such a ranking would tell whoever is top that they are winning and tell everyone
 * in eighth place to leave — accelerating exactly the concentration ADR 0012 warned
 * about, where a few purohits take everything and the rest stop maintaining their
 * calendars. ADR 0016 refused public karma on the community surface for the same
 * reason; a purohit leaderboard two screens away would contradict it.
 *
 * So: no other purohit is ever named here. Comparison is to a COHORT — "half the
 * purohits in your city take over 40 minutes to accept" — which carries the same
 * motivation, is actionable, and cannot be gamed by anyone.
 *
 * Everything below answers a question a purohit actually asks, in the order they ask
 * it: what am I doing today, what am I owed, and why is my work what it is.
 */

/** A week, for the "this period" numbers. Named because it appears in the copy. */
const PERIOD_DAYS = 7;
/**
 * Fewer than this in a cohort and the comparison is not anonymous.
 *
 * With three purohits doing Annaprashan in a city, "you are below the median" names
 * someone. Below the floor we return nulls and say nothing rather than leak a
 * neighbour's performance through a statistic.
 */
const COHORT_MIN = 5;

/**
 * The smallest number of OTHER PEOPLE'S bookings a neighbourhood count may disclose.
 *
 * `addresses` holds real households. A purohit who can see "1 puja in 700029" can
 * work out which family booked a shraddha there — the addresses are in their own
 * city and the tithi narrows the date. That is the same harm the community identity
 * split exists to prevent, arriving through a statistic instead of a name.
 *
 * Deliberately a constant and NOT configuration, unlike the demand window beside it.
 * The window is a tuning question; this is a privacy floor, and a floor somebody can
 * lower with an environment variable is not a floor.
 */
const DEMAND_MIN_OTHERS = 5;

/*
 * THE LADDER's thresholds.
 *
 * Every one of these is stated to the purohit — "three more pujas", "two more rated
 * above four and a half" — because a badge whose criterion is not stated is either a
 * mystery or an insult depending on whether you have it. That rule is why each number
 * here has a reason rather than a round shape.
 */

/** Enough completed work that the rating means something. */
const PUJAS_FOR_EXPERIENCE = 10;
/**
 * Reviews needed before a rating is shown as a standing.
 *
 * Five, matching the Bayesian prior's spirit in `search.service.ts`: two five-star
 * reviews is not a record, and a badge awarded on it would be one a purohit loses by
 * doing more work.
 */
const REVIEWS_FOR_RATING = 5;
const RATING_FOR_BADGE = 4.5;
/**
 * Samagri is rated separately from the purohit (see `reviews`), so it earns its own
 * rung — and a bad kit must never read as the person's failure.
 */
const SAMAGRI_REVIEWS_NEEDED = 3;
/** Answers that were endorsed by a peer, not merely posted. */
const ENDORSED_ANSWERS_FOR_VOICE = 3;

export interface DashboardOptions {
  /** `BOOKING_HORIZON_DAYS`, for the upcoming-work window. */
  horizonDays: number;
  /** `PUROHIT_DEMAND_WINDOW_DAYS`, how far back demand is measured. */
  demandWindowDays: number;
}

export class DashboardService {
  constructor(
    private readonly db: Db,
    private readonly payouts: { preview(panditId: string): Promise<{
      grossPaise: number; duesPaise: number; tdsCarryPaise: number;
      alreadyPaidPaise: number; netPayablePaise: number;
    }> },
    /*
     * What the community surface knows about this purohit, as a bound capability.
     *
     * ADR 0014 requires the community context to stay droppable — you must be able to
     * DROP those tables and still take a booking. A direct read from here would make
     * the purohit dashboard depend on them, so the one fact the ladder needs arrives
     * as a function instead. Same shape as `hasCompletedBooking` on CommunityService,
     * pointing the other way.
     */
    private readonly community: {
      endorsedAnswers(panditId: string): Promise<number>;
    },
    private readonly opts: DashboardOptions,
  ) {}

  async forPandit(panditId: string) {
    const profile = (await this.db.select().from(panditProfiles)
      .where(eq(panditProfiles.userId, panditId)).limit(1))[0];
    if (!profile) throw new DomainError(ErrorCode.NOT_FOUND, 'no purohit profile');

    const [money, work, allocation, cohort, demand, ladder] = await Promise.all([
      this.money(panditId, profile),
      this.work(panditId),
      this.allocation(panditId),
      this.cohort(panditId),
      this.demand(panditId),
      this.ladder(panditId, profile),
    ]);

    return {
      standing: {
        /** The raw average, for them. The RANKING uses a Bayesian prior — see search. */
        rating: profile.ratingCount > 0
          ? Math.round((profile.ratingSum / profile.ratingCount) * 10) / 10
          : null,
        ratingCount: profile.ratingCount,
        acceptanceRate: profile.acceptanceRate === null
          ? null : Number(profile.acceptanceRate),
        experienceYears: profile.experienceYears,
        kycStatus: profile.kycStatus,
        /**
         * Surfaced because it is a temporary advantage they should know is finite.
         * A purohit who thinks their work rate is normal, and then watches it fall
         * when the boost runs out, concludes the platform turned against them.
         */
        newSupplyBoostRemaining: profile.newSupplyBoostRemaining,
      },
      money,
      work,
      allocation,
      cohort,
      demand,
      ladder,
      /**
       * Things that silently stop work, each with the fix.
       *
       * A purohit whose cash jobs were switched off, or whose payout account was
       * never linked, currently discovers it by their income stopping. Every entry
       * here is a state the system already knows about and never tells them.
       */
      attention: this.attention(profile, money),
    };
  }

  /**
   * WHERE THE WORK IS, by neighbourhood.
   *
   * The most actionable thing on the dashboard: it converts directly into two
   * decisions a purohit can make this afternoon — widen the service radius, or open a
   * slot. Measured over recent bookings because upcoming ones are already allocated
   * and therefore not opportunity.
   *
   * Bucketed by the address PINCODE rather than by its coordinate, and distance is
   * measured from the pincode centroid. That is both more accurate and the only
   * honest option: an address with `city` precision carries the city centroid, so
   * distances computed from it would put every unlocated booking in whichever
   * neighbourhood happens to sit in the middle of town and send purohits there.
   *
   * PRIVACY IS THE HARD PART. See `DEMAND_MIN_OTHERS`: a small count in a named
   * pincode identifies a household. A bucket is disclosed only when it contains at
   * least that many bookings that are not the purohit's own — their own are their own
   * data and are always shown, which is why `yours` is reported separately rather
   * than folded into a single suppressed total.
   */
  async demand(panditId: string) {
    const rows = await this.db.execute(sql`
      WITH me AS (
        SELECT pp.base_lat, pp.base_lng, pp.service_radius_km, u.city_id
          FROM pandit_profiles pp
          JOIN users u ON u.id = pp.user_id
         WHERE pp.user_id = ${panditId}
      ),
      demand AS (
        SELECT a.pincode,
               count(*)::int AS total,
               -- Their own, so the two can be told apart at disclosure time.
               count(*) FILTER (WHERE b.pandit_id = ${panditId})::int AS mine
          FROM bookings b
          JOIN addresses a ON a.id = b.address_id
         WHERE b.city_id = (SELECT city_id FROM me)
           AND b.created_at >= now() - ${`${this.opts.demandWindowDays} days`}::interval
           AND b.state IN ('confirmed', 'in_progress', 'completed', 'reviewed')
         GROUP BY a.pincode
      )
      SELECT d.pincode, d.total, d.mine,
             m.service_radius_km,
             CASE WHEN m.base_lat IS NULL OR pc.lat IS NULL THEN NULL ELSE
               6371 * 2 * asin(sqrt(
                 power(sin(radians(pc.lat - m.base_lat) / 2), 2)
                 + cos(radians(m.base_lat)) * cos(radians(pc.lat))
                 * power(sin(radians(pc.lng - m.base_lng) / 2), 2)))
             END AS distance_km
        FROM demand d
        CROSS JOIN me m
        LEFT JOIN pincode_centroids pc ON pc.pincode = d.pincode
       ORDER BY d.total DESC, d.pincode`);

    const list = ((rows as unknown as { rows?: unknown[] }).rows ?? rows) as Array<{
      pincode: string; total: number; mine: number;
      service_radius_km: number; distance_km: number | null;
    }>;

    const radiusKm = list[0]?.service_radius_km ?? null;

    const areas = list.map((r) => {
      const others = r.total - r.mine;
      const disclosable = others === 0 || others >= DEMAND_MIN_OTHERS;
      const distanceKm = r.distance_km === null
        ? null : Math.round(r.distance_km * 10) / 10;
      return {
        pincode: r.pincode,
        /** Null when disclosing it would expose too few other households. */
        bookings: disclosable ? r.total : null,
        yours: r.mine,
        /** True when the total is withheld. `yours` is still exact. */
        suppressed: !disclosable,
        distanceKm,
        /**
         * Null rather than false when we cannot measure it. A purohit told an area
         * is "outside your radius" on a distance we never computed would widen their
         * radius for nothing — or worse, narrow it.
         */
        covered: distanceKm === null || radiusKm === null
          ? null : distanceKm <= radiusKm,
      };
    });

    return {
      windowDays: this.opts.demandWindowDays,
      serviceRadiusKm: radiusKm,
      /** Ordered by demand, so the first row is the one worth acting on. */
      areas,
      /**
       * Areas with real demand that this purohit does not reach. The one list on the
       * dashboard that names a specific, profitable change.
       */
      uncovered: areas.filter((a) => a.covered === false && a.bookings !== null),
    };
  }

  /**
   * THE LADDER — what they have earned, and what the next rung costs.
   *
   * Derived on every read, never stored. `pandit_profiles.badges` exists as a jsonb
   * column and this deliberately does not write to it: a stored badge is a second copy
   * of a fact the database already holds, and the copy is the one that goes stale. A
   * purohit who uploads a chanting sample should see that rung turn the moment they do,
   * not when a job next runs.
   *
   * EVERY RUNG STATES ITS CRITERION, and that is a rule rather than a nicety. An
   * unexplained badge is a mystery to the person who has it and an insult to the
   * person who does not — and the ones here are all things a purohit can act on this
   * afternoon, which is the only reason to show them a ladder at all.
   *
   * Codes, not sentences: the copy is translated client-side, because a purohit
   * reading Bengali should not be told how to improve their standing in English.
   */
  async ladder(panditId: string, profile: {
    kycStatus: string; photoKey: string | null; chantingSampleUrl: string | null;
    linkedAccountId: string | null; cashJobsEnabled: boolean;
    highestQualification: string | null;
  }) {
    const rows = await this.db.execute(sql`
      SELECT
        (SELECT count(*) FROM bookings b
          WHERE b.pandit_id = ${panditId}
            AND b.state IN ('completed', 'reviewed'))::int AS completed,
        (SELECT count(*) FROM reviews r
           JOIN bookings b2 ON b2.id = r.booking_id
          WHERE b2.pandit_id = ${panditId}
            AND r.author = 'devotee' AND r.pandit_stars IS NOT NULL
            AND r.published_at IS NOT NULL)::int AS rated,
        (SELECT COALESCE(AVG(r.pandit_stars), 0) FROM reviews r
           JOIN bookings b3 ON b3.id = r.booking_id
          WHERE b3.pandit_id = ${panditId}
            AND r.author = 'devotee' AND r.pandit_stars IS NOT NULL
            AND r.published_at IS NOT NULL)::float8 AS avg_stars,
        (SELECT count(*) FROM reviews r
           JOIN bookings b4 ON b4.id = r.booking_id
          WHERE b4.pandit_id = ${panditId}
            AND r.samagri_stars IS NOT NULL AND r.published_at IS NOT NULL)::int
          AS samagri_rated,
        (SELECT COALESCE(AVG(r.samagri_stars), 0) FROM reviews r
           JOIN bookings b5 ON b5.id = r.booking_id
          WHERE b5.pandit_id = ${panditId}
            AND r.samagri_stars IS NOT NULL AND r.published_at IS NOT NULL)::float8
          AS avg_samagri`);

    const c = (((rows as unknown as { rows?: unknown[] }).rows ?? rows) as Array<{
      completed: number; rated: number; avg_stars: number;
      samagri_rated: number; avg_samagri: number;
    }>)[0]!;

    const endorsed = await this.community.endorsedAnswers(panditId);

    const step = (
      code: string, earned: boolean, have?: number, need?: number,
    ) => ({
      code,
      earned,
      // Progress only where there is something to count. A yes/no rung showing
      // "0 of 1" reads as a score rather than as a task.
      progress: have === undefined || need === undefined ? null : { have, need },
    });

    return [
      step('verified', profile.kycStatus === 'verified'),
      // A card with a letter in a circle instead of a face is the weakest thing a
      // devotee sees, and they did not choose this purohit (ADR 0012).
      step('photo', profile.photoKey !== null),
      // Devotees judge shuddha uchcharan and no competitor lets them hear it.
      step('chanting_sample', profile.chantingSampleUrl !== null),
      step('payout_linked', profile.linkedAccountId !== null),
      step('cash_enabled', profile.cashJobsEnabled),
      step('qualification', profile.highestQualification !== null),
      step(
        'ten_pujas', c.completed >= PUJAS_FOR_EXPERIENCE,
        Math.min(c.completed, PUJAS_FOR_EXPERIENCE), PUJAS_FOR_EXPERIENCE,
      ),
      step(
        'well_rated',
        c.rated >= REVIEWS_FOR_RATING && c.avg_stars >= RATING_FOR_BADGE,
        Math.min(c.rated, REVIEWS_FOR_RATING), REVIEWS_FOR_RATING,
      ),
      step(
        'samagri_accurate',
        c.samagri_rated >= SAMAGRI_REVIEWS_NEEDED && c.avg_samagri >= RATING_FOR_BADGE,
        Math.min(c.samagri_rated, SAMAGRI_REVIEWS_NEEDED), SAMAGRI_REVIEWS_NEEDED,
      ),
      // Endorsed, not merely posted: anybody can write an answer, and a peer putting
      // their name to it is the part that means something. ADR 0014's supply-retention
      // argument, made visible.
      step(
        'community_voice', endorsed >= ENDORSED_ANSWERS_FOR_VOICE,
        Math.min(endorsed, ENDORSED_ANSWERS_FOR_VOICE), ENDORSED_ANSWERS_FOR_VOICE,
      ),
    ];
  }

  private async money(panditId: string, profile: { cashCreditLimitPaise: number }) {
    const preview = await this.payouts.preview(panditId);
    return {
      ...preview,
      /**
       * Cash headroom, which is the single most opaque thing in the product.
       *
       * `cashCreditLimitPaise` stops a purohit being offered cash jobs once their
       * outstanding dues reach it, and nothing has ever told them so. Their work
       * simply thins out.
       */
      cashLimitPaise: profile.cashCreditLimitPaise,
      cashHeadroomPaise: Math.max(0, profile.cashCreditLimitPaise - preview.duesPaise),
    };
  }

  /** Today, and what is booked ahead. Absolute instants, so no slot arithmetic. */
  private async work(panditId: string) {
    const rows = await this.db.execute(sql`
      SELECT
        count(*) FILTER (
          WHERE state IN ('confirmed', 'in_progress')
            AND slot_start_at >= date_trunc('day', now())
            AND slot_start_at <  date_trunc('day', now()) + interval '1 day'
        )::int AS today,
        count(*) FILTER (
          WHERE state IN ('confirmed', 'in_progress') AND slot_start_at >= now()
        )::int AS upcoming,
        count(*) FILTER (WHERE state = 'pending_accept' AND accept_deadline_at > now())::int
          AS awaiting_accept,
        count(*) FILTER (
          WHERE state IN ('completed', 'reviewed')
            AND completed_at >= now() - ${`${PERIOD_DAYS} days`}::interval
        )::int AS completed_this_period,
        count(*) FILTER (
          WHERE state = 'cancelled_pandit'
            AND cancelled_at >= now() - ${`${PERIOD_DAYS} days`}::interval
        )::int AS dropped_this_period
      FROM bookings
       WHERE pandit_id = ${panditId}`);
    const r = (((rows as unknown as { rows?: unknown[] }).rows ?? rows) as Array<{
      today: number; upcoming: number; awaiting_accept: number;
      completed_this_period: number; dropped_this_period: number;
    }>)[0]!;
    /*
     * Named explicitly rather than spread.
     *
     * Spreading the row leaked the SQL aliases — `awaiting_accept` beside
     * `periodDays` — so the response was half snake_case and half camel. A client
     * then has to know which convention each field happens to use, which is the kind
     * of thing that is discovered by a typo in production.
     */
    return {
      today: r.today,
      upcoming: r.upcoming,
      awaitingAccept: r.awaiting_accept,
      completedThisPeriod: r.completed_this_period,
      droppedThisPeriod: r.dropped_this_period,
      periodDays: PERIOD_DAYS,
      horizonDays: this.opts.horizonDays,
    };
  }

  /**
   * WHY THEY ARE GETTING THE WORK THEY ARE GETTING.
   *
   * The whole reason `match_decisions` exists (ADR 0012: *"the weights need to be
   * observable"*). Three numbers, from rows that could not be produced before:
   *
   *   offered      — allocations that named them
   *   nearMiss     — allocations where they were a candidate and someone else won
   *   declinedAway — allocations they lost to their own decline, not to their score
   *
   * The third matters more than it looks. Telling a purohit they were "outranked" on
   * a booking they turned down is both wrong and insulting, and it is the mistake a
   * naive query makes.
   */
  private async allocation(panditId: string) {
    const rows = await this.db.execute(sql`
      SELECT
        count(*) FILTER (WHERE chosen_pandit_id = ${panditId})::int AS offered,
        count(*) FILTER (
          WHERE chosen_pandit_id IS DISTINCT FROM ${panditId}
            AND EXISTS (
              SELECT 1 FROM jsonb_array_elements(candidates) AS cand
               WHERE cand->>'panditId' = ${panditId}
                 AND COALESCE((cand->>'declined')::boolean, false) = false
            )
        )::int AS near_miss,
        count(*) FILTER (
          WHERE EXISTS (
            SELECT 1 FROM jsonb_array_elements(candidates) AS cand
             WHERE cand->>'panditId' = ${panditId}
               AND COALESCE((cand->>'declined')::boolean, false) = true
          )
        )::int AS declined_away
      FROM match_decisions
       WHERE created_at >= now() - ${`${PERIOD_DAYS} days`}::interval`);
    const r = (((rows as unknown as { rows?: unknown[] }).rows ?? rows) as Array<{
      offered: number; near_miss: number; declined_away: number;
    }>)[0]!;

    /*
     * Their own score components from the most recent allocation they featured in.
     *
     * Not an average: an average of scores computed against different candidate pools
     * is not a number that means anything. The latest one is a real decision they can
     * be shown line by line.
     */
    const latest = await this.db.execute(sql`
      SELECT cand AS entry, weights, created_at
        FROM match_decisions m,
             jsonb_array_elements(m.candidates) AS cand
       WHERE cand->>'panditId' = ${panditId}
       ORDER BY m.created_at DESC
       LIMIT 1`);
    const l = (((latest as unknown as { rows?: unknown[] }).rows ?? latest) as Array<{
      entry: Record<string, unknown>; weights: Record<string, unknown>; created_at: string;
    }>)[0];

    return {
      periodDays: PERIOD_DAYS,
      offered: r.offered,
      nearMiss: r.near_miss,
      declinedAway: r.declined_away,
      lastScored: l
        ? { at: l.created_at, components: l.entry, weights: l.weights }
        : null,
    };
  }

  /**
   * The cohort, and only ever as an aggregate.
   *
   * Purohits in the same city, so the comparison is against people working the same
   * market. Suppressed entirely below `COHORT_MIN`, because with four peers a median
   * names one of them — and a purohit reading their neighbour's acceptance rate out
   * of a statistic is a privacy failure whether or not anyone intended it.
   */
  private async cohort(panditId: string) {
    const rows = await this.db.execute(sql`
      WITH peers AS (
        SELECT pp.acceptance_rate::float8 AS acceptance,
               CASE WHEN pp.rating_count > 0
                    THEN pp.rating_sum::float8 / pp.rating_count ELSE NULL END AS rating
          FROM pandit_profiles pp
          JOIN users u ON u.id = pp.user_id
         WHERE pp.kyc_status = 'verified'
           AND u.city_id = (SELECT city_id FROM users WHERE id = ${panditId})
      )
      SELECT count(*)::int AS n,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY acceptance) AS median_acceptance,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY rating) AS median_rating
        FROM peers`);
    const r = (((rows as unknown as { rows?: unknown[] }).rows ?? rows) as Array<{
      n: number; median_acceptance: number | null; median_rating: number | null;
    }>)[0]!;

    if (r.n < COHORT_MIN) {
      return { size: r.n, suppressed: true, medianAcceptance: null, medianRating: null };
    }
    return {
      size: r.n,
      suppressed: false,
      medianAcceptance: r.median_acceptance,
      medianRating: r.median_rating === null
        ? null : Math.round(r.median_rating * 10) / 10,
    };
  }

  /**
   * What is quietly costing them work, with the remedy in the same object.
   *
   * Every item is a state the system has always known and never mentioned. A code
   * rather than a sentence, so the copy is translated client-side — a purohit
   * reading Bengali should not be told why their income stopped in English.
   */
  private attention(
    profile: {
      kycStatus: string; cashJobsEnabled: boolean; linkedAccountId: string | null;
      autoAccept: boolean; chantingSampleUrl: string | null;
    },
    money: { netPayablePaise: number; cashHeadroomPaise: number; cashLimitPaise: number },
  ) {
    const out: Array<{ code: string; severity: 'blocking' | 'advice' }> = [];

    if (profile.kycStatus !== 'verified') out.push({ code: 'kyc_incomplete', severity: 'blocking' });
    // Earnings with nowhere to send them: PAYOUT_ACCOUNT_MISSING, seen before
    // payout day rather than on it.
    if (!profile.linkedAccountId && money.netPayablePaise > 0) {
      out.push({ code: 'payout_account_missing', severity: 'blocking' });
    }
    if (!profile.cashJobsEnabled) out.push({ code: 'cash_jobs_paused', severity: 'blocking' });
    // Approaching the limit is the actionable moment; reaching it is too late.
    if (profile.cashJobsEnabled && money.cashLimitPaise > 0
        && money.cashHeadroomPaise <= money.cashLimitPaise / 5) {
      out.push({ code: 'cash_headroom_low', severity: 'advice' });
    }
    if (!profile.autoAccept) out.push({ code: 'auto_accept_off', severity: 'advice' });
    // Devotees judge shuddha uchcharan and no competitor lets them hear it.
    if (!profile.chantingSampleUrl) out.push({ code: 'no_chanting_sample', severity: 'advice' });

    return out;
  }
}
