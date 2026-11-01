import { Controller, Get, Post, Param, Query, Body, Inject } from '@nestjs/common';
import { z } from 'zod';
import { CommunityService } from './community.service';
import { Roles, CurrentUser } from '../auth/guards';
import type { JwtClaims } from '../auth/auth.service';
import { PAGE_SIZE_MIN, PAGE_SIZE_MAX } from '@themaithil/contracts';

/**
 * The moderation queue.
 *
 * C1 shipped without this and was incomplete because of it: triage could set a post
 * to `held` and there was no way for a human to release it, so an automated hold was
 * indistinguishable from a deletion — the exact outcome ADR 0016 says this product
 * must never produce. A hold is only defensible if somebody can undo it.
 *
 * Deliberately a separate controller from `CommunityController`. Those routes are
 * public or devotee-authenticated; every route here is `@Roles('admin','ops')`, and
 * mixing the two on one class means the guard is decided per method on a surface
 * where forgetting once exposes the queue.
 */

const Decision = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('release') }),
  /*
   * A removal carries a reason and an approval does not.
   *
   * The author reads it, and it is the only thing that tells them what to change —
   * a removal with no explanation is one they will repeat. It is also the only
   * record a later reviewer has of why a post is gone. Same shape as the KYC
   * `DocumentVerdict`, for the same reason.
   */
  z.object({ decision: z.literal('remove'), reason: z.string().trim().min(3).max(500) }),
]);

const ReportResolution = z.object({
  state: z.enum(['actioned', 'rejected']),
  resolution: z.string().trim().max(1000).optional(),
});

const TrustChange = z.object({
  level: z.enum(['restricted', 'newcomer']),
});

@Controller('v1/admin/community')
@Roles('admin', 'ops')
export class CommunityModerationController {
  constructor(@Inject(CommunityService) private readonly community: CommunityService) {}

  /** Held posts and open reports, oldest first — which is also SLA order. */
  @Get('queue')
  queue(@Query('limit') limit?: string) {
    const parsed = z.coerce.number().int().min(PAGE_SIZE_MIN).max(PAGE_SIZE_MAX)
      .optional().parse(limit);
    return this.community.queue({ limit: parsed });
  }

  @Post('posts/:id/decision')
  decide(@CurrentUser() user: JwtClaims, @Param('id') id: string, @Body() raw: unknown) {
    const body = Decision.parse(raw);
    return this.community.decide({
      postId: id,
      decision: body.decision,
      reason: body.decision === 'remove' ? body.reason : undefined,
      actorId: user.sub,
      actorRole: user.role,
    });
  }

  /**
   * Acknowledging is its own action, separate from resolving.
   *
   * The IT Rules give 24 hours to acknowledge and 15 days to resolve, and they are
   * different obligations. An operator who has read a report at 9am but needs a
   * second opinion has met the first and not the second, and a console that could
   * only record both at once would understate compliance on exactly the reports
   * that took the most care.
   */
  @Post('reports/:id/acknowledge')
  acknowledge(@Param('id') id: string) {
    return this.community.acknowledgeReport(id);
  }

  @Post('reports/:id/resolution')
  resolve(@CurrentUser() user: JwtClaims, @Param('id') id: string, @Body() raw: unknown) {
    const body = ReportResolution.parse(raw);
    return this.community.resolveReport({
      reportId: id, state: body.state, resolution: body.resolution,
      actorId: user.sub, actorRole: user.role,
    });
  }

  /** The only lever that restricts an account, and the only one that restores it. */
  @Post('profiles/:userId/trust')
  trust(@CurrentUser() user: JwtClaims, @Param('userId') userId: string, @Body() raw: unknown) {
    const body = TrustChange.parse(raw);
    return this.community.setTrust({
      userId, level: body.level, actorId: user.sub, actorRole: user.role,
    });
  }
}
