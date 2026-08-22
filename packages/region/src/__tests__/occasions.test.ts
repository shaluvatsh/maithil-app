import { describe, it, expect } from 'vitest';
import { OCCASIONS, OCCASION_IDS, getOccasion, ritualsForOccasion } from '../occasions';
import { KOLKATA_SLUGS } from './fixtures';

/**
 * An occasion that suggests a ritual we do not sell is worse than no occasion: the
 * devotee picks "we are moving into a new home", and the screen offers something
 * they cannot book.
 */
describe('occasions', () => {
  it('has unique ids and a stable order', () => {
    expect(new Set(OCCASION_IDS).size).toBe(OCCASION_IDS.length);
    const orders = OCCASIONS.map((o) => o.order);
    expect(new Set(orders).size).toBe(orders.length);
  });

  it('ONLY SUGGESTS RITUALS THAT EXIST IN THE CATALOGUE', () => {
    const unknown = OCCASIONS.flatMap((o) =>
      o.rituals.filter((r) => !KOLKATA_SLUGS.includes(r.slug))
        .map((r) => `${o.id} -> ${r.slug}`));
    expect(unknown).toEqual([]);
  });

  it('gives every occasion at least one core ritual', () => {
    const coreless = OCCASIONS
      .filter((o) => !o.rituals.some((r) => r.weight === 'core'))
      .map((o) => o.id);
    expect(coreless, 'an occasion with no core ritual leads nowhere').toEqual([]);
  });

  it('explains what each ritual does and whether you need more than one', () => {
    for (const o of OCCASIONS) {
      expect(o.guidance.length, `${o.id} has no guidance`).toBeGreaterThan(40);
      expect(o.label.length).toBeGreaterThan(8);
      for (const r of o.rituals) {
        expect(r.does.length, `${o.id}/${r.slug} does not say what it does`)
          .toBeGreaterThan(15);
      }
    }
  });

  it('orders core rituals ahead of optional ones', () => {
    const home = ritualsForOccasion('new-home');
    expect(home[0]).toBe('griha-prabesh');
    expect(home.at(-1)).toBe('satyanarayan-puja');
  });

  it('covers the catalogue reasonably — a ritual nobody can arrive at is dead stock', () => {
    const reachable = new Set(OCCASIONS.flatMap((o) => o.rituals.map((r) => r.slug)));
    const unreachable = KOLKATA_SLUGS.filter((s) => !reachable.has(s));
    // Some festival rituals are only reachable by browsing, which is fine — but if
    // most of the catalogue is unreachable, occasions are not doing their job.
    expect(unreachable.length).toBeLessThan(KOLKATA_SLUGS.length / 2);
  });

  it('returns undefined for an unknown occasion rather than throwing', () => {
    expect(getOccasion('nope')).toBeUndefined();
    expect(ritualsForOccasion('nope')).toEqual([]);
  });
});
