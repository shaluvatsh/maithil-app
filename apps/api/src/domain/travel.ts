import { getRegion } from '@themaithil/region';
import type { GeoPrecision } from '../modules/booking/geocode.service';

const EARTH_KM = 6371;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in km. The same formula `search.service.ts` ranks with. */
export function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return EARTH_KM * 2 * Math.asin(Math.sqrt(h));
}

/**
 * Slack ADDED for a coarse coordinate — not a competing floor.
 *
 * A `city`-precision point is the city's centroid, so two addresses in one city are
 * literally the same point and the distance between them computes to zero: a number
 * that is not merely imprecise but actively false. A `pincode` point is good to a
 * couple of km. Neither may be trusted at face value, and the direction of the error
 * matters — under-estimating travel makes a purohit late for a muhurat, which is the
 * failure that costs a family their ceremony.
 *
 * Added rather than maxed, deliberately. As a floor it did nothing wherever the
 * region's own minimum already matched it — Kolkata's turnaround is 30 minutes and
 * so was the city-precision floor, so `max` returned 30 either way and an address
 * we could not locate got exactly as much room as one we could. Uncertainty about
 * WHERE has to cost something on top of the time the journey takes.
 */
const PRECISION_SLACK_MINUTES: Record<GeoPrecision, number> = {
  exact: 0,
  pincode: 10,
  city: 30,
};

export interface TravelEstimate {
  minutes: number;
  km: number;
  /** The weakest precision of the two endpoints — what the estimate is worth. */
  precision: GeoPrecision;
}

const WEAKEST: GeoPrecision[] = ['exact', 'pincode', 'city'];
const weaker = (a: GeoPrecision, b: GeoPrecision): GeoPrecision =>
  WEAKEST.indexOf(a) >= WEAKEST.indexOf(b) ? a : b;

/**
 * Door-to-door travel time between two addresses, in minutes.
 *
 * Straight-line distance over an average city speed, then floored — by the region's
 * minimum turnaround (parking, packing samagri, greeting the family) and by how
 * much the coordinates can be trusted. Never a Maps call: ranking a candidate set
 * per booking would bill per origin-destination pair, which is the cost the search
 * path already refuses to take on (see `search.service.ts`).
 *
 * Deliberately conservative in both terms. It is better to leave a purohit idle
 * than to promise a family someone who arrives an hour into their muhurat.
 */
export function estimateTravel(args: {
  from: { lat: number; lng: number; precision: GeoPrecision };
  to: { lat: number; lng: number; precision: GeoPrecision };
  citySlug: string;
}): TravelEstimate {
  const region = getRegion(args.citySlug);
  const km = haversineKm(args.from, args.to);
  const precision = weaker(args.from.precision, args.to.precision);

  const driving = (km / region.avgSpeedKmph) * 60;
  // The journey, never below the city's minimum turnaround, plus whatever the
  // coordinates' vagueness is worth.
  const minutes = Math.ceil(
    Math.max(driving, region.travelGapMinutes) + PRECISION_SLACK_MINUTES[precision],
  );

  return { minutes, km, precision };
}
