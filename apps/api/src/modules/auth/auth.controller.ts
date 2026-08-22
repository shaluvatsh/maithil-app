import { Controller, Post, Get, Body, UsePipes, Inject } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/zod.pipe';
import { AuthService } from './auth.service';
import { Public, CurrentUser } from './guards';
import type { JwtClaims } from './auth.service';
import { RequestOtpBody, VerifyOtpBody } from '@themaithil/contracts';
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
});
const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
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

  @Get('me')
  me(@CurrentUser() user: JwtClaims) {
    return this.auth.me(user.sub);
  }
}
