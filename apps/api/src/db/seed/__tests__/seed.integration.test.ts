import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as schema from '../../schema/index';
import type { Db } from '../../client';
import { CatalogService } from '../../../modules/catalog/catalog.service';
import { OffersService } from '../../../modules/catalog/offers.service';
import { allRegions } from '@themaithil/region';
import { KOLKATA_RITUALS } from '../rituals.kolkata';
import { seedDatabase } from '../index';

/**
 * Nothing tested the seed, and both shipped bugs lived in it: rituals could not be
 * re-seeded (so the new category column kept its default and every category showed an
 * identical list), and prices were written for the launch city only (so every other
 * city returned nothing at all).
 */
const migrations = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

let pg: PGlite;
let db: Db;
let catalog: CatalogService;
const active = allRegions().filter((r) => r.active);

beforeAll(async () => {
  pg = await PGlite.create({ extensions: { btree_gist } });
  await pg.exec('CREATE EXTENSION IF NOT EXISTS btree_gist;');
  for (const f of readdirSync(migrations).filter((x) => x.endsWith('.sql')).sort()) {
    for (const stmt of readFileSync(join(migrations, f), 'utf8').split('--> statement-breakpoint')) {
      if (stmt.trim()) await pg.exec(stmt);
    }
  }
  db = drizzle(pg, { schema }) as unknown as Db;
  catalog = new CatalogService(db);
  await seedDatabase(db);
}, 120_000);
afterAll(async () => { await pg?.close(); });

describe('the seed is re-runnable', () => {
  it('runs a second time without throwing', async () => {
    await expect(seedDatabase(db)).resolves.toBeTruthy();
  });

  it('does not duplicate rituals', async () => {
    expect(await db.select().from(schema.rituals)).toHaveLength(KOLKATA_RITUALS.length);
  });

  it('does not stack duplicate BOMs', async () => {
    const first = (await db.select().from(schema.rituals).limit(1))[0]!;
    const boms = await db.select().from(schema.boms)
      .where(eq(schema.boms.ritualId, first.id));
    expect(boms).toHaveLength(1);
  });
});

describe('categories are real, not left at the column default', () => {
  it('spreads rituals across more than one category', async () => {
    const rows = await db.select({ c: schema.rituals.category }).from(schema.rituals);
    expect(new Set(rows.map((r) => r.c)).size).toBeGreaterThan(1);
  });

  it('serves categories with counts that sum to the catalogue', async () => {
    const cats = await catalog.categories('kolkata');
    expect(cats.length).toBeGreaterThan(1);
    expect(cats.reduce((a, c) => a + c.count, 0)).toBe(KOLKATA_RITUALS.length);
  });
});

describe('the service list is identical in every city', () => {
  it('prices every ritual in every active city', async () => {
    const prices = await db.select().from(schema.ritualCityPrices);
    expect(prices).toHaveLength(KOLKATA_RITUALS.length * active.length);
  });

  it('RETURNS THE SAME SERVICES EVERYWHERE, not an empty list outside Kolkata', async () => {
    const baseline = (await catalog.listRituals({ citySlug: 'kolkata', locale: 'en' }))
      .map((r) => r.slug).sort();
    expect(baseline).toHaveLength(KOLKATA_RITUALS.length);

    for (const region of active) {
      const here = (await catalog.listRituals({ citySlug: region.slug, locale: 'en' }))
        .map((r) => r.slug).sort();
      expect(here, `${region.slug} has a different catalogue`).toEqual(baseline);
    }
  });

  it('offers the same categories in every city', async () => {
    const baseline = (await catalog.categories('kolkata')).map((c) => c.id).sort();
    for (const region of active) {
      const here = (await catalog.categories(region.slug)).map((c) => c.id).sort();
      expect(here, `${region.slug} differs`).toEqual(baseline);
    }
  });

  it('varies PRICE by city while the list stays identical', async () => {
    const k = (await catalog.listRituals({ citySlug: 'kolkata', locale: 'en' }))
      .find((r) => r.slug === 'satyanarayan-puja')!;
    const m = (await catalog.listRituals({ citySlug: 'mumbai', locale: 'en' }))
      .find((r) => r.slug === 'satyanarayan-puja')!;
    const v = (await catalog.listRituals({ citySlug: 'varanasi', locale: 'en' }))
      .find((r) => r.slug === 'satyanarayan-puja')!;
    expect(m.priceBand.defaultPaise).toBeGreaterThan(k.priceBand.defaultPaise);
    expect(v.priceBand.defaultPaise).toBeLessThan(k.priceBand.defaultPaise);
  });

  it('gives every active city its own slot definitions', async () => {
    for (const region of active) {
      const city = (await db.select().from(schema.cities)
        .where(eq(schema.cities.slug, region.slug)))[0];
      expect(city, `${region.slug} was never created`).toBeDefined();
      const slots = await db.select().from(schema.slotDefs)
        .where(eq(schema.slotDefs.cityId, city!.id));
      expect(slots, `${region.slug} slots`).toHaveLength(region.slots.length);
    }
  });
});

/**
 * "The membership card is not visible" and "the seed has not been run" look
 * identical from a browser: the card renders only what `/v1/offers/current`
 * returns, and that is legitimately `null` when no plan row exists.
 *
 * This file applies the real migrations and then the real seed, so it is the one
 * place that can say which of the two is true.
 */
describe('the seed creates a live membership plan', () => {
  it('inserts the plan', async () => {
    const plans = await db.select().from(schema.membershipPlans);
    expect(plans, 'no plan row, so the offer card can never render').toHaveLength(1);
  });

  it('prices it and dates the offer into the future', async () => {
    const [plan] = await db.select().from(schema.membershipPlans);
    expect(plan!.pricePaise).toBeGreaterThan(0);
    expect(plan!.discountBps).toBeGreaterThan(0);
    expect(plan!.active).toBe(true);
    expect(plan!.offerEndsOn!).toBeTruthy();
    expect(Date.parse(`${plan!.offerEndsOn}T00:00:00+05:30`))
      .toBeGreaterThan(Date.now());
  });

  /** Advertised, but not yet chargeable — see migration 0010. */
  it('leaves it not purchasable until checkout exists', async () => {
    const [plan] = await db.select().from(schema.membershipPlans);
    expect(plan!.purchasable).toBe(false);
  });

  it('gives it benefits to list, so the card has a body', async () => {
    const [plan] = await db.select().from(schema.membershipPlans);
    expect(Array.isArray(plan!.benefits)).toBe(true);
    expect(plan!.benefits.length).toBeGreaterThan(2);
  });

  /** The endpoint the card actually calls, over the seeded database. */
  it('is returned by the offers service for the launch city', async () => {
    const offer = await new OffersService(db).current('kolkata', 'en');
    expect(offer, 'the seeded plan is not reachable through /v1/offers/current')
      .not.toBeNull();
    expect(offer!.name).toBeTruthy();
    expect(offer!.bundle, 'no bundle, so the card loses half its content')
      .not.toBeNull();
  });
});
