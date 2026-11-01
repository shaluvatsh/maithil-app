import {
  pgTable, text, integer, bigint, timestamp, jsonb, boolean,
  index, uniqueIndex, primaryKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './identity';
import { bookings } from './booking';
import { disputeTypeEnum, disputeStateEnum, localeEnum } from './enums';

const id = () => text('id').primaryKey();
const ts = (n: string) => timestamp(n, { withTimezone: true, mode: 'string' });
const created = () => ts('created_at').notNull().defaultNow();

/**
 * TRANSACTIONAL OUTBOX. Written inside the same transaction as the state change,
 * relayed to BullMQ afterwards. Without this, a crash between COMMIT and PUBLISH
 * leaves a booking confirmed with no downstream side effects. See ADR 0005.
 */
export const outbox = pgTable('outbox', {
  id: id(),
  aggregateType: text('aggregate_type').notNull(),   // 'booking'
  aggregateId: text('aggregate_id').notNull(),
  eventType: text('event_type').notNull(),           // 'booking.confirmed'
  payload: jsonb('payload').notNull(),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  publishedAt: ts('published_at'),
  /**
   * A lease, not a lock. The relay used to hold one Postgres transaction (and its
   * pooled connection) open across the WHOLE batch's publish calls so a row's lock
   * would block a second instance from claiming it too - correct, but it meant up to
   * 100 sequential, awaited external HTTP calls (the WhatsApp send) ran with a
   * connection checked out of the same small pool every other request shares. A slow
   * BSP response stalled that connection, and everything else on the instance
   * competing for the pool, for as long as the batch took.
   *
   * `claimedAt` lets the claim be a single fast UPDATE that commits immediately,
   * releasing the connection before a single publish() call happens. A second
   * instance skips a freshly-claimed row without waiting on a lock; a row whose
   * claimant crashed mid-batch becomes reclaimable again once CLAIM_VISIBILITY_MS
   * has passed, rather than being held forever by a lock nobody will ever release.
   */
  claimedAt: ts('claimed_at'),
  createdAt: created(),
}, (t) => ({
  /** The relay's hot path: unclaimed-or-stale, unpublished, oldest first. */
  unpublished: index('outbox_unpublished').on(t.publishedAt, t.claimedAt, t.id),
  aggregate: index('outbox_aggregate').on(t.aggregateType, t.aggregateId),
}));

/** Consumer-side dedupe. The outbox is at-least-once; consumers must be idempotent. */
export const processedEvents = pgTable('processed_events', {
  consumer: text('consumer').notNull(),
  eventId: text('event_id').notNull(),
  processedAt: created(),
}, (t) => ({
  uniq: uniqueIndex('processed_events_uniq').on(t.consumer, t.eventId),
}));

/** Required by the PRD ("every admin mutation audit-logged"), absent from the handoff. */
export const auditLog = pgTable('audit_log', {
  id: id(),
  actorId: text('actor_id').references(() => users.id),
  actorRole: text('actor_role'),
  action: text('action').notNull(),                  // 'booking.refund_issued'
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  before: jsonb('before'),
  after: jsonb('after'),
  ip: text('ip'),
  at: created(),
}, (t) => ({
  entityIdx: index('audit_log_entity_idx').on(t.entityType, t.entityId, t.at),
  actorIdx: index('audit_log_actor_idx').on(t.actorId, t.at),
}));

/**
 * Idempotency for non-payment mutations. /complete is the endpoint most likely to
 * be retried - it is on the offline-sync path - and in token+balance mode it
 * triggers a charge. The original design covered payments and webhooks only.
 */
export const idempotencyKeys = pgTable('idempotency_keys', {
  // Scoped to (userId, key), not key alone: a client-supplied key is only unique
  // within one caller's own requests. A shared PK on key meant one user's key
  // collided with any other user who happened to send the same value - reading
  // back a stranger's cached response, or being locked out by ANOTHER user's
  // in-flight request. See ADR/review note on idempotency scoping.
  key: text('key').notNull(),
  userId: text('user_id').notNull().references(() => users.id),
  endpoint: text('endpoint').notNull(),
  requestHash: text('request_hash').notNull(),
  responseStatus: integer('response_status'),
  responseBody: jsonb('response_body'),
  createdAt: created(),
  expiresAt: ts('expires_at').notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.key] }),
  expiryIdx: index('idempotency_expiry_idx').on(t.expiresAt),
}));

/**
 * Promos. The settlement algorithm in the handoff cites "waived-token promo" as the
 * origin of cash dues, but no promo table existed - the one feature that creates dues
 * had no data model.
 */
export const promoCodes = pgTable('promo_codes', {
  id: id(),
  code: text('code').notNull().unique(),
  /** Applied to the platform fee only, capped at it. See pricing.ts. */
  discountBps: integer('discount_bps'),
  discountFlatPaise: bigint('discount_flat_paise', { mode: 'number' }),
  maxRedemptions: integer('max_redemptions'),
  perUserLimit: integer('per_user_limit').notNull().default(1),
  validFrom: ts('valid_from').notNull(),
  validUntil: ts('valid_until').notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: created(),
});

export const promoRedemptions = pgTable('promo_redemptions', {
  id: id(),
  promoId: text('promo_id').notNull().references(() => promoCodes.id),
  userId: text('user_id').notNull().references(() => users.id),
  bookingId: text('booking_id').notNull().references(() => bookings.id),
  discountPaise: bigint('discount_paise', { mode: 'number' }).notNull(),
  at: created(),
}, (t) => ({
  uniq: uniqueIndex('promo_redemptions_uniq').on(t.promoId, t.bookingId),
  userIdx: index('promo_redemptions_user_idx').on(t.userId, t.promoId),
}));

