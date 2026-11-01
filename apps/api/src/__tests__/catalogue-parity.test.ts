import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KOLKATA_RITUALS } from '../db/seed/rituals.kolkata';

/**
 * The catalogue and its test mirror must agree.
 *
 * `packages/region/src/__tests__/fixtures.ts` hand-copies every ritual slug, and the
 * duplication is DELIBERATE and correct: `packages/region` must not depend on the
 * API, so its category tests cannot import the seed. Its own comment says a mirror
 * that drifts from the seed "is exactly what the orphans assertion catches".
 *
 * It did catch it — and from the wrong side. Four multi-day rituals (`durga-puja`,
 * `chandi-paath`, `rudra-chandi-paath`, `mahamrityunjay-jaap`, added with ADR 0006's
 * multi-day work) went into the catalogue and into `RITUAL_CATEGORY_MAP`, the mirror
 * was not updated, and `packages/region` then failed with "maps nothing that is not
 * in the catalogue" — pointing at four slugs that were entirely correct. The failure
 * named the wrong file and blamed the wrong change.
 *
 * Only `apps/api` can see both sides, so the check belongs here. Read as TEXT rather
 * than imported, the same technique `routes.test.ts` uses on `app.module.ts`: the
 * fixture lives in another package's test directory and is not part of its published
 * surface.
 */
const FIXTURE = join(
  __dirname, '..', '..', '..', '..',
  'packages', 'region', 'src', '__tests__', 'fixtures.ts',
);

function mirroredSlugs(): string[] {
  const body = readFileSync(FIXTURE, 'utf8');
  const start = body.indexOf('KOLKATA_SLUGS');
  const open = body.indexOf('[', start);
  const close = body.indexOf('];', open);
  const block = body.slice(open, close);
  // Quoted slugs only, so a comment mentioning a ritual by name cannot count.
  return [...block.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]!);
}

describe('the ritual catalogue and its test mirror agree', () => {
  it('mirrors every seeded slug', () => {
    const seeded = KOLKATA_RITUALS.map((r) => r.slug).sort();
    const mirrored = mirroredSlugs().sort();

    const missing = seeded.filter((s) => !mirrored.includes(s));
    expect(
      missing,
      `add these to packages/region/src/__tests__/fixtures.ts: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('mirrors nothing the catalogue has dropped', () => {
    const seeded = KOLKATA_RITUALS.map((r) => r.slug);
    const stale = mirroredSlugs().filter((s) => !seeded.includes(s));
    expect(
      stale,
      `remove these from packages/region/src/__tests__/fixtures.ts: ${stale.join(', ')}`,
    ).toEqual([]);
  });

  it('reads the mirror at all, so a rename cannot make this vacuous', () => {
    // A parity test that silently parses nothing passes for ever. This is the guard
    // on the guard.
    expect(mirroredSlugs().length).toBeGreaterThan(20);
  });
});
