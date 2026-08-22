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
