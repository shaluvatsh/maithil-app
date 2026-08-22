/**
 * Reading a tithi string.
 *
 * The panchang endpoint returns the tithi as a display string — "Shukla Saptami",
 * "Krishna Ekadashi", "Purnima". That is exactly what a devotee needs to read, but
 * it means the UI cannot draw anything from it without parsing.
 *
 * A tithi IS the moon's phase: it is defined as each 12° of elongation between sun
 * and moon, so tithi 1–15 of the bright fortnight is the moon filling and 1–15 of
 * the dark fortnight is the moon emptying. Rendering the phase alongside the name
 * is therefore not decoration — it is the same fact in the form most people can
 * read at a glance, which matters when the audience spans a grandmother who knows
 * the tithi by name and a grandchild who does not.
 *
 * Pure and total: unknown input yields `null` and the caller renders text only.
 */
const NAMES = [
  'pratipada', 'dwitiya', 'tritiya', 'chaturthi', 'panchami', 'shashthi',
  'saptami', 'ashtami', 'navami', 'dashami', 'ekadashi', 'dwadashi',
  'trayodashi', 'chaturdashi',
] as const;

/** Bengali and Devanagari transliterations the API may emit for the same tithi. */
const ALIASES: Record<string, number> = {
  prathama: 1, pratipat: 1, dutiya: 2, dwitia: 2, tritia: 3, chaturthy: 4,
  sasthi: 6, shasthi: 6, saptami: 7, astami: 8, nabami: 9, dasami: 10,
  ekadasi: 11, dwadasi: 12, trayodasi: 13, chaturdasi: 14,
};

export interface Tithi {
  /** 1–15 within the fortnight. */
  index: number;
  paksha: 'shukla' | 'krishna';
  /** 0 at new moon, 1 at full moon. */
  illumination: number;
  /** A moon glyph for the phase. */
  glyph: string;
  label: string;
}

const GLYPHS_WAXING = ['🌑', '🌒', '🌓', '🌔', '🌕'];
const GLYPHS_WANING = ['🌕', '🌖', '🌗', '🌘', '🌑'];

export function readTithi(raw: string | null | undefined): Tithi | null {
  if (!raw) return null;
  const s = raw.toLowerCase();

  // The two boundary tithis carry no paksha word; they are the phase itself.
  if (s.includes('purnima') || s.includes('pournami')) {
    return { index: 15, paksha: 'shukla', illumination: 1, glyph: '🌕', label: 'Full moon' };
  }
  if (s.includes('amavasya') || s.includes('amabasya')) {
    return { index: 15, paksha: 'krishna', illumination: 0, glyph: '🌑', label: 'New moon' };
  }

  const paksha: Tithi['paksha'] =
    s.includes('krishna') || s.includes('krisna') || s.includes('kṛṣṇa') ? 'krishna' : 'shukla';

  let index = 0;
  for (let i = 0; i < NAMES.length; i++) if (s.includes(NAMES[i]!)) index = i + 1;
  if (index === 0) {
    for (const [alias, n] of Object.entries(ALIASES)) if (s.includes(alias)) index = n;
  }
  if (index === 0) return null;

  // Bright fortnight fills 0 → 1 across 15 tithis; dark fortnight empties 1 → 0.
  const progress = index / 15;
  const illumination = paksha === 'shukla' ? progress : 1 - progress;

  const table = paksha === 'shukla' ? GLYPHS_WAXING : GLYPHS_WANING;
  const glyph = table[Math.min(table.length - 1, Math.round(progress * (table.length - 1)))]!;

  return {
    index, paksha, illumination, glyph,
    label: paksha === 'shukla' ? 'Waxing moon' : 'Waning moon',
  };
}

/**
 * The tithis a household marks regardless of whether they are booking anything.
 *
 * Distinct from "auspicious for a ritual", which is what the booking flow ranks —
 * an Ekadashi is observed by people who have no puja planned, and Purnima and
 * Amavasya anchor the fortnight. Listing these beside the search box is the reason
 * someone opens the site on a day they are not buying.
 */
const NOTABLE: Array<{ match: RegExp; label: string }> = [
  { match: /purnima|pournami/i, label: 'Purnima' },
  { match: /amavasya|amabasya/i, label: 'Amavasya' },
  { match: /ekadashi|ekadasi/i, label: 'Ekadashi' },
  { match: /chaturthi|chaturthy/i, label: 'Chaturthi' },
  { match: /ashtami|astami/i, label: 'Ashtami' },
];

export function notableTithi(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return NOTABLE.find((n) => n.match.test(raw))?.label ?? null;
}

export type NowState =
  | { kind: 'abhijit'; until: string }
  | { kind: 'rahu'; until: string }
  | { kind: 'clear' };

/**
 * Where the clock sits relative to today's two windows people actually act on.
 *
 * Printing both ranges and leaving the arithmetic to the reader is the difference
 * between information and an answer. Callers must compute this in an effect, not
 * during render — the server has no idea what time it is on the device, and a
 * clock rendered during SSR is a hydration mismatch.
 */
export function nowState(
  now: Date,
  abhijit: { startsAt: string; endsAt: string } | null,
  rahuKaal: { startsAt: string; endsAt: string } | null,
): NowState {
  const within = (w: { startsAt: string; endsAt: string } | null) =>
    Boolean(w && now >= new Date(w.startsAt) && now < new Date(w.endsAt));

  // Rahu Kaal first: a warning outranks an invitation when both somehow apply.
  if (within(rahuKaal)) return { kind: 'rahu', until: rahuKaal!.endsAt };
  if (within(abhijit)) return { kind: 'abhijit', until: abhijit!.endsAt };
  return { kind: 'clear' };
}
