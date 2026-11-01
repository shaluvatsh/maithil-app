import {
  pgTable, text, integer, bigint, doublePrecision, timestamp,
  index, uniqueIndex,
} from 'drizzle-orm/pg-core';
import { users, cities } from './identity';
import { rituals } from './catalog';
import {
  eventHostKindEnum, eventKindEnum, eventRegistrationModeEnum, eventStateEnum,
  eventRegistrationStateEnum, geoPrecisionEnum, panjikaSchoolEnum, contentLocaleEnum,
} from './enums';

const id = () => text('id').primaryKey();
const ts = (n: string) => timestamp(n, { withTimezone: true, mode: 'string' });
const created = () => ts('created_at').notNull().defaultNow();
const updated = () => ts('updated_at').notNull().defaultNow();

/**
 * EVENTS — and they are NOT BOOKINGS. ADR 0015.
 *
 * Both occupy time and can take money, which is where the temptation to reuse
 * `bookings` comes from. Everything else differs: a booking is one devotee, one
 * purohit, one home address, escrow, an OTP handshake at the door, travel buffers,
 * refund tiers and TDS. An event is many devotees, one host, a public venue, no
 * travel, no samagri, and nobody knocks on a door.
 *
 * Forcing events through `bookingStateEnum` would put `cancelled_pandit`,
 * `in_progress` and `offlineCaptureAt` on a temple kirtan, and give `bookings` a
 * nullable `addressId` that is always null and a `samagriOption` that is always
 * `none`. Every one of those is a column that lies, and each weakens a state machine
 * that is currently correct and carries the money.
 *
 * What IS reused, because it genuinely is the same problem: the ledger, payment
 * intents, the outbox, `pincode_centroids`, the Redis hold pattern, the OTP-hash
 * pattern for check-in, and the panchang.
 *
 * Lives in the community context (ADR 0014): nothing in booking, ledger or payments
 * references anything here, so events stay droppable.
 */
