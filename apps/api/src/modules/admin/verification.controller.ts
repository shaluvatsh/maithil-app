import { Controller, Post, Get, Param, Body, Query, Inject } from '@nestjs/common';
import { eq, and, sql, desc, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { DB } from '../../common/tokens';
import type { Db } from '../../db/client';
import {
  panditProfiles, users, kycRecords, cities, bookings, bookingEvents,
} from '../../db/schema/index';
import { AvailabilityService } from '../availability/availability.service';
import { OutboxService } from '../../domain/outbox';
import type { ObjectStore } from '../storage/object-store';
import { AuditService } from '../../common/audit';
import { Roles, CurrentUser } from '../auth/guards';
import type { JwtClaims } from '../auth/auth.service';
import { DomainError, ErrorCode } from '@themaithil/contracts';

/**
 * One document's verdict.
 *
 * A rejection must carry a reason, because the purohit reads it and it is the only
 * thing that tells them which document to replace and why. An approval needs none.
 */
const DocumentVerdict = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('verified'), notes: z.string().max(500).optional() }),
  z.object({ decision: z.literal('rejected'), notes: z.string().trim().min(3).max(500) }),
]);

/**
 * Asking for specific documents again.
 *
 * At least one document, each with a reason the purohit will read. The reason is
 * required rather than optional: a request to re-upload with no explanation is the
 * thing that makes someone send the same photograph a second time.
 */
const ChangeRequest = z.object({
  /** Anything about the application as a whole. Optional — the per-document reasons carry it. */
  notes: z.string().max(1000).optional(),
});

const Decision = z.object({
  decision: z.enum(['verified', 'rejected']),
  /** Applies to the whole application — shown once, above the documents. */
  notes: z.string().max(1000).optional(),
  /**
   * Per-document notes, keyed by `kyc_records.id`.
   *
   * The single `notes` field was written to EVERY document row for the purohit, so
   * "the PAN is illegible" appeared under their photo ID, their address proof and
   * their certificate alike. A rejected purohit could not tell which document to
   * replace, which is the only thing the note exists to tell them.
   */
  documentNotes: z.record(z.string(), z.string().max(500)).optional(),
});

/**
 * Purohit verification queue.
 *
 * KYC is reviewed by a human in R1 (ADR 0010) - at roughly one verification a day a
 * person does it in ten minutes, and the judgement that matters (is this a credible
 * purohit, is the lineage real) is not automatable anyway. Every decision is
 * audit-logged, because approving supply is the most consequential action an operator
 * takes: a bad approval is a stranger in someone's home.
 */
