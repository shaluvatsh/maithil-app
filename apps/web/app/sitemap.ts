import type { MetadataRoute } from 'next';
import { getRituals } from '@/lib/server-api';

/**
 * Without this the detail pages exist but nothing points a crawler at them.
 *
 * Every competitor in this category runs on organic search — 99Pandit has ~95 city
 * landing pages, SmartPuja has per-city and per-ritual pages going back to 2016. A
 * marketplace with no sitemap has no acquisition channel.
 */
const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://themaithil.com';
const DEFAULT_CITY = process.env.NEXT_PUBLIC_REGION ?? 'kolkata';

export const revalidate = 86400;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const rituals = (await getRituals(DEFAULT_CITY)) ?? [];

  const staticPages: MetadataRoute.Sitemap = [
    { url: `${SITE}/`, changeFrequency: 'weekly', priority: 1 },
    // The category hub: the crawlable index that links every /pooja/[slug].
    { url: `${SITE}/services`, changeFrequency: 'weekly', priority: 0.9 },
    { url: `${SITE}/book`, changeFrequency: 'daily', priority: 0.9 },
    { url: `${SITE}/panchang`, changeFrequency: 'daily', priority: 0.8 },
    { url: `${SITE}/purohit`, changeFrequency: 'monthly', priority: 0.5 },
  ];

  return [
    ...staticPages,
    ...rituals.map((r) => ({
      url: `${SITE}/pooja/${r.slug}`,
      changeFrequency: 'weekly' as const,
      priority: 0.8,
    })),
  ];
}
