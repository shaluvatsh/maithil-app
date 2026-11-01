import type { Locale } from './types';

/**
 * The festival catalogue.
 *
 * WHY THIS IS DATA AND NOT DERIVED. A festival is a lunar date — Vijaya Dashami is
 * Ashwin shukla dashami — and deriving it needs the lunar MONTH, which this system
 * does not hold. `panchang_days` stores the tithi and the nakshatra at sunrise;
 * `formatEraDate` produces a solar era date by arithmetic approximation and says so
 * in its own comment. Neither can tell Ashwin shukla dashami from Chaitra shukla
 * dashami.
 *
 * That gap is not an oversight to close. Under ADR 0003 the panjikas disagree about
 * festival dates, and that disagreement IS the product — Mithila keeps purnimant
 * months, so a krishna-paksha tithi belongs to a differently named month there and
 * the festival moves. Computing our own dates would invent a third opinion and quietly
 * contradict the almanac a household actually keeps. So dates are transcribed per
 * school, exactly as the hand-entered Gupta Press muhurats are, and this file holds
 * only what is true regardless of school: what the festival IS, who marks it, and what
 * a household might book for it.
 *
 * `regions` is a list of region slugs rather than a language or a state, because
 * observance follows neither. Kolkata and Guwahati both keep Durga Puja; Bengaluru
 * and Chennai keep Pongal under different names. An empty list means everywhere.
 */
export interface Festival {
  id: string;
  en: string;
  /** Names in the languages a dictionary exists for. Falls back to `en`. */
  names?: Partial<Record<Locale, string>>;
  /** Region slugs that mark it. Empty or absent means every city we serve. */
  regions?: readonly string[];
  /** What a household would book for it, as a ritual slug. Drives the CTA. */
  ritualSlug?: string;
  /** Consecutive days. Most are one; Durga Puja is four. */
  days?: number;
  /** One line telling someone who does not keep it what it is. */
  blurb: string;
}

const EAST = ['kolkata', 'guwahati', 'bhubaneswar'] as const;
const HINDI_BELT = ['delhi', 'jaipur', 'lucknow', 'varanasi', 'patna'] as const;
const WEST = ['mumbai', 'pune', 'ahmedabad'] as const;
const SOUTH = ['bengaluru', 'chennai', 'hyderabad'] as const;

