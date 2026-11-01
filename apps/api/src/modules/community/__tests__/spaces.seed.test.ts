import { describe, it, expect, beforeAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { drizzle } from 'drizzle-orm/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeRegions } from '@themaithil/region';
import * as schema from '../../../db/schema/index';
import type { Db } from '../../../db/client';
import { seedDatabase } from '../../../db/seed/index';

/**
 * Every city we serve must have somewhere to post.
 *
 * The seed derives spaces from `packages/region` and the ritual catalogue rather
 * than from a list, and this is the test that keeps it that way. A hand-maintained
 * list of spaces fails silently and regionally: the city launches, the community tab
 * renders empty, and nothing anywhere raises an error — the same shape of bug
 * `panjika-parity.test.ts` exists to catch on the almanac axis.
 */
let db: Db;

beforeAll(async () => {
  const pg = await PGlite.create({ extensions: { btree_gist } });
  await pg.exec('CREATE EXTENSION IF NOT EXISTS btree_gist;');
  const migrations = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'db', 'migrations');
  for (const file of readdirSync(migrations).filter((f) => f.endsWith('.sql')).sort()) {
    for (const stmt of readFileSync(join(migrations, file), 'utf8').split('--> statement-breakpoint')) {
      if (stmt.trim()) await pg.exec(stmt);
    }
  }
  db = drizzle(pg, { schema }) as unknown as Db;
  await seedDatabase(db);
}, 120_000);

const rows = async <T>(q: ReturnType<typeof sql>): Promise<T[]> => {
  const r = await db.execute(q);
  return ((r as unknown as { rows?: unknown[] }).rows ?? r) as T[];
};

describe('community spaces are derived, never listed', () => {
  it('gives every active region a city space', async () => {
    const found = await rows<{ slug: string }>(sql`
      SELECT s.slug FROM community_spaces s WHERE s.kind = 'city'`);
    const slugs = new Set(found.map((r) => r.slug));
    for (const region of activeRegions()) {
      expect(slugs.has(`city-${region.slug}`), `${region.slug} has nowhere to post`).toBe(true);
    }
  });

  it('gives every city space its own languages, not the launch city’s', async () => {
    // The typed select, not `db.execute`: the raw path hands back the wire format
    // for an array column, so a string would pass a sloppy assertion and prove
    // nothing about what the application actually reads.
    const all = await db.select({
      slug: schema.communitySpaces.slug, locales: schema.communitySpaces.locales,
    }).from(schema.communitySpaces);
    const bySlug = new Map(all.map((r) => [r.slug, r.locales]));

    for (const region of activeRegions()) {
      expect([...(bySlug.get(`city-${region.slug}`) ?? [])].sort(), region.slug)
        .toEqual([...region.locales].sort());
    }
  });

  /** The point of the two axes: a ritual question is the same question everywhere. */
  it('scopes ritual spaces nationally and city spaces to their city', async () => {
    const bad = await rows<{ slug: string }>(sql`
      SELECT slug FROM community_spaces
       WHERE (kind = 'ritual' AND scope <> 'national')
          OR (kind = 'city'   AND scope <> 'city')`);
    expect(bad).toEqual([]);
  });

  it('points every ritual space at a real ritual', async () => {
    const orphans = await rows<{ slug: string }>(sql`
      SELECT s.slug FROM community_spaces s
       LEFT JOIN rituals r ON r.id = s.ritual_id
       WHERE s.kind = 'ritual' AND r.id IS NULL`);
    expect(orphans).toEqual([]);
  });

  it('is rerunnable, the way the rest of the seed is', async () => {
    const before = await rows<{ n: number }>(sql`SELECT count(*)::int AS n FROM community_spaces`);
    await seedDatabase(db);
    const after = await rows<{ n: number }>(sql`SELECT count(*)::int AS n FROM community_spaces`);
    expect(after[0]!.n).toBe(before[0]!.n);
  }, 120_000);
});
