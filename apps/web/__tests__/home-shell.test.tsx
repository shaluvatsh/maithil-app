import './setup';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RegionProvider } from '@/lib/region-context';
import { RITUAL_CATEGORIES } from '@themaithil/region';
import { COLLECTIONS } from '@/lib/collections';
import Home from '@/app/page';

/**
 * The page must be its full height before any data arrives.
 *
 * Two bugs came out of the same place. The footer appeared under the hero on every
 * load, and refreshing from below the fold dumped you at the bottom of the page.
 * Neither was a footer bug: every list here renders from a client fetch, and each
 * one rendered nothing until its fetch resolved — the rails returned null at zero
 * items, the category grid mapped an empty array. So the first paint was hero,
 * a couple of static bands, footer. The browser restores a scroll offset against
 * the document as it exists at that instant, and an offset past the end of a short
 * document clamps to the end of it.
 *
 * `renderToStaticMarkup` runs no effects, so this is precisely the markup that
 * leaves the server and precisely what paints first. Testing Library cannot ask
 * this question — it flushes effects inside `act`, so by the time it looks, the
 * data is in and the page is tall. That is why a green suite never noticed.
 *
 * These are counts, not pixels. jsdom has no layout, so the assertion is that the
 * boxes EXIST from the first byte; that they are the right height is the business
 * of the skeleton markup mirroring the real card.
 */
const shell = () =>
  renderToStaticMarkup(<RegionProvider><Home /></RegionProvider>);

const occurrences = (html: string, needle: string) =>
  html.split(needle).length - 1;

describe('the home page holds its height before any data arrives', () => {
  it('reserves a placeholder for every category tile', () => {
    expect(occurrences(shell(), 'cat-card skeleton-card'))
      .toBe(RITUAL_CATEGORIES.length);
  });

  it('reserves a card for every slot each rail will fill', () => {
    const expected = COLLECTIONS.reduce((n, c) => n + c.preview, 0);
    expect(occurrences(shell(), 'svc-card skeleton-card')).toBe(expected);
  });

  /**
   * The rails used to vanish entirely while loading. A heading with a reserved grid
   * under it is the shape of the finished page; a heading that appears later moves
   * everything below it.
   */
  it('names every rail from the first byte', () => {
    const html = shell();
    for (const c of COLLECTIONS) {
      expect(html, `"${c.title}" is missing until the catalogue loads`)
        .toContain(c.title);
    }
  });

  /**
   * The guard against a half-fix: reserving the space but leaving the footer with
   * nothing above it would still look like the bug. The static bands and the hero
   * are the fixed part of the page and must be there too.
   */
  it('renders the hero and the closing bands, not just the chrome', () => {
    const html = shell();
    expect(html).toContain('Book a pandit for any pooja');
    expect(html).toContain('Need someone in 48 hours?');
    expect(html).toContain('Talk to someone');
  });

  /** Placeholders are furniture. A screen reader should hear the section, not them. */
  it('hides the placeholders from assistive technology', () => {
    const html = shell();
    expect(occurrences(html, 'aria-busy="true"')).toBeGreaterThanOrEqual(4);
    expect(occurrences(html, 'skeleton-card'))
      .toBe(occurrences(html, 'skeleton-card" aria-hidden="true"'));
  });
});

/**
 * A rail with nothing in it and nothing coming still renders nothing — the reason
 * `count === 0` returned null in the first place. A heading over an empty grid reads
 * as a failure. `pending` was added to tell the two apart, not to replace one with
 * the other.
 */
describe('an empty rail still disappears once that is known', () => {
  it('distinguishes "none" from "not yet"', async () => {
    const { ServiceRail } = await import('@/components/home/service-rail');
    const empty = renderToStaticMarkup(
      <ServiceRail title="Nothing here" count={0}>{null}</ServiceRail>,
    );
    expect(empty).toBe('');

    const loading = renderToStaticMarkup(
      <ServiceRail title="Nothing here" count={0} pending reserve={4}>{null}</ServiceRail>,
    );
    expect(loading).toContain('Nothing here');
    expect(occurrences(loading, 'skeleton-card')).toBe(4);
  });
});
