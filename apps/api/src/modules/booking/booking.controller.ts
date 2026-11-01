import { Controller, Post, Body, Param, Inject } from '@nestjs/common';
import { BookingService } from './booking.service';
import { IdempotencyService } from '../../common/idempotency';
import { CurrentUser, Roles } from '../auth/guards';
import type { JwtClaims } from '../auth/auth.service';
import {
  CreateBookingBody, CompleteBookingBody, CancelBookingBody, RescheduleBookingBody,
  StartBookingBody, JoinLinkBody, DeclineBookingBody,
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
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
  ) {}

  /**
   * The city is NOT passed in.
   *
   * This used to hand `createDraft` the process-wide `LAUNCH_CITY_SLUG`, so every
   * booking in the product was created against Kolkata whichever city the devotee
   * had chosen — and no purohit outside it could ever be matched. The service
   * derives it from the booking's own address instead, which is both correct and
   * untamperable. See `BookingService.cityOf`.
   */
  @Post()
  async create(@CurrentUser() user: JwtClaims, @Body() raw: unknown) {
    const body = CreateBookingBody.parse(raw);
    return this.bookings.createDraft({ ...body, devoteeId: user.sub });
  }

  /**
   * Submitting is the last step the devotee takes when payments are off.
   *
   * With a gateway, this moves the booking to `pending_accept` and the devotee then
   * pays; the webhook confirms. Cash-only has no second step, so the service
   * confirms here and the response carries the start and completion codes exactly
   * as a captured payment would. `submitAndConfirmUnpaid` is a no-op beyond
   * `submit` whenever payments are enabled, so this endpoint's behaviour is
   * unchanged for every deployment that takes money.
   */
  @Post(':id/submit')
  submit(@CurrentUser() user: JwtClaims, @Param('id') id: string) {
    return this.bookings.submitAndConfirmUnpaid(id, user.sub);
  }

  @Roles('pandit')
  @Post(':id/accept')
  accept(@CurrentUser() user: JwtClaims, @Param('id') id: string) {
    return this.bookings.accept(id, user.sub);
  }

  /**
   * Declining an auto-assigned job.
   *
   * ADR 0011 removed the accept step and said a decline path must remain. Until now
   * it did not exist, so a purohit who genuinely could not attend had one route —
   * the full cancel flow — which charges a cancellation penalty for a job they never
   * individually agreed to. That made the honest early "I can't" cost more than
   * going quiet, which is the behaviour that ends with nobody at the devotee's door.
   *
   * Re-match is attempted first, so in the good case the devotee keeps their booking
   * and simply learns who is coming instead.
   */
  @Roles('pandit')
  @Post(':id/decline')
  decline(
    @CurrentUser() user: JwtClaims,
    @Param('id') id: string,
    @Body() raw: unknown,
  ) {
    const body = DeclineBookingBody.parse(raw);
    return this.bookings.decline({ bookingId: id, panditId: user.sub, reason: body.reason });
  }

  /**
   * Beginning the puja.
   *
   * The body was read raw — `@Body() body: { otp: string }` with no schema — which
   * made this the only mutating booking route not validated by Zod. It is now.
   */
  @Roles('pandit')
  @Post(':id/start')
  start(@CurrentUser() user: JwtClaims, @Param('id') id: string, @Body() raw: unknown) {
    const body = StartBookingBody.parse(raw);
    return this.bookings.start({ bookingId: id, panditId: user.sub, otp: body.otp });
  }

  /**
   * The purohit's meeting link for a remote booking.
   *
   * `online-aarti` and `virtual-consultation` have been purchasable since the
   * catalogue was seeded, with no way for either side to reach the other. Not
   * idempotency-wrapped: it is a last-writer-wins setting, not a state change, and
   * a purohit correcting a mistyped link must not be told the key was already used.
   */
  @Roles('pandit')
  @Post(':id/join-link')
  joinLink(@CurrentUser() user: JwtClaims, @Param('id') id: string, @Body() raw: unknown) {
    const body = JoinLinkBody.parse(raw);
    return this.bookings.setJoinUrl({
      bookingId: id, panditId: user.sub, joinUrl: body.joinUrl,
    });
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
        ...(body.recordingUrl ? { recordingUrl: body.recordingUrl } : {}),
      }),
    });
  }

  /**
   * "Free rescheduling up to 24 hours before" is on the membership plan today
   * with no endpoint behind it — this is that endpoint. Idempotent for the same
   * reason cancel and complete are: a client on a flaky connection retries, and
   * a naive retry would try to release-then-lock a slot the booking is already
   * sitting on, or double-write the audit trail.
   */
  @Post(':id/reschedule')
  reschedule(@CurrentUser() user: JwtClaims, @Param('id') id: string, @Body() raw: unknown) {
    const body = RescheduleBookingBody.parse(raw);
    return this.idempotency.run({
      key: body.idempotencyKey,
      userId: user.sub,
      endpoint: `POST /v1/bookings/${id}/reschedule`,
      body,
      handler: () => this.bookings.reschedule({
        bookingId: id, devoteeId: user.sub, date: body.date, slotIdx: body.slotIdx,
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
