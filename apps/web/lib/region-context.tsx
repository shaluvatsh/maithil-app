'use client';
import {
  createContext, useContext, useEffect, useMemo, useState, type ReactNode,
} from 'react';
import {
  getRegion, allRegions, createTranslator, formatMoney, formatTime, formatDate,
  formatEraDate, toLocalNumerals, slotLabel,
  type Region, type Locale, type Translator,
} from '@themaithil/region';

const KEY = 'themaithil.city';
export const DEFAULT_CITY = process.env.NEXT_PUBLIC_REGION ?? 'kolkata';

interface Ctx {
  region: Region;
  regions: Region[];
  /** Null until the user has chosen — the header shows "Select your city". */
  chosen: boolean;
  setCity: (slug: string) => void;
  locale: Locale;
  t: Translator;
  money: (paise: number, opts?: { numerals?: boolean }) => string;
  time: (iso: string) => string;
  date: (isoDate: string) => string;
  eraDate: (isoDate: string) => string | null;
  numerals: (v: string | number) => string;
  slotLabel: (idx: number) => string;
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

  useEffect(() => {
    const saved = localStorage.getItem(KEY);
    if (saved) {
      try { getRegion(saved); setSlug(saved); setChosen(true); } catch { /* stale slug */ }
    }
  }, []);

  const value = useMemo<Ctx>(() => {
    const region = getRegion(slug);
    const locale = region.locales[0]!;
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
      t: createTranslator(region, locale),
      money: (paise, opts) => formatMoney(paise, region, opts ?? {}),
      time: (iso) => formatTime(iso, region),
      date: (isoDate) => formatDate(isoDate, region),
      eraDate: (isoDate) => formatEraDate(isoDate, region),
      numerals: (v) => toLocalNumerals(v, region.numerals),
      slotLabel: (idx) => slotLabel(region, idx),
    };
  }, [slug, chosen]);

  return <RegionCtx.Provider value={value}>{children}</RegionCtx.Provider>;
}

export function useRegion(): Ctx {
  const ctx = useContext(RegionCtx);
  if (!ctx) throw new Error('useRegion must be used inside <RegionProvider>');
  return ctx;
}
