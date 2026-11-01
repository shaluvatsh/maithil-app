import { z } from 'zod';
import { Ulid } from '../ids.js';
import { ContentLocale, PAGE_SIZE_MIN, PAGE_SIZE_MAX } from './community.js';

/**
 * The knowledge library — shared truth. ADR 0014.
 *
 * The bounds here are the editorial ones: how short a summary may be before it tells
 * a reader nothing, how long a body may be before nobody finishes it. Both sides
 * enforce them, so the composer's counter and the API's rejection are one number.
 */

export const KnowledgeType = z.enum([
  'article', 'ritual_guide', 'mantra_audio', 'video', 'shloka', 'glossary',
]);
export type KnowledgeType = z.infer<typeof KnowledgeType>;

export const KnowledgeLevel = z.enum(['beginner', 'deep']);
export const KnowledgeStatus = z.enum(['draft', 'in_review', 'published', 'retired']);
export type KnowledgeStatus = z.infer<typeof KnowledgeStatus>;

/** These carry a recording, and cannot publish without one. */
export const MEDIA_TYPES = ['mantra_audio', 'video'] as const satisfies readonly KnowledgeType[];
export const isMediaType = (t: KnowledgeType): boolean =>
  (MEDIA_TYPES as readonly string[]).includes(t);

export const TITLE_MIN_K = 6;
export const TITLE_MAX_K = 160;
/**
 * A summary is what a list row and a crawler read, so it has a floor as well as a
 * ceiling: two words tells a reader nothing and wastes the only line they will see.
 */
export const SUMMARY_MIN = 30;
export const SUMMARY_MAX = 320;
export const BODY_MIN_K = 80;
export const BODY_MAX_K = 40_000;

/**
 * How many guides a ritual page shows.
 *
 * Three, because this sits inside a booking flow: the guides are there to answer
 * "what am I agreeing to", and a fourth link starts competing with the thing the
 * reader came to do. A display decision every client shares, so it has one owner
 * rather than a literal on each page that renders it.
 *
 * The LIBRARY's page size is deliberately not here — that is the server's
 * `COMMUNITY_FEED_PAGE_SIZE`, and a client that passed its own would override a knob
 * an operator is meant to tune.
 */
export const GUIDES_ON_RITUAL_PAGE = 3;

/** A slug is a URL for ever. Lowercase, hyphenated, no surprises. */
export const KnowledgeSlug = z.string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lowercase words separated by hyphens')
  .min(3).max(120);

export const KnowledgeText = z.object({
  locale: ContentLocale,
  title: z.string().trim().min(TITLE_MIN_K).max(TITLE_MAX_K),
  summary: z.string().trim().min(SUMMARY_MIN).max(SUMMARY_MAX),
  body: z.string().trim().min(BODY_MIN_K).max(BODY_MAX_K),
  /**
   * Required in practice for audio and video, and the service says so.
   *
   * A recording with no written form cannot be searched, cannot be read along with,
   * and is inaccessible to anyone who cannot hear it — which is half the point of
   * publishing a mantra at all.
   */
  transcript: z.string().trim().max(BODY_MAX_K).optional(),
});
export type KnowledgeText = z.infer<typeof KnowledgeText>;

export const Citation = z.object({
  work: z.string().trim().min(2).max(160),
  chapter: z.string().trim().max(40).optional(),
  verse: z.string().trim().max(40).optional(),
  note: z.string().trim().max(500).optional(),
});
export type Citation = z.infer<typeof Citation>;

export const CreateKnowledge = z.object({
  slug: KnowledgeSlug,
  type: KnowledgeType,
  level: KnowledgeLevel.default('beginner'),
  primaryLocale: ContentLocale,
  ritualSlug: z.string().min(1).optional(),
  tradition: z.string().trim().max(80).optional(),
  coverKey: z.string().max(400).optional(),
  mediaKey: z.string().max(400).optional(),
  durationSec: z.number().int().positive().max(86_400).optional(),
  /** At least one. An item with no text is a slug and a status. */
  text: z.array(KnowledgeText).min(1).max(11),
  citations: z.array(Citation).max(50).optional(),
});
export type CreateKnowledge = z.infer<typeof CreateKnowledge>;

/**
 * A reviewer's verdict.
 *
 * A rejection carries a note and an approval need not, the same asymmetry the KYC
 * queue and the moderation queue both use: the author reads the note, and it is the
 * only thing that tells them what to change.
 */
export const ReviewVerdict = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('publish'), note: z.string().trim().max(1000).optional() }),
  z.object({ decision: z.literal('changes'), note: z.string().trim().min(3).max(1000) }),
]);

export const BrowseKnowledge = z.object({
  type: KnowledgeType.optional(),
  level: KnowledgeLevel.optional(),
  ritualSlug: z.string().min(1).optional(),
  /** The reader's language, for picking which translation to render. */
  locale: ContentLocale.optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(PAGE_SIZE_MIN).max(PAGE_SIZE_MAX).optional(),
});
export type BrowseKnowledge = z.infer<typeof BrowseKnowledge>;

export const KnowledgeCard = z.object({
  id: Ulid,
  slug: z.string(),
  type: KnowledgeType,
  level: KnowledgeLevel,
  title: z.string(),
  summary: z.string(),
  /**
   * The language this row is actually being SHOWN in, which may not be the one
   * asked for. A reader deserves to know they are reading a fallback rather than
   * wondering why a Tamil library page is in English.
   */
  locale: ContentLocale,
  /** True when `locale` is the author's own words rather than a translation. */
  original: z.boolean(),
  ritualSlug: z.string().nullable(),
  durationSec: z.number().int().nullable(),
  coverUrl: z.string().nullable(),
  mediaUrl: z.string().nullable(),
  authorName: z.string(),
  authorVerified: z.boolean(),
  /** Named, because "somebody qualified read this" is the whole proposition. */
  reviewedByName: z.string().nullable(),
  citationCount: z.number().int(),
  publishedAt: z.string(),
});
export type KnowledgeCard = z.infer<typeof KnowledgeCard>;

export interface KnowledgeCursor { publishedAt: string; id: string }

const SEP = '|';

export const encodeKnowledgeCursor = (c: KnowledgeCursor): string =>
  Buffer.from(`${c.publishedAt}${SEP}${c.id}`, 'utf8').toString('base64url');

export const decodeKnowledgeCursor = (raw: string | undefined): KnowledgeCursor | null => {
  if (!raw) return null;
  try {
    const parts = Buffer.from(raw, 'base64url').toString('utf8').split(SEP);
    const publishedAt = parts[0]; const id = parts[1];
    if (!publishedAt || !id || parts.length !== 2) return null;
    if (!Ulid.safeParse(id).success) return null;
    if (Number.isNaN(Date.parse(publishedAt))) return null;
    return { publishedAt, id };
  } catch {
    return null;
  }
};