export const FESTIVALS: readonly Festival[] = [
  {
    id: 'mahalaya', en: 'Mahalaya',
    names: { bn: 'মহালয়া', hi: 'महालय' },
    regions: [...EAST, ...HINDI_BELT],
    ritualSlug: 'tarpan', days: 1,
    blurb: 'The end of Pitru Paksha, and the morning tarpan offered to the ancestors.',
  },
  {
    id: 'durga-puja', en: 'Durga Puja',
    names: { bn: 'দুর্গাপূজা', hi: 'दुर्गा पूजा' },
    regions: EAST, days: 4,
    blurb: 'Shashthi to Dashami — four days, and the largest observance in the east.',
  },
  {
    id: 'navratri', en: 'Navratri',
    names: { hi: 'नवरात्रि' },
    regions: [...HINDI_BELT, ...WEST, ...SOUTH], days: 9,
    blurb: 'Nine nights of the Goddess, kept as fasting, garba or Golu by region.',
  },
  {
    id: 'lakshmi-puja', en: 'Lakshmi Puja',
    names: { bn: 'লক্ষ্মীপূজা', hi: 'लक्ष्मी पूजा' },
    ritualSlug: 'lakshmi-puja', days: 1,
    blurb: 'The Kojagari full moon in the east; the Diwali evening elsewhere.',
  },
  {
    id: 'kali-puja', en: 'Kali Puja',
    names: { bn: 'কালীপূজা' },
    regions: EAST, days: 1,
    blurb: 'The Diwali new moon, kept through the night.',
  },
  {
    id: 'diwali', en: 'Diwali',
    names: { hi: 'दीपावली', bn: 'দীপাবলি' },
    days: 1,
    blurb: 'Lamps, the household Lakshmi puja, and the new account book for a business.',
  },
  {
    id: 'chhath', en: 'Chhath Puja',
    names: { hi: 'छठ पूजा' },
    regions: ['patna', 'varanasi', 'lucknow', 'delhi', 'kolkata'], days: 4,
    blurb: 'Four days of fasting and the offering to the setting and rising sun.',
  },
  {
    id: 'ganesh-chaturthi', en: 'Ganesh Chaturthi',
    names: { hi: 'गणेश चतुर्थी' },
    regions: [...WEST, ...SOUTH],
    ritualSlug: 'ganesh-puja', days: 1,
    blurb: 'The installation of Ganapati at home, and the immersion that follows.',
  },
  {
    id: 'saraswati-puja', en: 'Saraswati Puja',
    names: { bn: 'সরস্বতী পূজা', hi: 'सरस्वती पूजा' },
    regions: [...EAST, ...HINDI_BELT], days: 1,
    blurb: 'Vasant Panchami — the first letters written, and the books set down.',
  },
  {
    id: 'maha-shivaratri', en: 'Maha Shivaratri',
    names: { hi: 'महाशिवरात्रि', bn: 'মহাশিবরাত্রি' },
    days: 1,
    blurb: 'The night of Shiva, kept with fasting and the four watches of abhishek.',
  },
  {
    id: 'ram-navami', en: 'Ram Navami',
    names: { hi: 'राम नवमी' },
    days: 1,
    blurb: 'The birth of Rama, at midday.',
  },
  {
    id: 'janmashtami', en: 'Janmashtami',
    names: { hi: 'जन्माष्टमी', bn: 'জন্মাষ্টমী' },
    days: 1,
    blurb: 'The birth of Krishna, kept until midnight.',
  },
  {
    id: 'raksha-bandhan', en: 'Raksha Bandhan',
    names: { hi: 'रक्षाबंधन' },
    regions: [...HINDI_BELT, ...WEST], days: 1,
    blurb: 'The thread tied on a brother’s wrist, on the Shravan full moon.',
  },
  {
    id: 'makar-sankranti', en: 'Makar Sankranti',
    names: { hi: 'मकर संक्रांति', bn: 'মকর সংক্রান্তি' },
    days: 1,
    blurb: 'The sun turning north — Pongal in the south, Poush Sankranti in the east.',
  },
  {
    id: 'pongal', en: 'Pongal',
    regions: SOUTH, days: 4,
    blurb: 'Four days of the harvest, opening with the pot boiled over at dawn.',
  },
  {
    id: 'ugadi', en: 'Ugadi',
    regions: ['bengaluru', 'hyderabad'], days: 1,
    blurb: 'The lunar new year in the Deccan, opened with the six-taste pachadi.',
  },
  {
    id: 'poila-boishakh', en: 'Poila Boishakh',
    names: { bn: 'পয়লা বৈশাখ' },
    regions: EAST, days: 1,
    blurb: 'The Bengali new year, and the halkhata that opens a shop’s new ledger.',
  },
] as const;

/** Everything this city marks. Order is the catalogue's, not the calendar's. */
export function festivalsFor(regionSlug: string): readonly Festival[] {
  return FESTIVALS.filter((f) => !f.regions?.length || f.regions.includes(regionSlug));
}

export const festivalById = (id: string): Festival | undefined =>
  FESTIVALS.find((f) => f.id === id);

/** The name to show, in the reader's language where we have it. */
export const festivalName = (f: Festival, locale: Locale): string =>
  f.names?.[locale] ?? f.en;

/**
 * The tithis a household marks every month, independent of the lunar month — so
 * these ARE derivable from what `panchang_days` already stores.
 *
 * Matched on the stored `value_key` (`shukla_ekadashi`, `purnima`), never on the
 * displayed label. The label is localised, so matching it means the observances
 * silently disappear for any reader not using English — which is exactly what the
 * English-regex version in the web app did.
 */
export const NOTABLE_TITHI_KEYS: Readonly<Record<string, string>> = {
  purnima: 'Purnima',
  amavasya: 'Amavasya',
  shukla_ekadashi: 'Ekadashi',
  krishna_ekadashi: 'Ekadashi',
  krishna_chaturdashi: 'Masik Shivaratri',
  shukla_chaturthi: 'Vinayaka Chaturthi',
  krishna_chaturthi: 'Sankashti Chaturthi',
};

/** Null when the tithi is an ordinary one. Total, so an unknown key is not a crash. */
export const notableTithiKey = (valueKey: string | null | undefined): string | null =>
  (valueKey ? NOTABLE_TITHI_KEYS[valueKey] ?? null : null);
