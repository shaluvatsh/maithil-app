import {
  pgTable, text, integer, timestamp, boolean, jsonb,
  index, uniqueIndex, primaryKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users, cities } from './identity';
import { rituals } from './catalog';
import {
  contentLocaleEnum, communityScopeEnum, communitySpaceKindEnum,
  communityPostingPolicyEnum, communityPostKindEnum, communityPostStateEnum,
  communityReactionKindEnum, communityTrustLevelEnum,
  communityReportReasonEnum, communityReportStateEnum, panjikaSchoolEnum,
} from './enums';

const id = () => text('id').primaryKey();
const ts = (n: string) => timestamp(n, { withTimezone: true, mode: 'string' });
const created = () => ts('created_at').notNull().defaultNow();
const updated = () => ts('updated_at').notNull().defaultNow();

/**
 * COMMUNITY — a separate bounded context. ADR 0014.
 *
 * The rule that keeps it separate: nothing in booking, ledger or payments may hold a
 * foreign key into this file. Community may reference `users`, `cities` and
 * `rituals`; the arrow never points the other way. The test is whether you could
 * DROP every table here and still take a booking. If not, the coupling is wrong and
 * a moderation incident is now a marketplace outage.
 *
 * Three things break here that hold everywhere else in this codebase, and every
 * design decision below follows from one of them:
 *
 *   1. There is no single region per request. A feed mixes cities, scripts and
 *      almanacs in one list, so scope is a COLUMN (Law 1) and the reader's region
 *      cannot be used to format the writer's content.
 *   2. The content is authored by strangers, in languages nobody on the team reads.
 *      Hence `content_locale` rather than `locale`, and hence moderation as a
 *      structural property of spaces rather than a review queue bolted on later.
 *   3. These tables grow with READS, not with bookings. Counters are columns,
 *      pagination is keyset, and the hot indexes are partial. See Law 3.
 */

/**
 * Where a conversation lives.
 *
 * Spaces are scoped to a ritual, a city, a tradition or a festival — never a general
 * "discussion" room by default. That is deliberate and it is the cheapest moderation
 * decision available: a thread has to live under "Annaprashan" or "Kolkata", so
 * "is Hinduism under threat" has nowhere to sit. `general` exists as a value because
 * it will eventually be wanted, not because it should be opened at launch.
 *
 * A row here, not a constant in `packages/region`: ops open a space for Chhath or
 * Pongal without a deploy, which is the whole point of Tier 4.
 */
export const communitySpaces = pgTable('community_spaces', {
  id: id(),
  slug: text('slug').notNull().unique(),
  kind: communitySpaceKindEnum('kind').notNull(),

  /** Law 1. The pairing with city_id / state_name is a CHECK, not a service rule. */
  scope: communityScopeEnum('scope').notNull(),
  cityId: text('city_id').references(() => cities.id),
  /** Mirrors `Region.state`, which is a display name today. Region owns that shape. */
  stateName: text('state_name'),

  ritualId: text('ritual_id').references(() => rituals.id),
  tradition: text('tradition'),

  postingPolicy: communityPostingPolicyEnum('posting_policy').notNull().default('open'),
  /**
   * The languages this space expects. Empty means "whatever the region speaks".
   * Read from `Region.locales` at write time rather than stored per city, so a
   * space follows its city's language list instead of a snapshot of it.
   */
  locales: contentLocaleEnum('locales').array().notNull().default(sql`ARRAY[]::content_locale[]`),

  active: boolean('active').notNull().default(true),
  createdAt: created(),
}, (t) => ({
  /** Space discovery is always "what is open, here". */
  scopeIdx: index('community_spaces_scope_idx').on(t.scope, t.cityId, t.active),
}));

/**
 * COMMUNITY IDENTITY IS NOT MARKETPLACE IDENTITY. This is the rule with no exceptions.
 *
 * Devotees book for the shraddha of a dead parent, for a fertility rite, for an
 * illness in the family. Their community presence must never expose any of that, so
 * a devotee appears under a display name they chose and nothing else — no phone, no
 * city, no booking history, no "booked 4 pujas" badge.
 *
 * Purohits are the deliberate asymmetry: they appear under their verified identity,
 * because identifiable expertise answering anonymous vulnerability IS the product.
 * That verification is read from `pandit_profiles` at render time and is not copied
 * here, so a revoked KYC removes the tick everywhere at once.
 *
 * `users.name` must never reach a community surface. One mapper, one test.
 */
