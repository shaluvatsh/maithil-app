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
export const formatTime = (iso: string, region: Region): string =>
  new Date(iso).toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', hour12: true, timeZone: region.timezone,
  });

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
