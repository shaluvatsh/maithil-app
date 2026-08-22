import { Controller, Post, Get, Param, Body, Query, Inject } from '@nestjs/common';
import { eq, sql, desc, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { DB } from '../../common/tokens';
import type { Db } from '../../db/client';
import {
  panditProfiles, users, kycRecords, cities, bookings, bookingEvents,
} from '../../db/schema/index';
import { AvailabilityService } from '../availability/availability.service';
import type { ObjectStore } from '../storage/object-store';
import { AuditService } from '../../common/audit';
import { Roles, CurrentUser } from '../auth/guards';
import type { JwtClaims } from '../auth/auth.service';
import { DomainError, ErrorCode } from '@themaithil/contracts';

const Decision = z.object({
  decision: z.enum(['verified', 'rejected']),
  notes: z.string().max(1000).optional(),
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
  ) {}

  @Get('verification-queue')
  async queue() {
    return this.db.select({
      id: users.id, name: users.name, phone: users.phone,
      kycStatus: panditProfiles.kycStatus,
      experienceYears: panditProfiles.experienceYears,
      languages: panditProfiles.languages,
      traditions: panditProfiles.traditions,
      createdAt: panditProfiles.createdAt,
      documents: sql<number>`(
        SELECT count(*)::int FROM kyc_records k WHERE k.pandit_id = ${panditProfiles.userId}
      )`,
    })
      .from(panditProfiles)
      .innerJoin(users, eq(users.id, panditProfiles.userId))
      .where(sql`${panditProfiles.kycStatus} IN ('pending', 'submitted')`)
      .orderBy(panditProfiles.createdAt);
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
        // Annual re-verification, per the PRD.
        kycExpiresAt: body.decision === 'verified'
          ? new Date(Date.now() + 365 * 86400_000).toISOString() : null,
      }).where(eq(panditProfiles.userId, panditId));

      await tx.update(kycRecords).set({
        status: body.decision, reviewedBy: actor.sub, reviewNotes: body.notes ?? null,
        // Identity images are purged 30 days after a decision - we keep the reference,
        // never the document. See ADR 0010.
        docPurgeAfter: new Date(Date.now() + 30 * 86400_000).toISOString(),
      }).where(eq(kycRecords.panditId, panditId));

      await this.audit.record(tx, {
        actorId: actor.sub, actorRole: actor.role,
        action: `pandit.kyc.${body.decision}`,
        entityType: 'pandit', entityId: panditId,
        before: { kycStatus: before.kycStatus },
        after: { kycStatus: body.decision, notes: body.notes },
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
