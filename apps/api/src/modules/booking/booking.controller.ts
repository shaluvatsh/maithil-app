import { Controller, Post, Get, Body, Param, Headers } from '@nestjs/common';
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
  constructor(
    private readonly bookings: BookingService,
    private readonly pricing: PricingService,
    private readonly catalog: CatalogService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Post()
  async create(@CurrentUser() user: JwtClaims, @Body() raw: unknown) {
    const body = CreateBookingBody.parse(raw);
    return this.bookings.createDraft({ ...body, devoteeId: user.sub, citySlug: 'kolkata' });
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
