import type { Locale, Script, NumeralSystem } from './types';

/**
 * The languages a purohit can say they conduct in, and the traditions they follow.
 *
 * Both lists were typed into `apps/web/app/purohit/setup/page.tsx` as six English
 * strings — Bengali, Hindi, English, Maithili, Odia, Marwari — and that list is
 * Bengal's, not India's. The consequences were not cosmetic:
 *
 *   - A Chennai purohit could not record that they conduct in TAMIL. Nor could
 *     Bengaluru say Kannada, Mumbai or Pune say Marathi, Ahmedabad say Gujarati,
 *     Hyderabad say Telugu. Eight of the fourteen live cities could not describe
 *     their own supply in their own language.
 *   - Devotee search filters with `pp.languages && ARRAY[...]`, an overlap. A
 *     language you cannot record is a filter you can never match, so this is not a
 *     ranking penalty — it is the same total exclusion the wrong-city bug caused,
 *     and it fails silently in exactly the same way.
 *   - Everyone was offered Marwari, which no city declares.
 *
 * Every region already declares its `locales`. This turns those codes into names a
 * person recognises, so the list a purohit sees is derived from the city they work
 * in rather than from whoever last edited the wizard. Adding a city adds its
 * languages; there is no second list to remember.
 */
export interface LanguageOption {
  /** The code stored on the profile and matched by search. */
  code: Locale;
  /** What a purohit reads when choosing. */
  en: string;
  /** What they read if they read their own script more comfortably. */
  native: string;
}

/**
 * Keyed by `Locale`, so a new locale in `types.ts` is a type error here until it is
 * given a name. That is the point: the previous list could go stale without anything
 * noticing, because nothing connected it to the regions it was supposed to serve.
 */
export const LANGUAGES: Readonly<Record<Locale, LanguageOption>> = {
  bn: { code: 'bn', en: 'Bengali', native: 'বাংলা' },
  hi: { code: 'hi', en: 'Hindi', native: 'हिन्दी' },
  en: { code: 'en', en: 'English', native: 'English' },
  mai: { code: 'mai', en: 'Maithili', native: 'मैथिली' },
  ta: { code: 'ta', en: 'Tamil', native: 'தமிழ்' },
  te: { code: 'te', en: 'Telugu', native: 'తెలుగు' },
  kn: { code: 'kn', en: 'Kannada', native: 'ಕನ್ನಡ' },
  ml: { code: 'ml', en: 'Malayalam', native: 'മലയാളം' },
  gu: { code: 'gu', en: 'Gujarati', native: 'ગુજરાતી' },
  or: { code: 'or', en: 'Odia', native: 'ଓଡ଼ିଆ' },
  mr: { code: 'mr', en: 'Marathi', native: 'मराठी' },
} as const;

export const ALL_LANGUAGES: readonly LanguageOption[] = Object.values(LANGUAGES);

/**
 * What to offer a purohit registering in this city: the city's own languages first,
 * then the rest.
 *
 * Not filtered down to the city's locales, deliberately. A Maithil purohit in
 * Kolkata serves Maithil households in Maithili — the Kolkata region file says so in
 * a comment — and a migrant family in Bengaluru may want a purohit who speaks their
 * own language rather than Kannada. Ordering answers the common case; truncating
 * would recreate the exclusion this replaced, one city smaller.
 */
/*
 * Takes the locales rather than a city slug so this module never imports the region
 * registry — the registry is what would import this one, and a cycle between the two
 * is the kind of thing that resolves fine in tests and yields `undefined` at runtime
 * in a bundler. Callers pass `getRegion(slug).locales`.
 */
export function languagesFor(local: readonly Locale[]): readonly LanguageOption[] {
  const first = local.map((l) => LANGUAGES[l]).filter(Boolean);
  const rest = ALL_LANGUAGES.filter((l) => !local.includes(l.code));
  return [...first, ...rest];
}

/** Narrowing for anything that arrives from a request or a database row. */
export const isLocale = (v: string): v is Locale =>
  Object.prototype.hasOwnProperty.call(LANGUAGES, v);

/**
 * Sampradaya.
 *
 * Also hardcoded in the wizard, and also incomplete: a purohit's tradition
 * determines which vidhi they perform, so a devotee's "we are a Vaishnava family"
 * is a genuine matching constraint rather than a label. The four listed covered
 * Bengal; Madhva and Vaishnava sub-traditions matter in the south and west.
 */
export interface TraditionOption {
  id: string;
  en: string;
  /** One line, because most devotees do not know the word. */
  note: string;
}