export const disputes = pgTable('disputes', {
  id: id(),
  bookingId: text('booking_id').notNull().references(() => bookings.id),
  type: disputeTypeEnum('type').notNull(),
  state: disputeStateEnum('state').notNull().default('open'),
  raisedBy: text('raised_by').references(() => users.id),
  evidence: jsonb('evidence').notNull().default(sql`'{}'::jsonb`),
  resolution: text('resolution'),
  resolvedBy: text('resolved_by').references(() => users.id),
  /** SLA columns - the PRD promises <2h first response and <48h resolution. */
  firstResponseAt: ts('first_response_at'),
  resolvedAt: ts('resolved_at'),
  createdAt: created(),
}, (t) => ({
  openIdx: index('disputes_open_idx').on(t.state, t.createdAt),
  bookingIdx: index('disputes_booking_idx').on(t.bookingId),
}));

export const notificationTemplates = pgTable('notification_templates', {
  id: id(),
  key: text('key').notNull(),                 // 'booking.confirmed.devotee'
  locale: localeEnum('locale').notNull(),
  channel: text('channel').notNull(),         // whatsapp | sms | push
  /** BSP-approved template name. Approval takes 1-2 weeks per batch - see P0-0. */
  providerTemplateName: text('provider_template_name'),
  body: text('body').notNull(),
  active: boolean('active').notNull().default(true),
}, (t) => ({
  uniq: uniqueIndex('notification_templates_uniq').on(t.key, t.locale, t.channel),
}));

export const notifications = pgTable('notifications', {
  id: id(),
  /**
   * Null for a message sent to a phone that has no account — a login OTP, which is
   * delivered before the account exists. Every other notification is about a
   * booking, and a booking always has two known parties.
   */
  userId: text('user_id').references(() => users.id),
  templateKey: text('template_key').notNull(),
  channel: text('channel').notNull(),
  payload: jsonb('payload').notNull(),
  status: text('status').notNull().default('queued'),
  providerRef: text('provider_ref'),
  sentAt: ts('sent_at'),
  deliveredAt: ts('delivered_at'),
  failedReason: text('failed_reason'),
  createdAt: created(),
}, (t) => ({
  userIdx: index('notifications_user_idx').on(t.userId, t.createdAt),
}));

/**
 * One anniversary reminder per household, per ritual, per year.
 *
 * The primary key IS the deduplication. `AnniversaryJob` inserts here BEFORE it
 * sends, so a retry after a crash mid-batch cannot produce a second message — the
 * conflict is what tells the job it has already nudged this household. Doing it the
 * other way round (send, then record) drops a duplicate on every family whenever the
 * process dies between the two.
 *
 * Rows are kept rather than expired: they are the record of what we sent, and a
 * household that lapses and returns three years later should not be re-nudged for
 * the years they were away.
 */
export const anniversaryNudges = pgTable('anniversary_nudges', {
  devoteeId: text('devotee_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  ritualId: text('ritual_id').notNull(),
  /** Calendar year (IST) the reminder was sent for, not the year of the puja. */
  year: integer('year').notNull(),
  // Spelled out rather than using the `created()` helper, which names its column
  // `created_at` — the migration creates `sent_at`, and the mismatch made every
  // insert fail on a column that does not exist.
  sentAt: ts('sent_at').notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.devoteeId, t.ritualId, t.year] }),
}));

/**
 * WHY A PUROHIT GOT, OR DID NOT GET, A BOOKING.
 *
 * ADR 0012 ended with a requirement that was never built: *"Matching is now
 * load-bearing. It was a sort order over a list the user could override; it is now
 * the allocation of work and income. A bug in the weights is a bug in someone's
 * livelihood. The weights need to be observable — log the chosen purohit and the
 * runner-up per booking."*
 *
 * Without this row there is no way to answer either of the two questions that matter.
 * Ours: are the weights doing what we think, or is one purohit quietly taking
 * everything again? Theirs: why has my work dried up? A purohit whose income halved
 * deserves better than "the algorithm", and an allocation nobody can reconstruct is
 * an allocation nobody can defend.
 *
 * `weights` is snapshotted alongside the scores. They are constants today, but an
 * allocation from last month explained with this month's weights is a wrong
 * explanation — and being able to explain is the only reason this table exists.
 *
 * Append-only by intent and written best-effort: `matchPandit` swallows a failure
 * here, because a booking that happened and was not logged is a gap in a diary,
 * while a booking that did not happen because the diary was full is an outage.
 */
export const matchDecisions = pgTable('match_decisions', {
  id: id(),
  bookingId: text('booking_id').notNull().references(() => bookings.id),
  ritualId: text('ritual_id').notNull(),
  /** Null when nobody was available — itself a fact worth being able to count. */
  chosenPanditId: text('chosen_pandit_id').references(() => users.id),
  /** Numeric as text: the score is for reading and comparing, never for arithmetic. */
  chosenScore: text('chosen_score'),
  weights: jsonb('weights').notNull(),
  /**
   * The top candidates with their score components — including whoever had already
   * declined, flagged, so a purohit who lost work to their own answer is not told
   * they were outranked.
   */
  candidates: jsonb('candidates').notNull(),
  at: created(),
}, (t) => ({
  bookingIdx: index('match_decisions_booking_idx').on(t.bookingId),
  /** The purohit-facing query: my allocations, newest first. */
  chosenIdx: index('match_decisions_chosen_idx').on(t.chosenPanditId, t.at),
}));
