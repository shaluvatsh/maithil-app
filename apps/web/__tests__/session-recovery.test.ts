import { describe, it, expect, beforeEach, vi } from 'vitest';
import { api, auth } from '@/lib/api';

/**
 * The client half of the expired-session fix.
 *
 * Three behaviours, and the third is the new one:
 *
 *   a 401 on a normal call refreshes and replays;
 *   a failed refresh on a normal call signs the user out;
 *   a failed refresh on a PUBLIC BUT PERSONALISED call drops the token and reads
 *   anonymously, rather than throwing the reader off a page they may read.
 */
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

beforeEach(() => {
  localStorage.clear();
  // jsdom has no navigation; the sign-out path assigns location.href.
  Object.defineProperty(window, 'location', {
    value: { pathname: '/community', href: '' }, writable: true, configurable: true,
  });
});

describe('a 401 is recovered from, not surfaced', () => {
  it('refreshes once and replays the request', async () => {
    auth.set('stale', 'devotee', 'A Devotee', 'refresh-ok');
    const urls: string[] = [];
    let first = true;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes('/auth/refresh')) return json({ accessToken: 'fresh' });
      if (first) { first = false; return json({ error: { code: 'UNAUTHENTICATED' } }, 401); }
      return json({ ok: true });
    }) as unknown as typeof fetch;

    await expect(api('/v1/community/feed', { auth: 'optional' })).resolves.toEqual({ ok: true });
    expect(urls.filter((u) => u.includes('/auth/refresh'))).toHaveLength(1);
    // The replay carries the new token, which is the point of replaying.
    expect(auth.token).toBe('fresh');
  });

  it('signs the user out when a required session cannot be refreshed', async () => {
    auth.set('stale', 'devotee', 'A Devotee', 'refresh-bad');
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/refresh')) return json({}, 401);
      return json({ error: { code: 'UNAUTHENTICATED' } }, 401);
    }) as unknown as typeof fetch;

    await expect(api('/v1/community/questions', { method: 'POST' })).rejects.toThrow();
    expect(auth.token).toBeNull();
    expect(window.location.href).toContain('/login?next=');
  });

  /**
   * The new mode. A lapsed session on the community feed or an event page must not
   * bounce the reader to login: they lose their own pranam marks until they sign in
   * again, which is a far better outcome than losing the page.
   */
  it('falls back to an anonymous read on a public-but-personalised call', async () => {
    auth.set('stale', 'devotee', 'A Devotee', 'refresh-bad');
    const sent: Array<string | undefined> = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/auth/refresh')) return json({}, 401);
      const authz = (init?.headers as Record<string, string> | undefined)?.authorization;
      sent.push(authz);
      return authz
        ? json({ error: { code: 'UNAUTHENTICATED' } }, 401)
        : json({ items: [], nextCursor: null, scripts: [] });
    }) as unknown as typeof fetch;

    await expect(api('/v1/community/feed', { auth: 'optional' }))
      .resolves.toMatchObject({ items: [] });

    // Once with the stale token, once without.
    expect(sent).toEqual(['Bearer stale', undefined]);
    expect(auth.token).toBeNull();
    // And crucially, not redirected off a page they are entitled to read.
    expect(window.location.href).toBe('');
  });

  it('never sends a token when auth is false', async () => {
    auth.set('good', 'devotee', 'A Devotee', 'refresh-ok');
    let authz: string | undefined;
    global.fetch = vi.fn(async (_i: RequestInfo | URL, init?: RequestInit) => {
      authz = (init?.headers as Record<string, string> | undefined)?.authorization;
      return json({ ok: true });
    }) as unknown as typeof fetch;

    await api('/v1/rituals', { auth: false });
    expect(authz).toBeUndefined();
  });

  it('sends the token on a personalised read when the session is good', async () => {
    auth.set('good', 'devotee', 'A Devotee', 'refresh-ok');
    let authz: string | undefined;
    global.fetch = vi.fn(async (_i: RequestInfo | URL, init?: RequestInit) => {
      authz = (init?.headers as Record<string, string> | undefined)?.authorization;
      return json({ items: [] });
    }) as unknown as typeof fetch;

    await api('/v1/events', { auth: 'optional' });
    // The bug this replaces: `auth: false` stripped it, so an event always looked
    // unreserved and the Reserve button then failed with a conflict.
    expect(authz).toBe('Bearer good');
  });
});
