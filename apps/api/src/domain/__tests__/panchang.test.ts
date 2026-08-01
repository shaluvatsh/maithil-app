import { describe, it, expect } from 'vitest';
import { annotateSlot, abhijitWindow, rahuKaalWindow, overlaps, overlapMs } from '../panchang';

// Kolkata, midsummer: sunrise 04:58, sunset 18:22 IST.
const sunrise = new Date('2026-06-21T04:58:00+05:30');
const sunset  = new Date('2026-06-21T18:22:00+05:30');
const slot = (h1: number, h2: number) => ({
  startsAt: new Date(`2026-06-21T${String(h1).padStart(2, '0')}:00:00+05:30`),
  endsAt:   new Date(`2026-06-21T${String(h2).padStart(2, '0')}:00:00+05:30`),
});

describe('panchang interval maths', () => {
  it('abhijit is the 8th of 15 muhurtas, i.e. around solar noon', () => {
    const a = abhijitWindow(sunrise, sunset);
    expect(a.startsAt.getTime()).toBeGreaterThan(sunrise.getTime());
    expect(a.endsAt.getTime()).toBeLessThan(sunset.getTime());
    const mid = (a.startsAt.getTime() + a.endsAt.getTime()) / 2;
    const solarNoon = (sunrise.getTime() + sunset.getTime()) / 2;
    expect(Math.abs(mid - solarNoon)).toBeLessThan(45 * 60 * 1000);
  });

  it('rahu kaal is exactly one eighth of the daylight period', () => {
    const eighth = (sunset.getTime() - sunrise.getTime()) / 8;
    for (let weekday = 0; weekday < 7; weekday++) {
      const r = rahuKaalWindow(sunrise, sunset, weekday);
      expect(r.endsAt.getTime() - r.startsAt.getTime()).toBeCloseTo(eighth, -2);
      expect(r.startsAt.getTime()).toBeGreaterThanOrEqual(sunrise.getTime());
      expect(r.endsAt.getTime()).toBeLessThanOrEqual(sunset.getTime() + 1);
    }
  });

  it('rahu kaal moves with the weekday, not fixed clock hours', () => {
    const starts = new Set(
      Array.from({ length: 7 }, (_, d) => rahuKaalWindow(sunrise, sunset, d).startsAt.getTime()),
    );
    expect(starts.size).toBe(7);
  });

  it('annotates by real intersection, not a weekday lookup', () => {
    const abhijit = abhijitWindow(sunrise, sunset);
    const rahu = rahuKaalWindow(sunrise, sunset, 0);
    const morning = slot(6, 9);
    const midday = slot(9, 13);

    expect(annotateSlot(midday, abhijit, rahu).containsAbhijit).toBe(true);
    expect(annotateSlot(morning, abhijit, rahu).containsAbhijit).toBe(false);

    const a = annotateSlot(morning, abhijit, rahu);
    expect(a.overlapsRahuKaal).toBe(a.rahuOverlapMinutes > 0);
  });

  it('touching intervals do not count as overlapping', () => {
    const a = { startsAt: new Date('2026-01-01T09:00:00Z'), endsAt: new Date('2026-01-01T12:00:00Z') };
    const b = { startsAt: new Date('2026-01-01T12:00:00Z'), endsAt: new Date('2026-01-01T15:00:00Z') };
    expect(overlaps(a, b)).toBe(false);
    expect(overlapMs(a, b)).toBe(0);
  });

  it('handles a tithi spanning midnight, which day-granular storage cannot', () => {
    const tithi = {
      startsAt: new Date('2026-06-21T22:14:00+05:30'),
      endsAt: new Date('2026-06-22T19:03:00+05:30'),
    };
    const eveningSlot = slot(19, 22);
    expect(overlaps(eveningSlot, tithi)).toBe(false);
    const lateSlot = {
      startsAt: new Date('2026-06-21T22:00:00+05:30'),
      endsAt: new Date('2026-06-21T23:30:00+05:30'),
    };
    expect(overlaps(lateSlot, tithi)).toBe(true);
  });
});
