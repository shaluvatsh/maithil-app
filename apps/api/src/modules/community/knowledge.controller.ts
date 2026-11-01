import { Controller, Get, Post, Param, Query, Body, Inject } from '@nestjs/common';
import { z } from 'zod';
import { KnowledgeService } from './knowledge.service';
import { CurrentUser, Public, Roles } from '../auth/guards';
import type { JwtClaims } from '../auth/auth.service';
import {
  CreateKnowledge, ReviewVerdict, KnowledgeType, KnowledgeLevel, ContentLocale,
  PAGE_SIZE_MIN, PAGE_SIZE_MAX,
} from '@themaithil/contracts';
import { Cacheable, CACHE } from '../../common/cache';
import {
  ALLOWED_MEDIA_TYPES, knowledgeMediaKey, type ObjectStore,
} from '../storage/object-store';

/**
 * Knowledge library routes.
 *
 * Browsing is public AND cacheable, unlike the community feed — a published item is
 * the same for every reader, carries no per-viewer state, and is the surface a
 * crawler indexes. That is the difference the feed could not have: it renders
 * `viewerHasPranamed`, so a shared cache there would hand one devotee another's
 * reaction state.
 *
 * `@Roles` is not set at the class level here, because the review routes and the
 * public ones genuinely differ — stated per method rather than by splitting the file,
 * since every route touches the same service.
 */

const MediaUpload = z.object({
  /** Narrowed to the three formats a phone records; the list is the security control. */
  contentType: z.enum(ALLOWED_MEDIA_TYPES),
});

const BrowseParams = z.object({
  type: KnowledgeType.optional(),
  level: KnowledgeLevel.optional(),
  ritualSlug: z.string().min(1).optional(),
  locale: ContentLocale.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(PAGE_SIZE_MIN).max(PAGE_SIZE_MAX).optional(),
});

@Controller('v1/knowledge')
export class KnowledgeController {
  constructor(
    @Inject(KnowledgeService) private readonly knowledge: KnowledgeService,
    @Inject('OBJECT_STORE') private readonly store: ObjectStore,
  ) {}

  @Public()
  @Cacheable(CACHE.almanac)
  @Get()
  browse(@Query() raw: unknown) {
    return this.knowledge.browse(BrowseParams.parse(raw));
  }

  /**
   * The review queue, before the `:slug` route.
   *
   * Order matters: a literal path declared after a parameter route is swallowed by
   * it, so `/queue` would resolve as a slug and 404 for every reviewer.
   */
  @Get('queue')
  queue(@Query('limit') limit?: string) {
    const parsed = z.coerce.number().int().min(PAGE_SIZE_MIN).max(PAGE_SIZE_MAX)
      .optional().parse(limit);
    return this.knowledge.reviewQueue(parsed);
  }

  @Public()
  @Cacheable(CACHE.almanac)
  @Get(':slug')
  read(@Param('slug') slug: string, @Query('locale') locale?: string) {
    const parsed = ContentLocale.optional().parse(locale);
    return this.knowledge.bySlug(slug, parsed);
  }

  /**
   * A signed URL to PUT a recording to.
   *
   * The KEY IS SERVER-CHOSEN, never taken from the request — a client-supplied path
   * is how an upload endpoint becomes a way to overwrite somebody else's file. The
   * content type is signed with it, so a caller that asks for an mp3 URL cannot then
   * push an HTML file through it.
   */
  @Post('upload-url')
  async uploadUrl(@CurrentUser() user: JwtClaims, @Body() raw: unknown) {
    const { contentType } = MediaUpload.parse(raw);
    return this.store.presignUpload({
      key: knowledgeMediaKey({ authorId: user.sub, contentType }),
      contentType,
    });
  }

  /** Anyone signed in may write. Publishing is what is gated, not authorship. */
  @Post()
  create(@CurrentUser() user: JwtClaims, @Body() raw: unknown) {
    const body = CreateKnowledge.parse(raw);
    return this.knowledge.create({ ...body, authorId: user.sub });
  }

  @Post(':id/submit')
  submit(@CurrentUser() user: JwtClaims, @Param('id') id: string) {
    return this.knowledge.submit(id, user.sub);
  }

  /**
   * Reviewing is open to verified purohits, not only to staff.
   *
   * The role guard admits any purohit; the service then checks verification and that
   * the reviewer is not the author. Staff cannot judge whether a Maithili account of
   * a vidhi is right, and the people who can are already here — so restricting this
   * to `ops` would make the queue a bottleneck that never clears.
   */
  @Roles('pandit', 'admin', 'ops')
  @Post(':id/review')
  review(@CurrentUser() user: JwtClaims, @Param('id') id: string, @Body() raw: unknown) {
    const body = ReviewVerdict.parse(raw);
    return this.knowledge.review({
      itemId: id, reviewerId: user.sub, reviewerRole: user.role,
      decision: body.decision, note: body.note,
    });
  }

  @Post(':id/retire')
  retire(@CurrentUser() user: JwtClaims, @Param('id') id: string) {
    return this.knowledge.retire(id, user.sub, user.role);
  }
}
