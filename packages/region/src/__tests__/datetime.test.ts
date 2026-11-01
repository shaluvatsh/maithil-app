import { describe, it, expect } from 'vitest';
import { REGIONS, getRegion } from '../index';
import { formatDateTime, formatMonth, relativeDay, todayInRegion } from '../format';

/**
 * THE BUG THESE EXIST FOR, which shipped on the account page and two admin tables.
 *
 * `new Date(ev.at).toLocaleString('en-IN', { … })` was written inline wherever a
 * timestamp had to be shown. The LOCALE was right and the ZONE was missing, so a
 * UTC instant from the database rendered in whatever zone the reader's browser
 * happened to be in — while every other time on the same screen came from
 * `formatTime`, which has carried the rule ("Never the browser's") from the start.
 *
 * `formatTime` simply had no date-bearing sibling, so five callers hand-rolled one
 * and all five got it wrong the same way. The product's own comments name the case
 * it breaks: a family abroad booking a puja for their parents in Kolkata, reading a
 * booking timeline in Gulf time against slot times in IST.
 *
 * These run over every region, so a city in a second zone is covered on the day it
 * is added rather than the day someone notices.
 */
const kolkata = getRegion('kolkata');

describe('formatDateTime', () => {
  it('renders an instant in the region zone, not the host zone', () => {
    // 19:00 UTC on 23 Oct is 00:30 on 24 Oct in IST (+05:30). A formatter using the
    // host zone would say the 23rd anywhere west of India — which is where the
    // "booked from abroad" readers are.
    const out = formatDateTime('2026-10-23T19:00:00Z', kolkata);
    expect(out).toMatch(/24 Oct/);
    expect(out).toMatch(/12:30/);
  });

  it('is independent of the machine running it', () => {
    // The real assertion: whatever TZ this process has, the answer is the same.
    // A host-zone formatter only produces the expected string when TZ=IST, which is
    // why the original bug passed every test on a developer's laptop.
    const iso = '2026-10-23T19:00:00Z';
    const asIst = new Date(iso).toLocaleString('en-IN', {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
      hour12: true, timeZone: 'Asia/Kolkata',
    });
    expect(formatDateTime(iso, kolkata)).toBe(asIst);
  });

  /**
   * Same degrade-don't-throw contract as `formatTime` and `timeRange`, and for the
   * same reason: this runs during render on the bookings list, and
   * `toLocaleString` raises RangeError on an invalid date — so one row missing a
   * field took the whole screen down rather than rendering one imperfect line.
   */
  it('returns empty rather than throwing on an unparseable instant', () => {
    expect(formatDateTime('not-a-date', kolkata)).toBe('');
    expect(formatDateTime('', kolkata)).toBe('');
  });
});

describe('formatMonth', () => {
  it('names the month of a YYYY-MM key', () => {
    expect(formatMonth('2026-10', kolkata)).toBe('October 2026');
  });

  it('does not slip a month at either boundary', () => {
    // The inline version anchored on `${key}-01T12:00:00` — midday in the HOST
    // zone — which is the kind of near-miss that is right until it is not.
    expect(formatMonth('2026-01', kolkata)).toBe('January 2026');
    expect(formatMonth('2026-12', kolkata)).toBe('December 2026');
  });

  it('falls back to the key rather than rendering "Invalid Date"', () => {
    expect(formatMonth('nonsense', kolkata)).toBe('nonsense');
  });
});

describe('todayInRegion', () => {
  it.each(Object.entries(REGIONS))('gives %s a YYYY-MM-DD date', (_slug, region) => {
    expect(todayInRegion(region)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  /**
   * `lib/format.ts`'s `todayIso()` adds a literal `5.5 * 3600_000` to reach "today
   * in IST". That is IST hardcoded, in a package whose own slot arithmetic carries
   * the comment "Nepal is +05:45" — so the offset is already known to be wrong
   * somewhere the product intends to go. Deriving it from `region.timezone` means
   * a region in another zone is correct without anyone editing a constant.
   */
  it('reads the zone from the region rather than a fixed offset', () => {
    const fixed = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
    // In IST they agree, which is the only thing the hardcoded version ever got right.
    expect(todayInRegion(kolkata)).toBe(fixed);
  });
});

describe('relativeDay', () => {
  const dayFrom = (n: number) => {
    const today = todayInRegion(kolkata);
    return new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000)
      .toISOString().slice(0, 10);
  };

  it('names the days a reader would otherwise have to count', () => {
    expect(relativeDay(dayFrom(0), kolkata)).toBe('today');
    expect(relativeDay(dayFrom(1), kolkata)).toBe('tomorrow');
    expect(relativeDay(dayFrom(-1), kolkata)).toBe('yesterday');
    expect(relativeDay(dayFrom(6), kolkata)).toBe('in 6 days');
  });

  /** Past that, a plain date reads better than "in 94 days". */
  it('declines to label anything too far out to be useful', () => {
    expect(relativeDay(dayFrom(31), kolkata)).toBeNull();
    expect(relativeDay(dayFrom(-9), kolkata)).toBeNull();
  });

  it('returns null rather than NaN for a malformed date', () => {
    expect(relativeDay('not-a-date', kolkata)).toBeNull();
  });
});
