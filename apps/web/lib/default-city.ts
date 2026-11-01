/**
 * The launch city, for the pages that must render before anyone has chosen one.
 *
 * ONE OWNER. This was declared twice — in `lib/region-context.tsx` and again in
 * `app/pooja/[slug]/page.tsx` — each with its own `?? 'kolkata'`. Two copies of the
 * same default is the shape of bug that gets changed in one place: a second city
 * launches, the provider follows the environment variable and the statically
 * rendered ritual pages quietly keep pricing everything in Kolkata.
 *
 * A plain module rather than part of `region-context`, because that file is
 * `'use client'` and these pages are server components. A server component importing
 * from a client module pulls the whole provider into the server graph.
 */
export const DEFAULT_CITY = process.env.NEXT_PUBLIC_REGION ?? 'kolkata';
