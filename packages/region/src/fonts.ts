import type { Script } from './types';

/**
 * Per-script font loading.
 *
 * The single biggest performance decision in a pan-India product: Indic webfonts are
 * large, and shipping every script to every user would add hundreds of kilobytes of
 * blocking font data to each page. A Bengaluru user must never download a Bengali
 * face, and vice versa.
 *
 * Latin faces are constant across regions because the brand is constant. Only the
 * Indic pair swaps.
 */
export interface FontPlan {
  /** Google Fonts family specs, already weight-scoped. */
  families: string[];
  /** CSS custom property values the token layer reads. */
  vars: { display: string; ui: string };
  /**
   * Indic glyphs are optically smaller than Latin at the same point size. Without
   * this the two scripts look like different weights side by side, which is the tell
   * that a site was designed in English and translated afterwards.
   */
  opticalScale: number;
}

const LATIN = ['Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600', 'Inter:wght@400;500;600'];

const INDIC: Record<Exclude<Script, 'latin'>, Omit<FontPlan, 'families'> & { families: string[] }> = {
  bengali: {
    families: ['Noto+Serif+Bengali:wght@500;600', 'Anek+Bangla:wght@400;500;600'],
    vars: { display: "'Noto Serif Bengali', serif", ui: "'Anek Bangla', sans-serif" },
    opticalScale: 1.08,
  },
  devanagari: {
    families: ['Noto+Serif+Devanagari:wght@500;600', 'Mukta:wght@400;500;600'],
    vars: { display: "'Noto Serif Devanagari', serif", ui: "'Mukta', sans-serif" },
    opticalScale: 1.05,
  },
  tamil: {
    families: ['Noto+Serif+Tamil:wght@500;600', 'Anek+Tamil:wght@400;500;600'],
    vars: { display: "'Noto Serif Tamil', serif", ui: "'Anek Tamil', sans-serif" },
    opticalScale: 1.12,
  },
  telugu: {
    families: ['Noto+Serif+Telugu:wght@500;600', 'Anek+Telugu:wght@400;500;600'],
    vars: { display: "'Noto Serif Telugu', serif", ui: "'Anek Telugu', sans-serif" },
    opticalScale: 1.10,
  },
  kannada: {
    families: ['Noto+Serif+Kannada:wght@500;600', 'Anek+Kannada:wght@400;500;600'],
    vars: { display: "'Noto Serif Kannada', serif", ui: "'Anek Kannada', sans-serif" },
    opticalScale: 1.10,
  },
  malayalam: {
    families: ['Noto+Serif+Malayalam:wght@500;600', 'Anek+Malayalam:wght@400;500;600'],
    vars: { display: "'Noto Serif Malayalam', serif", ui: "'Anek Malayalam', sans-serif" },
    opticalScale: 1.10,
  },
  gujarati: {
    families: ['Noto+Serif+Gujarati:wght@500;600', 'Anek+Gujarati:wght@400;500;600'],
    vars: { display: "'Noto Serif Gujarati', serif", ui: "'Anek Gujarati', sans-serif" },
    opticalScale: 1.06,
  },
  odia: {
    families: ['Noto+Serif+Oriya:wght@500;600', 'Anek+Odia:wght@400;500;600'],
    vars: { display: "'Noto Serif Oriya', serif", ui: "'Anek Odia', sans-serif" },
    opticalScale: 1.08,
  },
};

export function fontPlan(script: Script): FontPlan {
  if (script === 'latin') {
    return {
      families: LATIN,
      vars: { display: "'Fraunces', Georgia, serif", ui: "'Inter', sans-serif" },
      opticalScale: 1,
    };
  }
  const indic = INDIC[script];
  return { ...indic, families: [...LATIN, ...indic.families] };
}

/** `display=swap` so text is readable before the Indic face lands. */
export const fontHref = (script: Script): string =>
  `https://fonts.googleapis.com/css2?${fontPlan(script).families
    .map((f) => `family=${f}`).join('&')}&display=swap`;
