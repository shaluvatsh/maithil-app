import { z } from 'zod';
import { Ulid } from '../ids.js';
import { PanjikaSchool } from '../enums.js';

/**
 * COMMUNITY — the shared truth between the API, the web app and future clients.
 *
 * Everything here is Tier 2 of the value-ownership rule: a value both sides must
 * agree on. The composer disables its submit button at the same length the API
 * rejects at, and the client clamps its page size to the same bounds the server
 * clamps to, because two copies of one number drift and the drift shows up as a
 * form that lets you type a post the server will not take.
 *
 * What is NOT here: anything that varies by city, language or almanac (that is
 * `packages/region`) and anything an operator tunes per deployment (that is
 * `loadConfig()`).
 */

/**
 * The language a devotee WRITES in — not the language the app is translated into.
 *
 * `Locale` in enums.ts has three values because the interface exists in three
 * languages. This has eleven because that is how many are spoken in the cities we
 * serve, and a Chennai household will write Tamil whether or not we have a Tamil
 * interface. Must equal `LANGUAGES` in packages/region and the `content_locale`
 * pg enum; `content-locale-parity.test.ts` fails the build if it drifts.
 */
export const ContentLocale = z.enum([
  'bn', 'hi', 'en', 'mai', 'ta', 'te', 'kn', 'ml', 'gu', 'or', 'mr',
]);
export type ContentLocale = z.infer<typeof ContentLocale>;

/** Who a piece of content is for. Never inferred from the author's city. */
export const CommunityScope = z.enum(['city', 'state', 'national']);
export type CommunityScope = z.infer<typeof CommunityScope>;

export const CommunityPostKind = z.enum(['question', 'answer', 'reply']);
export type CommunityPostKind = z.infer<typeof CommunityPostKind>;

export const CommunityPostState = z.enum(['published', 'held', 'removed']);
export type CommunityPostState = z.infer<typeof CommunityPostState>;

export const CommunityTrustLevel = z.enum([
  'restricted', 'newcomer', 'member', 'contributor',
]);
export type CommunityTrustLevel = z.infer<typeof CommunityTrustLevel>;

export const CommunityReportReason = z.enum([
  'sectarian', 'caste', 'communal', 'political', 'medical_claim',
  'occult_solicitation', 'off_platform', 'spam', 'personal_info', 'other',
]);
export type CommunityReportReason = z.infer<typeof CommunityReportReason>;

/**
 * What each rung of the trust ladder may do.
 *
 * Ordered, and compared by index — a rung is "at least" another when its position is
 * not lower. Expressed as data rather than as a chain of ifs in the service so the
 * web app can grey out the right button instead of discovering the rule from a 403.
 */
export const TRUST_ORDER = [
  'restricted', 'newcomer', 'member', 'contributor',
] as const satisfies readonly CommunityTrustLevel[];

export const trustAtLeast = (have: CommunityTrustLevel, need: CommunityTrustLevel): boolean =>
  TRUST_ORDER.indexOf(have) >= TRUST_ORDER.indexOf(need);

/**
 * The minimum rung for each action.
 *
 * `react` and `reply` are open to a brand-new account on purpose: the cost of a bad
 * reply is low and the cost of making a first-time devotee feel shut out is high.
 * Asking needs an account that has existed for a while, which is what actually stops
 * throwaway spam. Starting a discussion needs a completed booking or an operator.
 */
export const TRUST_REQUIRED = {
  react: 'newcomer',
  reply: 'newcomer',
  answer: 'newcomer',
  ask: 'member',
  discuss: 'contributor',
} as const satisfies Record<string, CommunityTrustLevel>;

export type CommunityAction = keyof typeof TRUST_REQUIRED;

/**
 * Length bounds. Both sides enforce these, which is why they live here.
 *
 * The body maximum is generous because a purohit explaining a vidhi needs room, and
 * the minimum exists because "?" is not a question anybody can answer.
 */
export const TITLE_MIN = 8;
export const TITLE_MAX = 180;
export const BODY_MIN = 20;
export const BODY_MAX = 8000;
export const REPLY_BODY_MAX = 2000;

