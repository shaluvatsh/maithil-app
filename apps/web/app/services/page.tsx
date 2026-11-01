import Link from 'next/link';
import type { Metadata } from 'next';
import { RITUAL_CATEGORIES } from '@themaithil/region';
import { getRituals } from '@/lib/server-api';

/**
 * The category hub.
 *
 * "See all" beneath the category tiles pointed at `/book?browse=1` — the booking
 * flow with a filter cleared. That is not "all categories", it is step one of a
 * checkout, and it drops every visitor who wanted to look before committing into a
 * form. This is the page that link was always implying: the whole catalogue laid
 * out under the five reasons a household books, with prices, readable without an
 * account and without starting anything.
 *
 * Server-rendered for the same reason `/pooja/[slug]` is: this is the page a search
 * engine should find when someone looks for "pandit for griha pravesh in Kolkata",
 * and a client-only page hands the crawler an empty shell.
 */
export const revalidate = 3600;

const DEFAULT_CITY = process.env.NEXT_PUBLIC_REGION ?? 'kolkata';

export const metadata: Metadata = {
  title: 'All pooja services — TheMaithil',
  description:
    'Every ritual we perform, grouped by occasion: life ceremonies, home and new '
    + 'beginnings, festival pujas, ancestral rites, remedies and online services.',
};

const rupees = (paise: number) =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 0,
  }).format(paise / 100);

export default async function ServicesPage() {
  const rituals = (await getRituals(DEFAULT_CITY)) ?? [];

  const grouped = RITUAL_CATEGORIES
    .map((c) => ({ category: c, items: rituals.filter((r) => r.category === c.id) }))
    // A category with nothing in it is a promise the catalogue cannot keep.
    .filter((g) => g.items.length > 0);

  const totalCount = grouped.reduce((n, g) => n + g.items.length, 0);

  return (
    <div className="wrap hub">
      {/*
        Rebuilt as a catalogue, not a directory.

        The first version was a page of grey rows: a name, a description, a delivery
        mode and a price laid out as four columns that became four unstyled lines on
        anything narrow, under a heading with a button floating beside it. Nothing
        carried the colour, the tiles or the card shape the rest of the site uses, so
        arriving here from the home page felt like leaving the product. It also
        opened cold — a wall of thirty rows with no sense of how much there was.
      */}
      <header className="hub-head">
        <span className="kicker-pill">Full catalogue</span>
        <h1>Every pooja we perform</h1>
        <p className="lede muted">
          {totalCount} rituals across {grouped.length} kinds of occasion, grouped by
          the reason families book them. Every price includes the purohit&apos;s
          dakshina and the standard samagri kit — itemised before you pay.
        </p>
        <nav className="hub-jump" aria-label="Jump to a category">
          {grouped.map(({ category: c, items }) => (
            <a key={c.id} href={`#${c.id}`} className="jump-pill">
              <img className="jp-tile" src={`/images/categories/${c.id}.jpg`} alt="" aria-hidden />
              {c.en}
              <span className="n">{items.length}</span>
            </a>
          ))}
        </nav>
      </header>

      {grouped.map(({ category: c, items }) => (
        <section key={c.id} id={c.id} className="hub-group">
          <div className="hub-group-head">
            <img className="hub-tile" src={`/images/categories/${c.id}.jpg`} alt="" aria-hidden />
            <div>
              <h2>{c.en}</h2>
              <p className="muted">{c.blurb}</p>
            </div>
            <Link href={`/book?category=${c.id}`} className="btn outline">
              Book from this group
            </Link>
          </div>

          {/*
            Cards, matching the home page's shelves rather than a price list. A
            coloured rule per group carries the category's own tint down the page,
            so the grouping stays legible once you have scrolled past the heading.
          */}
          <ul className="hub-grid" style={{ ['--group-tint' as string]: c.tint }}>
            {items.map((r) => (
              <li key={r.slug}>
                <Link href={`/pooja/${r.slug}`} className="hub-card">
                  <span className="hc-top">
                    <span className="hc-name">{r.name}</span>
                    <span className={`hc-mode${r.deliveryMode === 'virtual' ? ' online' : ''}`}>
                      {r.deliveryMode === 'virtual' ? 'Online' : 'At home'}
                    </span>
                  </span>
                  <span className="hc-desc">{r.shortDescription}</span>
                  <span className="hc-foot">
                    <span className="hc-price">
                      from <strong>{rupees(r.priceBand.minPaise)}</strong>
                    </span>
                    <span className="hc-dur">
                      {r.durationMin >= 60
                        ? `${Math.round(r.durationMin / 60)} hr`
                        : `${r.durationMin} min`}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {/* Same split as the home page's category error: the devotee gets a way
          forward, the migrate command goes to whoever can run it. */}
      {grouped.length === 0 && (
        <div className="notice err" role="alert">
          <strong>The catalogue could not be loaded.</strong>{' '}
          Please refresh in a moment — or{' '}
          <Link href="/contact">tell us what you need</Link> and we will book it for you.
          {process.env.NODE_ENV !== 'production' && (
            <div className="muted" style={{ fontSize: '.88rem', marginTop: 6 }}>
              Usually a pending migration. Run{' '}
              <code>pnpm db:migrate &amp;&amp; pnpm db:seed</code>, then refresh.
            </div>
          )}
        </div>
      )}

      <section className="hub-foot">
        <h2>Not sure which one you need?</h2>
        <p className="muted">
          Tell us the occasion and we&apos;ll suggest the rituals that usually go
          with it — you do not need to know the name.
        </p>
        <Link href="/book" className="btn">Start from the occasion</Link>
      </section>
    </div>
  );
}
