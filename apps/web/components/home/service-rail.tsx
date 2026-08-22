'use client';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ServiceCardSkeletons } from '@/components/skeletons';

/**
 * A titled row of cards.
 *
 * Renders nothing at all when it has no children to show — a heading over an empty
 * grid reads as a loading failure, and "Most booked services" above white space is
 * worse than the section simply not being there.
 *
 * But "no children" and "children not here yet" are different states, and treating
 * them the same is what collapsed the home page. All three rails returned null until
 * the catalogue fetch resolved, so the document was hero-then-footer for the first
 * moment of every load: the footer rode up under the hero, and a refresh from below
 * the fold clamped the restored scroll offset to the bottom of a page two thirds
 * shorter than the one you left. `pending` separates the two — reserve the space
 * while it is coming, disappear only once it is known there is nothing.
 */
export function ServiceRail({
  title, subtitle, seeAll, seeAllLabel = 'See all ›', aside, count,
  pending = false, reserve = 4, children,
}: {
  title: string;
  subtitle?: string;
  seeAll?: string;
  seeAllLabel?: string;
  aside?: ReactNode;
  /** Number of cards inside; the rail hides itself at zero once loaded. */
  count: number;
  /** The catalogue is still in flight, so hold the space rather than collapsing. */
  pending?: boolean;
  /** How many placeholders to hold it with — the collection's `preview`. */
  reserve?: number;
  children: ReactNode;
}) {
  if (count === 0 && !pending) return null;

  return (
    <section className="section tight">
      <div className="wrap">
        <div className="rail-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p className="muted">{subtitle}</p>}
          </div>
          <div className="rail-aside">
            {aside}
            {seeAll && <Link href={seeAll} className="seeall">{seeAllLabel}</Link>}
          </div>
        </div>
        {/*
          `rail` switches this to a two-column grid below 640px, matching the
          category tiles. The booking catalogue uses the same `.grid.svc` and must
          keep its own auto-fill track, because a chooser has to show how many
          options exist; a home shelf shows a curated few. That difference is what
          the modifier encodes.
        */}
        <div className="grid svc rail" aria-busy={pending || undefined}>
          {pending ? <ServiceCardSkeletons count={reserve} /> : children}
        </div>
      </div>
    </section>
  );
}
