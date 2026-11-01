import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../../schema/index';
import type { Db } from '../../client';
import { seedDatabase } from '../index';

/**
 * Every other seed test starts from an empty database. Nobody's laptop does.
 *
 * The realistic path is: seeded weeks ago, pull new code, run `db:migrate` and
 * `db:seed` again. That exercises the upsert branches — and a re-seed that throws is
 * how the category column stayed at its default while the UI rendered no categories
 * at all.
 */
const migrationsDir = join(__dirname, '..', '..', 'migrations');

const applyMigrations = async (pg: PGlite, files: string[]) => {
  for (const file of files) {
    const body = readFileSync(join(migrationsDir, file), 'utf8');
    for (const stmt of body.split('--> statement-breakpoint')) {
      if (stmt.trim()) await pg.exec(stmt);
    }
  }
};

const allMigrations = () =>
  readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

/**
 * Pricing sanity.
 *
 * One flat 13-item kit was attached to all 25 rituals, so a tarpan — til and kusha
 * grass at a ghat — carried a kalash, 250g of ghee and a garland, and its materials
 * cost twice its dakshina. A full Bengali biye carried the same ₹1,000 of samagri.
 * Nothing caught it because nothing asserted a relationship between the two numbers.
 */
describe('prices are plausible', () => {
  const load = async () => {
    const pg = await PGlite.create({ extensions: { btree_gist } });
    await pg.exec('CREATE EXTENSION IF NOT EXISTS btree_gist;');
    await applyMigrations(pg, allMigrations());
    await seedDatabase(drizzle(pg, { schema }) as unknown as Db);
    const rows = await pg.query<{
      slug: string; duration: number; dakshina: number; samagri: number;
    }>(`SELECT r.slug,
               r.duration_min AS duration,
               p.default_paise::int AS dakshina,
               COALESCE((SELECT SUM(bi.line_price_paise)
                           FROM bom_items bi JOIN boms b ON b.id = bi.bom_id
                          WHERE b.ritual_id = r.id), 0)::int AS samagri
          FROM rituals r
          JOIN ritual_city_prices p ON p.ritual_id = r.id
          JOIN cities c ON c.id = p.city_id AND c.slug = 'kolkata'`);
    await pg.close();
    return rows.rows;
  };

  it('never charges more for materials than for the purohit', async () => {
    const inverted = (await load())
      .filter((r) => r.samagri > r.dakshina)
      .map((r) => `${r.slug}: samagri ₹${r.samagri / 100} > dakshina ₹${r.dakshina / 100}`);

    expect(inverted, 'materials cannot cost more than the ritual').toEqual([]);
  }, 120_000);

  it('scales materials with the ritual instead of charging a flat kit', async () => {
    const rows = await load();
    const by = (s: string) => rows.find((r) => r.slug === s)!;

    // A 60-minute rite at a ghat against a multi-hour ceremony.
    expect(by('tarpan').samagri).toBeLessThan(by('biye').samagri / 10);
    expect(by('halkhata').samagri).toBeLessThan(by('upanayan').samagri / 10);

    // And the flat-kit signature: many rituals sharing one identical figure.
    const atHome = rows.filter((r) => r.samagri > 0).map((r) => r.samagri);
    const commonest = Math.max(
      ...[...new Set(atHome)].map((v) => atHome.filter((x) => x === v).length),
    );
    expect(commonest, 'too many rituals share one samagri total — the kit is flat again')
      .toBeLessThan(atHome.length * 0.6);
  }, 120_000);

  it('charges nothing for materials on a video call', async () => {
    const rows = await load();
    for (const slug of ['online-aarti', 'virtual-consultation']) {
      expect(rows.find((r) => r.slug === slug)!.samagri).toBe(0);
    }
  }, 120_000);
});

