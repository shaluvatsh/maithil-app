import { describe, it, expect } from 'vitest';
import {
  RITUAL_CATEGORIES, RITUAL_CATEGORY_MAP, CATEGORY_IDS, categoryFor, getCategory,
} from '../categories';
import { KOLKATA_SLUGS } from './fixtures';

/**
 * The taxonomy is only useful if it actually partitions the catalogue. Browse
 * previously showed six tiles that all led to the same unfiltered list; these
 * assertions make that state impossible to ship again.
 */
describe('ritual categories', () => {
  it('has unique ids and a stable order', () => {
    expect(new Set(CATEGORY_IDS).size).toBe(CATEGORY_IDS.length);
    const orders = RITUAL_CATEGORIES.map((c) => c.order);
    expect(new Set(orders).size).toBe(orders.length);
  });

  it('gives every category a label, a blurb and a tile', () => {
    for (const c of RITUAL_CATEGORIES) {
      expect(c.en.length).toBeGreaterThan(2);
      expect(c.blurb.length).toBeGreaterThan(10);
      expect(c.emoji).toBeTruthy();
      expect(c.tint).toBeTruthy();
    }
  });

  it('maps every ritual to a category that exists', () => {
    for (const [slug, id] of Object.entries(RITUAL_CATEGORY_MAP)) {
      expect(CATEGORY_IDS, `${slug} -> unknown category ${id}`).toContain(id);
    }
  });

  it('CATEGORISES EVERY SEEDED RITUAL — none may fall through to the default', () => {
    const uncategorised = KOLKATA_SLUGS.filter((s) => !(s in RITUAL_CATEGORY_MAP));
    expect(uncategorised).toEqual([]);
  });

  it('maps nothing that is not in the catalogue', () => {
    const orphans = Object.keys(RITUAL_CATEGORY_MAP).filter((s) => !KOLKATA_SLUGS.includes(s));
    expect(orphans).toEqual([]);
  });

  it('leaves no category empty', () => {
    const used = new Set(Object.values(RITUAL_CATEGORY_MAP));
    const empty = CATEGORY_IDS.filter((id) => !used.has(id as never));
    expect(empty, 'an empty category is a tile that leads nowhere').toEqual([]);
  });

  it('is DISJOINT — each ritual belongs to exactly one category', () => {
    // A plain object cannot hold duplicate keys, so the real risk is a slug appearing
    // under two spellings. Compare against the catalogue to catch that.
    expect(Object.keys(RITUAL_CATEGORY_MAP).length).toBe(new Set(KOLKATA_SLUGS).size);
  });

  it('spreads the catalogue rather than dumping it in one bucket', () => {
    const counts = new Map<string, number>();
    for (const id of Object.values(RITUAL_CATEGORY_MAP)) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const biggest = Math.max(...counts.values());
    expect(biggest / KOLKATA_SLUGS.length,
      'one category holds most of the catalogue — the split is not useful')
      .toBeLessThan(0.55);
  });

  it('resolves a known slug and falls back safely for an unknown one', () => {
    expect(categoryFor('annaprashan')).toBe('life-ceremonies');
    expect(CATEGORY_IDS).toContain(categoryFor('a-ritual-added-tomorrow'));
    expect(getCategory('life-ceremonies')?.en).toBe('Life Ceremonies');
  });
});
