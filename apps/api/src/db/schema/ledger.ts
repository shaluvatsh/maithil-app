import {
  pgTable, text, bigint, timestamp, jsonb, integer, date, index, uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './identity';
import { bookings } from './booking';
import {
  ledgerDirectionEnum, ledgerAccountTypeEnum, ledgerEntryTypeEnum,
  paymentIntentKindEnum, paymentIntentStatusEnum, payoutStatusEnum,
} from './enums';

const id = () => text('id').primaryKey();
const ts = (n: string) => timestamp(n, { withTimezone: true, mode: 'string' });
const created = () => ts('created_at').notNull().defaultNow();

export const ledgerAccounts = pgTable('ledger_accounts', {
  id: id(),
  ownerType: ledgerAccountTypeEnum('owner_type').notNull(),
  ownerId: text('owner_id'),
  currency: text('currency').notNull().default('INR'),
  createdAt: created(),
}, (t) => ({
  uniq: uniqueIndex('ledger_accounts_uniq').on(t.ownerType, t.ownerId),
}));

/**
 * Transaction header. Exists so the debits==credits invariant has a row to hang a
 * deferred constraint trigger on - in the original design the invariant lived only
 * in application code and a nightly job.
 */
export const ledgerTransactions = pgTable('ledger_transactions', {
  id: id(),
  bookingId: text('booking_id').references(() => bookings.id),
  kind: text('kind').notNull(),              // 'token_capture', 'settlement', ...
  description: text('description'),
  idempotencyKey: text('idempotency_key').unique(),
  createdAt: created(),
}, (t) => ({
  bookingIdx: index('ledger_txn_booking_idx').on(t.bookingId),
}));

export const ledgerEntries = pgTable('ledger_entries', {
  id: id(),
  txnId: text('txn_id').notNull().references(() => ledgerTransactions.id),
  accountId: text('account_id').notNull().references(() => ledgerAccounts.id),
  bookingId: text('booking_id').references(() => bookings.id),
  direction: ledgerDirectionEnum('direction').notNull(),
  amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
  type: ledgerEntryTypeEnum('type').notNull(),
  meta: jsonb('meta').notNull().default(sql`'{}'::jsonb`),
  at: created(),
}, (t) => ({
  txnIdx: index('ledger_entries_txn_idx').on(t.txnId),
  acctIdx: index('ledger_entries_acct_idx').on(t.accountId, t.at),
  typeIdx: index('ledger_entries_type_idx').on(t.type, t.at),
}));

export const paymentIntents = pgTable('payment_intents', {
  id: id(),
  bookingId: text('booking_id').references(() => bookings.id),
  userId: text('user_id').notNull().references(() => users.id),
  kind: paymentIntentKindEnum('kind').notNull(),
  aggregator: text('aggregator').notNull().default('razorpay'),
  aggregatorOrderId: text('aggregator_order_id'),
  aggregatorPaymentId: text('aggregator_payment_id'),
  amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
  status: paymentIntentStatusEnum('status').notNull().default('created'),
  method: text('method'),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  capturedAt: ts('captured_at'),
  createdAt: created(),
}, (t) => ({
  bookingIdx: index('payment_intents_booking_idx').on(t.bookingId),
}));

export const payouts = pgTable('payouts', {
  id: id(),
  panditId: text('pandit_id').notNull().references(() => users.id),
  periodStart: date('period_start').notNull(),
  periodEnd: date('period_end').notNull(),
  grossPaise: bigint('gross_paise', { mode: 'number' }).notNull(),
  duesRecoveredPaise: bigint('dues_recovered_paise', { mode: 'number' }).notNull().default(0),
  tdsPaise: bigint('tds_paise', { mode: 'number' }).notNull().default(0),
  feePaise: bigint('fee_paise', { mode: 'number' }).notNull().default(0),
  netPaise: bigint('net_paise', { mode: 'number' }).notNull(),
  aggregatorRef: text('aggregator_ref'),
  status: payoutStatusEnum('status').notNull().default('pending'),
  createdAt: created(),
}, (t) => ({
  panditIdx: index('payouts_pandit_idx').on(t.panditId, t.periodEnd),
}));

/** Exactly-once webhook processing, with a replay path the original design lacked. */
export const webhookEvents = pgTable('webhook_events', {
  id: id(),
  provider: text('provider').notNull(),
  providerEventId: text('provider_event_id').notNull(),
  payload: jsonb('payload').notNull(),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  processedAt: ts('processed_at'),
  createdAt: created(),
}, (t) => ({
  uniq: uniqueIndex('webhook_events_uniq').on(t.provider, t.providerEventId),
  pending: index('webhook_events_pending').on(t.processedAt),
}));
