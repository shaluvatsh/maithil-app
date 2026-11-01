import type { Region, NumeralSystem } from './types';

/**
 * Formatting, region-aware. One place, so no screen ever hand-rolls a rupee string
 * or a date and drifts.
 */

/** Money. Always from paise, always tabular in the UI. */
/**
 * Money, to the rupee.
 *
 * `maximumFractionDigits: 2` let paise through, so a card computed as
 * `(defaultPaise + bomTotal * 1.05) * 1.15` rendered as **₹5,207.2** — a price with
 * a trailing tenth of a rupee, next to a category tile reading a clean "5 services".
 * India has not circulated a coin below one rupee since 2011; nobody quotes a puja
 * to the paise, and a price that looks miscalculated reads as a site that cannot be
 * trusted with a payment.
 *
 * Paise remain the storage and arithmetic unit everywhere else — this is a display
 * decision, made once, at the only place money becomes a string. `opts.paise` is
 * for the ledger and payout screens, where the exact figure is the point.
 */
export const formatMoney = (
  paise: number, region: Region, opts: { numerals?: boolean; paise?: boolean } = {},
): string =>
  new Intl.NumberFormat(
    `en-IN-u-nu-${opts.numerals ? region.numerals : 'latn'}`,
    {
      style: 'currency', currency: region.currency,
      maximumFractionDigits: opts.paise ? 2 : 0,
      minimumFractionDigits: 0,
    },
  ).format(paise / 100);

/**
 * Local numerals. Used in the purohit app, where the audience is 30-65 and reading
 * their own script is materially faster than reading Latin digits.
 */
export const toLocalNumerals = (value: string | number, system: NumeralSystem): string => {
  if (system === 'latn') return String(value);
  const digits = digitTable(system);
  if (!digits) return String(value);
  return String(value).replace(/\d/g, (d) => digits[Number(d)] ?? d);
};

const tableCache = new Map<NumeralSystem, string[] | null>();

/**
 * Digit table for a numbering system, index-aligned 0-9.
 *
 * Built by formatting each digit separately. Formatting 1234567890 once and stripping
 * separators looks tidier and is wrong: the result starts at ONE, so index 0 maps to
 * the glyph for one and every rendered numeral is off by a digit.
 */
function digitTable(system: NumeralSystem): string[] | null {
  if (tableCache.has(system)) return tableCache.get(system)!;
  let table: string[] | null = null;
  try {
    const fmt = new Intl.NumberFormat(`en-u-nu-${system}`);
    const built = Array.from({ length: 10 }, (_, i) => fmt.format(i));
    table = built.every((g) => g.length > 0) ? built : null;
  } catch {
    table = null;
  }
  tableCache.set(system, table);
  return table;
}

/** Wall-clock time in the region's zone. Never the browser's. */
export const formatTime = (iso: string, region: Region): string => {
  // Empty string for anything unparseable, so a caller can decide what to render
  // instead of the process deciding for it by throwing mid-render.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', hour12: true, timeZone: region.timezone,
  });
};

export const formatDate = (isoDate: string, region: Region): string =>
  new Date(`${isoDate}T12:00:00`).toLocaleDateString('en-IN', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: region.timezone,
  });

/**
 * The local era date - Bangabda in Kolkata, Vikram Samvat in Patna. Arithmetic
 * approximation, adequate for display beside the Gregorian date.
 */
export function formatEraDate(isoDate: string, region: Region): string | null {
  if (!region.era) return null;
  const d = new Date(`${isoDate}T12:00:00Z`);
  const g = d.getUTCFullYear();
  const newYear = new Date(Date.UTC(g, region.era.newYear.month - 1, region.era.newYear.day));
  const before = d < newYear;
  const year = g - region.era.yearOffset - (before ? 1 : 0);
  const start = before
    ? new Date(Date.UTC(g - 1, region.era.newYear.month - 1, region.era.newYear.day))
    : newYear;
  const elapsed = Math.floor((d.getTime() - start.getTime()) / 86400_000);
  const monthIdx = Math.min(Math.floor(elapsed / 30.44), 11);
  const day = elapsed - Math.floor(monthIdx * 30.44) + 1;
  const n = (v: number) => toLocalNumerals(v, region.numerals);
  return `${n(day)} ${region.era.months[monthIdx]} ${n(year)}`;
}

/**
 * The window a booking ACTUALLY occupies, from its own two instants.
 *
 * `slotLabel` answers a different question — "what is slot 2 called in this city" —
 * and it was being used to display booked times. Since ADR 0013 a booking is a pair
 * of instants and `slot_idx` is vestigial bookkeeping, so the two disagree whenever
 * a devotee picks a time the slot grid has no index for: Kolkata's slots leave gaps
 * (09:00-09:30, 12:30-13:00, 16:00-16:30), a 12:30 booking falls in one, and the
 * slot label then reported a 45-minute online aarti as "6am-9am".
 *
 * Reads from `slot_start_at`/`slot_end_at`, which are what the booking was actually
 * made against and what every deadline in the product is measured from.
 */
