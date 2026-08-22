import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react';
import { RegionProvider } from '@/lib/region-context';
import Home from '@/app/page';
import { COLLECTIONS, getCollection, collectionPreview } from '@/lib/collections';
import { readTithi, nowState } from '@/lib/tithi';

const css = readFileSync(join(__dirname, '..', 'app', 'globals.css'), 'utf8');
const withRegion = (n: React.ReactNode) => render(<RegionProvider>{n}</RegionProvider>);

/** Eight in-person rituals, so every collection has more than its preview of four. */
const RITUALS = [
  ...Array.from({ length: 8 }, (_, i) => ({
    id: `r${i}`, slug: `ritual-${i}`, name: `Ritual ${i}`,
    shortDescription: 'A ritual', category: 'festival-pujas',
    durationMin: 120, bomTotalPaise: 80000, deliveryMode: 'at_home' as const,
    priceBand: { minPaise: 110000, maxPaise: 250000, defaultPaise: 150000 },
  })),
  {
    id: 'v1', slug: 'online-aarti', name: 'Online Aarti',
    shortDescription: 'Live aarti by video', category: 'online-services',
    durationMin: 30, bomTotalPaise: 0, deliveryMode: 'virtual' as const,
    priceBand: { minPaise: 40000, maxPaise: 90000, defaultPaise: 60000 },
  },
  {
    id: 'p1', slug: 'personalised-puja', name: 'Personalised Puja',
    shortDescription: 'Shaped around your chart', category: 'peace-and-remedies',
    durationMin: 90, bomTotalPaise: 50000, deliveryMode: 'at_home' as const,
    priceBand: { minPaise: 200000, maxPaise: 500000, defaultPaise: 300000 },
  },
];

