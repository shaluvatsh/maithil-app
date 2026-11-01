import { ulid } from 'ulid';
import { eq, and, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import {
  knowledgeItems, knowledgeTranslations, knowledgeCitations,
  panditProfiles, rituals,
} from '../../db/schema/index';
import {
  DomainError, ErrorCode, isMediaType,
  encodeKnowledgeCursor, decodeKnowledgeCursor,
  type CreateKnowledge, type BrowseKnowledge, type KnowledgeCard, type ContentLocale,
} from '@themaithil/contracts';

/**
 * The knowledge library (C3).
 *
 * TWO THINGS CARRY THIS SERVICE and the rest is CRUD:
 *
 * 1. THE REVIEW GATE. Nothing publishes without a verified purohit or an operator,
 *    and never the author. The database enforces it (`assert_knowledge_reviewer`);
 *    this refuses earlier with a reason an author can act on. Every other app in this
 *    category is a firehose of unsourced text, and "somebody qualified put their name
 *    to this" is the only durable differentiator available here.
 *
 * 2. THE TRANSLATION FALLBACK. A reader asks for Tamil; the item may exist only in
 *    Bengali. Falling back silently would leave them wondering why a Tamil page is in
 *    another script, so the row says which language it is actually in and whether
 *    that is the author's own words. That is the same honesty `geo_precision` keeps
 *    about coordinates: report the quality of what you are serving.
 */

export interface KnowledgePeers {
  /** Signs a cover or media key. Local crypto, not a round trip. */
  mediaUrl(key: string): Promise<string>;
}

export interface KnowledgeOptions {
  pageSize: number;
}

interface ItemRow {
  id: string; slug: string; type: KnowledgeCard['type']; level: KnowledgeCard['level'];
  title: string; summary: string; locale: ContentLocale; primary_locale: ContentLocale;
  ritual_slug: string | null; duration_sec: number | null;
  cover_key: string | null; media_key: string | null;
  author_name: string | null; author_kyc: string | null;
  reviewer_name: string | null; citation_count: number; published_at: string;
}

/*
 * WHY `citation_count` IS COUNTED AT READ TIME rather than kept as a column.
 *
 * Law 3 says counters belong in columns, and on `community_posts` they do: reactions
 * and replies grow with READERS, without bound, so counting them per row is the
 * standard way a list that was fast at a hundred rows stops being fast at a hundred
 * thousand.
 *
 * Citations do not. The library is a curated corpus bounded by how fast people write
 * and reviewers approve — tens to hundreds of items, a handful of citations each — and
 * the subquery is an index lookup on `knowledge_citations_item_idx` per row of a page
 * of twenty. Denormalising would buy nothing and add a trigger that can drift.
 *
 * Revisit if the library ever passes a few thousand items, or if a page starts asking
 * for more than a screenful at a time.
 */
export class KnowledgeService {
  constructor(
    private readonly db: Db,
    private readonly peers: KnowledgePeers,
    private readonly opts: KnowledgeOptions,
  ) {}

  // --- authoring ------------------------------------------------------------

  /**
   * Create a draft. Anyone signed in may write; publishing is what is gated.
   *
   * A devotee writing about their family's practice is valuable and the review gate
   * is what makes it safe to publish — so the restriction belongs there and not
   * here. Refusing to let them write at all would lose the content and teach them
   * the library is not for them.
   */
  async create(args: CreateKnowledge & { authorId: string }) {
    const clash = (await this.db.select({ id: knowledgeItems.id }).from(knowledgeItems)
      .where(eq(knowledgeItems.slug, args.slug)).limit(1))[0];
    if (clash) {
      throw new DomainError(ErrorCode.IDEMPOTENCY_CONFLICT, `slug already taken: ${args.slug}`);
    }

    const ritualId = args.ritualSlug
      ? (await this.db.select({ id: rituals.id }).from(rituals)
          .where(eq(rituals.slug, args.ritualSlug)).limit(1))[0]?.id ?? null
      : null;
    if (args.ritualSlug && !ritualId) {
      throw new DomainError(ErrorCode.NOT_FOUND, `unknown ritual: ${args.ritualSlug}`);
    }

    /*
     * The primary locale must be among the texts supplied.
     *
     * `primary_locale` says which version is the author's own words; naming a
     * language they did not write would make every translation look like an original
     * and none of them the source.
     */
    if (!args.text.some((x) => x.locale === args.primaryLocale)) {
      throw new DomainError(
        ErrorCode.KNOWLEDGE_NOT_PUBLISHABLE,
        `no text supplied in ${args.primaryLocale}, which you named as the original`,
      );
    }

    const id = ulid();
    await this.db.transaction(async (tx) => {
      await tx.insert(knowledgeItems).values({
        id,
        slug: args.slug,
        authorId: args.authorId,
        type: args.type,
        level: args.level,
        ritualId,
        tradition: args.tradition ?? null,
        primaryLocale: args.primaryLocale,
        status: 'draft',
        coverKey: args.coverKey ?? null,
        mediaKey: args.mediaKey ?? null,
        durationSec: args.durationSec ?? null,
      });

      for (const text of args.text) {
        await tx.insert(knowledgeTranslations).values({
          itemId: id,
          locale: text.locale,
          title: text.title,
          summary: text.summary,
          body: text.body,
          transcript: text.transcript ?? null,
          // Null marks the author's own words; anything else was translated.
          translatedBy: text.locale === args.primaryLocale ? null : args.authorId,
        });
      }

      for (const c of args.citations ?? []) {
        await tx.insert(knowledgeCitations).values({
          id: ulid(), itemId: id,
          work: c.work, chapter: c.chapter ?? null, verse: c.verse ?? null,
          note: c.note ?? null,
        }).onConflictDoNothing();
      }
    });

    return { id, slug: args.slug, status: 'draft' as const };
  }

  /**
   * Hand it over for review.
   *
   * Everything that can be checked without a human is checked here, so a reviewer's
   * time is spent on judgement rather than on noticing a missing transcript.
   */
  async submit(itemId: string, authorId: string) {
    const item = await this.own(itemId, authorId);
    if (item.status === 'published') {
      throw new DomainError(ErrorCode.INVALID_TRANSITION, 'already published');
    }

    if (isMediaType(item.type)) {
      if (!item.mediaKey) {
        throw new DomainError(
          ErrorCode.KNOWLEDGE_NOT_PUBLISHABLE, 'this kind needs a recording',
        );
      }
      /*
       * A recording with no transcript cannot be searched, cannot be read along
       * with, and is inaccessible to anyone who cannot hear it — which is half the
       * reason to publish a mantra at all.
       */
      const withText = await this.db.select({ locale: knowledgeTranslations.locale })
        .from(knowledgeTranslations).where(and(
          eq(knowledgeTranslations.itemId, itemId),
          sql`${knowledgeTranslations.transcript} IS NOT NULL`,
        )).limit(1);
      if (!withText[0]) {
        throw new DomainError(
          ErrorCode.KNOWLEDGE_NOT_PUBLISHABLE,
          'a recording needs a transcript in at least one language',
        );
      }
    }

    await this.db.update(knowledgeItems)
      .set({ status: 'in_review', updatedAt: new Date().toISOString() })
      .where(eq(knowledgeItems.id, itemId));
    return { id: itemId, status: 'in_review' as const };
  }

  // --- reviewing ------------------------------------------------------------

  /**
   * Waiting on a human, oldest first.
   *
   * Open to VERIFIED PUROHITS as well as operators, which is the only way this
   * scales: staff cannot judge whether a Maithili account of a vidhi is right, and
   * the people who can are already on the platform. It is also the contribution that
   * earns a purohit standing here rather than somewhere else.
   */
  async reviewQueue(limit?: number) {
    const rows = await this.db.execute(sql`
      SELECT k.id, k.slug, k.type, k.level, k.primary_locale, k.media_key,
             k.updated_at, u.name AS author_name, pp.kyc_status AS author_kyc,
             t.title, t.summary,
             (SELECT count(*)::int FROM knowledge_citations c WHERE c.item_id = k.id)
               AS citation_count
        FROM knowledge_items k
        JOIN users u ON u.id = k.author_id
        LEFT JOIN pandit_profiles pp ON pp.user_id = k.author_id
        LEFT JOIN knowledge_translations t
               ON t.item_id = k.id AND t.locale = k.primary_locale
       WHERE k.status = 'in_review'
       ORDER BY k.updated_at ASC
       LIMIT ${limit ?? this.opts.pageSize}`);
    return ((rows as unknown as { rows?: unknown[] }).rows ?? rows) as Array<Record<string, unknown>>;
  }

  /**
   * Publish it, or send it back.
   *
   * The reviewer identity is checked here AND by `assert_knowledge_reviewer`, and the
   * duplication is deliberate: this produces a message an author can act on, the
   * trigger produces a guarantee no code path can route around.
   */
  async review(args: {
    itemId: string; reviewerId: string; reviewerRole: string;
    decision: 'publish' | 'changes'; note?: string | undefined;
  }) {
    const item = (await this.db.select().from(knowledgeItems)
      .where(eq(knowledgeItems.id, args.itemId)).limit(1))[0];
    if (!item) throw new DomainError(ErrorCode.NOT_FOUND, 'no such item');
    if (item.status !== 'in_review') {
      throw new DomainError(ErrorCode.INVALID_TRANSITION, `item is ${item.status}`, {
        status: item.status,
      });
    }

    const now = new Date().toISOString();

    if (args.decision === 'changes') {
      await this.db.update(knowledgeItems).set({
        status: 'draft', reviewNote: args.note ?? null, updatedAt: now,
      }).where(eq(knowledgeItems.id, args.itemId));
      return { id: args.itemId, status: 'draft' as const };
    }

    if (item.authorId === args.reviewerId) {
      // Peer review, the same discipline the Q&A board applies to endorsement:
      // nobody vouches for themselves. Operators are the relief valve.
      throw new DomainError(
        ErrorCode.KNOWLEDGE_NOT_PUBLISHABLE,
        'someone other than the author has to sign this off',
      );
    }

    const staff = args.reviewerRole === 'admin' || args.reviewerRole === 'ops';
    if (!staff) {
      const verified = (await this.db.select({ kyc: panditProfiles.kycStatus })
        .from(panditProfiles).where(eq(panditProfiles.userId, args.reviewerId)).limit(1))[0];
      if (verified?.kyc !== 'verified') {
        throw new DomainError(
          ErrorCode.FORBIDDEN, 'only a verified purohit or an operator may publish this',
        );
      }
    }

    await this.db.update(knowledgeItems).set({
      status: 'published',
      reviewedBy: args.reviewerId,
      reviewedAt: now,
      reviewNote: args.note ?? null,
      publishedAt: item.publishedAt ?? now,
      updatedAt: now,
    }).where(eq(knowledgeItems.id, args.itemId));

    return { id: args.itemId, status: 'published' as const };
  }

  /** Taken down without being erased — a retired item keeps who vouched for it. */
  async retire(itemId: string, actorId: string, actorRole: string) {
    const item = (await this.db.select({ authorId: knowledgeItems.authorId })
      .from(knowledgeItems).where(eq(knowledgeItems.id, itemId)).limit(1))[0];
    if (!item) throw new DomainError(ErrorCode.NOT_FOUND, 'no such item');
    const staff = actorRole === 'admin' || actorRole === 'ops';
    if (!staff && item.authorId !== actorId) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'not yours to retire');
    }
    const now = new Date().toISOString();
    await this.db.update(knowledgeItems)
      .set({ status: 'retired', retiredAt: now, updatedAt: now })
      .where(eq(knowledgeItems.id, itemId));
    return { id: itemId, status: 'retired' as const };
  }

  // --- reading --------------------------------------------------------------

  /**
   * The library. Keyset, newest first, one statement.
   *
   * The translation is chosen by a LATERAL that prefers the reader's language, then
   * the author's original, then anything at all — so a library page is never empty
   * because nobody has translated an item yet, and the row reports which language it
   * settled on.
   */
  async browse(args: BrowseKnowledge) {
    const limit = args.limit ?? this.opts.pageSize;
    const cursor = decodeKnowledgeCursor(args.cursor);
    const want = args.locale ?? null;

    const rows = await this.db.execute(sql`
      SELECT k.id, k.slug, k.type, k.level, k.primary_locale,
             k.duration_sec, k.cover_key, k.media_key, k.published_at,
             r.slug AS ritual_slug,
             u.name AS author_name, pp.kyc_status AS author_kyc,
             rv.name AS reviewer_name,
             t.locale, t.title, t.summary,
             (SELECT count(*)::int FROM knowledge_citations c WHERE c.item_id = k.id)
               AS citation_count
        FROM knowledge_items k
        JOIN users u        ON u.id = k.author_id
        LEFT JOIN users rv  ON rv.id = k.reviewed_by
        LEFT JOIN pandit_profiles pp ON pp.user_id = k.author_id
        LEFT JOIN rituals r ON r.id = k.ritual_id
        JOIN LATERAL (
          SELECT tr.locale, tr.title, tr.summary
            FROM knowledge_translations tr
           WHERE tr.item_id = k.id
           -- Reader's language first, then the author's own words, then whatever
           -- exists. An empty page because nobody has translated it yet would be a
           -- worse answer than a readable page in another language.
           ORDER BY (tr.locale::text = ${want}) DESC,
                    (tr.locale = k.primary_locale) DESC,
                    tr.locale
           LIMIT 1
        ) t ON TRUE
       WHERE k.status = 'published'
         AND (${args.type ?? null}::knowledge_type IS NULL OR k.type = ${args.type ?? null})
         AND (${args.level ?? null}::knowledge_level IS NULL OR k.level = ${args.level ?? null})
         AND (${args.ritualSlug ?? null}::text IS NULL OR r.slug = ${args.ritualSlug ?? null})
         AND (${cursor?.publishedAt ?? null}::timestamptz IS NULL
              OR (k.published_at, k.id) < (${cursor?.publishedAt ?? null}::timestamptz, ${cursor?.id ?? null}))
       ORDER BY k.published_at DESC, k.id DESC
       LIMIT ${limit + 1}`);

    const list = ((rows as unknown as { rows?: unknown[] }).rows ?? rows) as ItemRow[];
    const page = list.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor = list.length > limit && last
      ? encodeKnowledgeCursor({ publishedAt: last.published_at, id: last.id })
      : null;

    const items = await Promise.all(page.map((r) => this.card(r)));
    return { items, nextCursor };
  }

  /**
   * One item, by slug, with its text and its citations.
   *
   * A direct lookup, not a scan of `browse`. The first version of this paged through
   * the library looking for a slug — two round trips and up to fifty rows to render
   * one page, growing with the library. A slug is unique and indexed; asking for it
   * directly is both correct and the only version that stays correct at size.
   */
  async bySlug(slug: string, locale?: ContentLocale) {
    const want = locale ?? null;
    const rows = await this.db.execute(sql`
      SELECT k.id, k.slug, k.type, k.level, k.primary_locale,
             k.duration_sec, k.cover_key, k.media_key, k.published_at,
             r.slug AS ritual_slug,
             u.name AS author_name, pp.kyc_status AS author_kyc,
             rv.name AS reviewer_name,
             t.locale, t.title, t.summary, t.body, t.transcript,
             (SELECT count(*)::int FROM knowledge_citations c WHERE c.item_id = k.id)
               AS citation_count
        FROM knowledge_items k
        JOIN users u        ON u.id = k.author_id
        LEFT JOIN users rv  ON rv.id = k.reviewed_by
        LEFT JOIN pandit_profiles pp ON pp.user_id = k.author_id
        LEFT JOIN rituals r ON r.id = k.ritual_id
        JOIN LATERAL (
          SELECT tr.locale, tr.title, tr.summary, tr.body, tr.transcript
            FROM knowledge_translations tr
           WHERE tr.item_id = k.id
           ORDER BY (tr.locale::text = ${want}) DESC,
                    (tr.locale = k.primary_locale) DESC,
                    tr.locale
           LIMIT 1
        ) t ON TRUE
       WHERE k.slug = ${slug} AND k.status = 'published'`);

    const row = (((rows as unknown as { rows?: unknown[] }).rows ?? rows) as Array<
      ItemRow & { body: string; transcript: string | null }
    >)[0];
    if (!row) throw new DomainError(ErrorCode.NOT_FOUND, `no such item: ${slug}`);

    const [locales, citations] = await Promise.all([
      this.db.select({ locale: knowledgeTranslations.locale })
        .from(knowledgeTranslations).where(eq(knowledgeTranslations.itemId, row.id)),
      this.db.select().from(knowledgeCitations)
        .where(eq(knowledgeCitations.itemId, row.id)),
    ]);

    return {
      ...(await this.card(row)),
      body: row.body,
      transcript: row.transcript,
      /** Every language this exists in, so the page can offer the others. */
      availableLocales: locales.map((x) => x.locale),
      citations: citations.map((c) => ({
        work: c.work, chapter: c.chapter, verse: c.verse, note: c.note,
      })),
    };
  }

  // --- helpers --------------------------------------------------------------

  private async card(r: ItemRow): Promise<KnowledgeCard> {
    return {
      id: r.id,
      slug: r.slug,
      type: r.type,
      level: r.level,
      title: r.title,
      summary: r.summary,
      locale: r.locale,
      /** Their own words, or somebody's translation of them. */
      original: r.locale === r.primary_locale,
      ritualSlug: r.ritual_slug,
      durationSec: r.duration_sec,
      coverUrl: r.cover_key ? await this.peers.mediaUrl(r.cover_key) : null,
      mediaUrl: r.media_key ? await this.peers.mediaUrl(r.media_key) : null,
      authorName: r.author_name ?? '',
      authorVerified: r.author_kyc === 'verified',
      // Named. "Somebody qualified read this" is the whole proposition, and an
      // unattributed claim of review is worth nothing.
      reviewedByName: r.reviewer_name,
      citationCount: r.citation_count,
      publishedAt: r.published_at,
    };
  }

  private async own(itemId: string, authorId: string) {
    const item = (await this.db.select().from(knowledgeItems)
      .where(eq(knowledgeItems.id, itemId)).limit(1))[0];
    if (!item) throw new DomainError(ErrorCode.NOT_FOUND, 'no such item');
    if (item.authorId !== authorId) throw new DomainError(ErrorCode.FORBIDDEN, 'not yours');
    return item;
  }
}
