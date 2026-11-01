import { ulid } from 'ulid';
import { eq, and, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import {
  communitySpaces, communityProfiles, communityPosts, communityPostRevisions,
  communityPostEndorsements, communityPostReactions, communityReports,
  communityModerationTerms, users, cities,
} from '../../db/schema/index';
import {
  DomainError, ErrorCode, TRUST_REQUIRED, trustAtLeast,
  encodeCursor, decodeCursor,
  type CommunityAction, type CommunityTrustLevel, type ContentLocale,
  type ScopeInput, type CommunityPostCard,
} from '@themaithil/contracts';
import { allRegions, scriptsForLocales } from '@themaithil/region';
import { scrubContact, normaliseForMatching } from '../../domain/community-text';
import { AuditService } from '../../common/audit';

/**
 * Community — Ask a Purohit (C1).
 *
 * Not a forum clone. A question board scoped to rituals and cities, where a verified
 * purohit's answer is structurally different from a neighbour's opinion: verified
 * answers outrank everything by ROLE, and peer endorsement orders them within that
 * tier. Votes never cross the tiers. A board where a loud layperson can outrank a
 * shastri destroys the authority the whole surface exists to build, and there is no
 * ranking weight that fixes that afterwards.
 *
 * DEPENDENCIES POINT OUT, NEVER IN. This service reads `users`, `cities` and
 * `pandit_profiles`; nothing in booking, ledger or payments knows it exists. The one
 * thing it needs from the marketplace — whether someone has completed a booking, for
 * the trust ladder — arrives as a bound capability rather than as `BookingService`,
 * so the community context stays droppable (ADR 0014) and a moderation incident can
 * never become a marketplace outage.
 */

/** What the marketplace tells community, and the entirety of it. */
export interface CommunityPeers {
  /** Promotes to `contributor`. A completed booking is the cheapest real identity. */
  hasCompletedBooking(userId: string): Promise<boolean>;
  /** Signs an avatar key. Local crypto, not a network call — see `renderAuthor`. */
  avatarUrl(key: string): Promise<string>;
}

export interface CommunityOptions {
  /** `COMMUNITY_FEED_PAGE_SIZE`. Tuned against real latency, hence a knob. */
  feedPageSize: number;
  /** `COMMUNITY_TRUST_ASK_AFTER_HOURS`. The trust ladder's cheapest rung. */
  askAfterHours: number;
  /*
   * The IT Rules 2021 windows, sent to the console with the queue so one copy
   * drives both the clock and what an operator is told the clock means.
   */
  grievanceAckHours: number;
  grievanceResolveDays: number;
}

interface ResolvedScope {
  scope: 'city' | 'state' | 'national';
  cityId: string | null;
  stateName: string | null;
}

/** Shape of a post row as every read path selects it. One query, one shape. */
interface PostRow {
  id: string; kind: 'question' | 'answer' | 'reply';
  title: string | null; body: string; locale: ContentLocale;
  scope: 'city' | 'state' | 'national';
  city_slug: string | null; panjika_school: string | null;
  parent_id: string | null; accepted_answer_id: string | null;
  reply_count: number; pranam_count: number; endorsement_count: number;
  published_at: string;
  /** The QUESTION's accepted answer, carried onto every row of a thread. */
  thread_accepted?: string | null;
  author_id: string; display_name: string; avatar_key: string | null;
  kyc_status: string | null; experience_years: number | null;
  author_panjika: string | null;
  viewer_pranamed: boolean;
}

export class CommunityService {
  constructor(
    private readonly db: Db,
    private readonly opts: CommunityOptions,
    private readonly peers: CommunityPeers,
    /*
     * Taken as a dependency rather than imported, so the moderation paths can be
     * tested without a Nest container — and so every decision lands in the SAME
     * audit spine the KYC queue writes to. There is one `audit_log` and it is not
     * worth having two.
     */
    private readonly audit: AuditService,
  ) {}

  // --- identity -------------------------------------------------------------

  /**
   * The devotee's community identity, which is NOT their marketplace identity.
   *
   * A devotee books for the shraddha of a dead parent, for a fertility rite, for an
   * illness. None of that may reach a community surface, so a devotee posts under a
   * name they chose and we refuse to invent one for them: an auto-generated handle
   * is either derived from their real identity, which defeats the point, or it is a
   * random word pair they never agreed to be known by.
   *
   * A purohit is the deliberate asymmetry. They post under their verified name
   * because identifiable expertise answering anonymous vulnerability is the product,
   * so for them `users.name` is seeded here ONCE, with their knowledge, and this is
   * the only place in the community context that column is ever read.
   */
  async ensureProfile(userId: string, displayName?: string) {
    const existing = (await this.db.select().from(communityProfiles)
      .where(eq(communityProfiles.userId, userId)).limit(1))[0];

    if (existing) {
      if (displayName && displayName !== existing.displayName) {
        await this.db.update(communityProfiles)
          .set({ displayName, updatedAt: new Date().toISOString() })
          .where(eq(communityProfiles.userId, userId));
        return { ...existing, displayName };
      }
      return existing;
    }

    const user = (await this.db.select({ role: users.role, name: users.name })
      .from(users).where(eq(users.id, userId)).limit(1))[0];
    if (!user) throw new DomainError(ErrorCode.NOT_FOUND, 'no such account');

    const name = displayName ?? (user.role === 'pandit' ? user.name : null);
    if (!name) {
      throw new DomainError(
        ErrorCode.NOT_FOUND,
        'choose a display name before posting — your real name is never shown here',
      );
    }

    const row = {
      userId, displayName: name,
      trustLevel: 'newcomer' as const, trustReason: 'signup',
    };
    await this.db.insert(communityProfiles).values(row);
    return (await this.db.select().from(communityProfiles)
      .where(eq(communityProfiles.userId, userId)).limit(1))[0]!;
  }

  /**
   * The trust ladder, recomputed on every write and persisted when it moves.
   *
   * `restricted` is never auto-promoted out of: it is the outcome of a moderation
   * decision, and a rule that quietly undid a moderator's call after a day would
   * make the queue pointless. Every other rung is earned by facts about the account
   * — how long it has existed, whether it has ever completed a booking — so nobody
   * has to grant anything by hand for the common case.
   */
  private async effectiveTrust(userId: string): Promise<CommunityTrustLevel> {
    const profile = await this.ensureProfile(userId);
    if (profile.trustLevel === 'restricted') return 'restricted';

    const user = (await this.db.select({ createdAt: users.createdAt })
      .from(users).where(eq(users.id, userId)).limit(1))[0];
    if (!user) throw new DomainError(ErrorCode.NOT_FOUND, 'no such account');

    const ageHours = (Date.now() - Date.parse(user.createdAt)) / 3_600_000;
    let level: CommunityTrustLevel = 'newcomer';
    let reason = 'signup';
    if (ageHours >= this.opts.askAfterHours) { level = 'member'; reason = 'age'; }
    if (await this.peers.hasCompletedBooking(userId)) {
      level = 'contributor'; reason = 'completed_booking';
    }

    if (level !== profile.trustLevel) {
      await this.db.update(communityProfiles)
        .set({ trustLevel: level, trustReason: reason, trustChangedAt: new Date().toISOString() })
        .where(eq(communityProfiles.userId, userId));
    }
    return level;
  }

  /**
   * Refuses with COMMUNITY_TRUST_REQUIRED, never FORBIDDEN.
   *
   * The difference is the whole tone of the surface: FORBIDDEN reads as "not yours"
   * and this is "not yet". A first-time devotee told the wrong one does not come
   * back, so the code carries the distinction the copy depends on.
   */
  private async requireTrust(userId: string, action: CommunityAction) {
    const need = TRUST_REQUIRED[action];
    const have = await this.effectiveTrust(userId);
    if (!trustAtLeast(have, need)) {
      throw new DomainError(
        ErrorCode.COMMUNITY_TRUST_REQUIRED,
        `this needs a ${need} account; yours is ${have}`,
        { have, need, action },
      );
    }
  }

  // --- scope ----------------------------------------------------------------

  /**
   * Law 1: who this is for, resolved from slugs the client can say into ids the
   * database enforces. The CHECK constraint guarantees the pairing; this produces a
   * readable refusal instead of a constraint violation.
   *
   * A state is validated against `packages/region` rather than a list kept here, so
   * launching a city automatically makes its state postable and there is no second
   * list to forget.
   */
  private async resolveScope(input: ScopeInput): Promise<ResolvedScope> {
    if (input.scope === 'national') return { scope: 'national', cityId: null, stateName: null };

    if (input.scope === 'state') {
      const known = allRegions().some((r) => r.state === input.stateName);
      if (!known) {
        throw new DomainError(ErrorCode.NOT_FOUND, `no city we serve is in ${input.stateName}`);
      }
      return { scope: 'state', cityId: null, stateName: input.stateName };
    }

    const city = (await this.db.select({ id: cities.id })
      .from(cities).where(and(eq(cities.slug, input.citySlug), eq(cities.active, true)))
      .limit(1))[0];
    if (!city) throw new DomainError(ErrorCode.NOT_FOUND, `unknown city: ${input.citySlug}`);
    return { scope: 'city', cityId: city.id, stateName: null };
  }

  // --- writing --------------------------------------------------------------

  async ask(args: {
    authorId: string; spaceSlug: string; title: string; body: string;
    locale: ContentLocale; panjikaSchool?: string | undefined; scope: ScopeInput;
  }) {
    await this.requireTrust(args.authorId, 'ask');
    const space = await this.space(args.spaceSlug);
    await this.assertMayPostIn(space, args.authorId);

    const scope = await this.resolveScope(args.scope);
    const id = ulid();
    const held = await this.triage(args.body, args.locale, args.title);
    const body = scrubContact(args.body);
    const title = scrubContact(args.title);
    const now = new Date().toISOString();

    await this.db.transaction(async (tx) => {
      await tx.insert(communityPosts).values({
        id, spaceId: space.id, authorId: args.authorId, kind: 'question',
        parentId: null, rootId: id,
        title: title.text, body: body.text,
        scope: scope.scope, cityId: scope.cityId, stateName: scope.stateName,
        locale: args.locale,
        panjikaSchool: (args.panjikaSchool ?? null) as never,
        state: held ? 'held' : 'published',
        heldAt: held ? now : null, heldReason: held,
        // A held post has no publication instant, which is exactly what the
        // `community_posts_published_has_instant` CHECK says.
        publishedAt: held ? null : now,
      });
      // The raw text, before scrubbing. The only record of what was actually typed,
      // and the evidence a reviewer needs when investigating a contact leak.
      await tx.insert(communityPostRevisions).values({
        id: ulid(), postId: id, rawBody: args.body, rawTitle: args.title,
        editorId: args.authorId,
      });
    });

    return { id, state: held ? 'held' as const : 'published' as const, redacted: body.redacted };
  }

  /** An answer to a question, or a reply to an answer. The shape guard enforces which. */
  async respond(args: {
    authorId: string; parentId: string; body: string;
    locale: ContentLocale; panjikaSchool?: string | undefined;
  }) {
    const parent = (await this.db.select({
      id: communityPosts.id, kind: communityPosts.kind, spaceId: communityPosts.spaceId,
      rootId: communityPosts.rootId, state: communityPosts.state,
      scope: communityPosts.scope, cityId: communityPosts.cityId,
      stateName: communityPosts.stateName,
    }).from(communityPosts).where(eq(communityPosts.id, args.parentId)).limit(1))[0];

    if (!parent) throw new DomainError(ErrorCode.NOT_FOUND, 'no such post');
    if (parent.state !== 'published') {
      throw new DomainError(ErrorCode.COMMUNITY_CONTENT_HELD, 'that post is not open for replies');
    }
    if (parent.kind === 'reply') {
      throw new DomainError(
        ErrorCode.INVALID_TRANSITION,
        'replies do not nest — answer the question or reply to an answer',
      );
    }

    const kind = parent.kind === 'question' ? 'answer' as const : 'reply' as const;
    await this.requireTrust(args.authorId, kind === 'answer' ? 'answer' : 'reply');
    const space = await this.spaceById(parent.spaceId);
    await this.assertMayPostIn(space, args.authorId);

    const id = ulid();
    const held = await this.triage(args.body, args.locale);
    const body = scrubContact(args.body);
    const now = new Date().toISOString();

    await this.db.transaction(async (tx) => {
      await tx.insert(communityPosts).values({
        id, spaceId: parent.spaceId, authorId: args.authorId, kind,
        parentId: parent.id, rootId: parent.rootId,
        title: null, body: body.text,
        // Scope is INHERITED, never re-asked. An answer belongs to the same audience
        // as the question it answers; letting it differ would put a national answer
        // under a city question and break every feed predicate at once.
        scope: parent.scope, cityId: parent.cityId, stateName: parent.stateName,
        locale: args.locale,
        panjikaSchool: (args.panjikaSchool ?? null) as never,
        state: held ? 'held' : 'published',
        heldAt: held ? now : null, heldReason: held,
        publishedAt: held ? null : now,
      });
      await tx.insert(communityPostRevisions).values({
        id: ulid(), postId: id, rawBody: args.body, rawTitle: null,
        editorId: args.authorId,
      });
    });

    return { id, kind, state: held ? 'held' as const : 'published' as const, redacted: body.redacted };
  }

  /**
   * Peer endorsement — "৭ জন পুরোহিত সম্মত".
   *
   * The verification that the endorser is a verified purohit, that the target is an
   * answer, and that it is not their own, is done by `assert_endorser_verified` in
   * SQL. This method does not re-check it: one enforcement point, in the place an
   * ORM bug cannot route around. Here we only translate the constraint violation
   * into something a client can act on.
   */
  async endorse(postId: string, panditId: string) {
    try {
      await this.db.insert(communityPostEndorsements).values({ postId, panditId });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('duplicate key')) return { endorsed: true, alreadyEndorsed: true };
      if (msg.includes('verified purohit') || msg.includes('only an answer') || msg.includes('own answer')) {
        throw new DomainError(ErrorCode.FORBIDDEN, msg);
      }
      throw e;
    }
    return { endorsed: true, alreadyEndorsed: false };
  }

  /** One reaction, idempotent. See `communityReactionKindEnum` for why there is no downvote. */
  async pranam(postId: string, userId: string) {
    await this.requireTrust(userId, 'react');
    await this.db.execute(sql`
      INSERT INTO community_post_reactions (post_id, user_id, kind)
      VALUES (${postId}, ${userId}, 'pranam')
      ON CONFLICT DO NOTHING`);
    return { ok: true };
  }

  async unpranam(postId: string, userId: string) {
    await this.db.delete(communityPostReactions).where(and(
      eq(communityPostReactions.postId, postId),
      eq(communityPostReactions.userId, userId),
    ));
    return { ok: true };
  }

  /** Only the asker marks an answer accepted; the guard pins it to THAT question. */
  async acceptAnswer(questionId: string, answerId: string, askerId: string) {
    const q = (await this.db.select({ authorId: communityPosts.authorId })
      .from(communityPosts).where(eq(communityPosts.id, questionId)).limit(1))[0];
    if (!q) throw new DomainError(ErrorCode.NOT_FOUND, 'no such question');
    if (q.authorId !== askerId) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'only the person who asked can accept an answer');
    }
    try {
      await this.db.update(communityPosts).set({ acceptedAnswerId: answerId })
        .where(eq(communityPosts.id, questionId));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('not an answer to question')) {
        throw new DomainError(ErrorCode.NOT_FOUND, 'that answer does not belong to this question');
      }
      throw e;
    }
    return { accepted: answerId };
  }

  // --- moderation -----------------------------------------------------------

  async report(args: { postId: string; reporterId: string; reason: string; note?: string | undefined }) {
    const exists = (await this.db.select({ id: communityPosts.id })
      .from(communityPosts).where(eq(communityPosts.id, args.postId)).limit(1))[0];
    if (!exists) throw new DomainError(ErrorCode.NOT_FOUND, 'no such post');
    try {
      await this.db.insert(communityReports).values({
        id: ulid(), postId: args.postId, reporterId: args.reporterId,
        reason: args.reason as never, note: args.note ?? null,
      });
    } catch (e) {
      // One report per person per post. A pile-on is not stronger evidence, and
      // letting it be one turns the queue into a popularity contest.
      if (e instanceof Error && e.message.includes('duplicate key')) return { reported: true };
      throw e;
    }
    return { reported: true };
  }

  /**
   * Lexicon triage. Returns the reason to HOLD on, or null to publish.
   *
   * It holds; it never deletes. A false positive that silently removed a grieving
   * devotee's question is worse than a slow queue, and that asymmetry is the entire
   * moderation posture of this product.
   *
   * The lexicon is a table, not a constant: pan-India it is eleven languages in nine
   * scripts plus the Latin transliteration everyone actually types, it will be wrong
   * on launch day, and it will need a row added during an incident. In a TypeScript
   * array that is a deploy, at night, under pressure. Empty is a valid state and
   * means everything publishes.
   */
  private async triage(
    body: string, locale: ContentLocale, title?: string | undefined,
  ): Promise<string | null> {
    const terms = await this.db.select({
      term: communityModerationTerms.term, reason: communityModerationTerms.reason,
    }).from(communityModerationTerms).where(and(
      eq(communityModerationTerms.active, true),
      sql`(${communityModerationTerms.locale} IS NULL OR ${communityModerationTerms.locale} = ${locale})`,
    ));
    if (!terms.length) return null;

    /*
     * The TITLE is scanned as well as the body.
     *
     * It was body-only, so a slur in a headline — the most visible text on the
     * surface, the part that appears in every feed and in every search result —
     * published while the same word three lines down was held. The title is the
     * part a reader cannot avoid, so if anything it matters more.
     */
    const haystack = normaliseForMatching([title, body].filter(Boolean).join(' '));
    const hit = terms.find((t) => haystack.includes(normaliseForMatching(t.term)));
    return hit ? hit.reason : null;
  }

  /**
   * The moderation queue: everything waiting on a human, oldest first.
   *
   * Oldest-first is not a preference, it is the SLA. A held post and an open report
   * both have a clock running — the IT Rules 2021 acknowledgement window for a
   * report, and a devotee waiting to find out whether their question exists for a
   * hold — and the queue order is what makes the oldest wait the next thing looked
   * at rather than the thing that quietly ages out.
   *
   * Both partial indexes (`community_posts_held_idx`, `community_reports_queue_idx`)
   * serve exactly this predicate, so the queue stays cheap however large the
   * published corpus gets.
   */
  async queue(args: { limit?: number | undefined } = {}) {
    const limit = args.limit ?? this.opts.feedPageSize;

    const heldRows = await this.db.execute(sql`
      SELECT p.id, p.kind, p.title, p.body, p.locale, p.held_at, p.held_reason,
             p.author_id, prof.display_name, s.slug AS space_slug
        FROM community_posts p
        JOIN community_profiles prof ON prof.user_id = p.author_id
        JOIN community_spaces s      ON s.id = p.space_id
       WHERE p.state = 'held'
       ORDER BY p.held_at ASC
       LIMIT ${limit}`);

    const reportRows = await this.db.execute(sql`
      SELECT r.id, r.post_id, r.reason, r.note, r.created_at, r.reporter_id,
             p.title, p.body, p.locale, p.state AS post_state,
             prof.display_name AS author_name
        FROM community_reports r
        JOIN community_posts p       ON p.id = r.post_id
        JOIN community_profiles prof ON prof.user_id = p.author_id
       WHERE r.state = 'open'
       ORDER BY r.created_at ASC
       LIMIT ${limit}`);

    return {
      held: this.rows<Record<string, unknown>>(heldRows),
      reports: this.rows<Record<string, unknown>>(reportRows),
      /*
       * The windows the clocks are measured against, sent with the queue rather
       * than hardcoded into the console. They are legal windows set outside this
       * codebase (ADR 0016) and a console that carried its own copy would keep
       * showing the old one after the configuration changed.
       */
      sla: {
        ackHours: this.opts.grievanceAckHours,
        resolveDays: this.opts.grievanceResolveDays,
      },
    };
  }

  /**
   * Release a held post, or remove it. The only two ways out of `held`.
   *
   * Both are recorded in `audit_log` inside the same transaction as the state
   * change, because a moderation decision that is not attributable is not a
   * decision — it is something that happened. `AuditService` is passed in rather
   * than imported so this stays testable without a Nest container.
   */
  async decide(args: {
    postId: string; decision: 'release' | 'remove';
    actorId: string; actorRole: string; reason?: string | undefined;
  }) {
    const post = (await this.db.select({
      id: communityPosts.id, state: communityPosts.state,
      heldReason: communityPosts.heldReason,
    }).from(communityPosts).where(eq(communityPosts.id, args.postId)).limit(1))[0];
    if (!post) throw new DomainError(ErrorCode.NOT_FOUND, 'no such post');

    if (args.decision === 'remove' && !args.reason?.trim()) {
      // A removal the author cannot be told the reason for is one they will make
      // again, and one nobody can review later.
      throw new DomainError(ErrorCode.FORBIDDEN, 'a removal needs a reason');
    }

    const now = new Date().toISOString();
    await this.db.transaction(async (tx) => {
      await tx.update(communityPosts).set(
        args.decision === 'release'
          ? {
            state: 'published', heldAt: null, heldReason: null,
            // The publication instant is set NOW, not backdated to when it was
            // written: the feed sorts on it and a released post that claims to
            // have been published three days ago arrives already buried.
            publishedAt: now, updatedAt: now,
          }
          : { state: 'removed', removedAt: now, heldReason: args.reason ?? null, updatedAt: now },
      ).where(eq(communityPosts.id, args.postId));

      await this.audit.record(tx, {
        actorId: args.actorId,
        actorRole: args.actorRole,
        action: `community.${args.decision}`,
        entityType: 'community_post',
        entityId: args.postId,
        before: { state: post.state, heldReason: post.heldReason },
        after: { state: args.decision === 'release' ? 'published' : 'removed', reason: args.reason ?? null },
      });
    });

    return { id: args.postId, state: args.decision === 'release' ? 'published' : 'removed' };
  }

  /**
   * Close a report. `actioned` means something was done to the post; `rejected`
   * means the report was considered and the post stands.
   *
   * Both are resolutions and both stop the clock — "rejected" is not "ignored", and
   * the distinction is what the compliance record needs to show.
   */
  async resolveReport(args: {
    reportId: string; state: 'actioned' | 'rejected';
    actorId: string; actorRole: string; resolution?: string | undefined;
  }) {
    const now = new Date().toISOString();
    const before = (await this.db.select().from(communityReports)
      .where(eq(communityReports.id, args.reportId)).limit(1))[0];
    if (!before) throw new DomainError(ErrorCode.NOT_FOUND, 'no such report');

    await this.db.transaction(async (tx) => {
      await tx.update(communityReports).set({
        state: args.state,
        // Acknowledgement and resolution can land together — an operator who reads
        // and decides in one sitting has done both, and leaving `acknowledged_at`
        // null would under-report compliance for the fastest cases.
        acknowledgedAt: before.acknowledgedAt ?? now,
        resolvedAt: now,
        resolvedBy: args.actorId,
        resolution: args.resolution ?? null,
      }).where(eq(communityReports.id, args.reportId));

      await this.audit.record(tx, {
        actorId: args.actorId,
        actorRole: args.actorRole,
        action: `community.report_${args.state}`,
        entityType: 'community_report',
        entityId: args.reportId,
        before: { state: before.state },
        after: { state: args.state, resolution: args.resolution ?? null },
      });
    });

    return { id: args.reportId, state: args.state };
  }

  /** Acknowledge without deciding yet — the 24-hour obligation, met on its own. */
  async acknowledgeReport(reportId: string) {
    await this.db.update(communityReports)
      .set({ acknowledgedAt: new Date().toISOString(), state: 'acknowledged' })
      .where(and(
        eq(communityReports.id, reportId),
        eq(communityReports.state, 'open'),
      ));
    return { id: reportId, state: 'acknowledged' as const };
  }

  /**
   * Restrict or restore an account. The only way into and out of `restricted`.
   *
   * `effectiveTrust` never auto-promotes out of `restricted`, so this is the one
   * lever that undoes it — which is the point: a moderator's decision should not
   * expire because a day passed.
   */
  async setTrust(args: {
    userId: string; level: 'restricted' | 'newcomer';
    actorId: string; actorRole: string;
  }) {
    const before = await this.ensureProfile(args.userId);
    await this.db.transaction(async (tx) => {
      await tx.update(communityProfiles).set({
        trustLevel: args.level,
        trustReason: args.level === 'restricted' ? 'moderation' : 'ops',
        trustChangedAt: new Date().toISOString(),
      }).where(eq(communityProfiles.userId, args.userId));

      await this.audit.record(tx, {
        actorId: args.actorId,
        actorRole: args.actorRole,
        action: 'community.set_trust',
        entityType: 'community_profile',
        entityId: args.userId,
        before: { trustLevel: before.trustLevel },
        after: { trustLevel: args.level },
      });
    });
    return { userId: args.userId, trustLevel: args.level };
  }

  // --- reading --------------------------------------------------------------

  /**
   * The feed. Keyset, one statement, partial index.
   *
   * ONE query for the whole page, including the author of every row and whether the
   * viewer has already pranamed it. The viewer's reaction is a LEFT JOIN on a single
   * pinned user id, not a lookup per row — a feed of twenty that fires forty-one
   * statements is the standard way a list that was fast at a hundred rows stops
   * being fast at a hundred thousand.
   *
   * `(published_at, id) < (cursor)` is a row comparison, so it seeks straight into
   * `community_posts_scope_feed_idx` rather than producing and discarding rows the
   * way OFFSET does. The index is partial on published questions, which is exactly
   * this predicate.
   */
  async feed(args: {
    viewerId?: string | undefined;
    spaceSlug?: string | undefined;
    scope?: 'city' | 'state' | 'national' | undefined;
    citySlug?: string | undefined;
    locales?: readonly ContentLocale[] | undefined;
    cursor?: string | undefined;
    limit?: number | undefined;
  }) {
    const limit = args.limit ?? this.opts.feedPageSize;
    const cursor = decodeCursor(args.cursor);
    const viewer = args.viewerId ?? null;

    const spaceId = args.spaceSlug ? (await this.space(args.spaceSlug)).id : null;
    const cityId = args.citySlug
      ? (await this.db.select({ id: cities.id }).from(cities)
          .where(eq(cities.slug, args.citySlug)).limit(1))[0]?.id ?? null
      : null;
    if (args.citySlug && !cityId) {
      throw new DomainError(ErrorCode.NOT_FOUND, `unknown city: ${args.citySlug}`);
    }
    /*
     * A CSV string, not a JS array.
     *
     * postgres-js serialises an array parameter and PGlite does not — binding one
     * directly failed with `malformed array literal: "ta"` under the wasm engine
     * the tests run, which is the engine closest to production semantics. A text
     * parameter and `string_to_array` behave identically on both, and the index is
     * still used because the comparison stays on `p.locale`.
     */
    const localesCsv = args.locales?.length ? [...args.locales].join(',') : null;

    const rows = await this.db.execute(sql`
      SELECT
        p.id, p.kind, p.title, p.body, p.locale, p.scope,
        p.panjika_school, p.parent_id, p.accepted_answer_id,
        p.reply_count, p.pranam_count, p.endorsement_count, p.published_at,
        p.author_id, c.slug AS city_slug,
        prof.display_name, prof.avatar_key,
        pp.kyc_status, pp.experience_years, u.panjika_school AS author_panjika,
        (react.user_id IS NOT NULL) AS viewer_pranamed
      FROM community_posts p
      JOIN community_profiles prof ON prof.user_id = p.author_id
      JOIN users u                 ON u.id = p.author_id
      LEFT JOIN cities c           ON c.id = p.city_id
      LEFT JOIN pandit_profiles pp ON pp.user_id = p.author_id
      LEFT JOIN community_post_reactions react
             ON react.post_id = p.id AND react.user_id = ${viewer}
      WHERE p.state = 'published'
        AND p.kind = 'question'
        AND (${spaceId}::text IS NULL OR p.space_id = ${spaceId})
        AND (${args.scope ?? null}::community_scope IS NULL OR p.scope = ${args.scope ?? null})
        AND (${cityId}::text IS NULL OR p.city_id = ${cityId})
        AND (${localesCsv}::text IS NULL
             OR p.locale::text = ANY(string_to_array(${localesCsv}::text, ',')))
        AND (
          ${cursor?.publishedAt ?? null}::timestamptz IS NULL
          OR (p.published_at, p.id) < (${cursor?.publishedAt ?? null}::timestamptz, ${cursor?.id ?? null})
        )
      ORDER BY p.published_at DESC, p.id DESC
      LIMIT ${limit + 1}`);

    const list = this.rows<PostRow>(rows);
    // One extra row is fetched purely to learn whether there IS a next page, which
    // is cheaper and more honest than a COUNT over the whole feed.
    const page = list.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor = list.length > limit && last
      ? encodeCursor({ publishedAt: last.published_at, id: last.id })
      : null;

    const items = await Promise.all(page.map((r) => this.renderPost(r)));
    return { items, nextCursor, scripts: scriptsForLocales(items.map((i) => i.locale)) };
  }

  /**
   * One thread: the question, its answers, and the replies under them.
   *
   * ONE statement for the whole tree — `root_id` is denormalised onto every
   * descendant precisely so this is an indexed range scan rather than a recursive
   * walk that costs a round trip per level.
   *
   * ORDERING IS THE PRODUCT. Verified purohits first, by role; then the accepted
   * answer; then endorsements; and only then pranams. Popularity never lifts an
   * unverified answer above a verified one, because a board where it can is a board
   * whose answers nobody can rely on.
   */
  async thread(rootId: string, viewerId?: string) {
    const viewer = viewerId ?? null;
    const rows = await this.db.execute(sql`
      SELECT
        p.id, p.kind, p.title, p.body, p.locale, p.scope,
        p.panjika_school, p.parent_id, p.accepted_answer_id,
        p.reply_count, p.pranam_count, p.endorsement_count, p.published_at,
        p.author_id, c.slug AS city_slug,
        prof.display_name, prof.avatar_key,
        pp.kyc_status, pp.experience_years, u.panjika_school AS author_panjika,
        (react.user_id IS NOT NULL) AS viewer_pranamed,
        q.accepted_answer_id AS thread_accepted
      FROM community_posts p
      JOIN community_profiles prof ON prof.user_id = p.author_id
      JOIN users u                 ON u.id = p.author_id
      JOIN community_posts q       ON q.id = p.root_id
      LEFT JOIN cities c           ON c.id = p.city_id
      LEFT JOIN pandit_profiles pp ON pp.user_id = p.author_id
      LEFT JOIN community_post_reactions react
             ON react.post_id = p.id AND react.user_id = ${viewer}
      WHERE p.root_id = ${rootId}
        AND p.state = 'published'
      ORDER BY
        CASE p.kind WHEN 'question' THEN 0 WHEN 'answer' THEN 1 ELSE 2 END,
        -- COALESCE, and it is not decoration.
        --
        -- A devotee has no pandit_profiles row, so pp.kyc_status is NULL and
        -- (NULL = 'verified') evaluates to NULL rather than to false. Postgres
        -- sorts NULLs FIRST under DESC, so the unverified layperson ranked ABOVE
        -- the verified purohit -- the exact inversion this ordering exists to
        -- prevent, produced by the operator meant to prevent it. Same for the
        -- accepted answer, which is NULL on every thread where nobody has
        -- accepted one yet, which is most of them.
        COALESCE(p.id = q.accepted_answer_id, false) DESC,
        COALESCE(pp.kyc_status = 'verified', false) DESC,
        p.endorsement_count DESC,
        p.pranam_count DESC,
        p.published_at ASC`);

    const list = this.rows<PostRow & { thread_accepted: string | null }>(rows);
    const questionRow = list.find((r) => r.kind === 'question');
    if (!questionRow) throw new DomainError(ErrorCode.NOT_FOUND, 'no such thread');

    const cards = new Map<string, CommunityPostCard>();
    for (const r of list) cards.set(r.id, await this.renderPost(r));

    const answers = list.filter((r) => r.kind === 'answer').map((a) => ({
      ...cards.get(a.id)!,
      replies: list.filter((r) => r.kind === 'reply' && r.parent_id === a.id)
        .map((r) => cards.get(r.id)!),
    }));

    const all = [...cards.values()];
    return {
      question: cards.get(questionRow.id)!,
      answers,
      scripts: scriptsForLocales(all.map((c) => c.locale)),
    };
  }

  // --- helpers --------------------------------------------------------------

  /** PGlite and postgres-js disagree about where rows live. See db/client.ts. */
  private rows<T>(result: unknown): T[] {
    return ((result as { rows?: unknown[] }).rows ?? result) as T[];
  }

  /**
   * A post as a community surface may see it.
   *
   * `users.name` is not selected by any query in this file and is not available
   * here. A devotee is their chosen display name and nothing else — no phone, no
   * city, no booking history. The purohit tick is read LIVE from `pandit_profiles`
   * rather than copied onto the profile, so revoked KYC removes it everywhere at
   * once instead of leaving a verified-looking answer behind.
   */
  private async renderPost(r: PostRow): Promise<CommunityPostCard> {
    const verified = r.kyc_status === 'verified';
    return {
      id: r.id,
      kind: r.kind,
      title: r.title,
      body: r.body,
      locale: r.locale,
      scope: r.scope,
      citySlug: r.city_slug,
      panjikaSchool: (r.panjika_school ?? null) as CommunityPostCard['panjikaSchool'],
      author: {
        id: r.author_id,
        displayName: r.display_name,
        // Presigning is local crypto, not a round trip, so a page of twenty costs
        // twenty signatures and zero extra queries. `Promise.all` at the call site
        // keeps it off the critical path anyway.
        avatarUrl: r.avatar_key ? await this.peers.avatarUrl(r.avatar_key) : null,
        verifiedPurohit: verified,
        experienceYears: verified ? r.experience_years : null,
        panjikaSchool: verified
          ? (r.author_panjika as CommunityPostCard['panjikaSchool'])
          : null,
      },
      replyCount: r.reply_count,
      pranamCount: r.pranam_count,
      endorsementCount: r.endorsement_count,
      viewerHasPranamed: r.viewer_pranamed === true,
      /*
       * Compared against the THREAD's accepted id, not the row's own column.
       * `accepted_answer_id` lives on the question, so an answer row's copy is
       * always null and `r.accepted_answer_id === r.id` was false for every post
       * in the product — including the accepted one. A feed has no thread context,
       * so a question is never "the accepted answer", which is correct.
       */
      isAcceptedAnswer: r.thread_accepted != null && r.thread_accepted === r.id,
      publishedAt: r.published_at,
    };
  }

  private async space(slug: string) {
    const row = (await this.db.select().from(communitySpaces)
      .where(and(eq(communitySpaces.slug, slug), eq(communitySpaces.active, true)))
      .limit(1))[0];
    if (!row) throw new DomainError(ErrorCode.NOT_FOUND, `no such space: ${slug}`);
    return row;
  }

  private async spaceById(id: string) {
    const row = (await this.db.select().from(communitySpaces)
      .where(eq(communitySpaces.id, id)).limit(1))[0];
    if (!row) throw new DomainError(ErrorCode.NOT_FOUND, 'no such space');
    return row;
  }

  /**
   * Structural moderation: the cheapest way to keep content out of a space is to
   * make posting there impossible, not to review it afterwards. A space that only
   * verified purohits may write in needs no queue at all.
   */
  private async assertMayPostIn(
    space: { id: string; postingPolicy: string }, authorId: string,
  ) {
    if (space.postingPolicy === 'open') return;

    const row = (await this.db.select({
      role: users.role, kyc: sql<string | null>`pp.kyc_status`,
    }).from(users)
      .leftJoin(sql`pandit_profiles pp`, sql`pp.user_id = ${users.id}`)
      .where(eq(users.id, authorId)).limit(1))[0];

    const isPandit = row?.role === 'pandit';
    const isVerified = row?.kyc === 'verified';

    if (space.postingPolicy === 'pandit_only' && !isPandit) {
      throw new DomainError(ErrorCode.COMMUNITY_SPACE_CLOSED, 'only purohits post in this space');
    }
    if (space.postingPolicy === 'verified_only' && !isVerified) {
      throw new DomainError(
        ErrorCode.COMMUNITY_SPACE_CLOSED,
        'only verified purohits post in this space',
      );
    }
  }
}
