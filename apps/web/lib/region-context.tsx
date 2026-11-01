'use client';
import {
  createContext, useContext, useEffect, useMemo, useState, type ReactNode,
} from 'react';
import { DEFAULT_CITY } from './default-city';
import {
  getRegion, allRegions, createTranslator, formatMoney, formatTime, formatDate,
  formatEraDate, formatDateTime, formatMonth, relativeDay, toLocalNumerals,
  slotLabel, timeRange,
  availableLocales, isLocale, DEFAULT_LOCALE, NUMERALS_FOR_LOCALE, LANGUAGES,
  type Region, type Locale, type Translator,
} from '@themaithil/region';

const KEY = 'themaithil.city';
/**
 * The reader's language, kept separately from their city.
 *
 * Two preferences, because they are two different facts: where the ceremony happens
 * and what the reader reads. Someone in Bengaluru may want Bengali; someone in
 * Kolkata may want English. Storing one and inferring the other is what made the
 * app open in Bengali for people who had never asked for it.
 */
const LOCALE_KEY = 'themaithil.locale';
/*
 * From `lib/default-city`, which owns it. It was declared here AND in the ritual
 * page, each with its own `?? 'kolkata'` fallback — two copies of one default, and
 * the shape of bug that gets changed in only one of them.
 *
 * Imported and re-exported rather than `export … from`, because the provider below
 * uses it as its initial state and a bare re-export does not bind it locally.
 */
export { DEFAULT_CITY };

interface Ctx {
  region: Region;
  regions: Region[];
  /** Null until the user has chosen — the header shows "Select your city". */
  chosen: boolean;
  setCity: (slug: string) => void;
  locale: Locale;
  /** Languages the product is translated into, this region's first. */
  locales: { code: Locale; native: string; en: string }[];
  setLocale: (next: Locale) => void;
  /** True once the reader has chosen, so the picker can prompt rather than assume. */
  localeChosen: boolean;
  t: Translator;
  money: (paise: number, opts?: { numerals?: boolean }) => string;
  time: (iso: string) => string;
  date: (isoDate: string) => string;
  /** A timestamp — date AND clock time — in the region's zone, never the browser's. */
  dateTime: (iso: string) => string;
  /** `YYYY-MM` → "October 2026", for a heading over a month of history. */
  month: (yyyyMm: string) => string;
  /** "today" / "tomorrow" / "in 6 days", or null when a plain date reads better. */
  relativeDay: (isoDate: string) => string | null;
  eraDate: (isoDate: string) => string | null;
  numerals: (v: string | number) => string;
  slotLabel: (idx: number) => string;
  /** The window a booking actually occupies, from its own instants. */
  timeRange: (startIso: string, endIso: string) => string;
}

const RegionCtx = createContext<Ctx | null>(null);

/**
 * City selection lives on the client and persists.
 *
 * Pan-India means every region is live at once and the user picks — so the region is
 * runtime state, not a build-time constant. Content, panchang, slot shape, language
 * and pricing all follow from it.
 */
export function RegionProvider({ children }: { children: ReactNode }) {
  const [slug, setSlug] = useState<string>(DEFAULT_CITY);
  const [chosen, setChosen] = useState(false);
  /*
   * ENGLISH until the reader says otherwise, in every city (ADR 0017).
   *
   * Starting from the stored value would differ between the server render and the
   * first client render, so this opens on the default and adopts the preference in
   * the effect below — the same shape the city uses, and for the same reason.
   */
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);
  const [localeChosen, setLocaleChosen] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem(KEY);
    if (saved) {
      try { getRegion(saved); setSlug(saved); setChosen(true); } catch { /* stale slug */ }
    }
    const savedLocale = localStorage.getItem(LOCALE_KEY);
    if (savedLocale && isLocale(savedLocale)) {
      setLocaleState(savedLocale);
      setLocaleChosen(true);
    }
  }, []);

  const value = useMemo<Ctx>(() => {
    const region = getRegion(slug);
    return {
      region,
      regions: allRegions().filter((r) => r.active),
      chosen,
      setCity: (next: string) => {
        getRegion(next);
        localStorage.setItem(KEY, next);
        setSlug(next);
        setChosen(true);
      },
      locale,
      locales: availableLocales(region).map((code) => ({
        code, native: LANGUAGES[code].native, en: LANGUAGES[code].en,
      })),
      setLocale: (next: Locale) => {
        localStorage.setItem(LOCALE_KEY, next);
        setLocaleState(next);
        setLocaleChosen(true);
      },
      localeChosen,
      t: createTranslator(region, locale),
      money: (paise, opts) => formatMoney(paise, region, opts ?? {}),
      time: (iso) => formatTime(iso, region),
      date: (isoDate) => formatDate(isoDate, region),
      dateTime: (iso) => formatDateTime(iso, region),
      month: (yyyyMm) => formatMonth(yyyyMm, region),
      relativeDay: (isoDate) => relativeDay(isoDate, region),
      eraDate: (isoDate) => formatEraDate(isoDate, region),
      /*
       * Digits follow the LANGUAGE, not the city.
       *
       * With the app in English in Kolkata a count is "84", not "৮৪" — the region
       * has not changed, the language has. Switch to Bengali in Bengaluru and it is
       * ৮৪ there. `region.numerals` remains the city default for anything formatted
       * without a reader present.
       */
      numerals: (v) => toLocalNumerals(v, NUMERALS_FOR_LOCALE[locale] ?? region.numerals),
      slotLabel: (idx) => slotLabel(region, idx),
      timeRange: (a, b) => timeRange(a, b, region),
    };
  }, [slug, chosen, locale, localeChosen]);

  return <RegionCtx.Provider value={value}>{children}</RegionCtx.Provider>;
}

export function useRegion(): Ctx {
  const ctx = useContext(RegionCtx);
  if (!ctx) throw new Error('useRegion must be used inside <RegionProvider>');
  return ctx;
}