beforeEach(() => {
  localStorage.clear();
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes('/v1/rituals') ? RITUALS
      : url.includes('/v1/categories')
        ? [{ id: 'festival-pujas', en: 'Festival Pujas', blurb: 'x', emoji: '🪔', tint: '#eee', count: 8 }]
        : [];
    return new Response(JSON.stringify(body), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

/**
 * Every "See all" used to end at `/book?browse=1` — the whole catalogue in a
 * different order, with no sign of the rail you came from. The link looked like
 * navigation and behaved like a reset.
 */
describe('collections are one definition, used twice', () => {
  it('the rail preview is a prefix of what its See all shows', () => {
    for (const c of COLLECTIONS) {
      const { items, href } = collectionPreview(c, RITUALS);
      const full = c.select(RITUALS);
      expect(items, `${c.id} preview is not a prefix of its own selection`)
        .toEqual(full.slice(0, items.length));
      expect(getCollection(new URL(href, 'http://x').searchParams.get('collection')))
        .toBe(c);
    }
  });

  it('keeps popular and online disjoint, so nothing is in both rails', () => {
    const popular = new Set(getCollection('popular')!.select(RITUALS).map((r) => r.slug));
    for (const r of getCollection('online')!.select(RITUALS)) {
      expect(popular.has(r.slug), `${r.slug} is in both popular and online`).toBe(false);
    }
  });

  it('resolves an unknown collection to null rather than an empty shelf', () => {
    expect(getCollection('made-up')).toBeNull();
    expect(getCollection(null)).toBeNull();
  });

  it('every See all on the page reaches a real destination', async () => {
    const { container } = withRegion(<Home />);
    await screen.findAllByRole('link', { name: /Book Now/i });

    const hrefs = [...container.querySelectorAll('a.seeall')]
      .map((a) => a.getAttribute('href') ?? '');
    expect(hrefs.length).toBeGreaterThan(0);

    for (const href of hrefs) {
      // The old failure mode exactly: a "See all" that just clears the filters.
      expect(href, 'See all must not fall back to the bare catalogue').not.toBe('/book?browse=1');
      const collection = /collection=([\w-]+)/.exec(href)?.[1];
      if (collection) expect(getCollection(collection)).not.toBeNull();
    }
  });

  it('sends the category See all to the hub, not into the booking flow', async () => {
    withRegion(<Home />);
    const link = await screen.findByRole('link', { name: /All categories/i });
    expect(link).toHaveAttribute('href', '/services');
  });
});

describe('the two closing calls to action are actually different', () => {
  it('does not offer two links to the same place', async () => {
    const { container } = withRegion(<Home />);
    await screen.findAllByRole('link', { name: /Book Now/i });

    const cta = [...container.querySelectorAll('.outcard a, .pillghost')]
      .map((a) => a.getAttribute('href'));
    expect(new Set(cta).size, `duplicate destinations: ${cta.join(', ')}`).toBe(cta.length);
  });

  it('points the bespoke route at the real personalised service', async () => {
    withRegion(<Home />);
    expect(await screen.findByRole('link', { name: /personalised puja/i }))
      .toHaveAttribute('href', '/pooja/personalised-puja');
  });
});

/**
 * A tithi IS the moon's phase — 12° of elongation each — so drawing the phase from
 * the name is the same fact in a form more people can read, not decoration.
 */
describe('reading a tithi', () => {
  it('recognises the two boundary tithis by phase', () => {
    expect(readTithi('Purnima')?.illumination).toBe(1);
    expect(readTithi('Amavasya')?.illumination).toBe(0);
  });

  it('fills through the bright fortnight and empties through the dark', () => {
    expect(readTithi('Shukla Panchami')!.illumination)
      .toBeLessThan(readTithi('Shukla Trayodashi')!.illumination);
    expect(readTithi('Krishna Panchami')!.illumination)
      .toBeGreaterThan(readTithi('Krishna Trayodashi')!.illumination);
  });

  it('gives every tithi a glyph and never throws on nonsense', () => {
    expect(readTithi('Shukla Saptami')?.glyph).toBeTruthy();
    expect(readTithi('not a tithi')).toBeNull();
    expect(readTithi(null)).toBeNull();
    expect(readTithi('')).toBeNull();
  });

  it('tolerates the transliterations the API actually emits', () => {
    expect(readTithi('Krishna Astami')?.index).toBe(8);
    expect(readTithi('Shukla Sasthi')?.index).toBe(6);
  });
});

describe('the strip answers what is true right now', () => {
  const abhijit = { startsAt: '2026-08-15T06:00:00Z', endsAt: '2026-08-15T07:00:00Z' };
  const rahu = { startsAt: '2026-08-15T09:00:00Z', endsAt: '2026-08-15T10:30:00Z' };

  it('names the window the clock is inside', () => {
    expect(nowState(new Date('2026-08-15T06:30:00Z'), abhijit, rahu).kind).toBe('abhijit');
    expect(nowState(new Date('2026-08-15T09:30:00Z'), abhijit, rahu).kind).toBe('rahu');
    expect(nowState(new Date('2026-08-15T12:00:00Z'), abhijit, rahu).kind).toBe('clear');
  });

  it('lets a warning outrank an invitation when both apply', () => {
    const overlap = { startsAt: '2026-08-15T06:00:00Z', endsAt: '2026-08-15T07:00:00Z' };
    expect(nowState(new Date('2026-08-15T06:30:00Z'), abhijit, overlap).kind).toBe('rahu');
  });

  it('treats the closing instant as outside the window', () => {
    expect(nowState(new Date('2026-08-15T07:00:00Z'), abhijit, rahu).kind).toBe('clear');
  });
});

/**
 * `repeat(auto-fill, minmax(272px, 1fr))` resolves to one column on a phone, so
 * four cards became a 1700px column and five rails made a page nobody reached the
 * end of.
 */
/**
 * The rails were snap carousels: two cards at 46%, a third sliced at the edge, a
 * fade to soften the cut, and a "Swipe for more" hint. Three affordances teaching a
 * gesture to reach content the page could simply show.
 *
 * The category tiles directly above used a plain two-column grid, filled the width
 * exactly, and needed none of it. Matching them also removed the whole class of bug
 * the carousel kept producing — equal-height stretch across a flex row, cards cut
 * mid-button, a scroller that had to be masked so its clipped edge did not read as
 * broken.
 */
describe('rails are a grid, like the category tiles', () => {
  /** Every block at this breakpoint; the stylesheet declares more than one. */
  const at = (bp: string) => {
    const marker = `@media (max-width: ${bp})`;
    const out: string[] = [];
    for (let i = css.indexOf(marker); i >= 0; i = css.indexOf(marker, i + 1)) {
      const j = css.indexOf('\n@media', i + marker.length);
      out.push(css.slice(i, j < 0 ? undefined : j));
    }
    return out.join('\n');
  };
  const mobile = at('640px');
  /** Body of a rule, by plain selector — escaped here, once. */
  const rule = (sel: string) => {
    const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`${esc}\\s*\\{([^}]*)\\}`).exec(mobile)?.[1] ?? '';
  };

  it('lays the rail out in two equal columns', () => {
    expect(rule('.grid.svc.rail'))
      .toMatch(/grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  });

  it('does the same for the two closing cards', () => {
    expect(rule('.outband'))
      .toMatch(/grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  });

  /** No hidden content means no gesture to teach and no edge to soften. */
  it('is not a scroller any more', () => {
    for (const sel of ['.grid.svc.rail', '.outband']) {
      const body = rule(sel);
      expect(body, `${sel} still scrolls horizontally`).not.toMatch(/overflow-x:\s*auto/);
      expect(body).not.toMatch(/scroll-snap-type/);
      expect(body, 'a full-bleed negative margin is only needed by a scroller')
        .not.toMatch(/margin-inline:\s*-/);
    }
  });

  it('drops the swipe hint and the edge fade with it', () => {
    // Removed outright rather than hidden: a rule that styles nothing reads as
    // live to whoever edits next. See css-invariants.test.ts.
    expect(css, 'the swipe hint still has styling').not.toMatch(/rail-hint/);
    expect(mobile, 'nothing is clipped, so nothing needs masking')
      .not.toMatch(/\.grid\.svc\.rail[^{]*\{[^}]*mask-image/);

    const rail = readFileSync(
      join(__dirname, '..', 'components', 'home', 'service-rail.tsx'), 'utf8');
    expect(rail, 'the component still renders a swipe instruction')
      .not.toMatch(/rail-hint/);
  });

  /**
   * The booking catalogue renders with the same `.grid.svc` and must keep its
   * auto-fill track: a chooser has to show how many options exist, while a home
   * shelf shows a curated few. That is what the `.rail` modifier encodes.
   */
  it('leaves the booking catalogue on its own track', () => {
    const bare = /(^|})\s*\.grid\.svc\s*\{([^}]*)\}/m.exec(mobile);
    expect(bare, '.grid.svc must only be re-laid-out via .rail').toBeNull();
  });

  it('strips the card to the parts a 165px tile can carry', () => {
    expect(mobile).toMatch(/\.rail\s+\.feats,\s*\.rail\s+\.meta\s*\{[^}]*display:\s*none/);
    expect(mobile).toMatch(/\.rail\s+\.svc-actions\s+\.btn\.outline\s*\{[^}]*display:\s*none/);
  });
});
