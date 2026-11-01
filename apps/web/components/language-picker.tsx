'use client';
import { useEffect, useRef, useState } from 'react';
import { useRegion } from '@/lib/region-context';

/**
 * The language switcher, and the permanent home of the choice.
 *
 * It lived in the header first, on the argument that English-by-default (ADR 0017)
 * is only defensible if changing it is one tap away. That was the right concern and
 * the wrong control: almost nobody changes language twice, so it was paying header
 * space on every screen forever for a once-per-lifetime action, and on a phone it
 * collapsed to a bare globe competing with the city pill — the control devotees
 * actually use repeatedly.
 *
 * The concern is now answered by `LanguageOffer`, which speaks once, in the language
 * it is offering. This stays as the place the choice lives afterwards: in the
 * footer, where a language control conventionally is, reachable from every page and
 * costing nothing on any of them.
 *
 * Every option is written in its OWN script — বাংলা, हिन्दी — never "Bengali" in
 * Latin. Someone who needs this control is, by definition, someone for whom the
 * English label is the harder one to read, and a picker that lists languages in the
 * language you are trying to leave is the most common way this control fails.
 */
export function LanguagePicker() {
  const { locale, locales, setLocale } = useRegion();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  // One translated language is not a choice; render nothing rather than a control
  // that cannot do anything.
  if (locales.length < 2) return null;

  const current = locales.find((l) => l.code === locale) ?? locales[0]!;

  return (
    /*
     * `up` because this sits at the very bottom of the page: a menu that opened
     * downward would render below the fold and be scrolled to, which on a phone
     * looks like a control that did nothing.
     */
    <div className="lang-wrap up" ref={ref}>
      <button
        type="button"
        className="lang-pill"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Language: ${current.en}`}
        onClick={() => setOpen((v) => !v)}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="2" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" />
        </svg>
        <span className="lang-name" lang={current.code}>{current.native}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="3" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
      </button>

      {open && (
        <ul className="lang-menu" role="listbox" aria-label="Choose a language">
          {locales.map((l) => (
            <li key={l.code}>
              <button
                type="button"
                role="option"
                aria-selected={l.code === locale}
                className={`lang-opt${l.code === locale ? ' on' : ''}`}
                onClick={() => { setLocale(l.code); setOpen(false); }}
              >
                {/* Native first and larger — that is the label being scanned for. */}
                <span className="lang-native" lang={l.code}>{l.native}</span>
                {/* The English gloss is there to help someone who cannot read the
                    native script identify the row. For English itself the two are
                    the same string, and rendering both gives "English English". */}
                {l.en !== l.native && <span className="lang-en muted">{l.en}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
