import { describe, it, expect } from 'vitest';
import { allRegions, computableSchool } from '@themaithil/region';
import { PanjikaSchool } from '@themaithil/contracts';
import { panjikaSchoolEnum } from '../db/schema/enums';

/**
 * Three lists must agree about what an almanac is called.
 *
 * `packages/region` was expanded pan-India and gave twelve cities `drik_generic`
 * and `vikram_banaras`. The Postgres enum still held only the three Bengal and
 * Mithila values, and the contracts enum matched the database. So those cities
 * declared almanacs the database could not store.
 *
 * Nothing failed loudly. The materialiser defaulted to the literal
 * `'bisuddha_siddhanta'` — storable everywhere, offered nowhere outside Bengal — so
 * rows were written for Ahmedabad under a name Ahmedabad's own config never returns.
 * The read path lists schools from that config, matched nothing, and reported the
 * almanac unpublished. Data present, unreachable, no error at any layer.
 *
 * A drifting enum is invisible until it is a blank page in twelve cities.
 */
const dbValues = new Set<string>(panjikaSchoolEnum.enumValues);
const contractValues = new Set<string>(PanjikaSchool.options);

describe('panjika identifiers agree across the three layers', () => {
  it('every school a region declares can be stored', () => {
    for (const region of allRegions()) {
      for (const p of region.panjikas) {
        expect(dbValues.has(p.id), `${region.slug} offers ${p.id}, which the pg enum lacks`)
          .toBe(true);
      }
    }
  });

  it('every school a region declares can cross the API boundary', () => {
    for (const region of allRegions()) {
      for (const p of region.panjikas) {
        expect(
          contractValues.has(p.id),
          `${region.slug} offers ${p.id}, which the contracts enum rejects`,
        ).toBe(true);
      }
    }
  });

  it('the database and the contract hold exactly the same set', () => {
    expect([...dbValues].sort()).toEqual([...contractValues].sort());
  });
});

describe('every city can have a panchang computed for it', () => {
  it('declares at least one computable almanac', () => {
    for (const region of allRegions()) {
      expect(
        () => computableSchool(region),
        `${region.slug} has no drik school, so its panchang can never be materialised`,
      ).not.toThrow();
    }
  });

  it('resolves to a school that region actually offers', () => {
    for (const region of allRegions()) {
      const school = computableSchool(region);
      expect(
        region.panjikas.some((p) => p.id === school),
        `${region.slug} would materialise under ${school}, which it does not offer`,
      ).toBe(true);
    }
  });

  /** The exact bug: Kolkata's name for its drik almanac is not everyone else's. */
  it('does not assume Kolkata’s almanac name outside Kolkata', () => {
    const outside = allRegions().filter((r) => r.slug !== 'kolkata');
    expect(outside.length).toBeGreaterThan(0);
    for (const region of outside) {
      expect(computableSchool(region)).not.toBe('bisuddha_siddhanta');
    }
  });
});
