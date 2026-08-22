import type { MetadataRoute } from 'next';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://themaithil.com';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      // Signed-in surfaces and the internal console. Nothing here is useful in an
      // index, and /admin should never appear in one.
      disallow: ['/account', '/admin', '/login'],
    },
    sitemap: `${SITE}/sitemap.xml`,
  };
}
