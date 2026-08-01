import {
  pgTable, text, integer, date, time, timestamp, boolean, index, uniqueIndex,
} from 'drizzle-orm/pg-core';
import { cities, panditProfiles } from './identity';
import { slotStatusEnum, slotSourceEnum } from './enums';

const id = () => text('id').primaryKey();
const ts = (n: string) => timestamp(n, { withTimezone: true, mode: 'string' });

/**
 * Four slots per city per day. Note the 30-minute gaps: cross-Kolkata travel
 * routinely exceeds that, so real capacity is 2-3 slots/day, not 4. The income
 * model must use the real number. See ADR 0006.
 */
export const slotDefs = pgTable('slot_defs', {
  id: id(),
  cityId: text('city_id').notNull().references(() => cities.id),
  idx: integer('idx').notNull(),
  startTime: time('start_time').notNull(),
  endTime: time('end_time').notNull(),
  active: boolean('active').notNull().default(true),
}, (t) => ({
  uniq: uniqueIndex('slot_defs_uniq').on(t.cityId, t.idx),
}));

export const availability = pgTable('availability', {
  id: id(),
  panditId: text('pandit_id').notNull().references(() => panditProfiles.userId),
  date: date('date').notNull(),
  slotIdx: integer('slot_idx').notNull(),
  status: slotStatusEnum('status').notNull().default('open'),
  source: slotSourceEnum('source').notNull().default('default'),
  bookingId: text('booking_id'),
  /** Denormalised absolute instants - lets us filter by time without a join. */
  startsAt: ts('starts_at').notNull(),
  endsAt: ts('ends_at').notNull(),
}, (t) => ({
  /** THE guard against double-booking. Combined with FOR UPDATE at confirm time. */
  uniq: uniqueIndex('availability_uniq').on(t.panditId, t.date, t.slotIdx),
  search: index('availability_search').on(t.date, t.slotIdx, t.status),
  starts: index('availability_starts_idx').on(t.startsAt),
}));
