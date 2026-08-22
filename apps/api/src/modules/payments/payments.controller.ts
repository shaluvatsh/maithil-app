import { Controller, Post, Param, Req, Headers, HttpCode, Inject } from '@nestjs/common';
import type { Request } from 'express';
import { PaymentsService } from './payments.service';
import { CurrentUser, Public } from '../auth/guards';
import type { JwtClaims } from '../auth/auth.service';
import { DomainError, ErrorCode } from '@themaithil/contracts';

@Controller('v1')
export class PaymentsController {
  constructor(@Inject(PaymentsService) private readonly payments: PaymentsService) {}

  /** Returns the Razorpay order the client opens Checkout with. */
  @Post('bookings/:id/payment-intent')
  create(@CurrentUser() user: JwtClaims, @Param('id') id: string) {
    return this.payments.createTokenIntent({ bookingId: id, userId: user.sub });
  }

  /**
   * Razorpay webhook. Public because Razorpay cannot hold a JWT - the signature IS
   * the authentication, verified over the raw body.
   *
   * Always answers 200 once the event is claimed. A non-2xx on an event we have
   * already handled, or do not handle at all, makes Razorpay retry it indefinitely.
   */
  @Public()
  @Post('webhooks/razorpay')
  @HttpCode(200)
  async webhook(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('x-razorpay-signature') signature: string,
  ) {
    const raw = req.rawBody?.toString('utf8');
    if (!raw) {
      throw new DomainError(
        ErrorCode.FORBIDDEN,
        'raw body unavailable - the rawBody option must be enabled on the Nest app',
      );
    }
    return this.payments.handleWebhook({ rawBody: raw, signature });
  }
}
