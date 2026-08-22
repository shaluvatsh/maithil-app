export * from './types';
export * from './fonts';
export * from './format';
export * from './i18n';
export * from './categories';
export * from './ritual-presentation';
export * from './occasions';
export * from './muhurat';
export * from './languages';

import type { Region, PanjikaId } from './types';
import { kolkata } from './regions/kolkata';
import { patna } from './regions/patna';
import { INDIA } from './regions/india';

export * from './regions/factory';

/**
 * Kolkata and Patna are hand-written because their panjika situation is genuinely
 * bespoke. Everything else comes from the factory.
 */
export const REGIONS: Record<string, Region> = {
  kolkata,
  patna,
  ...Object.fromEntries(INDIA.map((r) => [r.slug, r])),
};

/** Alphabetical, for a city picker. */
export const allRegions = (): Region[] =>
  Object.values(REGIONS).sort((a, b) => a.name.en.localeCompare(b.name.en));

export const activeRegions = (): Region[] =>
  Object.values(REGIONS).filter((r) => r.active);

export function getRegion(slug: string): Region {
  const r = REGIONS[slug];
  if (!r) throw new Error(`unknown region: ${slug}`);
  return r;
}

/** Panjika lookup scoped to the region, so a Kolkata user is never offered a Tamil one. */
export function getPanjika(region: Region, id: PanjikaId) {
  return region.panjikas.find((p) => p.id === id);
}

export { kolkata, patna };

/**
 * The almanac we can actually compute for a city.
 *
 * Nothing may hardcode a school. The materialiser did — `'bisuddha_siddhanta'`,
 * which is Kolkata's drik almanac and no other city's — so every other city's
 * panchang was written under a name its own region config never offers, and the
 * read path, which lists schools from that config, reported nothing published. The
 * data was there; it was filed under a label nobody would ever ask for.
 *
 * A drik school is observed planetary positions: the astronomy is identical
 * everywhere and only the name differs. The traditional panjikas are transcribed by
 * hand under ADR 0003 and are never returned here.
 */
export function computableSchool(region: Region): PanjikaId {
  const drik = region.panjikas.find((p) => p.computable);
  if (!drik) {
    // A region offering only hand-entered almanacs cannot be materialised at all,
    // and silently substituting one it does not follow would be worse than failing.
    throw new Error(
      `${region.slug} declares no computable panjika; add a drik school to its config`,
    );
  }
  return drik.id;
}
