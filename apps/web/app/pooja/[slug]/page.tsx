import Link from 'next/link';
import type { Metadata } from 'next';
import { REGIONS, activeRegions, getCategory, formatMoney } from '@themaithil/region';
import { DEFAULT_CITY } from '@/lib/default-city';
import { computePrice } from '@themaithil/contracts';
import {
  getRitual, getRituals, getKnowledge, type BomLine,
} from '@/lib/server-api';
import { GUIDES_ON_RITUAL_PAGE } from '@themaithil/contracts';
import { ritualImageVariants, ritualImagePath } from '@/lib/ritual-images';

/**
 * The service detail page — and the first server-rendered page in the app.
 *
 * "Learn More" and "Book Now" both pointed at `/book`, so the two buttons on every
 * card did exactly the same thing and neither carried which ritual you clicked.
 * This is the page Learn More was always implying.
 *
 * It is also the fix for the largest strategic gap in docs/ARCHITECTURE.md: every
 * competitor in this category acquires demand through per-city, per-ritual landing
 * pages, and until now Google received an empty shell from this app.
 */

export const revalidate = 3600;
/** A ritual added between builds should still resolve, not 404. */
export const dynamicParams = true;

/**
 * Money, through the region's own formatter.
 *
 * This built its own `Intl.NumberFormat('en-IN', … 'INR')`, which is a second copy of
 * a decision `packages/region/src/format.ts` already owns — and a hardcoded locale
 * and currency on the one page a crawler reads, in a product that is meant to be
 * pan-India. `formatMoney` takes the region, so a market with different conventions
 * needs no change here.
 */
const region = REGIONS[DEFAULT_CITY];
const rupees = (paise: number) =>
  (region ? formatMoney(paise, region) : `${Math.round(paise / 100)}`);

