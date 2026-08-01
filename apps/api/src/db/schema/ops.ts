import {
  pgTable, text, integer, bigint, timestamp, jsonb, boolean, date,
  index, uniqueIndex,
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
  createdAt: created(),
}, (t) => ({
  /** The relay's hot path: unpublished, oldest first, SKIP LOCKED. */
  unpublished: index('outbox_unpublished').on(t.publishedAt, t.id),
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
  key: text('key').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  endpoint: text('endpoint').notNull(),
  requestHash: text('request_hash').notNull(),
  responseStatus: integer('response_status'),
  responseBody: jsonb('response_body'),
  createdAt: created(),
  expiresAt: ts('expires_at').notNull(),
}, (t) => ({
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
  userId: text('user_id').notNull().references(() => users.id),
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