export const communityProfiles = pgTable('community_profiles', {
  userId: text('user_id').primaryKey().references(() => users.id),
  displayName: text('display_name').notNull(),
  avatarKey: text('avatar_key'),
  bio: text('bio'),

  trustLevel: communityTrustLevelEnum('trust_level').notNull().default('newcomer'),
  /**
   * Why they are at this level, as a short machine-readable reason —
   * 'signup' | 'age' | 'completed_booking' | 'ops' | 'moderation'. Kept because a
   * purohit asking why they cannot post deserves an answer that is not a guess.
   */
  trustReason: text('trust_reason').notNull().default('signup'),
  /** Not `created()`: that helper names the column `created_at`, and this is not it. */
  trustChangedAt: ts('trust_changed_at').notNull().defaultNow(),

  /** Maintained by trigger. Never COUNT(*) these in a list — Law 3. */
  questionCount: integer('question_count').notNull().default(0),
  answerCount: integer('answer_count').notNull().default(0),
  endorsementsReceived: integer('endorsements_received').notNull().default(0),

  createdAt: created(),
  updatedAt: updated(),
});

/**
 * Questions, answers and replies — one table, three kinds, exactly two levels.
 *
 * `question -> answer -> reply` and then it stops, enforced by `assert_post_shape`
 * in SQL rather than in the service. Unbounded nesting is unreadable on a phone in
 * a script the reader may not be fluent in, and deep threads are where flame wars
 * live. The shape is an invariant, so it belongs where an ORM bug cannot bypass it.
 */
