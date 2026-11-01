import { Controller, Get, Post, Inject } from '@nestjs/common';
import { PayoutService } from './payouts.service';
import { CurrentUser, Roles } from '../auth/guards';
import type { JwtClaims } from '../auth/auth.service';

@Controller('v1/me')
export class PayoutController {
  constructor(@Inject(PayoutService) private readonly payouts: PayoutService) {}

  /** Earnings dashboard: gross, dues, carried TDS, and what is actually payable. */
  @Roles('pandit')
  @Get('earnings')
  earnings(@CurrentUser() user: JwtClaims) {
    return this.payouts.preview(user.sub);
  }

  @Roles('pandit')
  @Post('payouts/instant')
  instant(@CurrentUser() user: JwtClaims) {
    const today = new Date().toISOString().slice(0, 10);
    return this.payouts.run({
      panditId: user.sub, periodStart: today, periodEnd: today, instant: true,
    });
  }
}