/**
 * Page-size bounds, not the default.
 *
 * The DEFAULT is a deployment knob (`COMMUNITY_FEED_PAGE_SIZE`) because it is the
 * kind of thing you tune against real latency. The BOUNDS are a contract, because a
 * client that asks for ten thousand rows is a denial of service and the clamp has to
 * be the same number on both sides.
 */
export const PAGE_SIZE_MIN = 1;
export const PAGE_SIZE_MAX = 50;

/**
 * The feed cursor — opaque to the client, and keyset, never an offset.
 *
 * `OFFSET 2000` makes Postgres produce and discard two thousand rows, so the query
 * gets slower exactly as the feature succeeds. A cursor of (published_at, id) is a
 * constant-cost seek into the index instead.
 *
 * Opaque on purpose: it is base64 so nobody builds a client that parses it and then
 * breaks when the sort key changes. It is NOT a security boundary — it encodes a
 * public timestamp and a public id, and nothing is authorised by holding one.
 */
export interface FeedCursor { publishedAt: string; id: string }

/** Neither an ISO timestamp nor a ULID can contain a pipe, so it cannot collide. */
const CURSOR_SEP = '|';

export const encodeCursor = (c: FeedCursor): string =>
  Buffer.from(`${c.publishedAt}${CURSOR_SEP}${c.id}`, 'utf8').toString('base64url');

/** Returns null for anything malformed. A bad cursor is page one, never a 500. */
export const decodeCursor = (raw: string | undefined): FeedCursor | null => {
  if (!raw) return null;
  try {
    const parts = Buffer.from(raw, 'base64url').toString('utf8').split(CURSOR_SEP);
    const publishedAt = parts[0];
    const id = parts[1];
    if (!publishedAt || !id || parts.length !== 2) return null;
    if (!Ulid.safeParse(id).success) return null;
    if (Number.isNaN(Date.parse(publishedAt))) return null;
    return { publishedAt, id };
  } catch {
    return null;
  }
};

/**
 * Space slugs have one owner, and it is this file.
 *
 * The seed creates them, the web app posts into them and a future mobile client will
 * link to them. Three places building the same string with a template literal is
 * three places to get it wrong, and the failure is silent: a slug that does not
 * match resolves to "no such space" rather than to anything a reader would notice.
 *
 * `city-` and `ritual-` are prefixed rather than bare so a city can never collide
 * with a ritual of the same name, and so a slug says what kind of space it is.
 */
export const citySpaceSlug = (citySlug: string) => `city-${citySlug}`;
export const ritualSpaceSlug = (ritualSlug: string) => `ritual-${ritualSlug}`;

/**
 * Where a question goes when it is not about one ritual or one city.
 *
 * A singleton, and the only space named by a constant anywhere — every other space
 * is derived from `packages/region` or from the catalogue. It exists because the
 * composer needs a default that is true for the whole country, and "the national
 * board" is not derivable from a city list.
 */
export const DEFAULT_SPACE_SLUG = 'ask-a-purohit';

/**
 * What replaces a contact detail that was stripped from a post.
 *
 * A marketplace forum's most common harm is not abuse — it is a purohit and a
 * devotee agreeing to transact off-platform, which costs the platform the booking
 * and costs the devotee every protection the booking carried: the escrow, the OTP
 * handshake, the refund tiers, the dispute path.
 *
 * A SENTINEL rather than English text, because the reader may be in any of eleven
 * languages and the server does not know which. The client maps this to its own
 * localised copy; anything that renders it raw is a missing translation, which is
 * visible, rather than a silently English string in a Tamil thread, which is not.
 */
export const REDACTION_TOKEN = '[[redacted:contact]]';

// --- requests ---------------------------------------------------------------

/**
 * Where a post belongs. The pairing is a CHECK constraint in the database too —
 * this is the friendly rejection, that one is the guarantee.
 */
export const ScopeInput = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('city'), citySlug: z.string().min(1) }),
  z.object({ scope: z.literal('state'), stateName: z.string().min(1) }),
  z.object({ scope: z.literal('national') }),
]);
export type ScopeInput = z.infer<typeof ScopeInput>;

