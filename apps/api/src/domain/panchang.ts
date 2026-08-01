/**
 * Panchang slot annotation. Pure interval maths.
 *
 * The prototype hardcoded Rahu Kaal to a weekday lookup table. That is wrong twice
 * over: Rahu Kaal depends on the actual sunrise/sunset for the date and location,
 * and its overlap with a booking slot is an interval intersection, not a day match.
 */

export interface Interval { startsAt: Date; endsAt: Date }

export const overlaps = (a: Interval, b: Interval): boolean =>
  a.startsAt < b.endsAt && b.startsAt < a.endsAt;

export const contains = (outer: Interval, inner: Interval): boolean =>
  outer.startsAt <= inner.startsAt && outer.endsAt >= inner.endsAt;

/** Milliseconds of overlap. Used to rank "how much of this slot is Rahu Kaal". */
export const overlapMs = (a: Interval, b: Interval): number =>
  Math.max(0, Math.min(a.endsAt.getTime(), b.endsAt.getTime())
             - Math.max(a.startsAt.getTime(), b.startsAt.getTime()));

export interface SlotAnnotation {
  containsAbhijit: boolean;
  overlapsRahuKaal: boolean;
  rahuOverlapMinutes: number;
}

export function annotateSlot(
  slot: Interval,
  abhijit: Interval | null,
  rahuKaal: Interval | null,
): SlotAnnotation {
  const rahu = rahuKaal && overlaps(slot, rahuKaal) ? overlapMs(slot, rahuKaal) : 0;
  return {
    // "Best time" means the auspicious window falls inside the slot, so the purohit
    // can actually perform the sankalp within it.
    containsAbhijit: abhijit ? contains(slot, abhijit) : false,
    overlapsRahuKaal: rahu > 0,
    rahuOverlapMinutes: Math.round(rahu / 60000),
  };
}

/**
 * Abhijit muhurta: the 8th of 15 equal muhurtas between sunrise and sunset,
 * roughly midday. Computed rather than fetched, since it is pure geometry once we
 * have sunrise/sunset - and sunrise/sunset is the one panchang value both schools agree on.
 */
export function abhijitWindow(sunrise: Date, sunset: Date): Interval {
  const dayMs = sunset.getTime() - sunrise.getTime();
  const muhurtaMs = dayMs / 15;
  return {
    startsAt: new Date(sunrise.getTime() + muhurtaMs * 7),
    endsAt: new Date(sunrise.getTime() + muhurtaMs * 8),
  };
}

/**
 * Rahu Kaal: one eighth of the day, at a weekday-dependent POSITION - the position
 * is by weekday, but the duration and boundaries derive from actual sunrise/sunset.
 * Index by JS getDay(): Sunday = 0.
 */
const RAHU_SEGMENT_BY_WEEKDAY = [8, 2, 7, 5, 6, 4, 3] as const;

export function rahuKaalWindow(sunrise: Date, sunset: Date, weekday: number): Interval {
  const eighth = (sunset.getTime() - sunrise.getTime()) / 8;
  const segment = RAHU_SEGMENT_BY_WEEKDAY[weekday] ?? 1;
  return {
    startsAt: new Date(sunrise.getTime() + eighth * (segment - 1)),
    endsAt: new Date(sunrise.getTime() + eighth * segment),
  };
}
