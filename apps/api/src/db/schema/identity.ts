import {
  pgTable, text, timestamp, boolean, integer, bigint, doublePrecision,
  numeric, index, uniqueIndex, jsonb,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  userRoleEnum, localeEnum, panjikaSchoolEnum, kycStatusEnum, kycTypeEnum, qualificationLevelEnum,
  payoutMethodEnum, geoPrecisionEnum,
} from './enums';

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
  /**
   * Bumped to end every session for this account at once. See migration 0032 and
   * `AuthService.refresh` for why a counter rather than a denylist, and for the
   * window this does and does not close.
   */
  tokenVersion: integer('token_version').notNull().default(0),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({
  roleIdx: index('users_role_idx').on(t.role),
  /**
   * Case-insensitive and partial, matching `0015_users_email_unique.sql`. Declared
   * here so the schema tells the truth about what the database enforces; the
   * migration is what actually creates it. `lower(email)` because that is how
   * `loginWithPassword` looks an account up, and `WHERE email IS NOT NULL` because
   * every OTP-only account leaves it null.
   */
  emailLowerUniq: uniqueIndex('users_email_lower_uniq')
    .on(sql`lower(${t.email})`)
    .where(sql`${t.email} IS NOT NULL`),
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
  /**
   * Where `lat`/`lng` came from. Never decorative: travel time between two
   * addresses is computed from these points (ADR 0013), and two `city`-precision
   * addresses in the same city are the SAME point, so the distance between them
   * is zero and the buffer derived from it is a fiction. The scheduler reads this
   * to decide how much margin to add, and ops can see how much of the book is
   * actually locatable.
   */
  geoPrecision: geoPrecisionEnum('geo_precision').notNull().default('city'),
  createdAt: created(),
}, (t) => ({
  userIdx: index('addresses_user_idx').on(t.userId),
}));

/**
 * Pincode centroids — the middle tier of address resolution.
 *
 * A city centroid is useless for travel (every address in Kolkata is one point);
 * a rooftop coordinate needs a paid geocoder or the devotee's own device. A
 * pincode sits between them: Kolkata is ~200 km2 and a pincode within it is a
 * couple of km across, which is enough to tell Gariahat from Salt Lake and
 * therefore enough for a travel estimate to mean something.
 *
 * Deliberately a table rather than a constant in `packages/region`: it is ~19,000
 * rows for India, it is third-party data with its own provenance and refresh
 * cycle, and it must be loadable without a deploy. `source` records where a row
 * came from so a bad import can be identified and replaced rather than guessed at.
 *
 * Empty is a valid state — resolution falls back to the city centroid and says so
 * via `geo_precision`. Nothing here is invented: rows arrive from a dataset.
 */
export const pincodeCentroids = pgTable('pincode_centroids', {
  pincode: text('pincode').primaryKey(),
  lat: doublePrecision('lat').notNull(),
  lng: doublePrecision('lng').notNull(),
  /** Where the row came from, e.g. 'india-post-2024'. Not free text for humans. */
  source: text('source').notNull(),
  createdAt: created(),
});

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
  /**
   * Written on approval, read by nothing — and deliberately so.
   *
   * Annual re-verification is not a requirement of this product, so nothing sweeps
   * this date and no purohit is ever expired by it. Kept because `expired` remains a
   * valid, unbookable status if that changes; a column that nothing enforces is only
   * a trap when its name implies otherwise, which this note is here to prevent.
   */
  kycExpiresAt: ts('kyc_expires_at'),
  /**
   * The photo devotees see, as an object key.
   *
   * Not a `kyc_records` row: those are private, seen only by a reviewer, and purged
   * thirty days after a decision (ADR 0010). Filing the profile photo among them
   * would schedule its own deletion. Its key prefix is `profile/`, not `kyc/`, so a
   * purge sweep cannot reach it by accident either.
   */
  photoKey: text('photo_key'),
  /**
   * When the purohit handed their application to us, not when they signed up.
   *
   * The review queue ordered by `createdAt`, so someone who joined months ago and
   * submitted this morning outranked someone who did both yesterday.
   */
  submittedAt: ts('submitted_at'),
  /**
   * What the purohit claims, separate from the certificate that proves it.
   *
   * The certificate is a `kyc_records` row and is purged 30 days after a decision
   * (ADR 0010). This outlives it, so an operator reviewing an old approval can still
   * see what was claimed once the image is gone.
   */
  highestQualification: qualificationLevelEnum('highest_qualification'),
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
