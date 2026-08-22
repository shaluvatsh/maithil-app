import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { Logger } from '@nestjs/common';
import type { KvStore } from './kv';

/**
 * Security headers. Written out rather than pulling in helmet: the API serves JSON to
 * two apps and one browser origin, so the useful set is small and worth being able to
 * read at a glance.
 */
export function securityHeaders() {
  return (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('cross-origin-opener-policy', 'same-origin');
    res.setHeader('cross-origin-resource-policy', 'same-site');
    res.setHeader('permissions-policy', 'geolocation=(self), camera=(), microphone=()');
    res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
    // Nothing here renders HTML, so the strictest CSP is also the correct one.
    res.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    res.removeHeader('x-powered-by');
    next();
  };
}

/**
 * Request ID + structured access log.
 *
 * Every log line carries the request id, and the id goes back on the response, so a
 * devotee reporting "my booking failed at 3pm" can be traced through the whole stack
 * from one header.
 */
export function requestContext() {
  const log = new Logger('http');
  return (req: Request & { id?: string }, res: Response, next: NextFunction) => {
    const id = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();
    req.id = id;
    res.setHeader('x-request-id', id);

    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const line = JSON.stringify({
        id, method: req.method, path: req.path, status: res.statusCode,
        ms: Math.round(ms * 10) / 10,
      });
      if (res.statusCode >= 500) log.error(line);
      else if (res.statusCode >= 400) log.warn(line);
      else log.log(line);
    });
    next();
  };
}

/**
 * Fixed-window rate limiter over the KV store, so it is shared across instances once
 * Redis is configured and degrades to per-process in development.
 *
 * Deliberately strict on the endpoints that cost money or send messages, and lenient
 * on reads. Keyed by IP for anonymous routes; authenticated routes are additionally
 * protected by the per-booking guards in the domain layer.
 */
export interface RateRule { path: RegExp; method?: string; limit: number; windowSec: number }

export const DEFAULT_RATE_RULES: RateRule[] = [
  { path: /^\/v1\/auth\/otp\/request/, limit: 5, windowSec: 3600 },
  { path: /^\/v1\/auth\/otp\/verify/, limit: 20, windowSec: 3600 },
  // Credential stuffing is the threat here, so login is tighter than OTP verify.
  { path: /^\/v1\/auth\/login/, limit: 10, windowSec: 900 },
  { path: /^\/v1\/auth\/register/, limit: 5, windowSec: 3600 },
  /*
   * Booking CREATION only. This had no `method`, so it matched by path alone -
   * meaning `GET /v1/bookings` (reading your own list, fetched on every visit to
   * the booking page) counted against the SAME 30-per-hour budget as actually
   * creating one. A devotee who just revisits the page, or refreshes a few times
   * while deciding, exhausts the read traffic's share of a limit sized for
   * writes, then gets a 429 the moment they finally click "Review and book" -
   * indistinguishable, from the UI, from the confirm step silently not working.
   */
  { path: /^\/v1\/bookings$/, method: 'POST', limit: 30, windowSec: 3600 },
  { path: /^\/v1\/bookings\/.+\/(complete|cancel)$/, limit: 60, windowSec: 3600 },
  { path: /^\/v1\/search/, limit: 300, windowSec: 300 },
  { path: /^\/v1\//, limit: 600, windowSec: 300 },
];

/**
 * The client's real IP, trusted only from a source the client cannot write to.
 *
 * `X-Forwarded-For` is attacker-controlled: without `app.set('trust proxy', ...)`,
 * Express never touches it, but this middleware was reading `req.headers[...]`
 * directly - so `X-Forwarded-For: <random-value-per-request>` reset every counter
 * for free, on the exact endpoints (OTP send, login) whose whole security model is
 * "the rate limit is the real control, not the entropy" (see otp.service.ts).
 *
 * `Fly-Client-IP` is set by Fly's edge proxy and cannot arrive from outside it -
 * Fly overwrites any client-supplied copy of the header before it reaches this
 * process. That is specific to this deploy target (fly.toml), which is why it is
 * checked before falling back to the raw socket address rather than trusting XFF.
 */
function clientIp(req: Request): string {
  const flyIp = req.headers['fly-client-ip'];
  if (typeof flyIp === 'string' && flyIp) return flyIp;
  return req.socket.remoteAddress ?? 'unknown';
}

export function rateLimit(kv: KvStore, rules: RateRule[] = DEFAULT_RATE_RULES) {
  return async (req: Request, res: Response, next: NextFunction) => {
    // The payment webhook is authenticated by HMAC and must never be throttled:
    // dropping a capture event costs a confirmed booking.
    if (req.path.startsWith('/v1/webhooks/')) return next();

    /*
     * A CORS preflight is the browser asking permission, not a user action -
     * every authenticated cross-origin request from the web app sends one
     * automatically ahead of the real request (any call carrying an
     * `Authorization` header triggers one). Counting it silently halved every
     * limit in this table for every authenticated caller: two hits per actual
     * request, one of them the user never took.
     */
    if (req.method === 'OPTIONS') return next();

    const rule = rules.find((r) => r.path.test(req.path) && (!r.method || r.method === req.method));
    if (!rule) return next();

    const key = `rl:${rule.path.source}:${clientIp(req)}`;

    try {
      const hits = await kv.incr(key, rule.windowSec);
      res.setHeader('x-ratelimit-limit', String(rule.limit));
      res.setHeader('x-ratelimit-remaining', String(Math.max(rule.limit - hits, 0)));
      if (hits > rule.limit) {
        res.setHeader('retry-after', String(rule.windowSec));
        return res.status(429).json({
          error: { code: 'RATE_LIMITED', message: 'too many requests; slow down' },
        });
      }
    } catch {
      // A rate-limiter outage must not take the API down with it.
    }
    return next();
  };
}