export const events = pgTable('events', {
  id: id(),
  hostId: text('host_id').notNull().references(() => users.id),
  hostKind: eventHostKindEnum('host_kind').notNull(),
  kind: eventKindEnum('kind').notNull(),
  /** Set when the event is an instance of something the catalogue sells. */
  ritualId: text('ritual_id').references(() => rituals.id),

  title: text('title').notNull(),
  description: text('description').notNull(),
  /** Written in, not the app's language. Drives the font subset for this row. */
  locale: contentLocaleEnum('locale').notNull(),

  cityId: text('city_id').notNull().references(() => cities.id),
  venueName: text('venue_name').notNull(),
  venueLine1: text('venue_line1').notNull(),
  pincode: text('pincode'),
  lat: doublePrecision('lat').notNull(),
  lng: doublePrecision('lng').notNull(),
  /**
   * How precise that point actually is — the same honesty `addresses` keeps.
   *
   * A city-centroid event is not at a location: every event in Kolkata shares that
   * point, the distance between two of them is exactly zero, and a "2.3 km away"
   * label computed from it is a fiction. Discovery reads this and shows "in Kolkata"
   * instead of a number it cannot stand behind.
   */
  geoPrecision: geoPrecisionEnum('geo_precision').notNull().default('city'),

  /**
   * ABSOLUTE INSTANTS, never a local date plus a slot index.
   *
   * ADR 0006 learned this for bookings inside one city. Across a national feed a
   * local date is not even well defined — the feed spans fourteen cities, and every
   * "starts in 3 hours" is computed from these two columns alone.
   */
  startAt: ts('start_at').notNull(),
  endAt: ts('end_at').notNull(),
  /** Which almanac the host dated it by, so a reader can weigh it. */
  panjikaSchool: panjikaSchoolEnum('panjika_school'),

  registrationMode: eventRegistrationModeEnum('registration_mode').notNull().default('none'),
  state: eventStateEnum('state').notNull().default('draft'),
  /** Who vouched for a hosted event. Null on a listing, which nobody vouches for. */
  verifiedBy: text('verified_by').references(() => users.id),

  coverKey: text('cover_key'),
  /** An external page, for a listing that registers people somewhere else. */
  externalUrl: text('external_url'),

  cancelledAt: ts('cancelled_at'),
  cancelReason: text('cancel_reason'),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({
  /** Discovery's real predicate: what is published, here, and still to come. */
  discovery: index('events_discovery_idx').on(t.cityId, t.state, t.startAt),
  /**
   * The bounding-box prefilter. A btree on (lat, lng) cannot serve a radius query —
   * `CONTRIBUTING.md` says so — but it CAN serve the box that brackets one, which is
   * what the service does before ordering by haversine.
   */
  geo: index('events_geo_idx').on(t.lat, t.lng),
  hostIdx: index('events_host_idx').on(t.hostId, t.startAt),
}));

/**
 * A session is a thing you attend. CAPACITY LIVES HERE, not on `events`.
 *
 * A nine-day Chandi Paath is nine sessions and three daily aartis are three: each is
 * separately attended, separately full, and separately cancellable. Putting capacity
 * on the event would make "the Tuesday aarti is full" inexpressible.
 */
export const eventSessions = pgTable('event_sessions', {
  id: id(),
  eventId: text('event_id').notNull().references(() => events.id),
  startAt: ts('start_at').notNull(),
  endAt: ts('end_at').notNull(),
  /** Null means unlimited — an open-air tarpan at a ghat has no seat count. */
  capacity: integer('capacity'),
  /**
   * How far past `capacity` this session may be confirmed, in basis points.
   *
   * A COLUMN rather than a config read, for two reasons. The CHECK constraint has to
   * be able to evaluate the ceiling, and it can only see columns. And changing the
   * environment variable must not retroactively move the ceiling of a session people
   * have already taken places at — the factor is a property of the session from the
   * moment it is created.
   */
  oversellBps: integer('oversell_bps').notNull().default(10000),
  /**
   * THE TRUTH about how full this is, and the reason a CHECK can protect it.
   *
   * Counting `event_registrations` rows and comparing to capacity is a race, and
   * under festival load it oversells. This column plus `seats_within_capacity` plus
   * a `SELECT … FOR UPDATE` in the registration transaction is community's
   * equivalent of the ledger's balance trigger: the invariant is in the database,
   * so a code path that forgets the lock fails loudly instead of quietly seating
   * 210 people in a hall of 200.
   */
  seatsTaken: integer('seats_taken').notNull().default(0),
  pricePaise: bigint('price_paise', { mode: 'number' }).notNull().default(0),
  cancelledAt: ts('cancelled_at'),
  createdAt: created(),
}, (t) => ({
  eventIdx: index('event_sessions_event_idx').on(t.eventId, t.startAt),
}));

export const eventRegistrations = pgTable('event_registrations', {
  id: id(),
  sessionId: text('session_id').notNull().references(() => eventSessions.id),
  userId: text('user_id').notNull().references(() => users.id),
  seats: integer('seats').notNull().default(1),
  state: eventRegistrationStateEnum('state').notNull().default('confirmed'),
  /** Set while a seat is held during payment. Swept by Redis TTL, not by a job. */
  holdExpiresAt: ts('hold_expires_at'),
  /** The same hashed-code pattern a booking uses to prove someone turned up. */
  checkinCodeHash: text('checkin_code_hash'),
  checkedInAt: ts('checked_in_at'),
  /** Null on every free event, which is all of them until payments are wired. */
  paymentIntentId: text('payment_intent_id'),
  cancelledAt: ts('cancelled_at'),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({
  /**
   * One registration per person per session.
   *
   * Not per event: a household attending three days of a paath is three
   * registrations, and each can be cancelled on its own.
   */
  uniq: uniqueIndex('event_registrations_uniq').on(t.sessionId, t.userId),
  /** The host's attendee list, and the promotion sweep over the waitlist. */
  sessionIdx: index('event_registrations_session_idx').on(t.sessionId, t.state, t.createdAt),
  userIdx: index('event_registrations_user_idx').on(t.userId, t.createdAt),
}));
