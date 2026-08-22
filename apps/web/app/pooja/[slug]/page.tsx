import Link from 'next/link';
import type { Metadata } from 'next';
import { REGIONS, activeRegions, getCategory } from '@themaithil/region';
import { getRitual, getRituals, type BomLine } from '@/lib/server-api';

/**
 * The service detail page — and the first server-rendered page in the app.
 *
 * "Learn More" and "Book Now" both pointed at `/book`, so the two buttons on every
 * card did exactly the same thing and neither carried which ritual you clicked.
 * This is the page Learn More was always implying.
 *
 * It is also the fix for the largest strategic gap in ARCHITECTURE-REVIEW.md: every
 * competitor in this category acquires demand through per-city, per-ritual landing
 * pages, and until now Google received an empty shell from this app.
 */

export const revalidate = 3600;
/** A ritual added between builds should still resolve, not 404. */
export const dynamicParams = true;

const DEFAULT_CITY = process.env.NEXT_PUBLIC_REGION ?? 'kolkata';

const rupees = (paise: number) =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 0,
  }).format(paise / 100);

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
  const r = await getRitual(slug, DEFAULT_CITY);
  const city = REGIONS[DEFAULT_CITY]?.name.en ?? 'India';
  if (!r) return { title: 'Pooja — TheMaithil' };

  const title = `${r.name} at home in ${city} — book a verified pandit | TheMaithil`;
  const description =
    `${r.shortDescription}. ${hours(r.durationMin)}, from ${rupees(r.priceBand.minPaise)}. `
    + 'Pick a real time slot with a named pandit — no waiting to be allocated.';

  return {
    title,
    description,
    alternates: { canonical: `/pooja/${r.slug}` },
    openGraph: { title, description, type: 'website' },
  };
}

export default async function PoojaPage(
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const ritual = await getRitual(slug, DEFAULT_CITY);
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
  const samagri = ritual.bom.reduce(
    (sum: number, b: BomLine) => sum + b.linePricePaise, 0,
  );

  // Priced the way the bill is actually assembled, so the page cannot promise a
  // number the booking flow then contradicts.
  const dakshina = ritual.priceBand.defaultPaise;
  const sourcing = Math.round(samagri * 0.05);
  const platformFee = Math.round((dakshina + samagri + sourcing) * 0.15);
  const indicative = dakshina + samagri + sourcing + platformFee;

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
      priceCurrency: 'INR',
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
              </section>
            )}

            <section className="pooja-sec">
              <h2>How booking works</h2>
              <ol className="numbered">
                <li>Pick a date and a real time slot — you see the pandit&apos;s actual availability.</li>
                <li>Choose your pandit by experience, language and distance.</li>
                <li>Pay a small amount online to hold the slot. The rest is cash on the day, or fully online.</li>
                <li>Give the pandit your start and completion codes. That fixes the cash amount.</li>
              </ol>
            </section>

            <section className="pooja-sec">
              <h2>Common questions</h2>
              <details><summary>Can I choose the pandit?</summary>
                <p>Yes. You see who is free in your slot with their experience, languages
                   and distance, and you pick. You are not allocated someone later.</p></details>
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
              <div className="muted" style={{ fontSize: '.85rem', marginBottom: 14 }}>
                Dakshina ranges {rupees(ritual.priceBand.minPaise)}–{rupees(ritual.priceBand.maxPaise)}
                {' '}depending on the pandit you choose.
              </div>

              <div className="bill">
                <div className="line"><span>Dakshina</span><span>{rupees(dakshina)}</span></div>
                {samagri > 0 && (
                  <div className="line"><span>Materials</span><span>{rupees(samagri + sourcing)}</span></div>
                )}
                <div className="line"><span>Service fee</span><span>{rupees(platformFee)}</span></div>
              </div>

              <Link href={`/book?ritual=${ritual.slug}`} className="btn-block"
                    style={{ display: 'block', textAlign: 'center', marginTop: 16 }}>
                Check dates and book
              </Link>
              <p className="faint" style={{ fontSize: '.8rem', marginTop: 10, textAlign: 'center' }}>
                Final price is itemised before you pay anything.
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
