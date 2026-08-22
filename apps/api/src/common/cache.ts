import { SetMetadata, applyDecorators, Injectable, type NestInterceptor,
  type ExecutionContext, type CallHandler } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

/**
 * `Cache-Control` on the read endpoints.
 *
 * Every public GET was answered with no caching headers at all, so a browser
 * revalidated the catalogue, the categories, the panchang and the stats on every
 * navigation, and any CDN in front of the API was reduced to a proxy. The catalogue
 * changes when someone edits a ritual — a handful of times a year — and the panchang
 * for a given day never changes at all once computed.
 *
 * `stale-while-revalidate` is the important half: the client serves the cached copy
 * instantly and refreshes behind it, so a price correction still reaches people
 * within the window without anyone waiting on the round trip.
 *
 * Deliberately opt-in per route rather than a blanket default. Caching is a
 * correctness decision — get it wrong on `/v1/bookings` and a devotee sees someone
 * else's booking from a shared cache — so each route states its own policy and
 * anything unmarked stays uncached.
 */
export const CACHE_TTL = 'cache-ttl';

export interface CachePolicy {
  /** Seconds a client may serve this without asking again. */
  maxAge: number;
  /** Seconds it may keep serving the stale copy while it refetches. */
  staleWhileRevalidate: number;
  /**
   * `public` allows shared caches. Only ever correct for responses that do not
   * vary by user — which is why every route using it here is also `@Public()`.
   */
  scope: 'public' | 'private';
}

export const Cacheable = (
  maxAge: number,
  staleWhileRevalidate = maxAge * 10,
  scope: CachePolicy['scope'] = 'public',
) => applyDecorators(SetMetadata(CACHE_TTL, { maxAge, staleWhileRevalidate, scope }));

/** Common policies, named so the intent is legible at the call site. */
export const CACHE = {
  /** Catalogue, categories, offers: edited by hand, rarely. */
  catalogue: 300,
  /** Panchang: a computed day never changes once written. */
  almanac: 3600,
  /** Counts: cheap to be a few minutes stale, expensive to recompute per view. */
  stats: 600,
} as const;

@Injectable()
export class CacheHeaderInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const policy = this.reflector.getAllAndOverride<CachePolicy | undefined>(
      CACHE_TTL, [ctx.getHandler(), ctx.getClass()],
    );
    if (!policy) return next.handle();

    return next.handle().pipe(tap(() => {
      const res = ctx.switchToHttp().getResponse<{
        setHeader?: (k: string, v: string) => void;
        statusCode?: number;
      }>();
      // Never cache an error. A cached 500 outlives the incident that caused it.
      if (!res.setHeader || (res.statusCode ?? 200) >= 400) return;
      res.setHeader(
        'Cache-Control',
        `${policy.scope}, max-age=${policy.maxAge}`
        + `, stale-while-revalidate=${policy.staleWhileRevalidate}`,
      );
    }));
  }
}