describe('remote services', () => {
  it('seeds them as real bookable rows, billed nothing for materials', async () => {
    const pg = await PGlite.create({ extensions: { btree_gist } });
    await pg.exec('CREATE EXTENSION IF NOT EXISTS btree_gist;');
    await applyMigrations(pg, allMigrations());
    const db = drizzle(pg, { schema }) as unknown as Db;
    await seedDatabase(db);

    const virtual = await pg.query<{ slug: string; category: string }>(
      `SELECT slug, category FROM rituals WHERE delivery_mode = 'virtual' ORDER BY slug`,
    );
    expect(virtual.rows.map((r) => r.slug))
      .toEqual(['online-aarti', 'virtual-consultation']);
    expect(virtual.rows.every((r) => r.category === 'online-services')).toBe(true);

    /*
     * A video call carries no CHARGE for materials — but "no charge" and "no list"
     * are different things, and treating them as one left an online aarti with
     * nothing telling the family to have a lamp ready.
     *
     * A consultation needs nothing and has no BOM. An aarti has a checklist, priced
     * at zero: the devotee buys a diya from their own shop, so the total must stay
     * zero no matter what a caller sends as `samagriOption`. That is the invariant
     * worth pinning — not the absence of the rows.
     */
    const consultation = await pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM boms b
         JOIN rituals r ON r.id = b.ritual_id
        WHERE r.slug = 'virtual-consultation'`,
    );
    expect(consultation.rows[0]!.n).toBe(0);

    const virtualSamagri = await pg.query<{ total: number }>(
      `SELECT coalesce(sum(bi.line_price_paise), 0)::int AS total
         FROM bom_items bi
         JOIN boms b   ON b.id = bi.bom_id
         JOIN rituals r ON r.id = b.ritual_id
        WHERE r.delivery_mode = 'virtual'`,
    );
    expect(virtualSamagri.rows[0]!.total, 'a video call must never carry a samagri charge')
      .toBe(0);

    const aartiChecklist = await pg.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM bom_items bi
         JOIN boms b   ON b.id = bi.bom_id
         JOIN rituals r ON r.id = b.ritual_id
        WHERE r.slug = 'online-aarti'`,
    );
    expect(aartiChecklist.rows[0]!.n, 'an online aarti still needs a lamp at the devotee end')
      .toBeGreaterThan(0);

    // But they must still be priced in every city, or they vanish from browse.
    const priced = await pg.query<{ n: number }>(
      `SELECT count(DISTINCT p.city_id)::int AS n
         FROM ritual_city_prices p
         JOIN rituals r ON r.id = p.ritual_id
        WHERE r.slug = 'online-aarti'`,
    );
    const cities = await pg.query<{ n: number }>('SELECT count(*)::int AS n FROM cities');
    expect(priced.rows[0]!.n).toBe(cities.rows[0]!.n);

    await pg.close();
  }, 120_000);

  it('refuses a delivery mode outside the two we support', async () => {
    const pg = await PGlite.create({ extensions: { btree_gist } });
    await pg.exec('CREATE EXTENSION IF NOT EXISTS btree_gist;');
    await applyMigrations(pg, allMigrations());

    // An UPDATE against an empty table succeeds trivially, which proves nothing.
    await expect(
      pg.exec(`INSERT INTO rituals (id, slug, duration_min, delivery_mode)
               VALUES ('x1', 'teleported-puja', 60, 'teleport')`),
    ).rejects.toThrow(/delivery_mode/);

    // The two we do support are accepted.
    await pg.exec(`INSERT INTO rituals (id, slug, duration_min, delivery_mode)
                   VALUES ('x2', 'a-remote-one', 60, 'virtual')`);
    const ok = await pg.query<{ n: number }>('SELECT count(*)::int AS n FROM rituals');
    expect(ok.rows[0]!.n).toBe(1);

    await pg.close();
  }, 120_000);
});

describe('re-seeding an existing database', () => {
  it('is idempotent: seeding twice leaves one row per ritual, not two', async () => {
    const pg = await PGlite.create({ extensions: { btree_gist } });
    await pg.exec('CREATE EXTENSION IF NOT EXISTS btree_gist;');
    await applyMigrations(pg, allMigrations());
    const db = drizzle(pg, { schema }) as unknown as Db;

    await seedDatabase(db);
    const first = await pg.query<{ n: number }>('SELECT count(*)::int AS n FROM rituals');

    await expect(seedDatabase(db)).resolves.toBeTruthy();
    const second = await pg.query<{ n: number }>('SELECT count(*)::int AS n FROM rituals');

    expect(second.rows[0]!.n).toBe(first.rows[0]!.n);
    await pg.close();
  }, 120_000);

  it('backfills categories onto rituals seeded before the category migration existed', async () => {
    const pg = await PGlite.create({ extensions: { btree_gist } });
    await pg.exec('CREATE EXTENSION IF NOT EXISTS btree_gist;');

    // The world before 0003: schema without the category column.
    const before = allMigrations().filter((f) => !f.startsWith('0003'));
    await applyMigrations(pg, before);
    const db = drizzle(pg, { schema }) as unknown as Db;

    // Drizzle's typed insert references the column, so stand it up at its default
    // to imitate a database seeded under the old schema.
    await pg.exec(
      `ALTER TABLE rituals ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'festival-pujas'`,
    );
    await seedDatabase(db);

    // Now the operator pulls the new code and runs migrate + seed.
    await applyMigrations(pg, allMigrations().filter((f) => f.startsWith('0003')));
    await expect(seedDatabase(db)).resolves.toBeTruthy();

    // The bug: re-seed threw, so every ritual kept the default and the category
    // bar rendered a single bucket.
    const spread = await pg.query<{ category: string; n: number }>(
      'SELECT category, count(*)::int AS n FROM rituals GROUP BY category ORDER BY category',
    );

    expect(spread.rows.length).toBeGreaterThan(1);
    await pg.close();
  }, 120_000);
});
