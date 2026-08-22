import {
  pgTable, text, timestamp, boolean, integer, bigint, doublePrecision,
  numeric, index, uniqueIndex, jsonb,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { userRoleEnum, localeEnum, panjikaSchoolEnum, kycStatusEnum, kycTypeEnum, payoutMethodEnum } from './enums';

const id = () => text('id').primaryKey();
const ts = (n: string) => timestamp(n, { withTimezone: true, mode: 'string' });
const created = () => ts('created_at').notNull().defaultNow();
const updated = () => ts('updated_at').notNull().defaultNow();

export const cities = pgTable('cities', {
  id: id(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  tz: text('tz').notNull().default('Asia/Kolkata'),
  /** Which panjika the majority here follows - the default we show, never a lock. */
  defaultPanjikaSchool: panjikaSchoolEnum('default_panjika_school')
    .notNull().default('gupta_press'),
  active: boolean('active').notNull().default(true),
  createdAt: created(),
});

export const users = pgTable('users', {
  id: id(),
  phone: text('phone').notNull().unique(),
  name: text('name'),
  email: text('email'),
  /** scrypt, encoded as N$r$p$salt$hash. Null for OTP-only accounts. */
  passwordHash: text('password_hash'),
  emailVerifiedAt: ts('email_verified_at'),
  role: userRoleEnum('role').notNull().default('devotee'),
  locale: localeEnum('locale').notNull().default('bn'),
  /**
   * Which almanac this family follows. Nullable = "not sure, show me both".
   * Snapshotted onto every booking so changing it never rewrites history.
   */
  panjikaSchool: panjikaSchoolEnum('panjika_school'),
  cityId: text('city_id').references(() => cities.id),
  referralCode: text('referral_code').unique(),
  referredBy: text('referred_by'),
  /**
   * NOTE: there is deliberately NO credits_paise column here.
   * Devotee credit is derived from the ledger. One number, one source. ADR 0004.
   */
  status: text('status').notNull().default('active'),
  deletedAt: ts('deleted_at'),           // DPDP tombstone; financial rows survive
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({
  roleIdx: index('users_role_idx').on(t.role),
}));

export const addresses = pgTable('addresses', {
  id: id(),
  userId: text('user_id').notNull().references(() => users.id),
  label: text('label'),
  line1: text('line1').notNull(),
  line2: text('line2'),
  cityId: text('city_id').notNull().references(() => cities.id),
  pincode: text('pincode').notNull(),
  lat: doublePrecision('lat').notNull(),
  lng: doublePrecision('lng').notNull(),
  createdAt: created(),
}, (t) => ({
  userIdx: index('addresses_user_idx').on(t.userId),
}));

export const panditProfiles = pgTable('pandit_profiles', {
  userId: text('user_id').primaryKey().references(() => users.id),
  bio: text('bio'),
  experienceYears: integer('experience_years').notNull().default(0),
  traditions: text('traditions').array().notNull().default(sql`ARRAY[]::text[]`),
  languages: text('languages').array().notNull().default(sql`ARRAY[]::text[]`),
  serviceRadiusKm: integer('service_radius_km').notNull().default(15),
  baseLat: doublePrecision('base_lat'),
  baseLng: doublePrecision('base_lng'),
  /**
   * A 30-second recording of them chanting, and what they are reciting.
   * Devotees judge shuddha uchcharan and nobody in this category lets them hear it.
   */
  chantingSampleUrl: text('chanting_sample_url'),
  chantingSampleLabel: text('chanting_sample_label'),
  kycStatus: kycStatusEnum('kyc_status').notNull().default('pending'),
  kycVerifiedAt: ts('kyc_verified_at'),
  kycExpiresAt: ts('kyc_expires_at'),
  badges: jsonb('badges').notNull().default(sql`'[]'::jsonb`),
  /** Raw average, for display. The RANKING uses a Bayesian prior - see search service. */
  ratingSum: integer('rating_sum').notNull().default(0),
  ratingCount: integer('rating_count').notNull().default(0),
  acceptanceRate: numeric('acceptance_rate', { precision: 5, scale: 4 }),
  cashCreditLimitPaise: bigint('cash_credit_limit_paise', { mode: 'number' })
    .notNull().default(500000),
  cashJobsEnabled: boolean('cash_jobs_enabled').notNull().default(true),
  autoAccept: boolean('auto_accept').notNull().default(false),
  /**
   * Where the money goes.
   *
   * `linkedAccountId` is the provider's opaque handle for the purohit's account and
   * is the ONLY thing a transfer needs. The account number is sent to the provider
   * once, when the linked account is created, and never stored here — so this table
   * is not a list of bank accounts, and a payout is addressed to a token rather than
   * to digits. `payoutLast4` and `payoutIfsc` exist so a purohit can recognise which
   * account they gave us; an IFSC identifies a branch, not a person.
   */
  linkedAccountId: text('linked_account_id'),
  payoutMethod: payoutMethodEnum('payout_method'),
  payoutHolderName: text('payout_holder_name'),
  payoutLast4: text('payout_last4'),
  payoutIfsc: text('payout_ifsc'),
  payoutUpiVpa: text('payout_upi_vpa'),
  payoutLinkedAt: ts('payout_linked_at'),
  /** Cold-start: guaranteed impressions until this hits zero. See search service. */
  newSupplyBoostRemaining: integer('new_supply_boost_remaining').notNull().default(20),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({
  kycIdx: index('pandit_kyc_idx').on(t.kycStatus),
  geoIdx: index('pandit_geo_idx').on(t.baseLat, t.baseLng),
}));

export const kycRecords = pgTable('kyc_records', {
  id: id(),
  panditId: text('pandit_id').notNull().references(() => panditProfiles.userId),
  type: kycTypeEnum('type').notNull(),
  status: kycStatusEnum('status').notNull().default('pending'),
  /** 'manual' in R1. Becomes 'digilocker' later with no migration. ADR 0010. */
  provider: text('provider').notNull().default('manual'),
  providerRef: text('provider_ref'),
  /** Last 4 digits ONLY. A raw Aadhaar number is never stored. Ever. */
  identifierLast4: text('identifier_last4'),
  docKey: text('doc_key'),                 // R2 object key, deleted 30d post-approval
  docPurgeAfter: ts('doc_purge_after'),
  reviewedBy: text('reviewed_by').references(() => users.id),
  reviewNotes: text('review_notes'),
  expiresAt: ts('expires_at'),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({
  panditIdx: index('kyc_pandit_idx').on(t.panditId, t.type),
}));
