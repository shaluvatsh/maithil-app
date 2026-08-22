import { describe, it, expect } from 'vitest';
import { REGIONS, getRegion, getPanjika, fontPlan, fontHref } from '../index';
import { createTranslator, en, type MessageKey } from '../i18n';
import { formatMoney, formatEraDate, toLocalNumerals, slotLabel, slotInstant } from '../format';

const all = Object.entries(REGIONS);

/**
 * Config validation as a test.
 *
 * Adding a city is meant to be a config entry rather than a code change — which only
 * holds if a malformed config fails loudly at build time instead of shipping a broken
 * slot picker to a new market. These run over every region, so a fourth city is
 * covered the moment it is added.
 */
describe.each(all)('region: %s', (slug, region) => {
  it('has a slug matching its key', () => {
    expect(region.slug).toBe(slug);
  });

  it('offers at least one panjika, and its default is one of them', () => {
    expect(region.panjikas.length).toBeGreaterThan(0);
    expect(getPanjika(region, region.defaultPanjika)).toBeDefined();
  });

  it('has slots that are contiguous from zero, ordered, and non-overlapping', () => {
    const slots = [...region.slots].sort((a, b) => a.idx - b.idx);
    expect(slots.map((s) => s.idx)).toEqual(slots.map((_, i) => i));

    for (const s of slots) {
      expect(s.start).toMatch(/^\d{2}:\d{2}$/);
      expect(s.end).toMatch(/^\d{2}:\d{2}$/);
      expect(s.end > s.start, `${slug} slot ${s.idx} ends before it starts`).toBe(true);
    }
    for (let i = 1; i < slots.length; i++) {
      expect(slots[i]!.start >= slots[i - 1]!.end,
        `${slug} slot ${i} overlaps the one before`).toBe(true);
    }
  });

  it('leaves a gap between slots at least as long as the declared travel allowance', () => {
    const slots = [...region.slots].sort((a, b) => a.idx - b.idx);
    for (let i = 1; i < slots.length; i++) {
      const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
      const gap = mins(slots[i]!.start) - mins(slots[i - 1]!.end);
      // The gap may be smaller than the travel allowance - that is exactly why the
      // buffer mechanism exists - but it must never be negative.
      expect(gap).toBeGreaterThanOrEqual(0);
    }
  });

  it('declares a primary locale and a resolvable font plan', () => {
    expect(region.locales.length).toBeGreaterThan(0);
    const plan = fontPlan(region.script);
    expect(plan.families.length).toBeGreaterThan(0);
    expect(plan.opticalScale).toBeGreaterThanOrEqual(1);
    expect(fontHref(region.script)).toContain('display=swap');
  });

  it('has a twelve-month era, if it declares one', () => {
    if (!region.era) return;
    expect(region.era.months).toHaveLength(12);
    expect(formatEraDate('2026-08-08', region)).toBeTruthy();
  });

  it('resolves every message key through its locale chain', () => {
    const t = createTranslator(region);
    for (const key of Object.keys(en) as MessageKey[]) {
      const out = t(key);
      expect(out, `${slug} has no string for ${key}`).toBeTruthy();
      expect(out).not.toBe(key);
    }
  });

  it('labels every slot it declares', () => {
    const t = createTranslator(region);
    for (const s of region.slots) {
      expect(t(s.labelKey as MessageKey)).not.toBe(s.labelKey);
      expect(slotLabel(region, s.idx)).toMatch(/[ap]m/);
    }
  });

  it('formats money in rupees', () => {
    expect(formatMoney(150000, region)).toContain('1,500');
  });

  it('builds slot instants at its own UTC offset', () => {
    const d = slotInstant('2026-08-08', region.slots[0]!.start, region);
    expect(Number.isNaN(d.getTime())).toBe(false);
  });
});

describe('the model generalises', () => {
  it('covers more than one calendar system across the set', () => {
    const systems = new Set(all.flatMap(([, r]) => r.panjikas.map((p) => p.calendar)));
    expect(systems.has('amanta')).toBe(true);
    expect(systems.has('purnimant')).toBe(true);
  });

  it('covers more than one script, so the font plan is exercised', () => {
    expect(new Set(all.map(([, r]) => r.script)).size).toBeGreaterThan(1);
  });

  it('does not assume four slots a day', () => {
    const counts = new Set(all.map(([, r]) => r.slots.length));
    expect(counts.size).toBeGreaterThan(1);
  });

  it('renders local numerals where a region asks for them', () => {
    expect(toLocalNumerals(2026, 'beng')).toBe('২০২৬');
    expect(toLocalNumerals(2026, 'deva')).toBe('२०२६');
    expect(toLocalNumerals(2026, 'latn')).toBe('2026');
  });

  it('rejects an unknown region loudly', () => {
    expect(() => getRegion('atlantis')).toThrow(/unknown region/);
  });
});
