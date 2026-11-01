import { Controller, Post, Get, Body, UsePipes, Inject } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/zod.pipe';
import { AuthService } from './auth.service';
import { Public, CurrentUser } from './guards';
import type { JwtClaims } from './auth.service';
import {
  RequestOtpBody, VerifyOtpBody, RequestPasswordResetBody, ConfirmPasswordResetBody,
} from '@themaithil/contracts';
import { z } from 'zod';

const RefreshBody = z.object({ refreshToken: z.string().min(10) });

const RegisterBody = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email(),
  phone: z.string().min(10).max(15),
  password: z.string().min(8).max(200),
  /**
   * Registering as a purohit was impossible: this endpoint hardcoded
   * `role: 'devotee'`, so the only purohits in existence came from `db:seed:dev`.
   *
   * Only these two are selectable. `admin` and `ops` are never self-assignable —
   * an open enum here would be a privilege-escalation endpoint.
   */
  role: z.enum(['devotee', 'pandit']).default('devotee'),
  /** Where they are. Defaults to the launch city; see `VerifyOtpBody.citySlug`. */
  citySlug: z.string().min(2).max(40).optional(),
});
const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
});

/**
 * `currentPassword` is optional because an OTP-only account has none to give. The
 * service requires it whenever one is actually set, so it cannot be omitted to skip
 * the check.
 */
const SetPasswordBody = z.object({
  password: z.string().min(8).max(200),
  currentPassword: z.string().min(1).max(200).optional(),
});

@Controller('v1/auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Public()
  @Post('otp/request')
  @UsePipes(new ZodValidationPipe(RequestOtpBody))
  request(@Body() body: RequestOtpBody) {
    return this.auth.requestOtp(body.phone);
  }

  @Public()
  @Post('otp/verify')
  @UsePipes(new ZodValidationPipe(VerifyOtpBody))
  verify(@Body() body: VerifyOtpBody) {
    return this.auth.verifyOtp(body);
  }

  @Public()
  @Post('refresh')
  @UsePipes(new ZodValidationPipe(RefreshBody))
  refresh(@Body() body: z.infer<typeof RefreshBody>) {
    return this.auth.refresh(body.refreshToken);
  }

  @Public()
  @Post('register')
  @UsePipes(new ZodValidationPipe(RegisterBody))
  register(@Body() body: z.infer<typeof RegisterBody>) {
    return this.auth.register(body);
  }

  @Public()
  @Post('login')
  @UsePipes(new ZodValidationPipe(LoginBody))
  login(@Body() body: z.infer<typeof LoginBody>) {
    return this.auth.loginWithPassword(body);
  }

  /**
   * Starts a reset. Always `@Public()` and always answers the same way — see
   * `AuthService.requestPasswordReset`'s own note on why an endpoint that reveals
   * whether an email is registered is the actual vulnerability a "forgot
   * password" form tends to introduce.
   */
  @Public()
  @Post('password-reset/request')
  @UsePipes(new ZodValidationPipe(RequestPasswordResetBody))
  requestPasswordReset(@Body() body: RequestPasswordResetBody) {
    return this.auth.requestPasswordReset(body.email);
  }

  /**
   * Finishes a reset. Public like `otp/verify` — the token in the body IS the
   * credential; there is no session to be in yet.
   */
  @Public()
  @Post('password-reset/confirm')
  @UsePipes(new ZodValidationPipe(ConfirmPasswordResetBody))
  confirmPasswordReset(@Body() body: ConfirmPasswordResetBody) {
    return this.auth.confirmPasswordReset(body);
  }

  /**
   * Deliberately NOT `@Public()`. This is the proof-of-ownership path that
   * registration cannot provide: you reach it only with a token, which means you
   * already passed an OTP challenge on this number.
   */
  @Post('password')
  @UsePipes(new ZodValidationPipe(SetPasswordBody))
  setPassword(
    @CurrentUser() user: JwtClaims,
    @Body() body: z.infer<typeof SetPasswordBody>,
  ) {
    return this.auth.setPassword({ userId: user.sub, ...body });
  }

  /**
   * Sign out of every device.
   *
   * Bumps the account's token version, so every refresh token issued before now is
   * dead. Access tokens are not revoked — they are synchronous to verify by design
   * and expire in fifteen minutes — so the honest description is "every session
   * ends within fifteen minutes", not "immediately". The response says so rather
   * than letting someone who has just lost a phone believe otherwise.
   */
  @Post('sign-out-all')
  async signOutAll(@CurrentUser() user: JwtClaims) {
    await this.auth.revokeSessions(user.sub);
    return {
      ok: true as const,
      note: 'Signed out everywhere. Other devices lose access within 15 minutes.',
    };
  }

  @Get('me')
  me(@CurrentUser() user: JwtClaims) {
    return this.auth.me(user.sub);
  }
}
