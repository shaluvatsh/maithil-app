import {
  pgTable, text, integer, timestamp, index, uniqueIndex, primaryKey,
} from 'drizzle-orm/pg-core';
import { users } from './identity';
import { rituals } from './catalog';
import {
  knowledgeTypeEnum, knowledgeLevelEnum, knowledgeStatusEnum, contentLocaleEnum,
} from './enums';

const id = () => text('id').primaryKey();
const ts = (n: string) => timestamp(n, { withTimezone: true, mode: 'string' });
const created = () => ts('created_at').notNull().defaultNow();
const updated = () => ts('updated_at').notNull().defaultNow();

/**
 * THE KNOWLEDGE LIBRARY (C3).
 *
 * WHY THIS IS NOT `community_posts` WITH A TYPE. A forum post is conversational,
 * written once, in one language, by whoever felt like it. A knowledge item is
 * curated, translated, versioned, cited, reviewed before publication and indexed by
 * search engines — structurally it is `rituals` + `ritual_translations`, not a
 * thread. Merging them would grow an editorial workflow onto the table that also has
 * to serve a feed, and the feed would win every time there was a conflict.
 *
 * THE REVIEW GATE IS THE PRODUCT. Nothing publishes without a verified purohit or an
 * operator signing off, and the reviewer may not be the author. Every other Hindu
 * content app is a firehose of unsourced text; "somebody qualified read this and put
 * their name to it" is the only durable differentiator available here, and it costs
 * nothing but the discipline of enforcing it in SQL.
 *
 * Lives in the community context (ADR 0014), so nothing in booking references it and
 * the whole library stays droppable.
 */
export const knowledgeItems = pgTable('knowledge_items', {
  id: id(),
  /** Stable, human-readable, and the SEO surface. Never regenerated from a title. */
  slug: text('slug').notNull().unique(),
  authorId: text('author_id').notNull().references(() => users.id),
  type: knowledgeTypeEnum('type').notNull(),
  level: knowledgeLevelEnum('level').notNull().default('beginner'),

  /**
   * The ritual this explains, where there is one.
   *
   * The highest-value content type in the library is a guide attached to a ritual and
   * rendered on its own page: first-time devotees do not fail to book because of
   * price, they fail because they do not know what they are agreeing to.
   */
  ritualId: text('ritual_id').references(() => rituals.id),
  /** The sampradaya this describes, when a practice differs by it. */
  tradition: text('tradition'),

  /**
   * The language it was WRITTEN in. Translations hang off `knowledge_translations`;
   * this says which of them is the original, so a reader can tell a translation from
   * the author's own words.
   */
  primaryLocale: contentLocaleEnum('primary_locale').notNull(),

  status: knowledgeStatusEnum('status').notNull().default('draft'),
  /**
   * Who signed off. A verified purohit or an operator, never the author — enforced
   * by `assert_knowledge_reviewer`. Null while unpublished and never cleared once
   * set, so a retired item still records who vouched for it.
   */
  reviewedBy: text('reviewed_by').references(() => users.id),
  reviewedAt: ts('reviewed_at'),
  /** What the reviewer said. Read by the author, so a rejection is actionable. */
  reviewNote: text('review_note'),

  coverKey: text('cover_key'),
  /**
   * The audio or video, as an object-store key.
   *
   * `duration_sec` is stored rather than probed, because a list of thirty items must
   * not open thirty media files to render "4 min".
   */
  mediaKey: text('media_key'),
  durationSec: integer('duration_sec'),

  publishedAt: ts('published_at'),
  retiredAt: ts('retired_at'),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => ({
  /** The library's hot path: published, of a kind, newest first. */
  browse: index('knowledge_browse_idx').on(t.status, t.type, t.publishedAt),
  /** A ritual page asking "what explains this". */
  ritualIdx: index('knowledge_ritual_idx').on(t.ritualId, t.status),
  /** The review queue, oldest wait first — the same SLA ordering as moderation. */
  queue: index('knowledge_queue_idx').on(t.updatedAt),
  authorIdx: index('knowledge_author_idx').on(t.authorId, t.createdAt),
}));

/**
 * The text, per language. ADR 0009's model, applied to content rather than catalogue.
 *
 * `transcript` is what makes the audio usable: a mantra recording with no written
 * form cannot be searched, cannot be read along with, and is inaccessible to anyone
 * who cannot hear it. A recording without one is half a product.
 */
export const knowledgeTranslations = pgTable('knowledge_translations', {
  itemId: text('item_id').notNull().references(() => knowledgeItems.id),
  locale: contentLocaleEnum('locale').notNull(),
  title: text('title').notNull(),
  /** One or two sentences. What a list row shows, and what a crawler reads. */
  summary: text('summary').notNull(),
  body: text('body').notNull(),
  /** For audio and video. Null for text, which is its own transcript. */
  transcript: text('transcript'),
  /** Null when the author wrote this language; set when somebody translated it. */
  translatedBy: text('translated_by').references(() => users.id),
  updatedAt: updated(),
}, (t) => ({
  pk: primaryKey({ columns: [t.itemId, t.locale] }),
}));

/**
 * WHERE IT SAYS SO. The trust moat, and the cheapest one available.
 *
 * Every other app in this category asserts; a citation lets a reader check. It also
 * changes how the author writes: a claim that has to name a chapter and verse is a
 * claim somebody thought about. Deliberately free-form `work` rather than an
 * enumerated canon — the corpus is vast, regionally varied, and any list we drew up
 * would exclude somebody's tradition.
 */
export const knowledgeCitations = pgTable('knowledge_citations', {
  id: id(),
  itemId: text('item_id').notNull().references(() => knowledgeItems.id),
  /** 'Garuda Purana', 'Rigveda', a named paddhati. */
  work: text('work').notNull(),
  chapter: text('chapter'),
  verse: text('verse'),
  /** What this passage is being cited FOR, in the author's words. */
  note: text('note'),
  createdAt: created(),
}, (t) => ({
  itemIdx: index('knowledge_citations_item_idx').on(t.itemId),
  /** One citation per passage per item; re-adding the same one is a no-op. */
  uniq: uniqueIndex('knowledge_citations_uniq').on(t.itemId, t.work, t.chapter, t.verse),
}));
