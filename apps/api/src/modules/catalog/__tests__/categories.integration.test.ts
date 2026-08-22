import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ulid } from 'ulid';
import { makeHarness, type Harness } from '../../../test/harness';
import { rituals, ritualTranslations, ritualCityPrices } from '../../../db/schema/index';
import { CatalogService } from '../catalog.service';
import { KOLKATA_RITUALS } from '../../../db/seed/rituals.kolkata';
import { RITUAL_CATEGORY_MAP, categoryFor, CATEGORY_IDS } from '@themaithil/region';

let h: Harness;
let catalog: CatalogService;

beforeAll(async () => {
  h = await makeHarness();
  catalog = new CatalogService(h.db);

  // Seed the full Kolkata catalogue so category counts are realistic.
  for (const [i, r] of KOLKATA_RITUALS.entries()) {
    if (r.slug === 'satyanarayan-puja') continue;          // already in the harness
    const id = ulid();
    await h.db.insert(rituals).values({
      id, slug: r.slug, durationMin: r.durationMin,
      defaultSlotSpan: r.slotSpan, isMuhuratSensitive: r.muhuratSensitive,
      category: categoryFor(r.slug), sortOrder: i,
    });
    await h.db.insert(ritualTranslations).values({
      ritualId: id, locale: 'en', name: r.names.en,
      shortDescription: r.short.en, description: r.short.en,
    });
    await h.db.insert(ritualCityPrices).values({
      ritualId: id, cityId: h.ids.cityId,
      bandMinPaise: r.bandMin, bandMaxPaise: r.bandMax, defaultPaise: r.bandDefault,
    });
  }
}, 90_000);
afterAll(async () => { await h?.pg.close(); });

describe('the seed and the taxonomy agree', () => {
  it('every catalogue slug has an explicit category', () => {
    const missing = KOLKATA_RITUALS.map((r) => r.slug).filter((s) => !(s in RITUAL_CATEGORY_MAP));
    expect(missing, 'these would silently fall into the default bucket').toEqual([]);
  });
});

describe('category filtering', () => {
  it('returns only that category', async () => {
    for (const id of CATEGORY_IDS) {
      const list = await catalog.listRituals({ citySlug: 'kolkata', locale: 'en', category: id });
      for (const r of list) expect(r.category).toBe(id);
    }
  });

  it('GIVES A DIFFERENT SET PER CATEGORY — the actual bug', async () => {
    const sets = new Map<string, string[]>();
    for (const id of CATEGORY_IDS) {
      const list = await catalog.listRituals({ citySlug: 'kolkata', locale: 'en', category: id });
      sets.set(id, list.map((r) => r.slug).sort());
    }
    const signatures = [...sets.values()].map((s) => s.join(','));
    expect(new Set(signatures).size,
      'two categories returned an identical list').toBe(signatures.length);
  });

  it('partitions the catalogue — no ritual appears twice, none goes missing', async () => {
    const all = await catalog.listRituals({ citySlug: 'kolkata', locale: 'en' });
    const collected: string[] = [];
    for (const id of CATEGORY_IDS) {
      const list = await catalog.listRituals({ citySlug: 'kolkata', locale: 'en', category: id });
      collected.push(...list.map((r) => r.slug));
    }
    expect(new Set(collected).size, 'a ritual is in two categories').toBe(collected.length);
    expect(collected.sort()).toEqual(all.map((r) => r.slug).sort());
  });

  it('returns the whole catalogue when no category is given', async () => {
    const all = await catalog.listRituals({ citySlug: 'kolkata', locale: 'en' });
    expect(all.length).toBe(KOLKATA_RITUALS.length);
  });

  it('returns nothing for an unknown category rather than everything', async () => {
    const list = await catalog.listRituals({
      citySlug: 'kolkata', locale: 'en', category: 'not-a-category',
    });
    expect(list).toEqual([]);
  });
});

describe('category counts', () => {
  it('match the number of rituals actually returned', async () => {
    const cats = await catalog.categories('kolkata');
    expect(cats.length).toBeGreaterThan(1);
    for (const c of cats) {
      const list = await catalog.listRituals({
        citySlug: 'kolkata', locale: 'en', category: c.id,
      });
      expect(c.count, `${c.id} count is wrong`).toBe(list.length);
    }
  });

  it('sum to the whole catalogue', async () => {
    const cats = await catalog.categories('kolkata');
    const total = cats.reduce((a, c) => a + c.count, 0);
    expect(total).toBe(KOLKATA_RITUALS.length);
  });

  it('never advertises an empty category', async () => {
    for (const c of await catalog.categories('kolkata')) {
      expect(c.count).toBeGreaterThan(0);
    }
  });

  it('carries the label and tile the UI needs', async () => {
    for (const c of await catalog.categories('kolkata')) {
      expect(c.en).toBeTruthy();
      expect(c.blurb).toBeTruthy();
      expect(c.emoji).toBeTruthy();
      expect(c.tint).toBeTruthy();
    }
  });
});
