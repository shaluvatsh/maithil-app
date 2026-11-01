import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getKnowledgeItem } from '@/lib/server-api';
import { LearnBody } from '@/components/learn/body';

export const revalidate = 3600;

export async function generateMetadata(
  { params }: { params: Promise<{ slug: string }> },
): Promise<Metadata> {
  const { slug } = await params;
  const item = await getKnowledgeItem(slug);
  if (!item) return { title: 'Learn — TheMaithil' };
  return {
    title: `${item.title} — TheMaithil`,
    description: item.summary,
    /*
     * `Article` JSON-LD with a named author and reviewer.
     *
     * The review is the differentiator, so it belongs in the structured data as well
     * as on the page — a crawler that can see who checked a religious claim has
     * something no competitor in this category emits.
     */
    other: {
      'script:ld+json': JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'Article',
        headline: item.title,
        description: item.summary,
        inLanguage: item.locale,
        datePublished: item.publishedAt,
        author: { '@type': 'Person', name: item.authorName },
        ...(item.reviewedByName
          ? { reviewedBy: { '@type': 'Person', name: item.reviewedByName } }
          : {}),
        citation: item.citations.map((c) =>
          [c.work, c.chapter, c.verse].filter(Boolean).join(' ')),
      }),
    },
  };
}

/**
 * One piece of knowledge.
 *
 * Server-rendered so the text is in the HTML: this is the page a crawler reads and
 * the reason ADR 0008's cut `devotee-web` is no longer needed. The only client part
 * is the audio player and the transcript toggle, which are interactive by nature.
 */
export default async function LearnItemPage(
  { params, searchParams }: {
    params: Promise<{ slug: string }>;
    searchParams: Promise<{ locale?: string }>;
  },
) {
  const { slug } = await params;
  const { locale } = await searchParams;
  const item = await getKnowledgeItem(slug, locale);
  if (!item) notFound();

  return (
    <main className="wrap lr-wrap lr-item">
      <Link href="/learn" className="btn-link lr-back">← All of Learn</Link>

      <h1 lang={item.locale}>{item.title}</h1>
      <p className="lr-summary" lang={item.locale}>{item.summary}</p>

      <p className="lr-by muted">
        By {item.authorName}{item.authorVerified && <span className="lr-tick"> ✓</span>}
        {item.reviewedByName
          ? <> · Checked by {item.reviewedByName}</>
          // Stated rather than left blank. A reader must be able to tell a checked
          // item from one that slipped through.
          : <> · <span className="lr-unchecked">not yet checked</span></>}
      </p>

      {/*
        * A translation says so, and names the original.
        *
        * The API falls back when the reader's language is missing. Rendering that
        * silently would leave somebody reading a translation believing it is the
        * author's own account of their own tradition.
        */}
      {!item.original && (
        <p className="lr-translated">
          Translated — not the author&apos;s own words.
        </p>
      )}

      {item.availableLocales.length > 1 && (
        <p className="lr-langs muted">
          Also in:{' '}
          {item.availableLocales.filter((l) => l !== item.locale).map((l) => (
            <Link key={l} href={`/learn/${item.slug}?locale=${l}`} className="btn-link">{l}</Link>
          ))}
        </p>
      )}

      <LearnBody item={item} />

      {/*
        * WHERE IT SAYS SO.
        *
        * The trust moat and the cheapest one available: every other app asserts, a
        * citation lets a reader check. Rendered even when empty, because "no sources
        * given" is information a reader should have rather than an absence they have
        * to notice.
        */}
      <section className="lr-sources">
        <h2>Where it says so</h2>
        {item.citations.length === 0
          ? <p className="muted">No sources given for this one.</p>
          : (
            <ul>
              {item.citations.map((c, i) => (
                <li key={i}>
                  <strong>{c.work}</strong>
                  {' '}{[c.chapter, c.verse].filter(Boolean).join('.')}
                  {c.note && <span className="muted"> — {c.note}</span>}
                </li>
              ))}
            </ul>
          )}
      </section>

      {item.ritualSlug && (
        // The commercial point of a ritual guide: somebody who has just read what
        // happens at an annaprashan is the most likely person in the product to book
        // one, and this is the only moment they are that.
        <p className="lr-cta">
          <Link href={`/pooja/${item.ritualSlug}`} className="btn">
            Book this ritual
          </Link>
        </p>
      )}
    </main>
  );
}
