import {
  pgTable, text, integer, bigint, boolean, numeric, timestamp,
  primaryKey, index, uniqueIndex,
} from 'drizzle-orm/pg-core';
import { cities, panditProfiles } from './identity';
import { localeEnum } from './enums';

const id = () => text('id').primaryKey();
const ts = (n: string) => timestamp(n, { withTimezone: true, mode: 'string' });
const created = () => ts('created_at').notNull().defaultNow();

export const rituals = pgTable('rituals', {
  id: id(),
  slug: text('slug').notNull().unique(),
  durationMin: integer('duration_min').notNull(),
  /** Contiguous 3h slots this occupies. Biye needs 2+. See ADR 0006. */
  defaultSlotSpan: integer('default_slot_span').notNull().default(1),
  /** Whether muhurat matters. Tarpan is date-fixed; Satyanarayan is flexible. */
  isMuhuratSensitive: boolean('is_muhurat_sensitive').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(100),
  active: boolean('active').notNull().default(true),
  createdAt: created(),
});

/**
 * i18n lives here, not on `rituals`. Bengali is required at seed time;
 * hi/en may fall back. See ADR 0009.
 */
export const ritualTranslations = pgTable('ritual_translations', {
  ritualId: text('ritual_id').notNull().references(() => rituals.id),
  locale: localeEnum('locale').notNull(),
  name: text('name').notNull(),
  shortDescription: text('short_description').notNull(),
  description: text('description').notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.ritualId, t.locale] }),
}));

export const ritualCityPrices = pgTable('ritual_city_prices', {
  ritualId: text('ritual_id').notNull().references(() => rituals.id),
  cityId: text('city_id').notNull().references(() => cities.id),
  bandMinPaise: bigint('band_min_paise', { mode: 'number' }).notNull(),
  bandMaxPaise: bigint('band_max_paise', { mode: 'number' }).notNull(),
  defaultPaise: bigint('default_paise', { mode: 'number' }).notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.ritualId, t.cityId] }),
}));

export const panditRituals = pgTable('pandit_rituals', {
  panditId: text('pandit_id').notNull().references(() => panditProfiles.userId),
  ritualId: text('ritual_id').notNull().references(() => rituals.id),
  pricePaise: bigint('price_paise', { mode: 'number' }).notNull(),
  active: boolean('active').notNull().default(true),
}, (t) => ({
  pk: primaryKey({ columns: [t.panditId, t.ritualId] }),   // was missing in the handoff
  ritualIdx: index('pandit_rituals_ritual_idx').on(t.ritualId, t.active),
}));

export const boms = pgTable('boms', {
  id: id(),
  ritualId: text('ritual_id').notNull().references(() => rituals.id),
  cityId: text('city_id').references(() => cities.id),
  tradition: text('tradition'),
  version: integer('version').notNull().default(1),
  status: text('status').notNull().default('active'),   // draft | active | retired
  createdAt: created(),
}, (t) => ({
  ritualIdx: index('boms_ritual_idx').on(t.ritualId, t.status),
}));

export const bomItems = pgTable('bom_items', {
  id: id(),
  bomId: text('bom_id').notNull().references(() => boms.id),
  /** NUMERIC, not integer - "1.5 kg" and "0.25 tola" are real BOM lines. */
  qty: numeric('qty', { precision: 10, scale: 3 }).notNull(),
  unit: text('unit').notNull(),
  grade: text('grade'),
  catalogPricePaise: bigint('catalog_price_paise', { mode: 'number' }).notNull(),
  perishable: boolean('perishable').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
}, (t) => ({
  bomIdx: index('bom_items_bom_idx').on(t.bomId),
}));

export const bomItemTranslations = pgTable('bom_item_translations', {
  bomItemId: text('bom_item_id').notNull().references(() => bomItems.id),
  locale: localeEnum('locale').notNull(),
  name: text('name').notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.bomItemId, t.locale] }),
}));
