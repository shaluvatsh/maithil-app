import { Controller, Get, Post, Delete, Put, Param, Query, Body, Inject } from '@nestjs/common';
import { z } from 'zod';
import { CommunityService } from './community.service';
import { CurrentUser, OptionalUser, Public } from '../auth/guards';
import type { JwtClaims } from '../auth/auth.service';
import {
  AskQuestion, PostAnswer, PostReply, ReportPost,
  ContentLocale, CommunityScope, PAGE_SIZE_MIN, PAGE_SIZE_MAX,
} from '@themaithil/contracts';

/**
 * Community routes.
 *
 * Every schema here comes from `packages/contracts`, so the composer's character
 * limit and the server's rejection are one number rather than two that drift.
 *
 * NOTHING IS CACHED, deliberately, and it is the one thing on this controller worth
 * revisiting. `viewerHasPranamed` varies per reader, so a shared cache would hand
 * one devotee another's reaction state — exactly the failure `common/cache.ts` warns
 * about. The right fix is a separate anonymous, viewer-free rendering that CAN be
 * cached publicly and is what a crawler sees; that is worth doing when the public
 * pages exist, and is not worth guessing at before then.
 */

/** Query strings arrive as strings. Coerce once, here, not in the service. */
const FeedParams = z.object({
  spaceSlug: z.string().min(1).optional(),
  scope: CommunityScope.optional(),
  citySlug: z.string().min(1).optional(),
  /** `?locales=bn,ta` — a list in a query string, not repeated keys. */
  locales: z.string().optional().transform((v) =>
    v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(PAGE_SIZE_MIN).max(PAGE_SIZE_MAX).optional(),
}).transform((q) => ({
  ...q,
  locales: q.locales ? ContentLocale.array().parse(q.locales) : undefined,
}));

const SetProfile = z.object({
  displayName: z.string().trim().min(2).max(60),
});

@Controller('v1/community')
export class CommunityController {
  constructor(@Inject(CommunityService) private readonly community: CommunityService) {}

  /**
   * The feed. Readable signed-out, because a question a stranger can read is the
   * entire acquisition argument for building this at all.
   */
  @Public()
  @Get('feed')
  feed(@OptionalUser() user: JwtClaims | undefined, @Query() raw: unknown) {
    const q = FeedParams.parse(raw);
    return this.community.feed({ ...q, viewerId: user?.sub });
  }

  @Public()
  @Get('threads/:id')
  thread(@OptionalUser() user: JwtClaims | undefined, @Param('id') id: string) {
    return this.community.thread(id, user?.sub);
  }

  /**
   * A devotee chooses the name they are known by here before they post anything.
   *
   * Not optional and not generated: an invented handle is either derived from their
   * real identity, which defeats the separation, or it is a random pair of words
   * they never agreed to be called.
   */
  @Put('profile')
  setProfile(@CurrentUser() user: JwtClaims, @Body() raw: unknown) {
    const { displayName } = SetProfile.parse(raw);
    return this.community.ensureProfile(user.sub, displayName);
  }

  @Post('questions')
  ask(@CurrentUser() user: JwtClaims, @Body() raw: unknown) {
    const body = AskQuestion.parse(raw);
    return this.community.ask({ ...body, authorId: user.sub });
  }

  /**
   * One route for both answers and replies.
   *
   * Which one it is depends on what the parent is, and the database decides: an
   * answer hangs off a question, a reply off an answer, and nothing hangs off a
   * reply. Asking the client to declare the kind would let it declare the wrong one.
   */
  @Post('posts/:id/responses')
  respond(@CurrentUser() user: JwtClaims, @Param('id') parentId: string, @Body() raw: unknown) {
    const parsed = PostAnswer.safeParse(raw);
    const body = parsed.success ? parsed.data : PostReply.parse(raw);
    return this.community.respond({ ...body, parentId, authorId: user.sub });
  }

  @Post('posts/:id/endorse')
  endorse(@CurrentUser() user: JwtClaims, @Param('id') postId: string) {
    return this.community.endorse(postId, user.sub);
  }

  @Post('posts/:id/pranam')
  pranam(@CurrentUser() user: JwtClaims, @Param('id') postId: string) {
    return this.community.pranam(postId, user.sub);
  }

  @Delete('posts/:id/pranam')
  unpranam(@CurrentUser() user: JwtClaims, @Param('id') postId: string) {
    return this.community.unpranam(postId, user.sub);
  }

  @Post('questions/:id/accept/:answerId')
  accept(
    @CurrentUser() user: JwtClaims,
    @Param('id') questionId: string,
    @Param('answerId') answerId: string,
  ) {
    return this.community.acceptAnswer(questionId, answerId, user.sub);
  }

  @Post('posts/:id/report')
  report(@CurrentUser() user: JwtClaims, @Param('id') postId: string, @Body() raw: unknown) {
    const body = ReportPost.parse(raw);
    return this.community.report({ ...body, postId, reporterId: user.sub });
  }
}