export const AskQuestion = z.object({
  spaceSlug: z.string().min(1),
  title: z.string().trim().min(TITLE_MIN).max(TITLE_MAX),
  body: z.string().trim().min(BODY_MIN).max(BODY_MAX),
  /**
   * Required, never defaulted. A default here would tag every Chennai question as
   * Bengali, and a mislabelled language is worse than an absent one: it routes the
   * question to the wrong purohits and loads the wrong font.
   */
  locale: ContentLocale,
  /** Set when the answer depends on a calendar. Rendered as a visible qualifier. */
  panjikaSchool: PanjikaSchool.optional(),
  scope: ScopeInput,
});
export type AskQuestion = z.infer<typeof AskQuestion>;

export const PostAnswer = z.object({
  body: z.string().trim().min(BODY_MIN).max(BODY_MAX),
  locale: ContentLocale,
  panjikaSchool: PanjikaSchool.optional(),
});

export const PostReply = z.object({
  body: z.string().trim().min(1).max(REPLY_BODY_MAX),
  locale: ContentLocale,
});

export const ReportPost = z.object({
  reason: CommunityReportReason,
  note: z.string().trim().max(1000).optional(),
});

export const FeedQuery = z.object({
  /** Omitted means the scope feed rather than one space. */
  spaceSlug: z.string().min(1).optional(),
  scope: CommunityScope.optional(),
  citySlug: z.string().min(1).optional(),
  locales: z.array(ContentLocale).optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(PAGE_SIZE_MIN).max(PAGE_SIZE_MAX).optional(),
});
export type FeedQuery = z.infer<typeof FeedQuery>;

// --- responses --------------------------------------------------------------

/**
 * The author, as a community surface is allowed to see them.
 *
 * There is no phone, no city, no booking history and no real name for a devotee —
 * see `community_profiles`. A purohit's `verified` and `experienceYears` are read
 * live from `pandit_profiles`, never copied, so revoked KYC removes the tick
 * everywhere at once.
 */
export const CommunityAuthor = z.object({
  id: Ulid,
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  verifiedPurohit: z.boolean(),
  experienceYears: z.number().int().nullable(),
  /** The school this purohit keeps, so a reader can weigh a calendar answer. */
  panjikaSchool: PanjikaSchool.nullable(),
});

export const CommunityPostCard = z.object({
  id: Ulid,
  kind: CommunityPostKind,
  title: z.string().nullable(),
  body: z.string(),
  /**
   * Drives the font subset for THIS row. A national feed carries three scripts, so
   * the region's script can no longer decide what to download — see the per-item
   * note in the community skill.
   */
  locale: ContentLocale,
  scope: CommunityScope,
  citySlug: z.string().nullable(),
  panjikaSchool: PanjikaSchool.nullable(),
  author: CommunityAuthor,
  replyCount: z.number().int(),
  pranamCount: z.number().int(),
  endorsementCount: z.number().int(),
  viewerHasPranamed: z.boolean(),
  isAcceptedAnswer: z.boolean(),
  publishedAt: z.string(),
});
export type CommunityPostCard = z.infer<typeof CommunityPostCard>;

export const CommunityFeedResponse = z.object({
  items: z.array(CommunityPostCard),
  nextCursor: z.string().nullable(),
  /**
   * Every script present in `items`, so the client loads exactly those font subsets
   * and no more. Computed server-side because the client would otherwise have to
   * parse every row before it can render the first one.
   */
  scripts: z.array(z.string()),
});

export const CommunityThreadResponse = z.object({
  question: CommunityPostCard,
  /**
   * Verified purohits first, always — ordered by role, then by endorsement, and only
   * then by pranams. Not by votes: a forum where a loud layperson can outrank a
   * shastri is a forum that destroys the authority it exists to build.
   */
  answers: z.array(CommunityPostCard.extend({
    replies: z.array(CommunityPostCard),
  })),
  scripts: z.array(z.string()),
});
