import {
  pgTable, text, integer, bigint, boolean, numeric, timestamp, jsonb,
  primaryKey, index,
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
  /**
   * Consecutive days this ritual runs over. 1 for almost everything.
   *
   * A Durga Puja is four days and a full Chandi Paath can be nine: the same purohit,
   * the same house, the same hour, on consecutive dates — each performed, and each
   * able to go wrong on its own. `parent_booking_id` has existed since the first
   * migration to express exactly that and nothing ever wrote it. See ADR 0006 and
   * `BookingService.createDraft`.
   */
  days: integer('days').notNull().default(1),
  /** Whether muhurat matters. Tarpan is date-fixed; Satyanarayan is flexible. */
  isMuhuratSensitive: boolean('is_muhurat_sensitive').notNull().default(true),
  /** Browse taxonomy. Owned by packages/region — see categories.ts. */
  category: text('category').notNull().default('festival-pujas'),
  /**
   * `virtual` services have no travel, no samagri and no address — the purohit
   * never leaves their own home. Slot booking, the ledger and settlement are all
   * unchanged; only the price inputs and the venue differ.
   */
  deliveryMode: text('delivery_mode').notNull().default('at_home'),
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
  /**
   * Price for the quantity on THIS line — ₹180 against qty '250', unit 'g' means
   * ₹180 for 250 g. It is not a unit rate, so never multiply it by `qty`.
   */
  linePricePaise: bigint('line_price_paise', { mode: 'number' }).notNull(),
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

/**
 * Membership plans.
 *
 * The home page advertised a plan with a price, a discount, a saving and a
 * countdown, all of them string literals in a React component. Nobody could buy
 * it and the countdown counted down from nothing. A plan is now a row: if there
 * is no row, the page shows no offer.
 */
export const membershipPlans = pgTable('membership_plans', {
  id: id(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  tagline: text('tagline').notNull().default(''),
  pricePaise: bigint('price_paise', { mode: 'number' }).notNull(),
  /** How long the membership lasts once bought, not how long it is on sale. */
  durationDays: integer('duration_days').notNull(),
  /** Basis points off the ritual subtotal. A percentage as a float is a rounding dispute. */
  discountBps: integer('discount_bps').notNull(),
  benefits: jsonb('benefits').$type<string[]>().notNull().default([]),
  /** Null means on sale indefinitely; a date is what the countdown reads. */
  offerEndsOn: text('offer_ends_on'),
  active: boolean('active').notNull().default(true),
  /**
   * Distinct from `active`. `active` means "show this offer"; this means "money can
   * change hands for it". Today the discount is not enforced at booking time, so a
   * working Join button would charge for a benefit nothing applies.
   */
  purchasable: boolean('purchasable').notNull().default(false),
  createdAt: created(),
});

/** A membership priced for Mumbai is not priced for Patna. */
export const membershipCityPrices = pgTable('membership_city_prices', {
  planId: text('plan_id').notNull().references(() => membershipPlans.id, { onDelete: 'cascade' }),
  cityId: text('city_id').notNull().references(() => cities.id, { onDelete: 'cascade' }),
  pricePaise: bigint('price_paise', { mode: 'number' }).notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.planId, t.cityId] }) }));
