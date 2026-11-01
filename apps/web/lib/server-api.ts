/**
 * Server-side data access for the pages that must be crawlable.
 *
 * `lib/api.ts` is `'use client'` and reads a JWT from localStorage, so it cannot be
 * used from a server component. These are unauthenticated catalogue reads, cached
 * by Next rather than fetched per visitor.
 *
 * The architecture review flagged that 12 of 13 pages were client components, which
 * means Google receives an empty shell. Everything here renders on the server.
 */
const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

/** Catalogue and prices change at most daily. */
const REVALIDATE = 3600;

export interface RitualSummary {
  id: string;
  slug: string;
  name: string;
  shortDescription: string;
  durationMin: number;
  defaultSlotSpan: number;
  isMuhuratSensitive: boolean;
  category: string;
  deliveryMode: 'at_home' | 'virtual';
  bomTotalPaise: number;
  priceBand: { minPaise: number; maxPaise: number; defaultPaise: number };
}

export interface BomLine {
  id: string; name: string; qty: string; unit: string;
  grade: string | null; linePricePaise: number; perishable: boolean;
}

export interface RitualDetail extends RitualSummary {
  description: string;
  bom: BomLine[];
}

/**
 * Returns null rather than throwing.
 *
 * A detail page that 500s because the API is briefly unreachable is worse than one
 * that renders a "temporarily unavailable" state, and during `next build` the API is
 * often not running at all.
 */
async function get<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${BASE}${path}`, { next: { revalidate: REVALIDATE } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export const getRituals = (citySlug: string, locale = 'en') =>
  get<RitualSummary[]>(`/v1/rituals?citySlug=${citySlug}&locale=${locale}`);

export const getRitual = (slug: string, citySlug: string, locale = 'en') =>
  get<RitualDetail>(`/v1/rituals/${slug}?citySlug=${citySlug}&locale=${locale}`);

/**
 * Published knowledge, read on the SERVER.
 *
 * Ritual guides are the highest-conversion content in the library — first-time
 * devotees do not fail to book because of price, they fail because they do not know
 * what they are agreeing to — and they are also the SEO asset ADR 0008 cut when it
 * dropped `devotee-web`. Both of those require the text to be in the HTML, not
 * fetched after hydration, so this goes through the server path like the catalogue.
 */
export interface KnowledgeSummary {
  id: string;
  slug: string;
  type: 'article' | 'ritual_guide' | 'mantra_audio' | 'video' | 'shloka' | 'glossary';
  level: 'beginner' | 'deep';
  title: string;
  summary: string;
  locale: string;
  /** False when the reader is being served a translation rather than the original. */
  original: boolean;
  ritualSlug: string | null;
  durationSec: number | null;
  coverUrl: string | null;
  mediaUrl: string | null;
  authorName: string;
  authorVerified: boolean;
  reviewedByName: string | null;
  citationCount: number;
  publishedAt: string;
}

export interface KnowledgeItem extends KnowledgeSummary {
  body: string;
  transcript: string | null;
  availableLocales: string[];
  citations: Array<{
    work: string; chapter: string | null; verse: string | null; note: string | null;
  }>;
}

const qs = (p: Record<string, string | number | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
};

/**
 * Through `get`, not a bare `fetch`.
 *
 * These called `fetch` directly and checked `res.ok`, which handles a 404 and not a
 * REJECTION — and `next build` runs with no API listening, so the fetch does not
 * return a bad response, it throws ECONNREFUSED. That failed the build on the ritual
 * pages, which now read guides. `get` already existed for exactly this and says so in
 * its own comment; using it is the whole fix.
 *
 * An empty list rather than null for the library, because a ritual page renders no
 * guides section at all when there are none — a missing section is correct, a thrown
 * page is not.
 */
export async function getKnowledge(params: {
  type?: string; level?: string; ritualSlug?: string; locale?: string; limit?: number;
} = {}): Promise<{ items: KnowledgeSummary[]; nextCursor: string | null }> {
  return (await get<{ items: KnowledgeSummary[]; nextCursor: string | null }>(
    `/v1/knowledge${qs(params)}`,
  )) ?? { items: [], nextCursor: null };
}

export const getKnowledgeItem = (slug: string, locale?: string) =>
  get<KnowledgeItem>(`/v1/knowledge/${slug}${qs({ locale })}`);
