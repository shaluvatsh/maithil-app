/**
 * The region model.
 *
 * Everything that differs between one Indian city and the next lives here, in data,
 * so that launching a new city is a config file and a seed script rather than a
 * codebase search for the string "kolkata".
 *
 * Deliberately framework-agnostic and dependency-free: the API reads it to compute
 * panchang and materialise slots, the web app reads it to pick fonts and copy, and
 * the React Native apps will read the same objects when they exist.
 */

/** Drives which webfont subset is downloaded. A Chennai user must never fetch Bengali. */
export type Script =
  | 'bengali' | 'devanagari' | 'tamil' | 'telugu'
  | 'kannada' | 'malayalam' | 'gujarati' | 'odia' | 'latin';

export type Locale =
  | 'bn' | 'hi' | 'en' | 'mai' | 'ta' | 'te' | 'kn' | 'ml' | 'gu' | 'or' | 'mr';

/**
 * Where the lunar month ends.
 *
 *  - `amanta`     — at the new moon. Bengal, and most of the south and west.
 *  - `purnimant`  — at the full moon. Mithila, and most of the north.
 *
 * This is not cosmetic. The same krishna-paksha tithi belongs to a differently NAMED
 * month under each system, which moves festival dates. See the addendum to ADR 0003.
 */
export type CalendarSystem = 'amanta' | 'purnimant';

/** Intl numbering system. Bengali households expect ০-৯ in the purohit app. */
export type NumeralSystem = 'latn' | 'beng' | 'deva' | 'tamldec' | 'telu' | 'knda' | 'mlym' | 'gujr' | 'orya';

/**
 * Which almanacs this region's households keep.
 *
 * NOTE ON GROWTH: these ids are currently a Postgres enum. That is fine for three
 * values and becomes a liability past about six - `ALTER TYPE` can add but never
 * remove or reorder, and every new city that brings its own panjika needs a
 * migration. Convert `panjika_school` to a reference table before city three. The
 * trigger is stated here rather than in a backlog because it is cheap now and
 * expensive after there is production data in three regions.
 */
export type PanjikaId =
  | 'gupta_press' | 'bisuddha_siddhanta' | 'mithila'
  | 'vikram_banaras' | 'tamil_vakya' | 'drik_generic';

export interface Panjika {
  id: PanjikaId;
  /** Shown in the household's own script - this is a first-run question, not a setting. */
  native: string;
  english: string;
  note: string;
  calendar: CalendarSystem;
  /** True when we can compute it from astronomy; false means hand-entered. ADR 0003. */
  computable: boolean;
}

export interface SlotDef {
  idx: number;
  /** Local wall-clock, HH:MM. Not every city wants Kolkata's four 3-hour blocks. */
  start: string;
  end: string;
  labelKey: string;
}

export interface CalendarEra {
  /** Month names in the local calendar, in order. */
  months: readonly string[];
  /** Gregorian year minus this gives the era year at new-year. */
  yearOffset: number;
  /** Gregorian month/day the local year turns over. */
  newYear: { month: number; day: number };
  name: string;
}

export interface Region {
  slug: string;
  name: { en: string; native: string };
  state: string;

  /** All of India is IST today, but never hardcode the offset - Nepal is +05:45. */
  timezone: string;
  utcOffsetMinutes: number;

  /** Panchang is computed for these coordinates. Sunrise moves ~4 min per degree. */
  coords: { lat: number; lng: number };

  /** First entry is primary and sets first. */
  locales: readonly Locale[];
  script: Script;
  numerals: NumeralSystem;

  panjikas: readonly Panjika[];
  defaultPanjika: PanjikaId;

  slots: readonly SlotDef[];
  /**
   * The MINIMUM turnaround between two jobs, whatever the distance — parking,
   * packing samagri, greeting the family. A floor, not the gap itself: actual
   * travel is estimated per pair of addresses and the larger of the two wins.
   * See ADR 0013.
   */
  travelGapMinutes: number;

  /**
   * Average door-to-door speed in km/h, used to turn a straight-line distance into
   * a travel time.
   *
   * Deliberately low, and per city. It stands in for real driving over an
   * as-the-crow-flies distance, so it has to absorb both the road detour and the
   * traffic: Kolkata's lanes and Mumbai's arterials are not the same problem, and a
   * single national constant would be wrong in both directions at once. Erring low
   * leaves a purohit idle; erring high makes them late for a muhurat, which is the
   * failure that costs a family their ceremony.
   */
  avgSpeedKmph: number;

  /**
   * Preferred `boms.tradition` variant — the SAME ritual performed to a local vidhi.
   *
   * This is NOT a different catalogue. Every city offers the identical list of
   * services; only the samagri variant and the price differ. Splitting the catalogue
   * per city was a mistake: a devotee in Pune looking for Satyanarayan Puja should
   * find it, and a national brand cannot have a different menu in every market.
   */
  ritualSet: string;

  /**
   * City price multiplier against the Kolkata baseline, in basis points.
   * 10000 = same as baseline. Dakshina in Mumbai is genuinely higher than in Patna,
   * but the service LIST stays identical everywhere.
   */
  priceIndexBps: number;
  era?: CalendarEra;

  currency: 'INR';
  active: boolean;
}
