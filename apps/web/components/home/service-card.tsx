'use client';
import Link from 'next/link';

/**
 * One service card, used by every rail on the home page.
 *
 * There were three of these inline in `page.tsx`, each hand-written with slightly
 * different markup for the same thing. That is how "Learn More" and "Book Now"
 * came to point at the same URL in one rail and not the others: a fix applied to
 * one copy left the other two wrong, and nothing in the code said they were
 * supposed to agree. One component means one definition of what a service card
 * is, and the variation between rails is now the props below.
 */
export interface ServiceCardModel {
  slug: string;
  name: string;
  shortDescription: string;
  durationMin: number;
}

export interface ServiceCardProps {
  service: ServiceCardModel;
  price: string;
  emoji: string;
  /**
   * The tile background, taken from the service's category.
   *
   * Every service tile was the same orange gradient, directly beneath a category
   * grid where colour is the thing that tells one tile from another. Four
   * identically-coloured cards in a row are harder to scan than four different
   * ones, and the two sections stopped looking related despite sharing a shape.
   * Inheriting the category's own tint makes the colour mean something: this card
   * is a Home & New Beginnings ritual, and it is the same orange as that tile.
   */
  tint?: string;
  /** Warm by default; `cool` is the blue treatment used by online services. */
  tone?: 'warm' | 'cool';
  badges?: Array<{ text: string; kind: string; side?: 'l' | 'r' }>;
  chips?: Array<{ text: string; kind?: string }>;
  rating?: { stars: number; reviews: number } | undefined;
  features?: string[];
  meta?: string[];
  /**
   * Carried into the booking flow so a date chosen on the home page survives the
   * jump. Absent for most cards.
   */
  day?: string | undefined;
}

export function ServiceCard({
  service: s, price, emoji, tone = 'warm', tint,
  badges = [], chips = [], rating, features = [], meta = [], day,
}: ServiceCardProps) {
  const cool = tone === 'cool';
  const bookHref = `/book?ritual=${s.slug}${day ? `&day=${day}` : ''}`;

  return (
    <div className="svc-card">
      <div className={`svc-top${cool ? ' cool' : ''}`}>
        {badges.map((b) => (
          <span key={b.text} className={`badge ${b.side ?? 'r'} ${b.kind}`}>{b.text}</span>
        ))}
        <div className="emoji" style={tint ? { background: tint } : undefined}>{emoji}</div>
        {rating && (
          <div className="rating">
            ⭐ {rating.stars.toFixed(1)}{' '}
            <span className="rev">· {rating.reviews} review{rating.reviews === 1 ? '' : 's'}</span>
          </div>
        )}
      </div>

      <div className="svc-body">
        {chips.length > 0 && (
          <div className="chips">
            {chips.map((c) => (
              <span key={c.text} className={`chip${c.kind ? ` ${c.kind}` : ''}`}>{c.text}</span>
            ))}
          </div>
        )}
        {/*
          The title is the read path.
          Below 640px the card loses its "Learn More" button — two buttons inside a
          155px card are untappable, and stacking them doubles the card's height for
          a link the heading already is. Making the heading the link keeps the
          detail page reachable at every width instead of hiding a route on the
          device most people arrive on.
        */}
        <Link href={`/pooja/${s.slug}`} className="title">{s.name}</Link>
        <div className="desc">{s.shortDescription}</div>

        {features.length > 0 && (
          <ul className={`feats${cool ? ' blue' : ''}`}>
            {features.map((f) => <li key={f}>{f}</li>)}
          </ul>
        )}
        {meta.length > 0 && (
          <div className="meta">{meta.map((m) => <span key={m}>{m}</span>)}</div>
        )}

        <div className="price">{price}</div>
        <div className="svc-actions">
          {/*
            Two distinct destinations, always. Learn More reads; Book Now commits.
            Collapsing them is a real bug — a devotee who wants to know what a
            ritual involves should never be dropped into a checkout.
          */}
          <Link href={`/pooja/${s.slug}`} className="btn outline block">Learn More</Link>
          <Link href={bookHref} className={`btn${cool ? ' blue' : ''} block`}>Book Now</Link>
        </div>
      </div>
    </div>
  );
}
