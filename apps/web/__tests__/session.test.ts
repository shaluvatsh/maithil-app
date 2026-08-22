import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { api, auth } from '@/lib/api';

/**
 * Session survival.
 *
 * The access token lives 15 minutes and the refresh token 30 days, but the client
 * stored only the first and never called /v1/auth/refresh. Fifteen minutes after
 * signing in, every authenticated request failed with "invalid or expired token"
 * while the header still showed the user's name — nothing noticed the session was
 * dead. These tests are the reason that cannot recur silently.
 */
const unauthorized = () => new Response(
  JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'invalid or expired token' } }),
  { status: 401, headers: { 'content-type': 'application/json' } },
);
const ok = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200, headers: { 'content-type': 'application/json' },
});

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  // jsdom forbids assigning window.location; this keeps the redirect observable.
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { pathname: '/book', href: '' },
  });
});
afterEach(() => { vi.useRealTimers(); });

describe('an expired access token', () => {
  it('is refreshed and the request replayed, invisibly to the caller', async () => {
    auth.set('stale-access', 'devotee', 'Om', 'good-refresh');

    const calls: string[] = [];
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      calls.push(u);
      if (u.includes('/v1/auth/refresh')) {
        return ok({ tokens: { accessToken: 'fresh-access', refreshToken: 'next-refresh' } });
      }
      // Fail while the stale token is presented, succeed once rotated.
      return auth.token === 'fresh-access' ? ok({ id: 'a1' }) : unauthorized();
    }) as unknown as typeof fetch;

    await expect(api('/v1/me/addresses', { method: 'POST', body: '{}' }))
      .resolves.toEqual({ id: 'a1' });

    expect(calls.filter((c) => c.includes('/v1/auth/refresh'))).toHaveLength(1);
    expect(auth.token).toBe('fresh-access');
    expect(auth.refreshToken).toBe('next-refresh');
  });

  it('refreshes once for three concurrent requests, not three times', async () => {
    auth.set('stale-access', 'devotee', 'Om', 'good-refresh');

    let refreshes = 0;
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes('/v1/auth/refresh')) {
        refreshes++;
        return ok({ tokens: { accessToken: 'fresh-access', refreshToken: 'next-refresh' } });
      }
      return auth.token === 'fresh-access' ? ok({ ok: true }) : unauthorized();
    }) as unknown as typeof fetch;

    await Promise.all([
      api('/v1/bookings'), api('/v1/me/addresses'), api('/v1/auth/me'),
    ]);

    // Three parallel refreshes would rotate the token out from under each other.
    expect(refreshes).toBe(1);
  });

  it('signs the user out and sends them to login when the refresh is dead too', async () => {
    auth.set('stale-access', 'devotee', 'Om', 'dead-refresh');

    global.fetch = vi.fn(async () => unauthorized()) as unknown as typeof fetch;

    await expect(api('/v1/me/addresses')).rejects.toThrow(/invalid or expired token/);

    expect(auth.token).toBeNull();
    expect(window.location.href).toContain('/login?next=%2Fbook');
  });

  it('does not try to refresh a session that never existed', async () => {
    const calls: string[] = [];
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      calls.push(String(url));
      return unauthorized();
    }) as unknown as typeof fetch;

    await expect(api('/v1/bookings')).rejects.toThrow();
    expect(calls.some((c) => c.includes('/v1/auth/refresh'))).toBe(false);
  });

  it('leaves public reads alone', async () => {
    global.fetch = vi.fn(async () => ok([{ slug: 'satyanarayan-puja' }])) as unknown as typeof fetch;

    await expect(api('/v1/rituals', { auth: false })).resolves.toHaveLength(1);
    const [, init] = (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    expect((init as RequestInit).headers).not.toHaveProperty('authorization');
  });
});

describe('signing in', () => {
  it('keeps the refresh token, not just the access token', () => {
    auth.set('a', 'devotee', 'Om', 'r');
    expect(auth.token).toBe('a');
    expect(auth.refreshToken).toBe('r');
  });

  it('clears both on sign out', () => {
    auth.set('a', 'devotee', 'Om', 'r');
    auth.clear();
    expect(auth.token).toBeNull();
    expect(auth.refreshToken).toBeNull();
  });
});
