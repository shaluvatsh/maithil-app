import { Controller, Post, Get, Body, Param, Inject } from '@nestjs/common';
import { CONFIG } from '../../common/tokens';
import type { Config } from '../../common/config';
import { BookingService } from './booking.service';
import { PricingService } from './pricing.service';
import { CatalogService } from '../catalog/catalog.service';
import { IdempotencyService } from '../../common/idempotency';
import { CurrentUser, Roles } from '../auth/guards';
import type { JwtClaims } from '../auth/auth.service';
import {
  CreateBookingBody, CompleteBookingBody, CancelBookingBody,
  DomainError, ErrorCode,
} from '@themaithil/contracts';

@Controller('v1/bookings')
export class BookingController {
  // Explicit tokens on every parameter.
  //
  // Nest's type-based constructor injection relies on `emitDecoratorMetadata`, which
  // esbuild - and therefore both tsx and vitest - does not emit. Without it every
  // injected dependency silently arrives as undefined and the route 500s at runtime
  // while the build stays green. Naming the token removes the dependency on metadata.
  constructor(
    @Inject(BookingService) private readonly bookings: BookingService,
    @Inject(PricingService) private readonly pricing: PricingService,
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  @Post()
  async create(@CurrentUser() user: JwtClaims, @Body() raw: unknown) {
    const body = CreateBookingBody.parse(raw);
    return this.bookings.createDraft({
      ...body, devoteeId: user.sub, citySlug: this.config.LAUNCH_CITY_SLUG,
    });
  }

  @Post(':id/submit')
  submit(@CurrentUser() user: JwtClaims, @Param('id') id: string) {
    return this.bookings.submit(id, user.sub);
  }

  @Roles('pandit')
  @Post(':id/accept')
  accept(@CurrentUser() user: JwtClaims, @Param('id') id: string) {
    return this.bookings.accept(id, user.sub);
  }

  @Roles('pandit')
  @Post(':id/start')
  start(@CurrentUser() user: JwtClaims, @Param('id') id: string, @Body() body: { otp: string }) {
    return this.bookings.start({ bookingId: id, panditId: user.sub, otp: body.otp });
  }

  /**
   * Completion is idempotent by contract. It sits on the offline-sync path and in
   * token+balance mode it triggers a charge, so a naive retry would double-charge.
   */
  @Roles('pandit')
  @Post(':id/complete')
  complete(@CurrentUser() user: JwtClaims, @Param('id') id: string, @Body() raw: unknown) {
    const body = CompleteBookingBody.parse(raw);
    return this.idempotency.run({
      key: body.idempotencyKey,
      userId: user.sub,
      endpoint: `POST /v1/bookings/${id}/complete`,
      body,
      handler: () => this.bookings.complete({
        bookingId: id,
        panditId: user.sub,
        otp: body.otp,
        capturedAt: body.capturedAt,
        ...(body.cashCollectedPaise !== undefined
          ? { cashCollectedPaise: body.cashCollectedPaise } : {}),
        ...(body.location ? { location: body.location } : {}),
      }),
    });
  }

  @Post(':id/cancel')
  cancel(@CurrentUser() user: JwtClaims, @Param('id') id: string, @Body() raw: unknown) {
    const body = CancelBookingBody.parse(raw);
    const role = user.role === 'admin' || user.role === 'ops' ? 'admin'
      : user.role === 'pandit' ? 'pandit' : 'devotee';
    return this.idempotency.run({
      key: body.idempotencyKey,
      userId: user.sub,
      endpoint: `POST /v1/bookings/${id}/cancel`,
      body,
      handler: () => this.bookings.cancel({
        bookingId: id, actorId: user.sub, actorRole: role, reason: body.reason,
      }),
    });
  }
}
