import { Controller, Post, Get, Body, UsePipes } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/zod.pipe';
import { AuthService } from './auth.service';
import { Public, CurrentUser } from './guards';
import type { JwtClaims } from './auth.service';
import { RequestOtpBody, VerifyOtpBody } from '@themaithil/contracts';
import { z } from 'zod';

const RefreshBody = z.object({ refreshToken: z.string().min(10) });

@Controller('v1/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

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

  @Get('me')
  me(@CurrentUser() user: JwtClaims) {
    return this.auth.me(user.sub);
  }
}
