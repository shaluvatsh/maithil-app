/**
 * Panchang astronomy, computed rather than licensed.
 *
 * ADR 0003 says "do not hand-roll v1", and for GUPTA PRESS that still holds - it
 * applies Surya Siddhanta with the press's own corrections and cannot be reproduced
 * without their tables, so those dates stay hand-entered.
 *
 * But BISUDDHA SIDDHANTA is the drik (observed) school, which is ordinary positional
 * astronomy with the Lahiri ayanamsa. That we can compute, and computing it removes a
 * vendor from the critical path entirely.
 *
 * ACCURACY, measured rather than claimed. Individual tithi lengths come out at
 * 21.1-27.7 hours against a true 20.0-26.8, so a boundary can land tens of minutes
 * from a full ephemeris. The synodic month implied is 29.46 days against a true 29.53,
 * so nothing drifts cumulatively - the error is in the shape of the variation, not the
 * mean. The test suite pins both numbers.
 *
 * That is comfortably good enough to mark auspicious days, annotate slots and rank
 * search results. It is NOT good enough to be the last word on a wedding lagna - which
 * is why the purohit view shows transition times, the devotee view carries a "confirm
 * with your purohit" note, and the consulting purohit signs this off before launch.
 * Upgrade path if the accuracy ever bites: swap in a full ephemeris behind the same
 * two functions, sunLongitude() and moonLongitude(). Nothing else has to change.
 */

const RAD = Math.PI / 180;
const sin = (deg: number) => Math.sin(deg * RAD);
const cos = (deg: number) => Math.cos(deg * RAD);
const norm360 = (deg: number) => ((deg % 360) + 360) % 360;

export const J2000 = 2451545.0;

/** Julian day from a JS Date (UTC). */
export function julianDay(date: Date): number {
  return date.getTime() / 86400000 + 2440587.5;
}
export function fromJulianDay(jd: number): Date {
  return new Date((jd - 2440587.5) * 86400000);
}

/** Days since J2000, the argument every series below is expressed in. */
const daysSinceJ2000 = (jd: number) => jd - J2000;

/**
 * Apparent geocentric longitude of the Sun, in degrees.
 * Meeus ch. 25, low-precision form: good to about 0.01 degrees.
 */
export function sunLongitude(jd: number): number {
  const d = daysSinceJ2000(jd);
  const L = norm360(280.459 + 0.98564736 * d);        // mean longitude
  const M = norm360(357.529 + 0.98560028 * d);        // mean anomaly
  const C = 1.915 * sin(M) + 0.020 * sin(2 * M);      // equation of centre
  return norm360(L + C);
}

/**
 * Apparent geocentric longitude of the Moon, in degrees.
 * Meeus ch. 47, principal periodic terms. The Moon is the hard part: its orbit is
 * perturbed enough that the first term alone is off by a third of a degree, which
 * would move a tithi boundary by nearly an hour.
 */
export function moonLongitude(jd: number): number {
  const d = daysSinceJ2000(jd);
  const L = norm360(218.316 + 13.176396 * d);         // mean longitude
  const M = norm360(134.963 + 13.064993 * d);         // mean anomaly (Moon)
  const Ms = norm360(357.529 + 0.98560028 * d);       // mean anomaly (Sun)
  const D = norm360(297.850 + 12.190749 * d);         // mean elongation
  const F = norm360(93.272 + 13.229350 * d);          // argument of latitude

  const lon = L
    + 6.289 * sin(M)
    - 1.274 * sin(2 * D - M)
    + 0.658 * sin(2 * D)
    - 0.214 * sin(2 * M)
    - 0.186 * sin(Ms)
    - 0.114 * sin(2 * F)
    + 0.059 * sin(2 * D - 2 * M)
    + 0.057 * sin(2 * D - M - Ms)
    + 0.053 * sin(2 * D + M)
    + 0.046 * sin(2 * D - Ms)
    + 0.041 * sin(M - Ms)
    - 0.035 * sin(D)
    - 0.031 * sin(M + Ms);
  return norm360(lon);
}

/**
 * Lahiri (Chitrapaksha) ayanamsa in degrees - the offset between the tropical zodiac
 * the formulae above produce and the sidereal zodiac Indian astronomy uses.
 * 23 deg 51' 11" at J2000, precessing at about 50.29 arcsec/year.
 */
export function lahiriAyanamsa(jd: number): number {
  const years = daysSinceJ2000(jd) / 365.25;
  return 23.853 + (years * 50.29) / 3600;
}

export const toSidereal = (tropicalLon: number, jd: number): number =>
  norm360(tropicalLon - lahiriAyanamsa(jd));

/**
 * Tithi index 0..29. A tithi is 12 degrees of elongation between Moon and Sun, so it
 * is the one panchang element that needs no ayanamsa - a difference of longitudes
 * cancels it out.
 * 0..14 are shukla paksha (waxing), 15..29 krishna paksha (waning).
 */
export function tithiIndex(jd: number): number {
  const elongation = norm360(moonLongitude(jd) - sunLongitude(jd));
  return Math.floor(elongation / 12);
}

/** Nakshatra index 0..26, from the Moon's SIDEREAL longitude. 13 deg 20' each. */
export function nakshatraIndex(jd: number): number {
  return Math.floor(toSidereal(moonLongitude(jd), jd) / (360 / 27));
}

