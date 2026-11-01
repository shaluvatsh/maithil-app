/**
 * Placeholders that hold a section's height while its data is in flight.
 *
 * These are not decoration. Every list on the home page renders from a client
 * fetch, and each one rendered NOTHING until its fetch resolved — the rails
 * returned null at zero items, the category grid mapped an empty array. So the
 * document was briefly about a third of its real height, which had two visible
 * consequences:
 *
 *   - The footer rode up under the hero on every load, because there was almost
 *     nothing between them. This is the second half of a bug whose first half was
 *     the role gate blanking the page; fixing that made the shell render, but a
 *     shell with three collapsed sections is still a short page.
 *   - Refreshing anywhere below the fold dumped you at the bottom. The browser
 *     restores the previous scroll offset against the document as it exists at
 *     that moment, and an offset past the end of a short document clamps to the
 *     end of it — the footer. By the time the content arrived and the page grew,
 *     the scroll had already been set.
 *
 * Reserving the space fixes both, and is the same thing that keeps Cumulative
 * Layout Shift down. The card markup mirrors the real card closely enough that the
 * reserved height is near the final one; the point is the box, not the shimmer.
 *
 * `aria-hidden` throughout, with the live region left to the section: a screen
 * reader should hear "loading", not four empty articles.
 */

const KEYS = (n: number) => Array.from({ length: n }, (_, i) => i);

/** Mirrors `ServiceCard`: emoji header, three text lines, a price row. */
export function ServiceCardSkeletons({ count }: { count: number }) {
  return (
    <>
      {KEYS(count).map((i) => (
        <div className="svc-card skeleton-card" key={i} aria-hidden>
          <div className="svc-top"><div className="sk sk-emoji" /></div>
          <div className="svc-body">
            <div className="sk sk-line" style={{ width: '70%' }} />
            <div className="sk sk-line" style={{ width: '95%' }} />
            <div className="sk sk-line" style={{ width: '45%' }} />
          </div>
        </div>
      ))}
    </>
  );
}

/** Mirrors `.cat-card`: tile, name, blurb, count. */
export function CategoryCardSkeletons({ count }: { count: number }) {
  return (
    <>
      {KEYS(count).map((i) => (
        <div className="cat-card skeleton-card" key={i} aria-hidden>
          <div className="sk sk-emoji" />
          <div className="sk sk-line" style={{ width: '60%', margin: '14px auto 10px' }} />
          <div className="sk sk-line" style={{ width: '85%', margin: '0 auto 10px' }} />
          <div className="sk sk-line" style={{ width: '40%', margin: '0 auto' }} />
        </div>
      ))}
    </>
  );
}

/**
 * A stack of card-shaped rows — the purohit's job inbox and the admin console's
 * tables, both of which used to pop in from nothing.
 *
 * Neither surface had any placeholder at all: skeletons were built for the home
 * page and the devotee flow and never reached the other two personas, so staff
 * and supply got a blank panel while their fetch resolved and no signal that
 * anything was happening. Deliberately generic — a row is a row on both.
 */
export function RowSkeletons({ count, height = 64 }: { count: number; height?: number }) {
  return (
    <>
      {KEYS(count).map((i) => (
        <div className="sk-row" key={i} aria-hidden style={{ height }}>
          <div className="sk sk-line" style={{ width: '32%' }} />
          <div className="sk sk-line" style={{ width: '18%' }} />
          <div className="sk sk-line" style={{ width: '22%' }} />
        </div>
      ))}
    </>
  );
}
