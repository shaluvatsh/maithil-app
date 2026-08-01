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

export const CurrentUser = createParamDecorator((_d: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  if (!req.user) throw new DomainError(ErrorCode.FORBIDDEN, 'not authenticated');
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
      req.user = this.auth.verifyAccess(header.slice(7));
    } else if (!isPublic) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'authentication required');
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