export const timeRange = (startIso: string, endIso: string, region: Region): string => {
  /*
   * Degrades rather than throws.
   *
   * `toLocaleTimeString` raises RangeError on an invalid date, and this is called
   * during render on the devotee's bookings list and the purohit's job card — so a
   * single row missing `slot_end_at`, or any future caller passing a field the API
   * did not return, took the WHOLE screen down rather than rendering one imperfect
   * line. A formatter is not a place to enforce data quality.
   */
  const start = formatTime(startIso, region);
  if (!start) return '';
  const end = formatTime(endIso, region);
  return end ? `${start} – ${end}` : start;
};

/** Slot windows in local wall clock, from region config rather than a constant. */
export const slotLabel = (region: Region, idx: number): string => {
  const s = region.slots.find((x) => x.idx === idx);
  if (!s) return '—';
  const pretty = (hhmm: string) => {
    const [h = '0', m = '00'] = hhmm.split(':');
    const hour = Number(h);
    const suffix = hour < 12 ? 'am' : 'pm';
    const h12 = hour % 12 === 0 ? 12 : hour % 12;
    return m === '00' ? `${h12}${suffix}` : `${h12}:${m}${suffix}`;
  };
  return `${pretty(s.start)}–${pretty(s.end)}`;
};

/** The absolute instant a slot begins, honouring the region offset (Nepal is +05:45). */
export function slotInstant(isoDate: string, hhmm: string, region: Region): Date {
  const sign = region.utcOffsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(region.utcOffsetMinutes);
  const off = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return new Date(`${isoDate}T${hhmm.length === 5 ? `${hhmm}:00` : hhmm}${off}`);
}

/**
 * An instant — a timestamp, not a calendar date — in the region's zone.
 *
 * `new Date(ev.at).toLocaleString('en-IN', { … })` was written inline on the
 * account page's booking timeline and on two admin tables. The locale was right
 * and the ZONE was missing, so a UTC instant rendered in whatever zone the
 * browser happened to be in. The product's own comments describe the case it
 * breaks: a family in Dubai booking a puja for their parents in Kolkata read
 * "Confirmed 2:35 am" against a 4:05 am IST event, on a screen where every other
 * time came from `formatTime` and was correctly IST. Two clocks, one screen.
 *
 * `formatTime` already carried the rule ("Never the browser's"); it just had no
 * date-bearing sibling, so callers who needed both hand-rolled one.
 */
export const formatDateTime = (iso: string, region: Region): string => {
  // Same degrade-don't-throw contract as `formatTime`: this runs during render on
  // the bookings list, and `toLocaleString` raises RangeError on an invalid date.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-IN', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    hour12: true, timeZone: region.timezone,
  });
};

/**
 * "October 2026" — the heading on a month's worth of history.
 *
 * Takes `YYYY-MM`, the key bookings are already grouped by, rather than a date,
 * so no caller has to invent a day-of-month to anchor it to. The inline version
 * built `new Date(`${key}-01T12:00:00`)`, which is midday in the BROWSER's zone:
 * far enough from a boundary to be right in practice, and wrong for the same
 * reason every other missing `timeZone` here was wrong.
 */
export const formatMonth = (yyyyMm: string, region: Region): string => {
  const d = new Date(`${yyyyMm}-01T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return yyyyMm;
  return d.toLocaleDateString('en-IN', {
    month: 'long', year: 'numeric', timeZone: region.timezone,
  });
};

/**
 * Today in the REGION's zone, as the `YYYY-MM-DD` the API speaks.
 *
 * `lib/format.ts`'s `todayIso()` and `dayList()` both add a literal `5.5 * 3600_000`
 * to get there. That is IST, hardcoded, in a codebase whose own slot arithmetic
 * carries the comment "Nepal is +05:45" — so the offset is already known to be
 * wrong somewhere the product intends to go, and `+05:30` is not even IST for a
 * region that ever observes anything else.
 */
export const todayInRegion = (region: Region): string => {
  // `en-CA` is the one widely-supported locale whose short date IS `YYYY-MM-DD`,
  // which avoids re-deriving the parts from a formatToParts loop.
  return new Date().toLocaleDateString('en-CA', { timeZone: region.timezone });
};

/**
 * "today" / "tomorrow" / "in 6 days" — a bare date makes the reader count.
 *
 * Both dates are resolved in the region's zone before subtracting, so the answer
 * is a difference in CALENDAR DAYS rather than in elapsed hours: a ceremony at
 * 9 am tomorrow is "tomorrow" whether it is now 11 pm or 6 am, which is what
 * "tomorrow" means to the person reading it.
 */
export const relativeDay = (isoDate: string, region: Region): string | null => {
  const today = todayInRegion(region);
  const days = Math.round(
    (Date.parse(`${isoDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
  );
  if (Number.isNaN(days)) return null;
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  if (days > 1 && days <= 30) return `in ${days} days`;
  return null;
};
