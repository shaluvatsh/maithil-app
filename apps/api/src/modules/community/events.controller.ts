import { Controller, Get, Post, Delete, Param, Query, Body, Inject } from '@nestjs/common';
import { z } from 'zod';
import { EventsService } from './events.service';
import { CurrentUser, OptionalUser, Public, Roles } from '../auth/guards';
import type { JwtClaims } from '../auth/auth.service';
import {
  CreateEvent, DiscoverEvents, RegisterForSession,
  EventKind, ContentLocale, PAGE_SIZE_MIN, PAGE_SIZE_MAX,
  RADIUS_KM_MIN, RADIUS_KM_MAX,
} from '@themaithil/contracts';

/**
 * Event routes. ADR 0015.
 *
 * Discovery is public — an event a stranger can find is the point of listing it, and
 * it is the surface a crawler can index. Everything that changes state is
 * authenticated, and `verify` is ops only because it is the moment the platform
 * starts standing behind an event rather than merely carrying it.
 */

/** Query strings arrive as strings; coerce once, here. */
const DiscoverParams = z.object({
  citySlug: z.string().min(1).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  radiusKm: z.coerce.number().min(RADIUS_KM_MIN).max(RADIUS_KM_MAX).optional(),
  kind: EventKind.optional(),
  from: z.string().datetime({ offset: true }).optional(),
  locales: z.string().optional().transform((v) =>
    v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(PAGE_SIZE_MIN).max(PAGE_SIZE_MAX).optional(),
}).transform((q) => ({
  ...q,
  locales: q.locales ? ContentLocale.array().parse(q.locales) : undefined,
})).refine(
  // A point without a radius cannot be filtered and a radius without a point cannot
  // be measured from. Rejecting the pair is clearer than silently ignoring half of it.
  (q) => (q.lat === undefined) === (q.lng === undefined),
  { message: 'lat and lng must be given together' },
);

const CancelEvent = z.object({ reason: z.string().trim().min(3).max(500) });

@Controller('v1/events')
export class EventsController {
  constructor(@Inject(EventsService) private readonly events: EventsService) {}

  @Public()
  @Get()
  discover(@OptionalUser() user: JwtClaims | undefined, @Query() raw: unknown) {
    const q = DiscoverParams.parse(raw);
    return this.events.discover({ ...q, viewerId: user?.sub } as DiscoverEvents);
  }

  @Public()
  @Get(':id')
  detail(@OptionalUser() user: JwtClaims | undefined, @Param('id') id: string) {
    return this.events.detail(id, user?.sub);
  }

  /**
   * Anyone signed in may create one. What they may create depends on who they are:
   * the service derives `hostKind` from the account and refuses a devotee who asks
   * for a paid mode, and the database refuses it again.
   */
  @Post()
  create(@CurrentUser() user: JwtClaims, @Body() raw: unknown) {
    const body = CreateEvent.parse(raw);
    return this.events.create({ ...body, hostId: user.sub });
  }

  @Post(':id/publish')
  publish(@CurrentUser() user: JwtClaims, @Param('id') id: string) {
    return this.events.publish(id, user.sub);
  }

  /** Ops only: the point at which the platform starts standing behind an event. */
  @Roles('admin', 'ops')
  @Post(':id/verify')
  verify(@CurrentUser() user: JwtClaims, @Param('id') id: string) {
    return this.events.verify(id, user.sub);
  }

  @Post(':id/cancel')
  cancel(@CurrentUser() user: JwtClaims, @Param('id') id: string, @Body() raw: unknown) {
    const { reason } = CancelEvent.parse(raw);
    return this.events.cancel(id, user.sub, reason);
  }

  @Post('sessions/:sessionId/registrations')
  register(
    @CurrentUser() user: JwtClaims,
    @Param('sessionId') sessionId: string,
    @Body() raw: unknown,
  ) {
    const { seats } = RegisterForSession.parse(raw ?? {});
    return this.events.register({ sessionId, userId: user.sub, seats });
  }

  @Delete('sessions/:sessionId/registrations')
  giveUp(@CurrentUser() user: JwtClaims, @Param('sessionId') sessionId: string) {
    return this.events.cancelRegistration({ sessionId, userId: user.sub });
  }
}
