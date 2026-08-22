import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryKv } from '../kv';
import { rateLimit, DEFAULT_RATE_RULES, type RateRule } from '../security';

/**
 * `rateLimit` matched purely on `req.path` with no regard for HTTP method, so a
 * rule sized for booking CREATION (30/hour) was also charged against every
 * `GET /v1/bookings` (the devotee's own list, fetched on every page visit) and
 * every CORS preflight `OPTIONS` request the browser sends automatically ahead
 * of any authenticated call. In practice: a devotee who simply revisited the
 * booking page enough times could exhaust the budget on reads alone, then hit a
 * 429 the moment they actually tried to book - indistinguishable, from the UI,
 * from the confirm step silently not working. This is exactly what surfaced
 * live: a "review and book" that never reached the server.
 */

const fakeReq = (path: string, method: string, ip = '127.0.0.1') => ({
  path, method,
  headers: {} as Record<string, string>,
  socket: { remoteAddress: ip },
});

const fakeRes = () => {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let body: unknown;
  return {
    setHeader: (k: string, v: string) => { headers[k] = v; },
    status(code: number) { statusCode = code; return this; },
    json(b: unknown) { body = b; return this; },
    get statusCode() { return statusCode; },
    get body() { return body; },
    headers,
  };
};

async function hit(
  mw: ReturnType<typeof rateLimit>, path: string, method: string, ip = '127.0.0.1',
) {
  const req = fakeReq(path, method, ip);
  const res = fakeRes();
  let calledNext = false;
  await mw(req as never, res as never, () => { calledNext = true; });
  return { calledNext, status: res.statusCode };
}

describe('rate limiting', () => {
  let kv: MemoryKv;
  beforeEach(() => { kv = new MemoryKv(); });

  it('does not let GET /v1/bookings (the list) share POST /v1/bookings (creation)\'s budget', async () => {
    const tightRule: RateRule = { path: /^\/v1\/bookings$/, method: 'POST', limit: 2, windowSec: 3600 };
    const mw = rateLimit(kv, [tightRule]);

    // Ten reads - none of them should touch the creation rule's counter at all,
    // because no rule in this table matches GET, so the request just falls
    // through untouched (see the next test for GET actually being covered by a
    // broader rule).
    for (let i = 0; i < 10; i++) {
      const r = await hit(mw, '/v1/bookings', 'GET');
      expect(r.calledNext).toBe(true);
      expect(r.status).toBe(200);
    }

    // The write budget is still fully intact.
    expect((await hit(mw, '/v1/bookings', 'POST')).calledNext).toBe(true);
    expect((await hit(mw, '/v1/bookings', 'POST')).calledNext).toBe(true);
    const third = await hit(mw, '/v1/bookings', 'POST');
    expect(third.calledNext).toBe(false);
    expect(third.status).toBe(429);
  });

  it('never rate-limits an OPTIONS preflight, on any path', async () => {
    const tightRule: RateRule = { path: /^\/v1\/bookings$/, method: 'POST', limit: 1, windowSec: 3600 };
    const mw = rateLimit(kv, [tightRule]);

    // Far more than the limit, all OPTIONS - every one must pass through, and
    // must not consume the POST budget either.
    for (let i = 0; i < 20; i++) {
      const r = await hit(mw, '/v1/bookings', 'OPTIONS');
      expect(r.calledNext).toBe(true);
    }
    // The real write budget (limit: 1) is untouched by the 20 preflights above.
    expect((await hit(mw, '/v1/bookings', 'POST')).calledNext).toBe(true);
    expect((await hit(mw, '/v1/bookings', 'POST')).calledNext).toBe(false);
  });

  it('still exempts the webhook path entirely, regardless of method', async () => {
    const mw = rateLimit(kv, [{ path: /^\/v1\//, limit: 1, windowSec: 3600 }]);
    for (let i = 0; i < 5; i++) {
      const r = await hit(mw, '/v1/webhooks/razorpay', 'POST');
      expect(r.calledNext).toBe(true);
    }
  });

  it('a rule with no method still matches every method on that path, unchanged', async () => {
    const mw = rateLimit(kv, [{ path: /^\/v1\/search/, limit: 1, windowSec: 3600 }]);
    expect((await hit(mw, '/v1/search/pandits', 'GET')).calledNext).toBe(true);
    expect((await hit(mw, '/v1/search/pandits', 'GET')).calledNext).toBe(false);
  });

  it('DEFAULT_RATE_RULES scopes booking creation to POST', () => {
    const rule = DEFAULT_RATE_RULES.find((r) => r.path.source === /^\/v1\/bookings$/.source);
    expect(rule?.method).toBe('POST');
  });
});