@Controller('v1/admin')
@Roles('admin', 'ops')
export class VerificationController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AvailabilityService) private readonly availability: AvailabilityService,
    @Inject('OBJECT_STORE') private readonly store: ObjectStore,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  @Get('verification-queue')
  async queue() {
    const rows = await this.db.select({
      id: users.id, name: users.name, phone: users.phone,
      kycStatus: panditProfiles.kycStatus,
      experienceYears: panditProfiles.experienceYears,
      languages: panditProfiles.languages,
      traditions: panditProfiles.traditions,
      createdAt: panditProfiles.createdAt,
      highestQualification: panditProfiles.highestQualification,
      submittedAt: panditProfiles.submittedAt,
      photoKey: panditProfiles.photoKey,
      documents: sql<number>`(
        SELECT count(*)::int FROM kyc_records k WHERE k.pandit_id = ${panditProfiles.userId}
      )`,
      /*
       * WHICH required documents are on file, not just how many exist.
       *
       * A count cannot tell a reviewer whether the missing one is a recording or a
       * PAN card. The purohit-side submit gate already refuses an incomplete
       * application, but a queue row is what an operator decides from, and older
       * applications predate that gate — so the screen has to be able to say what is
       * actually here.
       */
      /*
       * How far the review has got.
       *
       * A reviewer interrupted halfway through four documents had no way to see, from
       * the queue, that they had already checked three — so they started again. The
       * verdicts are recorded per document now, and this surfaces them.
       */
      reviewedDocs: sql<number>`(
        SELECT count(*)::int FROM kyc_records k
         WHERE k.pandit_id = ${panditProfiles.userId} AND k.status <> 'pending'
      )`,
      rejectedDocs: sql<number>`(
        SELECT count(*)::int FROM kyc_records k
         WHERE k.pandit_id = ${panditProfiles.userId} AND k.status = 'rejected'
      )`,
      missingDocs: sql<string[]>`(
        SELECT coalesce(array_agg(r), ARRAY[]::text[])
          FROM unnest(ARRAY['identity','address','pan','qualification']) AS r
         WHERE NOT EXISTS (
           SELECT 1 FROM kyc_records k
            WHERE k.pandit_id = ${panditProfiles.userId} AND k.type::text = r
         )
      )`,
    })
      .from(panditProfiles)
      .innerJoin(users, eq(users.id, panditProfiles.userId))
      .where(sql`${panditProfiles.kycStatus} IN ('pending', 'submitted', 'changes_requested')`)
      /*
       * Oldest submission first, not oldest signup.
       *
       * This ordered by `createdAt` — the date the purohit joined — so someone who
       * signed up months ago and submitted this morning sat above someone who did
       * both yesterday. A work queue is ordered by when the work arrived.
       *
       * Nulls last: a `pending` purohit has submitted nothing, so there is nobody
       * waiting on us and they belong below everyone who is.
       */
      .orderBy(sql`${panditProfiles.submittedAt} ASC NULLS LAST`);

    /*
     * A signed URL for each face.
     *
     * Comparing the photograph to the photo ID IS the identity check a reviewer
     * performs, so the queue has to show it rather than making them open a document
     * to see who they are looking at. Signed per request like every other object.
     */
    return Promise.all(rows.map(async ({ photoKey, ...row }) => ({
      ...row,
      photoUrl: photoKey ? await this.store.presignDownload({ key: photoKey }) : null,
    })));
  }

  /**
   * The documents themselves, behind short-lived signed URLs.
   *
   * The queue has always shown a document COUNT, and nothing could create a document,
   * so it rendered zero for everyone and an admin approved purohits on the strength
   * of a name and a self-declared number of years. A count is not evidence; this is
   * the screen where "verified" is either earned or is a rubber stamp.
   *
   * Five-minute URLs, minted per request rather than stored. An identity document
   * URL that outlives the review sitting in a browser history or a shared Slack
   * message is the whole risk of this feature.
   */
  @Get('pandits/:id/kyc')
  async documents(@Param('id') panditId: string) {
    const rows = await this.db.select({
      id: kycRecords.id, type: kycRecords.type, status: kycRecords.status,
      last4: kycRecords.identifierLast4, docKey: kycRecords.docKey,
      provider: kycRecords.provider, notes: kycRecords.reviewNotes,
      purgeAfter: kycRecords.docPurgeAfter, createdAt: kycRecords.createdAt,
    }).from(kycRecords).where(eq(kycRecords.panditId, panditId));

    return Promise.all(rows.map(async ({ docKey, ...row }) => ({
      ...row,
      /*
       * Null once purged, and that is a meaningful answer rather than a missing
       * one: the image is deleted 30 days after a decision (ADR 0010) and the
       * record deliberately outlives it. An operator looking at an old approval
       * should see that a document existed and is gone, not an error.
       */
      viewUrl: docKey ? await this.store.presignDownload({ key: docKey }) : null,
    })));
  }

  /**
   * Approve or reject ONE document.
   *
   * Review was a single verdict over the whole application, so a reviewer working
   * through four documents had nowhere to record that the first three were fine —
   * they held it in their head, and if they were interrupted they started again.
   *
   * Records the verdict and nothing else: no profile status change and no message.
   * The reviewer marks each document as they read it, then takes ONE action on the
   * application — approve, reject, or ask for the flagged ones again — and that
   * action is what reaches the purohit. Notifying per document would send someone
   * three WhatsApp messages for one review.
   */
  @Post('pandits/:id/documents/:docId')
  async reviewDocument(
    @CurrentUser() actor: JwtClaims,
    @Param('id') panditId: string,
    @Param('docId') docId: string,
    @Body() raw: unknown,
  ) {
    const body = DocumentVerdict.parse(raw);

    // Scoped to this purohit: the id comes from the URL, and a reviewer must not be
    // able to mark another purohit's document by mistyping one.
    const hit = await this.db.update(kycRecords)
      .set({
        status: body.decision,
        reviewNotes: body.notes ?? null,
        reviewedBy: actor.sub,
      })
      .where(and(eq(kycRecords.id, docId), eq(kycRecords.panditId, panditId)))
      .returning({ id: kycRecords.id, type: kycRecords.type });

    if (!hit[0]) {
      throw new DomainError(ErrorCode.NOT_FOUND, 'that document does not belong to this purohit');
    }
    return { id: hit[0].id, kind: hit[0].type, decision: body.decision };
  }

  /**
   * Ask the purohit for one or more documents again.
   *
   * Review used to be approve-or-reject, so a reviewer who could not read a single
   * PAN card had to reject the application — and the purohit, told only "rejected",
   * re-uploaded all four documents to fix one. This leaves them under review, flags
   * only what is wrong, and gives each flagged document its own reason.
   *
   * Not a decision, so it writes no `kyc_verified_at` and no audit `kyc.*` action of
   * the kind approve and reject record; it is recorded as its own action.
   */
  @Post('pandits/:id/request-changes')
  async requestChanges(
    @CurrentUser() actor: JwtClaims,
    @Param('id') panditId: string,
    @Body() raw: unknown,
  ) {
    const body = ChangeRequest.parse(raw);
    const [before] = await this.db.select().from(panditProfiles)
      .where(eq(panditProfiles.userId, panditId)).limit(1);
    if (!before) throw new DomainError(ErrorCode.NOT_FOUND, 'purohit not found');
    if (before.kycStatus === 'verified') {
      throw new DomainError(
        ErrorCode.INVALID_TRANSITION,
        'this purohit is already verified — reject the account instead if it must be undone',
      );
    }

    /*
     * Sends whatever the reviewer has already marked rejected.
     *
     * This used to take the flags in its own request body, which meant the verdicts
     * lived in two places — the per-document endpoint and this one — and could
     * disagree. The documents carry their own state now, so this reads it rather
     * than being told it again, and the reasons the purohit gets are exactly the
     * ones the reviewer typed against each document.
     */
    const rejected = await this.db.select({
      id: kycRecords.id, type: kycRecords.type, notes: kycRecords.reviewNotes,
    }).from(kycRecords).where(and(
      eq(kycRecords.panditId, panditId),
      eq(kycRecords.status, 'rejected'),
    ));

    if (rejected.length === 0) {
      throw new DomainError(
        ErrorCode.INVALID_TRANSITION,
        'mark at least one document as rejected before asking for changes',
      );
    }

    return this.db.transaction(async (tx) => {
      const flagged = rejected.map((r) => r.id);

      await tx.update(panditProfiles)
        .set({ kycStatus: 'changes_requested' })
        .where(eq(panditProfiles.userId, panditId));

      await this.audit.record(tx, {
        actorId: actor.sub, actorRole: actor.role,
        action: 'pandit.kyc.changes_requested',
        entityType: 'pandit', entityId: panditId,
        before: { kycStatus: before.kycStatus },
        after: { kycStatus: 'changes_requested', documents: flagged, notes: body.notes },
      });

      /*
       * The purohit has to hear this. A request sitting unseen on a screen they have
       * no reason to revisit is the same as no request at all — and they are the only
       * person who can act on it.
       */
      await this.outbox.emit(tx, {
        aggregateType: 'pandit', aggregateId: panditId,
        eventType: 'pandit.kyc.changes_requested',
        payload: {
          documents: flagged,
          /*
           * The reviewer's own words, gathered from the documents themselves. A
           * WhatsApp message has no room for a per-document list, so the reasons are
           * joined — and the app shows them against each document when they open it.
           */
          notes: body.notes?.trim()
            || rejected.map((r) => r.notes).filter(Boolean).join('; ')
            || null,
        },
      });

      return { panditId, kycStatus: 'changes_requested' as const, flagged };
    });
  }

  @Post('pandits/:id/verification')
  async decide(
    @CurrentUser() actor: JwtClaims,
    @Param('id') panditId: string,
    @Body() raw: unknown,
  ) {
    const body = Decision.parse(raw);
    const before = (await this.db.select().from(panditProfiles)
      .where(eq(panditProfiles.userId, panditId)).limit(1))[0];
    if (!before) throw new DomainError(ErrorCode.NOT_FOUND, 'purohit not found');

    return this.db.transaction(async (tx) => {
      const now = new Date().toISOString();
      await tx.update(panditProfiles).set({
        kycStatus: body.decision,
        kycVerifiedAt: body.decision === 'verified' ? now : null,
        /*
         * Not written any more.
         *
         * This set a one-year expiry "per the PRD", and nothing ever read it — so the
         * code looked as though annual re-verification were handled while a purohit
         * verified once stayed verified forever. Re-verification is not a requirement
         * of this product, so the honest thing is to stop writing a date nobody acts
         * on rather than leave one that implies otherwise.
         */
        kycExpiresAt: null,
      }).where(eq(panditProfiles.userId, panditId));

      /*
       * The decision applies to every document; the NOTES do not.
       *
       * `reviewNotes` was set to the same string on every row, so a note about one
       * document appeared under all of them and a rejected purohit could not tell
       * which one to replace. The blanket note is kept for the application as a
       * whole, and anything said about a specific document overrides it there.
       */
      await tx.update(kycRecords).set({
        status: body.decision, reviewedBy: actor.sub, reviewNotes: body.notes ?? null,
        // Identity images are purged 30 days after a decision - we keep the reference,
        // never the document. See ADR 0010.
        docPurgeAfter: new Date(Date.now() + 30 * 86400_000).toISOString(),
      }).where(eq(kycRecords.panditId, panditId));

      for (const [docId, note] of Object.entries(body.documentNotes ?? {})) {
        await tx.update(kycRecords).set({ reviewNotes: note })
          .where(and(eq(kycRecords.id, docId), eq(kycRecords.panditId, panditId)));
      }

      await this.audit.record(tx, {
        actorId: actor.sub, actorRole: actor.role,
        action: `pandit.kyc.${body.decision}`,
        entityType: 'pandit', entityId: panditId,
        before: { kycStatus: before.kycStatus },
        after: { kycStatus: body.decision, notes: body.notes },
      });

      /*
       * Tell them. Nothing did.
       *
       * The decision was written to the database and no message left the building, so
       * an approved purohit found out by opening the app and a rejected one might
       * never find out at all — on the one screen they have no reason to revisit.
       */
      await this.outbox.emit(tx, {
        aggregateType: 'pandit', aggregateId: panditId,
        eventType: `pandit.kyc.${body.decision}`,
        payload: { notes: body.notes ?? null },
      });

      return { panditId, kycStatus: body.decision };
    });
  }

  /**
   * Supply coverage for a city, day by day.
   *
   * The console shows bookings and a ledger, both records of what already happened.
   * Neither answers the question an operator actually needs before a festival week:
   * which days are about to run out of purohits. A Saturday with four open slots
   * across the whole city is a day of rejected bookings, and it is only actionable
   * while there is still time to ring purohits and ask them to open more.
   *
   * The same calendar a devotee reads for auspicious dates and a purohit reads to
   * mark availability — aggregated, because that is what the third role needs from
   * it.
   */
  /*
   * `@Controller('v1/admin')` at the class level already supplies the `admin`
   * segment - `@Get('admin/coverage')` doubled it, so this only ever answered at
   * `/v1/admin/admin/coverage`. The intended `/v1/admin/coverage` (what
   * panchang/page.tsx actually calls) 404'd, silently: an unmounted route and a
   * misspelled one are indistinguishable from the caller's side. Same bug, same
   * shape, as the VerificationController/ReviewsController registration miss
   * this file's own history already tells a story about - just one route
   * segment deep instead of a whole missing controller.
   */
  @Roles('admin', 'ops')
  @Get('coverage')
  async coverage(@Query() raw: unknown) {
    const q = z.object({
      citySlug: z.string().default(process.env.LAUNCH_CITY_SLUG ?? 'kolkata'),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }).parse(raw);

    const [city] = await this.db.select({ id: cities.id }).from(cities)
      .where(eq(cities.slug, q.citySlug)).limit(1);
    if (!city) throw new DomainError(ErrorCode.NOT_FOUND, `unknown city: ${q.citySlug}`);

    return this.availability.coverage({
      cityId: city.id, from: q.from as never, to: q.to as never,
    });
  }

  /**
   * Cancellations and substitutions, most recent first.
   *
   * Every one of these is already written to `booking_events` inside the same
   * transaction that made the change — and nothing has ever read them. So when a
   * purohit drops a job and `rematch` silently finds a replacement, that is a
   * success nobody sees; and when it silently fails, that is a devotee losing their
   * booking and nobody being told until they complain.
   *
   * Under ADR 0012 the platform assigns the purohit, which means the platform owns
   * the failure. An operator cannot own it without being able to see it.
   */
  // Same route-doubling bug as `coverage` above - this only ever answered at
  // `/v1/admin/admin/incidents`, so the Cancellations tab's "Nothing cancelled
  // or re-matched yet" was never actually true; it was a 404 rendered as an
  // empty state, on the one screen whose entire job is surfacing failed rematches.
  @Roles('admin', 'ops')
  @Get('incidents')
  async incidents(@Query() raw: unknown) {
    const q = z.object({
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }).parse(raw);

    const rows = await this.db
      .select({
        id: bookingEvents.id,
        bookingId: bookingEvents.bookingId,
        trigger: bookingEvents.trigger,
        toState: bookingEvents.toState,
        actorRole: bookingEvents.actorRole,
        meta: bookingEvents.meta,
        at: bookingEvents.at,
        slotStartAt: bookings.slotStartAt,
        cancelReason: bookings.cancelReason,
        devoteeName: users.name,
      })
      .from(bookingEvents)
      .innerJoin(bookings, eq(bookings.id, bookingEvents.bookingId))
      .leftJoin(users, eq(users.id, bookings.devoteeId))
      .where(inArray(bookingEvents.trigger, [
        'cancel_pandit', 'cancel_devotee', 'pandit_substituted',
      ]))
      .orderBy(desc(bookingEvents.at))
      .limit(q.limit);

    return rows.map((r) => {
      const meta = (r.meta ?? {}) as { previousPanditId?: string; panditId?: string };
      const substituted = r.trigger === 'pandit_substituted';
      return {
        id: r.id,
        bookingId: r.bookingId,
        at: r.at,
        slotStartAt: r.slotStartAt,
        devoteeName: r.devoteeName,
        reason: r.cancelReason,
        kind: substituted ? 'substituted'
          : r.trigger === 'cancel_pandit' ? 'pandit_cancelled'
          : 'devotee_cancelled',
        previousPanditId: meta.previousPanditId ?? null,
        panditId: meta.panditId ?? null,
        /**
         * The distinction an operator acts on. A purohit dropping a job that was
         * re-matched is routine; one that was NOT re-matched is a devotee with no
         * purohit and a slot getting closer.
         */
        rescued: substituted,
        needsAttention: r.trigger === 'cancel_pandit' && !substituted,
      };
    });
  }
}
