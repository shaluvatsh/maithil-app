import { describe, it, expect } from 'vitest';
import {
  LANGUAGES, ALL_LANGUAGES, languagesFor, isLocale, languageNames,
  TRADITIONS, TRADITION_IDS, traditionNames,
} from '../languages';
import { activeRegions, getRegion } from '../index';

/**
 * A purohit must be able to name the language they actually work in.
 *
 * The onboarding wizard offered six hardcoded English strings — Bengali, Hindi,
 * English, Maithili, Odia, Marwari — which is Bengal's list, not India's. Search
 * matches with an array overlap (`pp.languages && ARRAY[...]`), so a language a
 * purohit cannot record is a filter they can never match: not a ranking penalty,
 * total exclusion, and silent. Eight of the fourteen live cities could not describe
 * their own supply in their own language, and Marwari — which no city declares —
 * was offered to everyone.
 *
 * The rule these tests encode is that the offer is DERIVED from the regions, so
 * adding a city cannot leave a language list behind.
 */
describe('every live city can name its own languages', () => {
  for (const region of activeRegions()) {
    it(`${region.slug} offers all of ${region.locales.join(', ')} first`, () => {
      const offered = languagesFor(region.locales);
      const head = offered.slice(0, region.locales.length).map((l) => l.code);
      expect(head).toEqual([...region.locales]);
    });
  }

  it('has a name for every locale the type allows', () => {
    // Keyed by `Locale`, so this is really asserting the record stays exhaustive
    // as locales are added — the previous list had no such link to anything.
    for (const l of ALL_LANGUAGES) {
      expect(l.en.length, `${l.code} has no English name`).toBeGreaterThan(0);
      expect(l.native.length, `${l.code} has no native name`).toBeGreaterThan(0);
    }
  });

  /** The specific cities the old list shut out. */
  it.each([
    ['chennai', 'ta', 'Tamil'],
    ['bengaluru', 'kn', 'Kannada'],
    ['mumbai', 'mr', 'Marathi'],
    ['ahmedabad', 'gu', 'Gujarati'],
    ['hyderabad', 'te', 'Telugu'],
    ['bhubaneswar', 'or', 'Odia'],
  ])('%s can say %s', (slug, code, name) => {
    const offered = languagesFor(getRegion(slug).locales);
    const hit = offered.find((l) => l.code === code);
    expect(hit, `${slug} cannot record ${name}`).toBeDefined();
    expect(hit!.en).toBe(name);
  });

  /**
   * Not truncated to the city's own locales. A Maithil purohit in Kolkata serves
   * Maithil households in Maithili, and a migrant family in Bengaluru may want their
   * own language rather than Kannada — narrowing the list would recreate the
   * exclusion this replaced, one city smaller.
   */
  it('still offers every language, just ordered', () => {
    for (const region of activeRegions()) {
      expect(languagesFor(region.locales)).toHaveLength(ALL_LANGUAGES.length);
    }
  });

  it('lists each language exactly once', () => {
    for (const region of activeRegions()) {
      const codes = languagesFor(region.locales).map((l) => l.code);
      expect(new Set(codes).size).toBe(codes.length);
    }
  });
});

/**
 * The column held two encodings. `db:seed:dev` writes locale codes; the wizard wrote
 * display names. A devotee filtering for `bn` matched every seeded purohit and no
 * self-registered one, and nothing errored — the two halves of the supply were
 * simply never comparable.
 */
describe('locale codes are the canonical form', () => {
  it('accepts codes and rejects display names', () => {
    expect(isLocale('bn')).toBe(true);
    expect(isLocale('ta')).toBe(true);
    expect(isLocale('Bengali')).toBe(false);
    expect(isLocale('Marwari')).toBe(false);
  });

  it('renders codes for people, so an admin never reads "bn, hi"', () => {
    expect(languageNames(['bn', 'hi'])).toEqual(['Bengali', 'Hindi']);
  });

  /** A legacy row should still show an operator what it says rather than vanishing. */
  it('passes unknown values through untranslated', () => {
    expect(languageNames(['bn', 'Marwari'])).toEqual(['Bengali', 'Marwari']);
    expect(languageNames(null)).toEqual([]);
  });
});

describe('traditions', () => {
  it('covers the south and west, not only Bengal', () => {
    for (const id of ['smarta', 'vaishnava', 'shaiva', 'shakta', 'madhva', 'sri_vaishnava']) {
      expect(TRADITION_IDS).toContain(id);
    }
  });

  it('explains each one, since most devotees do not know the word', () => {
    for (const t of TRADITIONS) expect(t.note.length).toBeGreaterThan(0);
  });

  it('renders ids for people', () => {
    expect(traditionNames(['smarta', 'madhva'])).toEqual(['Smarta', 'Madhva']);
  });

  it('keys the language record by locale', () => {
    expect(Object.keys(LANGUAGES)).toContain('mai');
  });
});
