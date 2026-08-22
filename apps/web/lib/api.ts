'use client';

const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

export interface ApiError { code: string; message: string; [k: string]: unknown }

/** Where the JWT lives. Fine for a local dev console; a real client uses secure storage. */
const TOKEN_KEY = 'themaithil.token';
const REFRESH_KEY = 'themaithil.refresh';
const ROLE_KEY = 'themaithil.role';
const NAME_KEY = 'themaithil.name';

const ls = (k: string) => (typeof window === 'undefined' ? null : localStorage.getItem(k));

export const auth = {
  get token() { return ls(TOKEN_KEY); },
  get refreshToken() { return ls(REFRESH_KEY); },
  get role() { return ls(ROLE_KEY); },
  get name() { return ls(NAME_KEY); },

  /**
   * The refresh token used to be discarded here.
   *
   * The API issues an access token good for 15 minutes and a refresh token good for
   * 30 days, and this only ever stored the first. So a quarter of an hour after
   * signing in, every authenticated request failed with "invalid or expired token"
   * — while the header still showed the user's name, because nothing noticed.
   */
  set(token: string, role: string, name: string, refreshToken?: string) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(ROLE_KEY, role);
    localStorage.setItem(NAME_KEY, name);
    if (refreshToken) localStorage.setItem(REFRESH_KEY, refreshToken);
  },

  clear() {
    [TOKEN_KEY, REFRESH_KEY, ROLE_KEY, NAME_KEY].forEach((k) => localStorage.removeItem(k));
  },
};

/**
 * One refresh at a time.
 *
 * A page can have three requests in flight at once. Without this they would each
 * see a 401, each POST to /v1/auth/refresh, and the last two would present a token
 * the first had already rotated away.
 */
let refreshing: Promise<boolean> | null = null;

async function doRefresh(refreshToken: string): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return false;

    const body = await res.json() as {
      tokens?: { accessToken: string; refreshToken: string };
      accessToken?: string; refreshToken?: string;
    };
    const access = body.tokens?.accessToken ?? body.accessToken;
    const next = body.tokens?.refreshToken ?? body.refreshToken;
    if (!access) return false;

    localStorage.setItem(TOKEN_KEY, access);
    if (next) localStorage.setItem(REFRESH_KEY, next);
    return true;
  } catch {
    return false;
  }
}

async function refreshSession(): Promise<boolean> {
  const refreshToken = auth.refreshToken;
  if (!refreshToken) return false;

  // Assign and return the SAME promise: callers take their reference before the
  // `.finally` clears the slot, so late arrivals start a fresh attempt while
  // in-flight ones all resolve from this one. Clearing on a timer instead — as
  // this first did — leaves the slot pointing at a settled promise, and a caller
  // that read it after the reset awaited `null` and signed the user out.
  refreshing ??= doRefresh(refreshToken).finally(() => { refreshing = null; });
  return refreshing;
}

async function send(path: string, init: RequestInit & { auth?: boolean }) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.auth !== false && auth.token) headers.authorization = `Bearer ${auth.token}`;

  return fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
  });
}

export async function api<T = unknown>(
  path: string,
  init: RequestInit & { auth?: boolean } = {},
): Promise<T> {
  let res = await send(path, init);

  // An expired access token is the normal case after 15 minutes, not an error the
  // user should ever see. Refresh once and replay.
  if (res.status === 401 && init.auth !== false && auth.refreshToken) {
    if (await refreshSession()) {
      res = await send(path, init);
    } else {
      auth.clear();
      if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
        window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
      }
    }
  }

  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = (body?.error ?? { code: 'UNKNOWN', message: res.statusText }) as ApiError;
    throw Object.assign(new Error(err.message), err);
  }
  return body as T;
}

/** Every mutation that needs one gets a fresh key. */
export const idemKey = () =>
  `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