export const communityPosts = pgTable('community_posts', {
  id: id(),
  spaceId: text('space_id').notNull().references(() => communitySpaces.id),
  authorId: text('author_id').notNull().references(() => users.id),
  kind: communityPostKindEnum('kind').notNull(),
  /** Null for a question. An answer's parent is a question; a reply's is an answer. */
  parentId: text('parent_id'),
  /** Denormalised from the parent so a thread reads with one indexed predicate. */
  rootId: text('root_id'),

  /** Questions carry one; answers and replies never do. */
  title: text('title'),
  body: text('body').notNull(),

  /** Law 1, inherited from the parent for answers and replies. */
  scope: communityScopeEnum('scope').notNull(),
  cityId: text('city_id').references(() => cities.id),
  stateName: text('state_name'),
  /**
   * The language this was WRITTEN in, never defaulted to the launch city's.
   * Drives the font subset for this row — see the per-item note in the skill's
   * scale reference: a national feed carries three scripts and `region.script`
   * can no longer keep the promise that a Chennai user never fetches Bengali.
   */
  locale: contentLocaleEnum('locale').notNull(),

  /**
   * Snapshotted for the same reason `bookings.panjika_school` is, and a stronger one.
   *
   * An answer about a tithi is only true under one almanac, and the purnimant/amanta
   * split means a krishna-paksha question asked in Patna is a different question in
   * Kolkata. Rendered as a visible qualifier, not as metadata: "গুপ্ত প্রেস অনুযায়ী"
   * is trustworthy pan-India, and the same answer unlabelled is wrong in half the
   * country. Null where the question does not depend on a calendar.
   */
  panjikaSchool: panjikaSchoolEnum('panjika_school'),

  state: communityPostStateEnum('state').notNull().default('published'),
  /** Set when triage or a reviewer held it, so the queue can be ordered by wait. */
  heldAt: ts('held_at'),
  heldReason: text('held_reason'),
  removedAt: ts('removed_at'),

  /**
   * The answer the asker marked as the one that helped. Only meaningful on a
   * question, and constrained to an answer of THAT question by `assert_accepted_answer`.
   */
  acceptedAnswerId: text('accepted_answer_id'),

  /** Counters, maintained by trigger. A feed of 20 must be one query. */
  replyCount: integer('reply_count').notNull().default(0),
  pranamCount: integer('pranam_count').notNull().default(0),
  endorsementCount: integer('endorsement_count').notNull().default(0),

  publishedAt: ts('published_at'),
  editedAt: ts('edited_at'),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({
  /**
   * The feed's hot path. PARTIAL on state='published' because a moderated forum
   * accumulates held and removed rows, and carrying them in the index every reader
   * touches is pure cost. Created by the migration; declared here so the schema
   * tells the truth about what the database has — the `users_email_lower_uniq`
   * pattern.
   */
  feedIdx: index('community_posts_feed_idx')
    .on(t.spaceId, t.publishedAt, t.id)
    .where(sql`${t.state} = 'published' AND ${t.kind} = 'question'`),
  /** The national/city feed, which does not filter by space. */
  scopeFeedIdx: index('community_posts_scope_feed_idx')
    .on(t.scope, t.cityId, t.publishedAt, t.id)
    .where(sql`${t.state} = 'published' AND ${t.kind} = 'question'`),
  /** Reading one thread: every descendant of a root, in one indexed range. */
  threadIdx: index('community_posts_thread_idx').on(t.rootId, t.kind, t.createdAt),
  authorIdx: index('community_posts_author_idx').on(t.authorId, t.createdAt),
  /** The moderation queue, oldest wait first. */
  heldIdx: index('community_posts_held_idx').on(t.heldAt).where(sql`${t.state} = 'held'`),
}));

/**
 * Append-only edit history, in the spirit of `booking_events` and `ledger_entries`.
 *
 * An edited answer that changed a ritual instruction must be reconstructible — a
 * devotee may have already acted on the previous wording. This also holds the
 * UNSCRUBBED body: contact details are stripped from `community_posts.body` on
 * write, and a reviewer investigating disintermediation needs to see what was
 * actually typed.
 */
export const communityPostRevisions = pgTable('community_post_revisions', {
  id: id(),
  postId: text('post_id').notNull().references(() => communityPosts.id),
  /** Exactly as submitted, before contact-scrubbing. Reviewer-only, never rendered. */
  rawBody: text('raw_body').notNull(),
  rawTitle: text('raw_title'),
  editorId: text('editor_id').notNull().references(() => users.id),
  at: created(),
}, (t) => ({
  postIdx: index('community_post_revisions_post_idx').on(t.postId, t.at),
}));

/**
 * "৭ জন পুরোহিত সম্মত" — peer endorsement by verified purohits.
 *
 * The quality signal the whole surface rests on, and cheap for the endorser: one tap,
 * no writing. It also surfaces genuine regional disagreement rather than hiding it,
 * which in this domain is the truth — two verified purohits differing about a vidhi
 * is information, not a bug.
 *
 * Only a verified purohit may write here, enforced by `assert_endorser_verified`.
 * In application code one missing import bypasses it; in SQL nothing does.
 */
export const communityPostEndorsements = pgTable('community_post_endorsements', {
  postId: text('post_id').notNull().references(() => communityPosts.id),
  panditId: text('pandit_id').notNull().references(() => users.id),
  at: created(),
}, (t) => ({
  pk: primaryKey({ columns: [t.postId, t.panditId] }),
  panditIdx: index('community_endorsements_pandit_idx').on(t.panditId, t.at),
}));

/** One reaction, one row, one per person. See `communityReactionKindEnum`. */
export const communityPostReactions = pgTable('community_post_reactions', {
  postId: text('post_id').notNull().references(() => communityPosts.id),
  userId: text('user_id').notNull().references(() => users.id),
  kind: communityReactionKindEnum('kind').notNull().default('pranam'),
  at: created(),
}, (t) => ({
  pk: primaryKey({ columns: [t.postId, t.userId, t.kind] }),
}));

/**
 * The moderation queue, with an SLA clock.
 *
 * You are an intermediary the moment a third party posts, so the IT Rules 2021
 * obligations attach: a named Grievance Officer, acknowledgement within 24 hours,
 * resolution within 15 days, and 36 hours on a valid court or government order.
 * Those windows are deployment configuration (`COMMUNITY_GRIEVANCE_*`), because a
 * legal window that changes must not require a deploy — but the CLOCK has to be a
 * column or there is nothing to measure compliance against.
 */
export const communityReports = pgTable('community_reports', {
  id: id(),
  postId: text('post_id').notNull().references(() => communityPosts.id),
  reporterId: text('reporter_id').notNull().references(() => users.id),
  reason: communityReportReasonEnum('reason').notNull(),
  note: text('note'),
  state: communityReportStateEnum('state').notNull().default('open'),
  /** Start of the 24h acknowledgement window. */
  createdAt: created(),
  acknowledgedAt: ts('acknowledged_at'),
  resolvedAt: ts('resolved_at'),
  resolvedBy: text('resolved_by').references(() => users.id),
  resolution: text('resolution'),
}, (t) => ({
  /** One report per person per post; a pile-on is not stronger evidence. */
  uniq: uniqueIndex('community_reports_uniq').on(t.postId, t.reporterId),
  /** The queue: open reports, oldest first, which is also the SLA order. */
  queueIdx: index('community_reports_queue_idx').on(t.createdAt).where(sql`${t.state} = 'open'`),
}));

/**
 * The prohibited-term lexicon. A TABLE, deliberately — Tier 4.
 *
 * Pan-India this is eleven languages in nine scripts, plus the Latin transliteration
 * everyone actually types. A list that size will be wrong on launch day and will need
 * a row added during an incident; in a TypeScript array that is a deploy, at night,
 * under pressure. Empty is a valid state and means triage falls back to the model.
 *
 * A match HOLDS a post. Nothing here deletes anything.
 */
export const communityModerationTerms = pgTable('community_moderation_terms', {
  id: id(),
  /** Null means "every language" — for a phone number pattern, say. */
  locale: contentLocaleEnum('locale'),
  /** Matched case-insensitively against the normalised body. */
  term: text('term').notNull(),
  reason: communityReportReasonEnum('reason').notNull(),
  /** Where it came from, e.g. 'launch-list-v1' or a ticket id. Not free text. */
  source: text('source').notNull(),
  active: boolean('active').notNull().default(true),
  meta: jsonb('meta').notNull().default(sql`'{}'::jsonb`),
  createdAt: created(),
}, (t) => ({
  uniq: uniqueIndex('community_moderation_terms_uniq').on(t.locale, t.term),
  activeIdx: index('community_moderation_terms_active_idx').on(t.active),
}));
