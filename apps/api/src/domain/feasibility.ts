import { sql } from 'drizzle-orm';
import type { Executor } from '../db/client';
import { estimateTravel } from './travel';
import type { GeoPrecision } from '../modules/booking/geocode.service';
import { DomainError, ErrorCode } from '@themaithil/contracts';

/** A purohit's neighbouring commitment, either side of a requested window. */
interface Neighbour {
  bookingId: string;
  endsAt: string;
  startsAt: string;
  /**
   * Null for a VIRTUAL booking, which has no venue. A video consultation imposes
   * no journey the platform can model — the purohit takes it from wherever they
   * are — so it contributes no travel constraint. Its TIME is still protected, by
   * the exclusion constraint rather than by this.
   */
  venue: { lat: number; lng: number; precision: GeoPrecision } | null;
}

export interface FeasibilityArgs {
  panditId: string;
  /** The window being requested, as instants. */
  startsAt: Date;
  endsAt: Date;
  /** Where this booking happens. */
  venue: { lat: number; lng: number; precision: GeoPrecision };
  citySlug: string;
}

/**
 * Can this purohit actually get to this job, and on to the next one?
 *
 * The question the slot grid never asked. Four fixed slots with a published
 * 30-minute gap treated turnaround as a constant, and `applyTravelBuffer` — the one
 * piece that was supposed to vary it — has never fired in production: it is guarded
 * by `travelMinutes <= region.travelGapMinutes` and its only caller passes a
 * hardcoded 25, which is below every city's gap. So a purohit has been bookable
 * back-to-back regardless of whether the two homes are 2 km or 25 km apart.
 *
 * This asks it properly, against the booking's own timestamps rather than a slot
 * index, which is why it works under the current slot model AND is what the
 * continuous-time model in ADR 0013 will keep using unchanged.
 *
 * MUST be called inside a transaction that already holds the purohit's advisory
 * lock (see `lockPurohit`). Without it two concurrent allocations each read a
 * picture of the day that does not include the other, both find themselves
 * feasible, and the exclusion constraint catches only the ones that literally
 * overlap — not the pair an hour apart across the city, which is the case this
 * exists to prevent.
 */
export async function assertFeasible(tx: Executor, args: FeasibilityArgs): Promise<void> {
  /*
   * Overlap first, explicitly.
   *
   * The exclusion constraint on `bookings` already makes an overlap impossible, but
   * it reports one as a raw Postgres error — a 500 reading "conflicting key value
   * violates exclusion constraint" where the devotee should see "someone booked
   * this while you were checking out". Checking here, under the same lock, keeps
   * the constraint as the backstop it is meant to be and the message as the one a
   * person can act on.
   */
  const clash = await tx.execute(sql`
    SELECT 1 FROM bookings
     WHERE pandit_id = ${args.panditId}
       AND state IN ('confirmed', 'in_progress')
       AND tstzrange(slot_start_at, slot_end_at)
           && tstzrange(${args.startsAt.toISOString()}, ${args.endsAt.toISOString()})
     LIMIT 1`);
  const clashRows = ((clash as { rows?: unknown[] }).rows ?? clash) as unknown[];
  if (clashRows.length > 0) {
    throw new DomainError(
      ErrorCode.SLOT_UNAVAILABLE,
      'one or more slots were taken while you were checking out',
      { reason: 'overlap' },
    );
  }

  const [prev, next] = await Promise.all([
    neighbourBefore(tx, args),
    neighbourAfter(tx, args),
  ]);

  if (prev?.venue) {
    const travel = estimateTravel({
      from: prev.venue,
      to: args.venue,
      citySlug: args.citySlug,
    });
    const readyAt = new Date(new Date(prev.endsAt).getTime() + travel.minutes * 60_000);
    if (readyAt > args.startsAt) {
      throw new DomainError(
        ErrorCode.SLOT_UNAVAILABLE,
        'this purohit cannot reach you in time from their previous booking',
        {
          reason: 'travel_from_previous',
          previousEndsAt: prev.endsAt,
          travelMinutes: travel.minutes,
          earliestPossibleStart: readyAt.toISOString(),
        },
      );
    }
  }

  if (next?.venue) {
    const travel = estimateTravel({
      from: args.venue,
      to: next.venue,
      citySlug: args.citySlug,
    });
    const arriveBy = new Date(args.endsAt.getTime() + travel.minutes * 60_000);
    if (arriveBy > new Date(next.startsAt)) {
      throw new DomainError(
        ErrorCode.SLOT_UNAVAILABLE,
        'this purohit could not reach their next booking in time from you',
        {
          reason: 'travel_to_next',
          nextStartsAt: next.startsAt,
          travelMinutes: travel.minutes,
          latestPossibleEnd: new Date(
            new Date(next.startsAt).getTime() - travel.minutes * 60_000,
          ).toISOString(),
        },
      );
    }
  }
}

/**
 * Serialises allocation for one purohit.
 *
 * Keyed on the purohit ALONE, not on `(purohit, date)`. A booking running
 * 23:40–02:40 has neighbours on both calendar days, and a date-keyed lock would put
 * it and the 03:30 job the next morning on different keys — so neither would see
 * the other and the travel rule would be evaluated against a stale picture. The
 * exclusion constraint would still catch a literal overlap; it cannot catch two
 * jobs fifty minutes apart across town, which is exactly what this guards.
 *
 * Transaction-scoped: released at COMMIT or ROLLBACK, never leaked.
 */
export async function lockPurohit(tx: Executor, panditId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${panditId}))`);
}

/** Live states only. A cancelled booking has released the purohit's time. */
const LIVE = sql`('pending_accept', 'confirmed', 'in_progress', 'completed')`;

async function neighbourBefore(
  tx: Executor, args: FeasibilityArgs,
): Promise<Neighbour | null> {
  const rows = await tx.execute(sql`
    SELECT b.id, b.slot_end_at, b.slot_start_at, a.lat, a.lng, a.geo_precision
      FROM bookings b
      LEFT JOIN addresses a ON a.id = b.address_id
     WHERE b.pandit_id = ${args.panditId}
       AND b.state IN ${LIVE}
       AND b.slot_end_at <= ${args.startsAt.toISOString()}
     ORDER BY b.slot_end_at DESC
     LIMIT 1`);
  return first(rows);
}

async function neighbourAfter(
  tx: Executor, args: FeasibilityArgs,
): Promise<Neighbour | null> {
  const rows = await tx.execute(sql`
    SELECT b.id, b.slot_end_at, b.slot_start_at, a.lat, a.lng, a.geo_precision
      FROM bookings b
      LEFT JOIN addresses a ON a.id = b.address_id
     WHERE b.pandit_id = ${args.panditId}
       AND b.state IN ${LIVE}
       AND b.slot_start_at >= ${args.endsAt.toISOString()}
     ORDER BY b.slot_start_at ASC
     LIMIT 1`);
  return first(rows);
}

function first(res: unknown): Neighbour | null {
  const rows = ((res as { rows?: unknown[] }).rows ?? res) as Array<{
    id: string; slot_end_at: string; slot_start_at: string;
    lat: number | null; lng: number | null; geo_precision: GeoPrecision;
  }>;
  const r = rows[0];
  if (!r) return null;
  return {
    bookingId: r.id,
    endsAt: r.slot_end_at,
    startsAt: r.slot_start_at,
    venue: r.lat === null || r.lng === null
      ? null
      : { lat: r.lat, lng: r.lng, precision: r.geo_precision },
  };
}
