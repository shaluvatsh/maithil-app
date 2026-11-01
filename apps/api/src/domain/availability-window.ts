import { sql, type SQL } from 'drizzle-orm';

/**
 * "Is this purohit free for this window?" — in ONE place.
 *
 * This rule was written out twice, in SQL, in two services that must agree because
 * the product shows their answers one tap apart: `BookableTimesService.forDate`
 * renders the time picker's `purohitCount`, and `SearchService.rankPandits` produces
 * the "N pandits are free at this time" on the very next screen. Two copies of one
 * rule is two things to keep in step, and they did not stay in step — a missing pair
 * of query parameters meant the search copy was skipped entirely for months while
 * the picker's copy stayed correct, so the two screens disagreed and nothing failed.
 *
 * Both copies were character-for-character the same logic over the same two tables.
 * The only genuine difference was how each referred to the purohit and the window:
 * the picker joins a generated series and has them as COLUMNS, the search has them
 * as bound parameters. So they are arguments here, and the rule itself is written
 * once.
 *
 * THE STATES, and why they are not the exclusion constraint's states. The
 * `bookings_pandit_no_overlap` constraint (migration 0018) covers `confirmed` and
 * `in_progress` only, because that is the integrity rule: those are commitments that
 * may never double-book. Reading availability is a wider question — a
 * `pending_accept` hold is somebody mid-checkout and must not be offered to a second
 * devotee, and a `completed` booking still occupied that time. Index
 * `bookings_pandit_window_idx` (migration 0031) exists to serve exactly this list;
 * if it changes here, change it there too or the range stops being a seek.
 */
export const OCCUPYING_STATES = sql`('pending_accept','confirmed','in_progress','completed')`;

/**
 * The whole window sits inside one declared working window.
 *
 * A working window whose end is at or before its start crosses midnight, so it is
 * extended by a day on the closing side — the convention shift rosters use, and the
 * only way a purohit can offer the midnight Kali Puja the catalogue already sells.
 *
 * `AT TIME ZONE <iana>` throughout rather than a fixed offset: a naive timestamp cast
 * through `::timestamptz` resolves against the SERVER's TimeZone, which already
 * caused every window to come back 5h30m early once (06:00 hours offered as 00:30).
 */
export function withinWorkingHours(args: {
  /** SQL expression for the purohit's id — a column reference or a bound value. */
  panditId: SQL | string;
  /** SQL expressions for the window's two instants. */
  startsAt: SQL;
  endsAt: SQL;
  /** The city's IANA zone. */
  tz: string;
}): SQL {
  const { panditId, startsAt, endsAt, tz } = args;
  return sql`EXISTS (
    SELECT 1 FROM pandit_working_hours h
     WHERE h.pandit_id = ${panditId}
       AND h.weekday = EXTRACT(DOW FROM (${startsAt} AT TIME ZONE ${tz}))::int
       AND ${startsAt} >=
             ((date_trunc('day', ${startsAt} AT TIME ZONE ${tz}) + h.starts_at)
              AT TIME ZONE ${tz})
       AND ${endsAt} <=
             ((date_trunc('day', ${startsAt} AT TIME ZONE ${tz}) + h.ends_at)
              AT TIME ZONE ${tz})
             + CASE WHEN h.ends_at <= h.starts_at
                    THEN interval '1 day' ELSE interval '0' END
  )`;
}

/** Nothing already committed across the window. See `OCCUPYING_STATES`. */
export function notAlreadyBooked(args: {
  panditId: SQL | string;
  startsAt: SQL;
  endsAt: SQL;
}): SQL {
  const { panditId, startsAt, endsAt } = args;
  return sql`NOT EXISTS (
    SELECT 1 FROM bookings b
     WHERE b.pandit_id = ${panditId}
       AND b.state IN ${OCCUPYING_STATES}
       AND tstzrange(b.slot_start_at, b.slot_end_at) && tstzrange(${startsAt}, ${endsAt})
  )`;
}

/** Both halves of the rule, which is how every caller wants it. */
export function isFreeForWindow(args: {
  panditId: SQL | string;
  startsAt: SQL;
  endsAt: SQL;
  tz: string;
}): SQL {
  return sql`${withinWorkingHours(args)} AND ${notAlreadyBooked(args)}`;
}
