'use client';
import { useEffect, useState } from 'react';
import { createTranslator, LANGUAGES, type Locale } from '@themaithil/region';
import { useRegion } from '@/lib/region-context';

const DISMISSED = 'themaithil.langOffer.dismissed';

/**
 * A one-time offer to read the site in the local language.
 *
 * This replaces a permanent language control in the header, and it does the job
 * better. The person who needs to change language is, almost always, someone who
 * has not chosen yet — so the control was paying header space on every screen,
 * forever, for an action almost nobody performs twice. It also competed with the
 * city pill, which is the control a devotee actually uses repeatedly.
 *
 * The substantive improvement is that this speaks FIRST, in the language it is
 * offering, and names it in its own script. A globe icon asks the reader to notice
 * an icon and open a menu; "বাংলায় পড়ুন" asks nothing of someone who reads Bengali
 * and is invisible to someone who does not. A banner in English offering Bengali
 * would have been the same mistake as the icon, one step quieter.
 *
 * It appears at most once. `localeChosen` suppresses it for anyone who has already
 * decided, and dismissal is remembered — this is an offer, not a nag, and a banner
 * that returns is worse than no banner.
 */
export function LanguageOffer() {
  const { region, locale, locales, localeChosen, setLocale } = useRegion();
  const [dismissed, setDismissed] = useState(true);

  // Starts hidden and appears after mount. Reading localStorage during render is a
  // hydration mismatch, and a banner that flashes on every navigation is worse than
  // one that arrives a frame late.
  useEffect(() => {
    try { setDismissed(localStorage.getItem(DISMISSED) === '1'); }
    catch { setDismissed(true); }
  }, []);

  /*
   * What to offer: the region's own first language, if we have it translated and it
   * is not already what they are reading. Derived from region config rather than
   * named here, so a new city offers its own language with no change to this file.
   */
  const offer = region.locales.find(
    (l) => l !== locale && locales.some((a) => a.code === l),
  ) as Locale | undefined;

  if (dismissed || localeChosen || !offer) return null;

  // A translator pinned to the OFFERED language, so the invitation is written in it.
  const t = createTranslator(region, offer);

  return (
    <div className="lang-offer" role="region" aria-label="Language">
      <p lang={offer}>{t('language.readIn')}</p>
      <div className="lang-offer-actions">
        <button
          type="button" className="btn sm" lang={offer}
          onClick={() => { setLocale(offer); dismiss(setDismissed); }}
        >
          {LANGUAGES[offer].native}
        </button>
        <button
          type="button" className="btn ghost sm" lang={offer}
          onClick={() => dismiss(setDismissed)}
        >
          {t('language.notNow')}
        </button>
      </div>
    </div>
  );
}

function dismiss(set: (v: boolean) => void) {
  try { localStorage.setItem(DISMISSED, '1'); } catch { /* private mode */ }
  set(true);
}
