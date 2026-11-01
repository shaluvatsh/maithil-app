import { describe, it, expect } from 'vitest';
import { allRegions, LANGUAGES, SCRIPT_FOR_LOCALE, scriptsForLocales } from '@themaithil/region';
import { ContentLocale } from '@themaithil/contracts';
import { contentLocaleEnum, localeEnum } from '../db/schema/enums';

/**
 * Three lists must agree about what a language is called — the same lesson
 * `panjika-parity.test.ts` records, applied to the other axis that goes pan-India.
 *
 * The panjika enum drifted and twelve cities declared almanacs the database could
 * not store. Content locale is the identical trap one step later: `packages/region`
 * already names eleven languages across fourteen cities, and a community table typed
 * against a three-value enum would accept Bengali, Hindi and English and reject a
 * Tamil question outright — or, worse, a service would "helpfully" default it to the
 * launch city's language and file a Chennai question as Bengali. Data present,
 * mislabelled, routed to the wrong purohits, and no error at any layer.
 *
 * The UI locale (`locale`) and the content locale are deliberately NOT the same set
 * and must not be merged: one is what we have translated the app into, the other is
 * what people speak. These tests pin both the union and the separation.
 */
const dbValues = new Set<string>(contentLocaleEnum.enumValues);
const contractValues = new Set<string>(ContentLocale.options);
const regionValues = new Set<string>(Object.keys(LANGUAGES));

describe('content locale agrees across region, database and contract', () => {
  it('every language a region declares can be stored', () => {
    for (const region of allRegions()) {
      for (const locale of region.locales) {
        expect(dbValues.has(locale), `${region.slug} speaks ${locale}, which the pg enum lacks`)
          .toBe(true);
      }
    }
  });

  it('every language a region declares can cross the API boundary', () => {
    for (const region of allRegions()) {
      for (const locale of region.locales) {
        expect(
          contractValues.has(locale),
          `${region.slug} speaks ${locale}, which the contracts enum rejects`,
        ).toBe(true);
      }
    }
  });

  it('the database, the contract and packages/region hold exactly the same set', () => {
    expect([...dbValues].sort()).toEqual([...contractValues].sort());
    expect([...dbValues].sort()).toEqual([...regionValues].sort());
  });

  /**
   * The separation, pinned. If someone "simplifies" these into one enum, the UI
   * locale grows nine values the app has no translations for and every language
   * picker starts offering Malayalam.
   */
  it('keeps UI locale and content locale as different sets', () => {
    expect(localeEnum.enumValues.length).toBeLessThan(contentLocaleEnum.enumValues.length);
    for (const ui of localeEnum.enumValues) {
      expect(dbValues.has(ui), `UI locale ${ui} must also be writable as content`).toBe(true);
    }
  });
});

describe('every locale can be rendered', () => {
  it('maps to a script, so a font subset can be chosen per item', () => {
    for (const locale of contentLocaleEnum.enumValues) {
      expect(
        SCRIPT_FOR_LOCALE[locale as keyof typeof SCRIPT_FOR_LOCALE],
        `${locale} has no script, so a feed containing it cannot pick a font`,
      ).toBeTruthy();
    }
  });

  /**
   * The whole reason `scriptsForLocales` exists: a national feed carries several
   * scripts at once, and `region.script` cannot describe it.
   */
  it('derives the distinct scripts of a mixed feed, deduplicated and stable', () => {
    expect(scriptsForLocales(['bn', 'ta', 'hi', 'mr', 'bn'])).toEqual(
      ['bengali', 'devanagari', 'tamil'],
    );
    expect(scriptsForLocales(['hi', 'mr', 'mai'])).toEqual(['devanagari']);
    expect(scriptsForLocales([])).toEqual([]);
  });

  it('ignores anything that is not a locale rather than throwing', () => {
    expect(scriptsForLocales(['bn', 'klingon'])).toEqual(['bengali']);
  });
});
