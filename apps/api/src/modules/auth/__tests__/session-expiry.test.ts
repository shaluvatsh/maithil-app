import { describe, it, expect } from 'vitest';
import { Reflector } from '@nestjs/core';
import jwt from 'jsonwebtoken';
import { JwtAuthGuard, PUBLIC_KEY, ROLES_KEY } from '../guards';
import { ErrorCode } from '@themaithil/contracts';
import { STATUS_FOR_TEST } from '../../../common/http-errors';

/**
 * An expired session must be recoverable.
 *
 * THE BUG THIS PINS. `verifyAccess` threw FORBIDDEN for an expired token, which maps
 * to 403 — and `lib/api.ts` refreshes on 401. So fifteen minutes after signing in,
 * every authenticated request failed with "invalid or expired token", the thirty-day
 * refresh token was never used, and the only way out was to sign out and back in
 * again. The intent was right and written down; the status code did not match it.
 *
 * 401 means "prove who you are again". 403 means "we know who you are and this is not
 * yours". A client cannot do the first if it cannot tell them apart.
 */
const SECRET = 'test-secret-that-is-long-enough-32ch';

/** Just enough of AuthService for the guard. */
const authStub = {
  verifyAccess(token: string) {
    try {
      const claims = jwt.verify(token, SECRET) as { typ?: string; role?: string };
      if (claims.typ !== 'access') throw new Error('wrong type');
      return claims as never;
    } catch {
      throw Object.assign(new Error('invalid or expired token'), {
        code: ErrorCode.UNAUTHENTICATED, name: 'DomainError', meta: {},
      });
    }
  },
};

const ctx = (headers: Record<string, string>, meta: Record<string, unknown> = {}) => {
  const req = { headers } as { headers: Record<string, string>; user?: unknown };
  const reflector = {
    getAllAndOverride: (key: string) => meta[key],
  } as unknown as Reflector;
  const execution = {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => () => {},
    getClass: () => class {},
  } as never;
  return { req, guard: new JwtAuthGuard(authStub as never, reflector), execution };
};

/**
 * `iat`/`exp` set by hand rather than via `expiresIn`.
 *
 * `jsonwebtoken`'s `expiresIn` types reject a negative span, and an already-expired
 * token is exactly what these tests need — so the claim is written directly.
 */
const token = (payload: object, secondsFromNow: number) => {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { sub: 'u1', role: 'devotee', typ: 'access', ...payload, iat: now, exp: now + secondsFromNow },
    SECRET,
  );
};

describe('an expired token is 401, so the client can refresh', () => {
  it('maps UNAUTHENTICATED to 401 and FORBIDDEN to 403', () => {
    // The whole fix in one assertion: the two must not share a status.
    expect(STATUS_FOR_TEST[ErrorCode.UNAUTHENTICATED]).toBe(401);
    expect(STATUS_FOR_TEST[ErrorCode.FORBIDDEN]).toBe(403);
  });

  it('rejects an expired token as UNAUTHENTICATED, not FORBIDDEN', () => {
    const { guard, execution } = ctx({ authorization: `Bearer ${token({}, -1)}` });
    expect(() => guard.canActivate(execution)).toThrow();
    try { guard.canActivate(execution); } catch (e) {
      expect((e as { code: string }).code).toBe(ErrorCode.UNAUTHENTICATED);
    }
  });

  it('rejects a missing token as UNAUTHENTICATED on a protected route', () => {
    const { guard, execution } = ctx({});
    try { guard.canActivate(execution); expect.unreachable(); } catch (e) {
      expect((e as { code: string }).code).toBe(ErrorCode.UNAUTHENTICATED);
    }
  });

  it('still uses FORBIDDEN when the role is wrong, which is not recoverable', () => {
    const { guard, execution } = ctx(
      { authorization: `Bearer ${token({ role: 'devotee' }, 900)}` },
      { [ROLES_KEY]: ['admin', 'ops'] },
    );
    try { guard.canActivate(execution); expect.unreachable(); } catch (e) {
      // Refreshing would not help: they are who they say and still not allowed.
      expect((e as { code: string }).code).toBe(ErrorCode.FORBIDDEN);
    }
  });
});

describe('a public route and a token', () => {
  it('serves anonymously when no token is presented', () => {
    const { guard, execution, req } = ctx({}, { [PUBLIC_KEY]: true });
    expect(guard.canActivate(execution)).toBe(true);
    expect(req.user).toBeUndefined();
  });

  it('attaches the viewer when the token is good', () => {
    const { guard, execution, req } = ctx(
      { authorization: `Bearer ${token({}, 900)}` }, { [PUBLIC_KEY]: true },
    );
    expect(guard.canActivate(execution)).toBe(true);
    expect(req.user).toMatchObject({ sub: 'u1' });
  });

  /**
   * Deliberately NOT served anonymously.
   *
   * Swallowing a stale token here would silently strip every personalised field from
   * a public page — a devotee's own pranams, their own reserved place — with nothing
   * telling the client to refresh. A 401 makes it refresh and replay; the client
   * falls back to an anonymous read only if the refresh itself fails.
   */
  it('reports a stale token even on a public route, so the client refreshes', () => {
    const { guard, execution } = ctx(
      { authorization: `Bearer ${token({}, -1)}` }, { [PUBLIC_KEY]: true },
    );
    try { guard.canActivate(execution); expect.unreachable(); } catch (e) {
      expect((e as { code: string }).code).toBe(ErrorCode.UNAUTHENTICATED);
    }
  });
});