export const TRADITIONS: readonly TraditionOption[] = [
  { id: 'smarta', en: 'Smarta', note: 'The most common; worships the five deities' },
  { id: 'vaishnava', en: 'Vaishnava', note: 'Vishnu, Krishna, Rama' },
  { id: 'shaiva', en: 'Shaiva', note: 'Shiva' },
  { id: 'shakta', en: 'Shakta', note: 'Durga, Kali, the Devi' },
  { id: 'madhva', en: 'Madhva', note: 'Dvaita; common in Karnataka' },
  { id: 'sri_vaishnava', en: 'Sri Vaishnava', note: 'Tamil Vaishnava tradition' },
] as const;

export const TRADITION_IDS: readonly string[] = TRADITIONS.map((t) => t.id);

/**
 * Codes to something a person reads.
 *
 * The column has held two encodings since the wizard was written: `db:seed:dev`
 * stores locale codes (`['bn','hi']`), the onboarding wizard stored English display
 * names (`['Bengali']`). Search matches with an array overlap, so a devotee
 * filtering for `bn` matched every seeded purohit and no self-registered one — the
 * two halves of the supply were never comparable. Codes are now canonical, which
 * means every screen showing this field has to translate, or an admin reads "bn, hi"
 * on a verification card.
 *
 * Unknown values pass through rather than being dropped: a legacy row reading
 * "Marwari" should still show the operator what it says, not vanish.
 */
export function languageNames(codes: readonly string[] | null | undefined): string[] {
  return (codes ?? []).map((c) => (isLocale(c) ? LANGUAGES[c].en : c));
}

/** Same treatment for sampradaya, for the same reason. */
export function traditionNames(ids: readonly string[] | null | undefined): string[] {
  return (ids ?? []).map((id) => TRADITIONS.find((t) => t.id === id)?.en ?? id);
}

/**
 * Which script a language is written in.
 *
 * `Region.script` answers this for a CITY, and on every marketplace surface that is
 * enough — the whole page belongs to one region, so one font subset is downloaded
 * and `fonts.ts` keeps its promise that a Bengaluru user never fetches a Bengali
 * face.
 *
 * A community feed breaks that assumption: it is scoped nationally, so one response
 * can carry Bengali, Devanagari and Tamil at once and the reader's region no longer
 * describes what is on the screen. Loading all nine subsets to be safe would add
 * hundreds of kilobytes to exactly the low-end Android devices this product depends
 * on, so the promise has to be kept PER ITEM instead: derive the scripts actually
 * present in a response, and load those.
 *
 * Keyed by `Locale`, so adding a locale to `types.ts` is a type error here until it
 * has been given a script — the same guard `LANGUAGES` uses, for the same reason.
 */
export const SCRIPT_FOR_LOCALE: Readonly<Record<Locale, Script>> = {
  bn: 'bengali',
  hi: 'devanagari',
  en: 'latin',
  mai: 'devanagari',
  ta: 'tamil',
  te: 'telugu',
  kn: 'kannada',
  ml: 'malayalam',
  gu: 'gujarati',
  or: 'odia',
  mr: 'devanagari',
} as const;

/**
 * The distinct scripts a set of locales needs, deduplicated and stable.
 *
 * Sorted so the value is comparable between requests: it goes into a response the
 * client caches against, and an unstable order would look like a change every time.
 */
export function scriptsForLocales(locales: readonly string[]): Script[] {
  const out = new Set<Script>();
  for (const l of locales) if (isLocale(l)) out.add(SCRIPT_FOR_LOCALE[l]);
  return [...out].sort();
}

/**
 * Which digits a language is written with.
 *
 * `Region.numerals` answers this for a CITY, and it was the right answer while the
 * interface opened in the city's own language: Kolkata meant Bengali meant ০-৯.
 *
 * Once English is the default (ADR 0017) the two come apart. A reader who has the
 * app in English in Kolkata should see "84 pranams", not "৮৪" — the region has not
 * changed, the language has, and digits belong to the language. A reader who
 * switches to Bengali should see ৮৪ wherever they are, including Bengaluru.
 *
 * So numerals follow the ACTIVE LOCALE, and `Region.numerals` remains the city's
 * default for anything rendered without a reader — server-side formatting, a
 * purohit-facing document, a city page with no session.
 *
 * Keyed by `Locale`, so a new locale in `types.ts` is a type error here until it has
 * been given digits — the guard `LANGUAGES` and `SCRIPT_FOR_LOCALE` both use.
 */
export const NUMERALS_FOR_LOCALE: Readonly<Record<Locale, NumeralSystem>> = {
  bn: 'beng',
  hi: 'deva',
  en: 'latn',
  mai: 'deva',
  ta: 'tamldec',
  te: 'telu',
  kn: 'knda',
  ml: 'mlym',
  gu: 'gujr',
  or: 'orya',
  mr: 'deva',
} as const;
