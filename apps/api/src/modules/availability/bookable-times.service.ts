import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { getRegion } from '@themaithil/region';
import { isFreeForWindow } from '../../domain/availability-window';

/** Minutes between offerable start times. See ADR 0013 for why 30 and not 15. */
export const STEP_MINUTES = 30;

export interface BookableTime {
  /** The instant the ritual would begin. */
  startsAt: string;
  endsAt: string;
  /** At least one verified purohit could take it. */
  available: boolean;
  /** How many could — the devotee is not shown this, but the UI copy uses it. */
  purohitCount: number;
}

/**
 * The times a devotee may actually choose, for one ritual on one date.
 *
 * Replaces the four fixed slots. Those could not express a muhurat that begins at
 * 11:15, could not express the midnight Kali Puja or the 04:00 Brahma muhurta the
 * catalogue already sells, and charged the purohit's travel constraint to the
 * devotee as a published 30-minute gap. See ADR 0013.
 *
 * A time is offered when at least one verified purohit who performs this ritual has
 * the WHOLE window inside their declared working hours and nothing else booked
 * across it. Travel feasibility is deliberately NOT evaluated here: at this point
 * in the flow the devotee has not chosen an address yet, so there is no venue to
 * measure a journey to. The authoritative check runs at confirmation, where the
 * address is known (`assertFeasible`), exactly as the existing "N pandits are free"
 * pre-check is refined by allocation today.
 */
export class BookableTimesService {
  constructor(private readonly db: Db) {}

  async forDate(args: {
    ritualId: string;
    citySlug: string;
    /** Local calendar date, `YYYY-MM-DD`. */
    date: string;
    durationMin: number;
  }): Promise<BookableTime[]> {
    const region = getRegion(args.citySlug);
    /*
     * The city's IANA zone, applied explicitly with `AT TIME ZONE`, rather than a
     * fixed offset cast through `::timestamptz`. That cast resolves a naive
     * timestamp using the SERVER's TimeZone — which here is `Asia/Kolkata`, not
     * UTC — so subtracting the offset first applied it twice and every window came
     * back 5h30m early: 06:00 working hours were offered as 00:30. `AT TIME ZONE`
     * states the intent and gives the same answer on any server.
     */
    const tz = region.timezone;

    /*
     * One query, not one per candidate time.
     *
     * `generate_series` walks the day in STEP_MINUTES from local midnight, and each
     * step is joined against the purohits who could take it. Doing this in JS would
     * mean 48 round trips per date — on the screen a devotee is actively waiting on.
     *
     * Times are built in the CITY's offset and compared as instants, so a window
     * that runs past midnight is a range like any other rather than a special case.
     */
    const rows = await this.db.execute(sql`
      WITH day_start AS (
        -- Local midnight on the requested date, as an instant.
        SELECT (${args.date}::date::timestamp AT TIME ZONE ${tz}) AS t0
      ),
      candidate AS (
        SELECT (SELECT t0 FROM day_start)
                 + make_interval(mins => s * ${STEP_MINUTES}) AS starts_at
          FROM generate_series(0, (24 * 60 / ${STEP_MINUTES}) - 1) AS s
      ),
      windowed AS (
        SELECT c.starts_at,
               c.starts_at + make_interval(mins => ${args.durationMin}) AS ends_at
          FROM candidate c
      )
      SELECT w.starts_at, w.ends_at,
             count(DISTINCT p.user_id)::int AS purohit_count
        FROM windowed w
        LEFT JOIN pandit_profiles p
          ON p.kyc_status = 'verified'
         AND EXISTS (
               SELECT 1 FROM pandit_rituals pr
                WHERE pr.pandit_id = p.user_id
                  AND pr.ritual_id = ${args.ritualId}
                  AND pr.active
             )
         /*
          * The one definition of "free for this window", shared with
          * SearchService.rankPandits - see domain/availability-window.ts for why
          * these two must not have separate copies.
          */
         AND ${isFreeForWindow({
    panditId: sql`p.user_id`,
    startsAt: sql`w.starts_at`,
    endsAt: sql`w.ends_at`,
    tz,
  })}
       GROUP BY w.starts_at, w.ends_at
       ORDER BY w.starts_at`);

    const list = ((rows as unknown as { rows?: unknown[] }).rows ?? rows) as Array<{
      starts_at: string; ends_at: string; purohit_count: number;
    }>;

    return list.map((r) => ({
      startsAt: new Date(r.starts_at).toISOString(),
      endsAt: new Date(r.ends_at).toISOString(),
      available: r.purohit_count > 0,
      purohitCount: r.purohit_count,
    }));
  }
}
