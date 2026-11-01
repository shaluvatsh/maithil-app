import {
  Injectable, CanActivate, ExecutionContext, SetMetadata, createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { DomainError, ErrorCode, type UserRole } from '@themaithil/contracts';
import type { AuthService } from './auth.service';
import type { JwtClaims } from './auth.service';

export interface AuthedRequest extends Request { user?: JwtClaims }

export const ROLES_KEY = 'roles';
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
export const PUBLIC_KEY = 'public';
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/**
 * The signed-in user, or a refusal. For routes that REQUIRE one.
 *
 * Throws rather than returning undefined, so a handler can take `JwtClaims` and not
 * `JwtClaims | undefined` — which is right for the routes it was written for, and a
 * trap for the ones it was not. See `OptionalUser`.
 */
export const CurrentUser = createParamDecorator((_d: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  if (!req.user) throw new DomainError(ErrorCode.UNAUTHENTICATED, 'not authenticated');
  return req.user;
});

/**
 * The signed-in user IF THERE IS ONE. For `@Public()` routes that personalise.
 *
 * THE BUG THIS EXISTS TO PREVENT, because it shipped. The community feed, a thread,
 * event discovery and an event page are all public — anyone may read them — but each
 * renders something extra for a reader who is signed in: their own pranams, their own
 * reserved place. They were written as
 *
 *     feed(@CurrentUser() user: JwtClaims | undefined, …)
 *
 * which typechecks, reads correctly, and is wrong: `CurrentUser` THROWS when nobody
 * is signed in. So every signed-out visitor to those four routes — which is most of
 * the people the surfaces exist to attract — got `not authenticated` instead of the
 * page. The type annotation said `| undefined` and nothing anywhere made that true.
 *
 * A separate decorator rather than making `CurrentUser` lenient: the routes that
 * genuinely require a user are the majority, and silently handing them `undefined`
 * would turn a clear 401 into a null-dereference somewhere further in.
 */
export const OptionalUser = createParamDecorator((_d: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  return req.user;
});

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      ctx.getHandler(), ctx.getClass(),
    ]);
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();

    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      /*
       * A token that will not verify is an authentication problem even on a PUBLIC
       * route, and it has to be reported as one.
       *
       * The tempting alternative — ignore it and serve the anonymous view — is worse:
       * a signed-in devotee reading the community feed with a fifteen-minute-old token
       * would silently lose every personalised field on the page (their own pranams,
       * their own place at an event) with nothing telling the client to refresh. A 401
       * makes the client refresh and replay, and it gets the personalised view it
       * asked for. `lib/api.ts` retries anonymously when the refresh itself fails, so
       * a genuinely lapsed session still reads a public page.
       */
      req.user = this.auth.verifyAccess(header.slice(7));
    } else if (!isPublic) {
      throw new DomainError(ErrorCode.UNAUTHENTICATED, 'authentication required');
    }

    const required = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      ctx.getHandler(), ctx.getClass(),
    ]);
    if (required?.length) {
      if (!req.user || !required.includes(req.user.role)) {
        throw new DomainError(ErrorCode.FORBIDDEN, 'you do not have access to this resource');
      }
    }
    return true;
  }
}