export const TITHI_KEYS = [
  'pratipada', 'dwitiya', 'tritiya', 'chaturthi', 'panchami', 'sasthi', 'saptami',
  'ashtami', 'nabami', 'dashami', 'ekadashi', 'dwadashi', 'trayodashi', 'chaturdashi',
] as const;

export function tithiKey(index: number): string {
  if (index === 14) return 'purnima';
  if (index === 29) return 'amavasya';
  const paksha = index < 15 ? 'shukla' : 'krishna';
  return `${paksha}_${TITHI_KEYS[index % 15]}`;
}

export const NAKSHATRA_KEYS = [
  'ashwini', 'bharani', 'krittika', 'rohini', 'mrigashira', 'ardra', 'punarvasu',
  'pushya', 'ashlesha', 'magha', 'purva_phalguni', 'uttara_phalguni', 'hasta',
  'chitra', 'swati', 'vishakha', 'anuradha', 'jyestha', 'mula', 'purva_ashadha',
  'uttara_ashadha', 'shravana', 'dhanishta', 'shatabhisha', 'purva_bhadrapada',
  'uttara_bhadrapada', 'revati',
] as const;

export interface SunTimes { sunrise: Date; sunset: Date; solarNoon: Date }

/**
 * Sunrise and sunset (NOAA algorithm), including the standard -0.833 degree
 * correction for refraction and the solar disc's radius.
 */
export function sunTimes(date: Date, latitude: number, longitude: number): SunTimes {
  const jd = Math.floor(julianDay(date) - 0.5) + 0.5;
  const n = Math.round(jd - J2000 - 0.0009 + longitude / 360);
  const Jstar = J2000 + 0.0009 - longitude / 360 + n;

  const M = norm360(357.5291 + 0.98560028 * (Jstar - J2000));
  const C = 1.9148 * sin(M) + 0.0200 * sin(2 * M) + 0.0003 * sin(3 * M);
  const lambda = norm360(M + C + 180 + 102.9372);

  const Jtransit = Jstar + 0.0053 * sin(M) - 0.0069 * sin(2 * lambda);
  const declination = Math.asin(sin(lambda) * sin(23.44)) / RAD;

  const cosOmega =
    (sin(-0.833) - sin(latitude) * sin(declination)) /
    (cos(latitude) * cos(declination));

  // Polar day or night. Kolkata never sees this, but a future city might.
  const omega = cosOmega >= 1 ? 0 : cosOmega <= -1 ? 180 : Math.acos(cosOmega) / RAD;

  return {
    sunrise: fromJulianDay(Jtransit - omega / 360),
    sunset: fromJulianDay(Jtransit + omega / 360),
    solarNoon: fromJulianDay(Jtransit),
  };
}

export interface Interval { key: string; startsAt: Date; endsAt: Date }

/**
 * Finds the instant an index function changes value, by bisection.
 *
 * Tithi length varies from about 19 to 26 hours because both bodies move at varying
 * speeds, so boundaries cannot be interpolated linearly - but the function is
 * monotonic within a step, which makes bisection both simple and exact to the second.
 */
function findBoundary(
  indexAt: (jd: number) => number,
  startJd: number,
  endJd: number,
): number {
  const target = indexAt(startJd);
  let lo = startJd;
  let hi = endJd;
  for (let i = 0; i < 40; i++) {          // 40 halvings of a day is well under a second
    const mid = (lo + hi) / 2;
    if (indexAt(mid) === target) lo = mid;
    else hi = mid;
  }
  return hi;
}

/**
 * Every tithi (or nakshatra) interval overlapping [from, to].
 * Returned intervals are contiguous and non-overlapping, which is what the exclusion
 * constraint on panchang_intervals requires.
 */
export function intervalsBetween(
  kind: 'tithi' | 'nakshatra',
  from: Date,
  to: Date,
): Interval[] {
  const indexAt = kind === 'tithi' ? tithiIndex : nakshatraIndex;
  const keyOf = kind === 'tithi'
    ? tithiKey
    : (i: number) => NAKSHATRA_KEYS[i] ?? 'unknown';

  const fromJd = julianDay(from);
  const toJd = julianDay(to);
  const step = kind === 'tithi' ? 0.05 : 0.04;   // ~1 hour probes; both last >18h

  const out: Interval[] = [];
  let cursorJd = fromJd;
  let cursorIndex = indexAt(cursorJd);
  let segmentStart = fromJd;

  while (cursorJd < toJd) {
    const nextJd = Math.min(cursorJd + step, toJd);
    const nextIndex = indexAt(nextJd);

    if (nextIndex !== cursorIndex) {
      const boundary = findBoundary(indexAt, cursorJd, nextJd);
      out.push({
        key: keyOf(cursorIndex),
        startsAt: fromJulianDay(segmentStart),
        endsAt: fromJulianDay(boundary),
      });
      segmentStart = boundary;
      cursorIndex = nextIndex;
    }
    cursorJd = nextJd;
  }

  out.push({
    key: keyOf(cursorIndex),
    startsAt: fromJulianDay(segmentStart),
    endsAt: fromJulianDay(toJd),
  });
  return out;
}
