'use client';
import { useEffect, useMemo, useRef, useState, useId } from 'react';
import { useRouter } from 'next/navigation';

/**
 * The home page search.
 *
 * It used to be a text box that pushed `/book?q=<string>` and hoped. Typing
 * "housewarming" returned nothing, because the catalogue calls it Griha Prabesh —
 * so the one control most likely to be used first was also the one most likely to
 * dead-end. The catalogue is already fetched for the cards below, so matching
 * against it costs nothing and turns the box into navigation: you pick a real
 * service and land on it.
 *
 * Submitting free text still falls through to `/book?q=`, which is the honest
 * behaviour when nothing matched — the browse page can say so with the full
 * catalogue in front of it.
 */
export interface Searchable {
  slug: string;
  name: string;
  /** Alternative names people actually type. Matched, never displayed. */
  aliases?: readonly string[];
  hint?: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim();

/** Ranked so a name that starts with the query beats one that merely contains it. */
export function matchServices<T extends Searchable>(
  items: readonly T[], query: string, limit = 6,
): T[] {
  const q = norm(query);
  if (q.length < 2) return [];
  const scored: Array<{ item: T; score: number }> = [];

  for (const item of items) {
    const fields = [item.name, ...(item.aliases ?? [])].map(norm);
    let best = 0;
    for (const f of fields) {
      if (f.startsWith(q)) best = Math.max(best, 3);
      else if (f.split(' ').some((w) => w.startsWith(q))) best = Math.max(best, 2);
      else if (f.includes(q)) best = Math.max(best, 1);
    }
    if (best > 0) scored.push({ item, score: best });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.item.name.length - b.item.name.length)
    .slice(0, limit)
    .map((s) => s.item);
}

export function HeroSearch({
  services, variant = 'hero',
}: {
  services: readonly Searchable[];
  /**
   * `nav` is the compact form that lives in the header.
   *
   * Moved there because that is where people now look for it — every marketplace
   * in this category puts search in the top bar, so a hero-only search box means a
   * devotee on the catalogue page has nowhere to type at all. Same component, same
   * matching, same keyboard handling; only the chrome differs.
   */
  variant?: 'hero' | 'nav';
}) {
  const router = useRouter();
  const listId = useId();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  const results = useMemo(() => matchServices(services, q), [services, q]);

  // Clicking anywhere else dismisses the list. Without this the suggestions sat
  // over the categories below and swallowed the first click on them.
  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, []);

  useEffect(() => { setActive(0); }, [q]);

  const go = (slug?: string) => {
    setOpen(false);
    router.push(slug ? `/pooja/${slug}` : `/book${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open || results.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (i + 1) % results.length); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i - 1 + results.length) % results.length); }
    if (e.key === 'Escape') setOpen(false);
    if (e.key === 'Enter' && results[active]) { e.preventDefault(); go(results[active]!.slug); }
  };

  return (
    <div className={variant === 'nav' ? 'searchwrap nav-search' : 'searchwrap'} ref={box}>
      <form
        className="searchbar"
        role="search"
        onSubmit={(e) => { e.preventDefault(); go(); }}
      >
        <span className="searchbar-icon" aria-hidden>🔍</span>
        <input
          type="search"
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={variant === 'nav'
            ? 'Search for a pooja'
            : 'Search poojas, ceremonies, festivals…'}
          aria-label="Search poojas, ceremonies and festivals"
          role="combobox"
          aria-expanded={open && results.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && results[active] ? `${listId}-${active}` : undefined}
        />
        {/* The header has no room for a labelled button; the field is wide enough
            to be obviously a search, and Enter submits. */}
        {variant === 'hero' && <button className="btn" type="submit">Search</button>}
      </form>

      {open && results.length > 0 && (
        <ul className="suggest" id={listId} role="listbox" aria-label="Matching services">
          {results.map((r, i) => (
            <li key={r.slug} id={`${listId}-${i}`} role="option" aria-selected={i === active}>
              <button
                type="button"
                className={`suggest-item${i === active ? ' on' : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => go(r.slug)}
              >
                <span className="s-name">{r.name}</span>
                {r.hint && <span className="s-hint">{r.hint}</span>}
              </button>
            </li>
          ))}
          <li>
            <button type="button" className="suggest-all" onClick={() => go()}>
              Browse all services for “{q}” ›
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}
