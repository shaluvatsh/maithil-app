import {
  pgTable, text, date, timestamp, boolean, integer, index, uniqueIndex, primaryKey,
} from 'drizzle-orm/pg-core';
import { cities, users } from './identity';
import { rituals } from './catalog';
import { panjikaSchoolEnum, panchangKindEnum, panchangSourceEnum, localeEnum } from './enums';

const id = () => text('id').primaryKey();
const ts = (n: string) => timestamp(n, { withTimezone: true, mode: 'string' });
const created = () => ts('created_at').notNull().defaultNow();

/**
 * PANCHANG AS INTERVALS.
 *
 * The original design stored one tithi per day. Tithis transition at arbitrary
 * clock times and a day commonly spans two - a purohit opening the app would see
 * an obvious inaccuracy on day one. See ADR 0003.
 *
 * Every panchang table is keyed by SCHOOL, because Bengal's two panjika traditions
 * publish genuinely different dates and roughly half of Kolkata follows each.
 */
export const panchangIntervals = pgTable('panchang_intervals', {
  id: id(),
  cityId: text('city_id').notNull().references(() => cities.id),
  school: panjikaSchoolEnum('school').notNull(),
  kind: panchangKindEnum('kind').notNull(),
  valueKey: text('value_key').notNull(),        // 'shukla_pratipada', 'rohini'
  startsAt: ts('starts_at').notNull(),
  endsAt: ts('ends_at').notNull(),
  source: panchangSourceEnum('source').notNull().default('api'),
  createdAt: created(),
}, (t) => ({
  lookup: index('panchang_intervals_lookup')
    .on(t.cityId, t.school, t.kind, t.startsAt, t.endsAt),
}));

/** Localised display names for panchang terms. No provider gives us Bengali. */
export const panchangTerms = pgTable('panchang_terms', {
  valueKey: text('value_key').notNull(),
  locale: localeEnum('locale').notNull(),
  label: text('label').notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.valueKey, t.locale] }),
}));

/**
 * Materialised per-day summary. A CACHE over panchang_intervals, holding the
 * conventional at-sunrise collapse used by the devotee view.
 */
export const panchangDays = pgTable('panchang_days', {
  id: id(),
  cityId: text('city_id').notNull().references(() => cities.id),
  school: panjikaSchoolEnum('school').notNull(),
  date: date('date').notNull(),
  bengaliDate: text('bengali_date'),            // '১৫ আষাঢ় ১৪৩৩'
  sunrise: ts('sunrise').notNull(),
  sunset: ts('sunset').notNull(),
  tithiAtSunrise: text('tithi_at_sunrise').notNull(),
  nakshatraAtSunrise: text('nakshatra_at_sunrise').notNull(),
  abhijitStart: ts('abhijit_start'),
  abhijitEnd: ts('abhijit_end'),
  rahuStart: ts('rahu_start'),
  rahuEnd: ts('rahu_end'),
  /** Set by the nightly job when the two schools differ on this date. Shown in the UI. */
  schoolsDisagree: boolean('schools_disagree').notNull().default(false),
  createdAt: created(),
}, (t) => ({
  uniq: uniqueIndex('panchang_days_uniq').on(t.cityId, t.school, t.date),
}));

/**
 * Per-ritual auspiciousness. A relational table rather than the original JSONB blob,
 * because "which dates are good for Griha Prabesh in the next 90 days" is the single
 * most common query in the product and JSONB makes it unindexable.
 */
export const muhuratFlags = pgTable('muhurat_flags', {
  id: id(),
  cityId: text('city_id').notNull().references(() => cities.id),
  school: panjikaSchoolEnum('school').notNull(),
  date: date('date').notNull(),
  ritualId: text('ritual_id').notNull().references(() => rituals.id),
  isAuspicious: boolean('is_auspicious').notNull(),
  /** Optional narrower window inside the day. */
  windowStart: ts('window_start'),
  windowEnd: ts('window_end'),
  note: text('note'),
  /** 'manual_panjika' for the hand-entered Gupta Press dates. ADR 0003. */
  source: panchangSourceEnum('source').notNull().default('api'),
  enteredBy: text('entered_by').references(() => users.id),
  createdAt: created(),
}, (t) => ({
  uniq: uniqueIndex('muhurat_flags_uniq').on(t.cityId, t.school, t.date, t.ritualId),
  lookup: index('muhurat_flags_lookup').on(t.cityId, t.school, t.ritualId, t.date),
}));

/**
 * Surge, separated from panchang.
 * The original design put a single surge_multiplier column on panchang_days, which
 * forces one multiplier onto every ritual on a date. Demand on a Griha Prabesh
 * muhurat says nothing about Sraddha demand - and surging a funeral rite because
 * weddings are busy reads as gouging. ritual_id NULL means city-wide.
 */
export const surgeRules = pgTable('surge_rules', {
  id: id(),
  cityId: text('city_id').notNull().references(() => cities.id),
  date: date('date').notNull(),
  ritualId: text('ritual_id').references(() => rituals.id),
  /** Basis points. 12000 = 1.2x. CHECK constraint caps at 15000 in the migration. */
  multiplierBps: integer('multiplier_bps').notNull().default(10000),
  source: text('source').notNull().default('auto'),   // auto | manual
  createdBy: text('created_by').references(() => users.id),
  createdAt: created(),
}, (t) => ({
  uniq: uniqueIndex('surge_rules_uniq').on(t.cityId, t.date, t.ritualId),
}));
