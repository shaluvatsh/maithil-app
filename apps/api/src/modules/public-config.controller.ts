import { Controller, Get, Inject } from '@nestjs/common';
import { CONFIG } from '../common/tokens';
import type { Config } from '../common/config';
import { Public } from './auth/guards';

/**
 * The handful of settings a browser legitimately needs to render correctly.
 *
 * WHY AN ENDPOINT RATHER THAN A `NEXT_PUBLIC_` BUILD VARIABLE. The web app computes
 * a price preview before a booking exists, using the same `computePrice` the API
 * uses — so it has to know whether a token will be charged. Baking that into the
 * bundle would make two sources of truth for one fact, and the stale one would be
 * the bundle: flip the server to cash-only and every browser still holding the old
 * JavaScript would keep showing "Pay online now ₹225" for money nobody will take.
 *
 * Fetched at runtime, the server stays the only thing that decides, which is the
 * same reason the booking flow reads its confirmation from the submit RESPONSE
 * rather than from a flag it was told earlier.
 *
 * NOTHING SECRET GOES HERE, by construction: this is unauthenticated and cacheable,
 * so it carries only facts a devotee could infer from using the product for a
 * minute. Credentials, provider names and internal limits stay out.
 */
@Controller('v1')
export class PublicConfigController {
  constructor(@Inject(CONFIG) private readonly config: Config) {}

  @Public()
  @Get('config')
  config_() {
    return {
      /**
       * False when this deployment takes no money online: bookings confirm on
       * submission and the devotee pays the purohit in full on the day.
       */
      paymentsEnabled: this.config.PAYMENTS_ENABLED,
      /**
       * Whether a phone OTP can actually reach anybody on this deployment.
       *
       * The login screen opens on the OTP tab. Without this it would greet every
       * visitor to a deployment with no messaging provider with the one door that
       * cannot open, while email and password — which need nothing but the
       * database — sit behind a tab nobody clicks.
       */
      otpLoginAvailable: this.config.otpLoginAvailable,
    };
  }
}
