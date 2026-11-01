import type { Locale, Region } from '../types';
import { en, type Dictionary, type MessageKey } from './keys';
import { bn } from './bn';
import { hi } from './hi';

export type { MessageKey, Dictionary };
export { en };

const DICTIONARIES: Partial<Record<Locale, Dictionary>> = { en, bn, hi };

/**
 * The language the product speaks until someone tells it otherwise. ENGLISH,
 * everywhere, including the launch city.
 *
 * This reverses the original Bengali-first default, and the reasoning is about who
 * actually arrives rather than about what Kolkata speaks. A city's `locales` list
 * says which languages are spoken there; it does not say which one a given visitor
 * reads most comfortably. Kolkata contains Bengali, Hindi, English, Maithili and
 * Odia households, a large migrant population, and people who speak Bengali fluently
 * but read English faster because that is the script they were schooled in. Opening
 * in Bengali served the first group and quietly taxed everyone else, and it did so
 * on first paint — before a devotee had any way to say otherwise.
 *
 * English is the one language that is legible to some degree across all fourteen
 * cities, which makes it the right DEFAULT — not the right language. The preference
 * is one tap away, it persists, and it is offered in the reader's own script.
 *
 * `region.locales` is untouched and still means what it meant: the languages a city
 * speaks. It orders the language picker and drives purohit language lists and search
 * filters. It no longer decides what the interface opens in. See ADR 0017.
 */
export const DEFAULT_LOCALE: Locale = 'en';

/**
 * Resolves a string through the region's locale preference order, falling back to
 * English last. Returning the English string rather than the raw key means a missing
 * translation degrades to something readable instead of shipping `bill.dakshina` to a
 * devotee - which is how most Indian apps leak untranslated keys into production.
 */
export function createTranslator(region: Region, preferred?: Locale) {
  const chain: Locale[] = [
    ...(preferred ? [preferred] : []),
    ...region.locales,
    'en' as Locale,
  ].filter((v, i, a) => a.indexOf(v) === i);

  return function t(key: MessageKey, vars?: Record<string, string | number>): string {
    let out: string | undefined;
    for (const locale of chain) {
      out = DICTIONARIES[locale]?.[key];
      if (out) break;
    }
    out ??= en[key] ?? key;
    return vars
      ? out.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(vars[k] ?? `{{${k}}}`))
      : out;
  };
}

export type Translator = ReturnType<typeof createTranslator>;

/**
 * What the language picker offers: every locale the product is actually translated
 * into, with the region's own languages first.
 *
 * NOT filtered down to the region's locales, and that is the point. This used to
 * return `region.locales` intersected with the dictionaries, which gave Chennai a
 * picker containing English and nothing else — so a Bengali family living in Chennai
 * had no way to read the app in Bengali, although the translation exists and they
 * are exactly the household most helped by it. People move; a city's language list
 * describes the city, not the visitor.
 *
 * Region-first ordering keeps the common case at the top without excluding anyone.
 */
export const availableLocales = (region?: Region): Locale[] => {
  const translated = (Object.keys(DICTIONARIES) as Locale[])
    .filter((l) => DICTIONARIES[l] !== undefined);
  if (!region) return translated;
  const local = region.locales.filter((l) => translated.includes(l));
  return [...local, ...translated.filter((l) => !local.includes(l))];
};
