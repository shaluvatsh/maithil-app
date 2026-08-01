import { z } from 'zod';
import { IsoDate, Ulid } from '../ids.js';
import { PanjikaSchool, PanchangKind, Locale } from '../enums.js';

/**
 * Panchang is stored as INTERVALS, not day values - tithis transition at arbitrary
 * clock times and a day commonly spans two. See ADR 0003.
 */
export const PanchangInterval = z.object({
  kind: PanchangKind,
  valueKey: z.string(),        // canonical key, e.g. 'shukla_pratipada'
  label: z.string(),           // localised display, e.g. 'শুক্লা প্রতিপদ'
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
});

export const DevoteePanchangDay = z.object({
  date: IsoDate,
  school: PanjikaSchool,
  bengaliDate: z.string().nullable(),      // '১৫ আষাঢ় ১৪৩৩'
  tithiAtSunrise: z.string(),
  nakshatraAtSunrise: z.string(),
  /** The good window. */
  abhijit: z.object({ startsAt: z.string(), endsAt: z.string() }).nullable(),
  /** The window to avoid. */
  rahuKaal: z.object({ startsAt: z.string(), endsAt: z.string() }).nullable(),
  auspiciousForRitualIds: z.array(Ulid),
  /**
   * True when the two panjika schools disagree about this date. We surface the
   * disagreement rather than picking a winner - no competitor does, and being the
   * one who says "your family's almanac says X, the other says Y" is a trust asset.
   */
  schoolsDisagree: z.boolean(),
});

export const PanditPanchangDay = DevoteePanchangDay.extend({
  sunrise: z.string(),
  sunset: z.string(),
  intervals: z.array(PanchangInterval),
});

export const GetPanchangQuery = z.object({
  citySlug: z.string().default('kolkata'),
  from: IsoDate,
  to: IsoDate,
  school: PanjikaSchool.optional(),   // defaults to the caller's saved preference
  view: z.enum(['devotee', 'pandit']).default('devotee'),
  locale: Locale.default('bn'),
});

export type DevoteePanchangDay = z.infer<typeof DevoteePanchangDay>;
export type PanditPanchangDay = z.infer<typeof PanditPanchangDay>;
