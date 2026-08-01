import {
  pgTable, text, integer, bigint, date, timestamp, boolean, jsonb,
  index, uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users, cities, addresses } from './identity';
import { rituals } from './catalog';
import {
  bookingStateEnum, paymentModeEnum, samagriOptionEnum, panjikaSchoolEnum,
} from './enums';

const id = () => text('id').primaryKey();
const ts = (n: string) => timestamp(n, { withTimezone: true, mode: 'string' });
const created = () => ts('created_at').notNull().defaultNow();

export const bookings = pgTable('bookings', {
  id: id(),
  devoteeId: text('devotee_id').notNull().references(() => users.id),
  panditId: text('pandit_id').notNull().references(() => users.id),
  ritualId: text('ritual_id').notNull().references(() => rituals.id),
  cityId: text('city_id').notNull().references(() => cities.id),
  addressId: text('address_id').references(() => addresses.id),

  date: date('date').notNull(),
  slotIdx: integer('slot_idx').notNull(),
  /** Contiguous slots occupied. ADR 0006. */
  slotSpan: integer('slot_span').notNull().default(1),
  /**
   * ABSOLUTE INSTANTS. Every deadline in the product is relative to slot start:
   * refund tiers at 24/48h, BOM lock at T-48h, T-1 reminders, the 2h accept window.
   * Without these columns none of those is indexable and all of them require
   * reconstructing a timestamp from slot_defs + city tz on every query.
   */
  slotStartAt: ts('slot_start_at').notNull(),
  slotEndAt: ts('slot_end_at').notNull(),

  /** Multi-day rituals (Biye) are linked bookings in R1. */
  parentBookingId: text('parent_booking_id'),

  state: bookingStateEnum('state').notNull().default('draft'),
  /** Snapshotted so a later preference change never rewrites history. ADR 0003. */
  panjikaSchool: panjikaSchoolEnum('panjika_school').notNull(),
  language: text('language').notNull().default('bn'),
  tradition: text('tradition'),
  attendeeCount: integer('attendee_count').notNull().default(10),
  sankalp: jsonb('sankalp'),                  // { name, gotra }

  samagriOption: samagriOptionEnum('samagri_option').notNull().default('pandit_brings'),
  bomSnapshot: jsonb('bom_snapshot'),         // frozen at confirmation
  /** Frozen PriceBreakdown from @themaithil/contracts. Never recomputed. */
  price: jsonb('price').notNull(),
  paymentMode: paymentModeEnum('payment_mode').notNull(),

  startOtpHash: text('start_otp_hash'),
  completeOtpHash: text('complete_otp_hash'),
  otpAttempts: integer('otp_attempts').notNull().default(0),

  acceptedAt: ts('accepted_at'),
  acceptDeadlineAt: ts('accept_deadline_at'),
  confirmedAt: ts('confirmed_at'),
  startedAt: ts('started_at'),
  completedAt: ts('completed_at'),
  cancelledAt: ts('cancelled_at'),
  cancelReason: text('cancel_reason'),

  cashCollectedPaise: bigint('cash_collected_paise', { mode: 'number' }),
  /** Set when an offline capture is awaiting server-side OTP validation. ADR: never settles. */
  offlineCaptureAt: ts('offline_capture_at'),
  completionLat: text('completion_lat'),
  completionLng: text('completion_lng'),

  createdAt: created(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, (t) => ({
  devoteeIdx: index('bookings_devotee_idx').on(t.devoteeId, t.state),
  panditIdx: index('bookings_pandit_idx').on(t.panditId, t.state),
  slotStartIdx: index('bookings_slot_start_idx').on(t.slotStartAt),
  stateIdx: index('bookings_state_idx').on(t.state, t.slotStartAt),
}));

/** Append-only audit spine. Every transition writes here, in the same transaction. */
export const bookingEvents = pgTable('booking_events', {
  id: id(),
  bookingId: text('booking_id').notNull().references(() => bookings.id),
  fromState: bookingStateEnum('from_state'),
  toState: bookingStateEnum('to_state').notNull(),
  trigger: text('trigger').notNull(),
  actorId: text('actor_id').references(() => users.id),
  actorRole: text('actor_role'),
  meta: jsonb('meta').notNull().default(sql`'{}'::jsonb`),
  at: created(),
}, (t) => ({
  bookingIdx: index('booking_events_booking_idx').on(t.bookingId, t.at),
}));

export const reviews = pgTable('reviews', {
  id: id(),
  bookingId: text('booking_id').notNull().references(() => bookings.id),
  author: text('author').notNull(),          // devotee | pandit
  panditStars: integer('pandit_stars'),
  punctualityStars: integer('punctuality_stars'),
  /** Rated separately so supply quality never pollutes the purohit's rating. */
  samagriStars: integer('samagri_stars'),
  devoteeStars: integer('devotee_stars'),
  text: text('text'),
  submittedAt: created(),
  /** Double-blind: set when both sides submit, or by the 72h job. */
  publishedAt: ts('published_at'),
}, (t) => ({
  uniq: uniqueIndex('reviews_uniq').on(t.bookingId, t.author),
}));
