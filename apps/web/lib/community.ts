'use client';
import { api } from '@/lib/api';
import { fontHref, SCRIPT_FOR_LOCALE, type Script, type Translator } from '@themaithil/region';
import type {
  CommunityPostCard, ContentLocale, CommunityScope, PanjikaSchool,
} from '@themaithil/contracts';

/**
 * The community client.
 *
 * Types come from `packages/contracts` rather than being restated here, so the
 * composer's character limit and the API's rejection are one number. The only thing
 * this file adds is the browser-side half of the per-item font decision.
 */

export type Post = CommunityPostCard;
export interface Answer extends Post { replies: Post[] }

export interface Feed {
  items: Post[];
  nextCursor: string | null;
  /** Exactly the scripts present in `items` — see `useScriptFonts`. */
  scripts: Script[];
}

export interface Thread {
  question: Post;
  answers: Answer[];
  scripts: Script[];
}

const qs = (params: Record<string, string | number | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
};

export const community = {
  feed: (params: {
    spaceSlug?: string; scope?: CommunityScope; citySlug?: string;
    locales?: string; cursor?: string; limit?: number;
  }) => api<Feed>(`/v1/community/feed${qs(params)}`, { auth: 'optional' }),

  thread: (id: string) => api<Thread>(`/v1/community/threads/${id}`, { auth: 'optional' }),

  setProfile: (displayName: string) =>
    api<{ displayName: string }>('/v1/community/profile', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName }),
    }),

  ask: (body: {
    spaceSlug: string; title: string; body: string; locale: ContentLocale;
    panjikaSchool?: PanjikaSchool;
    scope: { scope: 'city'; citySlug: string } | { scope: 'national' };
  }) => api<{ id: string; state: 'published' | 'held'; redacted: boolean }>(
    '/v1/community/questions',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
  ),

  respond: (parentId: string, body: { body: string; locale: ContentLocale; panjikaSchool?: PanjikaSchool }) =>
    api<{ id: string; kind: 'answer' | 'reply'; state: 'published' | 'held'; redacted: boolean }>(
      `/v1/community/posts/${parentId}/responses`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    ),

  pranam: (id: string, on: boolean) =>
    api<{ ok: boolean }>(`/v1/community/posts/${id}/pranam`, { method: on ? 'POST' : 'DELETE' }),

  endorse: (id: string) =>
    api<{ endorsed: boolean }>(`/v1/community/posts/${id}/endorse`, { method: 'POST' }),

  accept: (questionId: string, answerId: string) =>
    api<{ accepted: string }>(`/v1/community/questions/${questionId}/accept/${answerId}`, {
      method: 'POST',
    }),

  report: (id: string, reason: string) =>
    api<{ reported: boolean }>(`/v1/community/posts/${id}/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason }),
    }),
};

/**
 * Load exactly the font subsets a response needs, and no more.
 *
 * `packages/region/src/types.ts` promises that a Chennai user never fetches a
 * Bengali face, and on every marketplace page `region.script` keeps that promise
 * because the whole page belongs to one city. A community feed is scoped nationally
 * — one response can carry Bengali, Devanagari and Tamil — so the region no longer
 * describes what is on the screen.
 *
 * Loading all nine subsets to be safe would add hundreds of kilobytes to exactly the
 * low-end Android devices this product depends on. So the promise is kept PER ITEM:
 * the API returns the scripts actually present, and this appends one stylesheet per
 * script, once. Already-loaded scripts are skipped, so paging a feed does not reload
 * anything, and the links are left in place rather than removed on unmount — a font
 * that has been fetched is in the browser cache either way, and removing it would
 * reflow text the user is still reading.
 */
export function ensureScriptFonts(scripts: readonly Script[]): void {
  if (typeof document === 'undefined') return;
  for (const script of scripts) {
    const id = `font-${script}`;
    if (document.getElementById(id)) continue;
    const link = document.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    link.href = fontHref(script);
    document.head.appendChild(link);
  }
}

/** The CSS custom property a post's own script should render with. */
export const scriptOf = (locale: string): Script =>
  SCRIPT_FOR_LOCALE[locale as keyof typeof SCRIPT_FOR_LOCALE] ?? 'latin';

/**
 * Error copy chosen by CODE, never by the server's message text.
 *
 * `COMMUNITY_TRUST_REQUIRED` is the one that matters. It means "not yet" — the
 * account is simply too new to start a thread, and replying is already open — and
 * rendering it as a generic failure is exactly how a first-time devotee concludes
 * they are unwelcome and does not come back. That is why the API returns 409 with
 * its own code rather than a bare 403.
 */
export function communityMessage(err: unknown, t: Translator): string {
  const code = (err as { code?: string } | null)?.code;
  if (code === 'COMMUNITY_TRUST_REQUIRED') return t('community.trustNotYet');
  if (code === 'COMMUNITY_SPACE_CLOSED') return t('community.spaceClosed');
  return err instanceof Error ? err.message : String(err);
}
