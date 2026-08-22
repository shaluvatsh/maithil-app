import type { Locale, Region } from '../types';
import { en, type Dictionary, type MessageKey } from './keys';
import { bn } from './bn';
import { hi } from './hi';

export type { MessageKey, Dictionary };
export { en };

const DICTIONARIES: Partial<Record<Locale, Dictionary>> = { en, bn, hi };

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

/** Locales a region actually ships, for a language switcher. */
export const availableLocales = (region: Region): Locale[] =>
  region.locales.filter((l) => DICTIONARIES[l] !== undefined);