const hours = (min: number) => {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m} minutes`;
  return m === 0 ? `${h} ${h === 1 ? 'hour' : 'hours'}` : `${h} hr ${m} min`;
};

/**
 * Pre-renders the launch city's catalogue. Deliberately not every city × ritual:
 * 14 × 28 is 392 pages, most for cities with no purohits yet, and `dynamicParams`
 * renders the rest on demand and caches them.
 */
export async function generateStaticParams() {
  const rituals = await getRituals(DEFAULT_CITY);
  return (rituals ?? []).map((r) => ({ slug: r.slug }));
}

export async function generateMetadata(
  { params }: { params: Promise<{ slug: string }> },
): Promise<Metadata> {
  const { slug } = await params;
  // Next dedupes this against the identical call in the page component below —
  // same URL, same revalidate window — so this costs nothing extra over what
  // the page itself already fetches.
  const [r, rituals] = await Promise.all([
    getRitual(slug, DEFAULT_CITY),
    getRituals(DEFAULT_CITY),
  ]);
  const city = REGIONS[DEFAULT_CITY]?.name.en ?? 'India';
  if (!r) return { title: 'Pooja — TheMaithil' };

  const title = `${r.name} at home in ${city} — book a verified pandit | TheMaithil`;
  const description =
    `${r.shortDescription}. ${hours(r.durationMin)}, from ${rupees(r.priceBand.minPaise)}. `
    + 'Pick a real time slot with a named pandit — no waiting to be allocated.';
  const image = ritualImagePath(r, ritualImageVariants(rituals ?? []));

  return {
    title,
    description,
    alternates: { canonical: `/pooja/${r.slug}` },
    openGraph: { title, description, type: 'website', images: [{ url: image }] },
  };
}

export default async function PoojaPage(
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  // Deduped against generateMetadata's identical calls above — one real fetch
  // for both, via Next's request cache.
  const [ritual, rituals, guideRes] = await Promise.all([
    getRitual(slug, DEFAULT_CITY),
    getRituals(DEFAULT_CITY),
    // Fetched alongside, not after: a guide is part of this page, and a second
    // round trip would put it below the fold on a slow connection.
    getKnowledge({
      ritualSlug: slug, type: 'ritual_guide', limit: GUIDES_ON_RITUAL_PAGE,
    }),
  ]);
  const guides = guideRes.items;
  const city = REGIONS[DEFAULT_CITY];

  if (!ritual) {
    return (
      <div className="wrap" style={{ padding: '60px 20px 90px', maxWidth: 720 }}>
        <h1>We could not load this service</h1>
        <p className="sub">
          It may have been renamed, or the catalogue is briefly unavailable.
        </p>
        <Link href="/book" className="btn">Browse all services</Link>
      </div>
    );
  }

  const virtual = ritual.deliveryMode === 'virtual';
  const category = getCategory(ritual.category);
  const image = ritualImagePath(ritual, ritualImageVariants(rituals ?? []));
  const samagri = ritual.bom.reduce(
    (sum: number, b: BomLine) => sum + b.linePricePaise, 0,
  );

  /*
   * The same `computePrice` the API bills from, not a third approximation of it.
   *
   * This comment used to read "priced the way the bill is actually assembled, so
   * the page cannot promise a number the booking flow then contradicts" — above
   * `Math.round((dakshina + samagri + sourcing) * 0.15)`, which charges the 15%
   * commission on the samagri. The engine does not: commission is taken on the
   * service only, because samagri is passed through to the purohit in full. So
   * this page quoted ₹3,150 for a Satyanarayan Puja the checkout then billed at
   * ₹2,964 — a page whose entire argument is "we itemise, they quote a package"
   * disagreeing with its own itemisation.
   *
   * A virtual ritual carries no samagri and settles online, which is also what
   * the booking flow derives, so the two now agree on that too.
   */
  const dakshina = ritual.priceBand.defaultPaise;
  const quote = computePrice({
    dakshinaBasePaise: dakshina as never,
    bomTotalPaise: samagri as never,
    // Unknowable here: no address has been chosen, so there is no distance to
    // price. The figure is honest about being a floor — see the caption below it.
    travelFeePaise: 0 as never,
    surgeBps: 10_000,
    samagriOption: virtual ? 'none' : 'pandit_brings',
    paymentMode: virtual ? 'digital_full' : 'cash',
  });
  const indicative = quote.totalPaise;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Service',
    name: ritual.name,
    description: ritual.shortDescription,
    serviceType: category?.en ?? 'Puja',
    areaServed: { '@type': 'City', name: city?.name.en ?? 'India' },
    provider: { '@type': 'Organization', name: 'TheMaithil' },
    offers: {
      '@type': 'Offer',
      // From the region, not a literal: schema.org wants an ISO 4217 code and the
      // region already declares which one this market uses.
      priceCurrency: region?.currency ?? 'INR', // no-hardcode: ISO fallback for schema.org
      lowPrice: (ritual.priceBand.minPaise / 100).toFixed(0),
      highPrice: (ritual.priceBand.maxPaise / 100).toFixed(0),
      availability: 'https://schema.org/InStock',
    },
  };

  return (
    <>
      <script type="application/ld+json"
              dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />

      <div className="wrap pooja">
        <nav className="crumbs" aria-label="Breadcrumb">
          <Link href="/">Home</Link>
          <span aria-hidden="true">›</span>
          <Link href={`/book?category=${ritual.category}`}>{category?.en ?? 'Services'}</Link>
          <span aria-hidden="true">›</span>
          <span aria-current="page">{ritual.name}</span>
        </nav>

        <div className="pooja-grid">
          <article>
            <header className="pooja-head">
              <div className="pooja-photo">
                <img src={image} alt={ritual.name} />
              </div>
              <div className="chips">
                {category && <span className="chip">{category.en}</span>}
                <span className={`chip ${virtual ? 'blue' : ''}`}>
                  {virtual ? '💻 Online' : '📍 At your home'}
                </span>
                {ritual.isMuhuratSensitive && <span className="chip">Muhurat-sensitive</span>}
              </div>
              <h1>{ritual.name}</h1>
              <p className="sub">{ritual.shortDescription}</p>
              <div className="facts">
                <span>⏱ {hours(ritual.durationMin)}</span>
                <span>{virtual ? '🎥 By video call' : '🧑‍🦱 Pandit comes to you'}</span>
                <span>🗓 In {city?.name.en ?? 'your city'}</span>
              </div>
            </header>

            <section className="pooja-sec">
              <h2>What&apos;s included</h2>
              <ul className="ticks">
                <li>A verified pandit who performs your family&apos;s vidhi</li>
                <li>
                  {virtual
                    ? 'A private video session at the time you book'
                    : 'Travel to your address within the city'}
                </li>
                {!virtual && ritual.bom.length > 0 && (
                  <li>All pooja materials, itemised at catalogue rates</li>
                )}
                <li>A fixed cash amount agreed up front, so nothing is negotiated on the day</li>
                <li>Full refund if the pandit cancels, whatever the notice</li>
              </ul>
            </section>

            {ritual.bom.length > 0 && (
              <section className="pooja-sec">
                <h2>Materials</h2>
                <p className="muted">
                  Every competitor quotes one package number. This is the actual list,
                  at the price we pay, plus a 5% sourcing line — you can also arrange
                  it yourself and pay nothing here.
                </p>
                {/*
                  A long ceremony's samagri kit runs 15-20 lines - open by default
                  that pushed How booking works and the FAQs a full page down for
                  exactly the rituals where a devotee most needs to see them. Same
                  `<details>` pattern as Common questions below: closed by default,
                  the count and total stand in for the list until it is opened, and
                  the full itemised table stays real HTML - still what a search
                  engine reads and still the trust point the paragraph above makes,
                  just not forced on every visitor by default.
                */}
                <details className="bom-details">
                  <summary>
                    {ritual.bom.length} item{ritual.bom.length === 1 ? '' : 's'}, itemised
                    · {rupees(samagri)} total
                  </summary>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        {/* "Rate" would imply a unit price the number is not. */}
                        <tr><th>Item</th><th>Quantity</th><th className="num">Cost</th></tr>
                      </thead>
                      <tbody>
                        {ritual.bom.map((b: BomLine) => (
                          <tr key={b.id}>
                            <td>{b.name}{b.perishable && <span className="tag" style={{ marginLeft: 8 }}>fresh</span>}</td>
                            <td className="muted">{b.qty} {b.unit}</td>
                            <td className="num">{rupees(b.linePricePaise)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              </section>
            )}

            {/*
              These four lines describe what actually happens. Step two used to
              read "Choose your pandit by experience, language and distance" —
              written before ADR 0012 removed the selection step, and left
              standing on the page a search engine sends people to. The flow
              assigns; the devotee is told who before they pay. Promising a
              choice that the checkout then does not offer is the one kind of
              copy drift a marketplace does not get to correct later.
            */}
            {/*
              * THE GUIDE, above "how booking works".
              *
              * First-time devotees do not fail to book because of price — they fail
              * because they do not know what they are agreeing to. A purohit-written,
              * peer-checked account of what actually happens answers the real
              * objection, and this is the one page where the person reading it is
              * already considering the ritual.
              *
              * Renders nothing when no guide exists, so the page is unaffected.
              */}
            {guides.length > 0 && (
              <section className="pooja-sec">
                <h2>Before you book</h2>
                <ul className="lr-inline">
                  {guides.map((g) => (
                    <li key={g.id}>
                      <Link href={`/learn/${g.slug}`}>
                        <strong lang={g.locale}>{g.title}</strong>
                      </Link>
                      <span className="muted" lang={g.locale}> — {g.summary}</span>
                      {g.reviewedByName && (
                        <span className="muted"> · Checked by {g.reviewedByName}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className="pooja-sec">
              <h2>How booking works</h2>
              <ol className="numbered">
                <li>Pick a date and a real time slot — you see {virtual ? 'the purohit’s' : 'the pandit’s'} actual availability.</li>
                <li>
                  We match you to a verified pandit for your vidhi and language,
                  nearest to you — and tell you who, with their experience, before
                  you pay anything.
                </li>
                <li>
                  {virtual
                    ? 'Pay online to hold the slot. A video call has no doorstep, so nothing is collected afterwards.'
                    : 'Pay a small amount online to hold the slot. The rest is cash on the day, or fully online.'}
                </li>
                <li>
                  Give the pandit your start and completion codes.
                  {!virtual && ' That fixes the cash amount.'}
                </li>
              </ol>
            </section>

            <section className="pooja-sec">
              <h2>Common questions</h2>
              {/* Was "Yes… You are not allocated someone later." The product
                  allocates. Answering the question honestly is also the stronger
                  answer: the objection behind it is "will I get a stranger I know
                  nothing about", and the flow's actual answer to that is better
                  than a choice between names a family cannot compare. */}
              <details><summary>Can I choose the pandit?</summary>
                <p>We choose for you, and we tell you who before you pay. The match is
                   made on your family&apos;s vidhi and language, how close the pandit
                   is to you, and their experience and acceptance record — then you see
                   their name, their years of practice and, where they have recorded
                   one, a sample of their recitation — and you can still step away at
                   that point without paying.</p></details>
              <details><summary>What if I need to cancel?</summary>
                <p>Cancel more than 48 hours ahead for a full refund. Inside 48 hours the
                   booking amount is retained. If the pandit cancels you are refunded in
                   full regardless of notice.</p></details>
              {ritual.isMuhuratSensitive && (
                <details><summary>How do you decide the auspicious date?</summary>
                  <p>By your family&apos;s panjika, which you choose. Where two schools
                     disagree on a date we show you both rather than picking one
                     silently.</p></details>
              )}
              {!virtual && (
                <details><summary>Do I have to buy the materials from you?</summary>
                  <p>No. Choose &quot;I&apos;ll arrange materials&quot; at booking and you get
                     the checklist in advance at no cost.</p></details>
              )}
            </section>
          </article>

          <aside className="pooja-buy">
            <div className="card">
              <div className="muted" style={{ fontSize: '.85rem' }}>Typical total</div>
              <div className="big">{rupees(indicative)}</div>
              {/* "depending on the pandit you choose" — they do not choose.
                  Same ADR 0012 drift as the FAQ below. */}
              <div className="muted" style={{ fontSize: '.85rem', marginBottom: 14 }}>
                Dakshina ranges {rupees(ritual.priceBand.minPaise)}–{rupees(ritual.priceBand.maxPaise)}
                {' '}depending on the pandit matched to you.
              </div>

              {/* Every line read off the engine's own breakdown, so the three
                  numbers add up to the figure above them and to the bill. */}
              <div className="bill">
                <div className="line"><span>Dakshina</span><span>{rupees(quote.dakshinaPaise)}</span></div>
                {quote.samagriPaise > 0 && (
                  <div className="line"><span>Materials</span><span>{rupees(quote.samagriPaise)}</span></div>
                )}
                <div className="line">
                  <span>Service fee · {quote.commissionBps / 100}%</span>
                  <span>{rupees(quote.platformFeePaise)}</span>
                </div>
              </div>

              <Link href={`/book?ritual=${ritual.slug}`} className="btn-block"
                    style={{ display: 'block', textAlign: 'center', marginTop: 16 }}>
                Check dates and book
              </Link>
              {/* Travel is the one line this page cannot know — it needs an
                  address — so the total above is a floor, and says so. */}
              <p className="muted" style={{ fontSize: '.8rem', marginTop: 10, textAlign: 'center' }}>
                {virtual
                  ? 'Final price is itemised before you pay anything.'
                  : 'Travel is added once you choose an address. The full bill is itemised before you pay anything.'}
              </p>
            </div>

            <div className="card quiet" style={{ marginTop: 14, fontSize: '.86rem' }}>
              <strong>Also available in</strong>
              <div className="citylinks">
                {activeRegions().filter((r) => r.slug !== DEFAULT_CITY).slice(0, 8).map((r) => (
                  <span key={r.slug}>{r.name.en}</span>
                ))}
              </div>
            </div>
          </aside>
        </div>
      </div>
    </>
  );
}
