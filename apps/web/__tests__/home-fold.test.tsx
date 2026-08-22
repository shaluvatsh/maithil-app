import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RegionProvider } from '@/lib/region-context';
import Home from '@/app/page';
import { matchServices } from '@/components/home/hero-search';

const css = readFileSync(join(__dirname, '..', 'app', 'globals.css'), 'utf8');

const withRegion = (node: React.ReactNode) =>
  render(<RegionProvider>{node}</RegionProvider>);

const RITUALS = [
  {
    id: 'r1', slug: 'satyanarayan-puja', name: 'Satyanarayan Puja',
    shortDescription: 'Full katha and puja with sinni', category: 'festival-pujas',
    durationMin: 120, bomTotalPaise: 80000, deliveryMode: 'at_home',
    priceBand: { minPaise: 110000, maxPaise: 250000, defaultPaise: 150000 },
  },
  {
    id: 'r2', slug: 'griha-prabesh', name: 'Griha Prabesh',
    shortDescription: 'Blessing a new home', category: 'life-events',
    durationMin: 180, bomTotalPaise: 90000, deliveryMode: 'at_home',
    priceBand: { minPaise: 150000, maxPaise: 320000, defaultPaise: 200000 },
  },
  {
    id: 'r3', slug: 'online-aarti', name: 'Online Aarti',
    shortDescription: 'Live aarti by video', category: 'online-services',
    durationMin: 30, bomTotalPaise: 0, deliveryMode: 'virtual',
    priceBand: { minPaise: 40000, maxPaise: 90000, defaultPaise: 60000 },
  },
];

const CATEGORIES = [{
  id: 'life-events', en: 'Life events', blurb: 'Milestones', emoji: '🏠',
  tint: '#FFF7ED', count: 2,
}];

/** One auspicious day, so "Good days to book" has something to render. */
const PANCHANG = [{
  date: '2026-08-20', bengaliDate: null,
  tithiAtSunrise: 'Shukla Saptami', nakshatraAtSunrise: 'Hasta',
  abhijit: { startsAt: '2026-08-20T06:12:00Z', endsAt: '2026-08-20T07:00:00Z' },
  rahuKaal: { startsAt: '2026-08-20T03:30:00Z', endsAt: '2026-08-20T05:00:00Z' },
  auspiciousForRitualIds: ['r1'],
}];

beforeEach(() => {
  localStorage.clear();
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes('/v1/rituals') ? RITUALS
      : url.includes('/v1/categories') ? CATEGORIES
      : url.includes('/v1/panchang') ? PANCHANG
      : [];
    return new Response(JSON.stringify(body), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

function block(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[,}])\\s*${esc}\\s*\\{([^}]*)\\}`, 'm').exec(css)?.[2] ?? '';
}

/** Sum of a shorthand's top and bottom, in px. `44px 0 40px` -> 84. */
function blockPadding(selector: string): number {
  const m = /padding:\s*([^;]+)/.exec(block(selector));
  if (!m) return 0;
  const parts = m[1]!.trim().split(/\s+/).map((p) => parseFloat(p) || 0);
  const [top, , bottom] = parts.length === 1 ? [parts[0]!, 0, parts[0]!]
    : parts.length === 2 ? [parts[0]!, 0, parts[0]!]
    : [parts[0]!, 0, parts[2] ?? parts[0]!];
  return top + bottom;
}

function marginTop(selector: string): number {
  const b = block(selector);
  const shorthand = /margin:\s*([^;]+)/.exec(b);
  if (shorthand) return parseFloat(shorthand[1]!.trim().split(/\s+/)[0]!) || 0;
  return parseFloat(/margin-top:\s*([\d.]+)px/.exec(b)?.[1] ?? '0') || 0;
}

/**
 * The hero's vertical budget.
 *
 * The home page shipped with a hero that measured roughly 630px under a 68px
 * sticky header, so a laptop's first screen held a slogan, four trust pills that
 * repeated the footer, and a stats block — and the first bookable service sat
 * near 1400px down. Nobody scrolls two screens to find out whether a booking site
 * sells what they want.
 *
 * A screenshot cannot be asserted on in a unit test, but the numbers that produce
 * the height can be. This adds up the fixed part of the stack and fails if it
 * creeps back up. It is a budget, not a pixel-perfect measurement: text height
 * varies with the viewport, so the cap is generous and the point is the trend.
 */
describe('the hero stays inside its vertical budget', () => {
  const CAP = 380;

  const parts = {
    'hero padding': blockPadding('.hero'),
    'lede margin': marginTop('.hero .lede'),
    // A two-line clamped heading at its 2.7rem ceiling, line-height 1.15.
    'heading (2 lines)': Math.round(2.7 * 16 * 1.15 * 2),
    'lede text': Math.round(1.06 * 16 * 1.6),
    'search margin': marginTop('.searchwrap'),
    // 6px padding either side of a 43px input row.
    'search control': 12 + 43,
    'trust margin': marginTop('.hero-trust'),
    'trust text': Math.round(0.92 * 16 * 1.6),
  };
  const total = Object.values(parts).reduce((a, b) => a + b, 0);

  it(`totals under ${CAP}px — measured ${total}px`, () => {
    expect(total, JSON.stringify(parts, null, 2)).toBeLessThanOrEqual(CAP);
  });

  it('does not reintroduce the trust pills the footer already carries', () => {
    const home = readFileSync(join(__dirname, '..', 'app', 'page.tsx'), 'utf8');
    expect(home).not.toMatch(/hero-pill/);
  });

  /**
   * This used to measure `.panchang-strip`, a component that had been removed from
   * the page while its export, its stylesheet rules and this assertion all survived.
   * The test passed because the CSS was still there — it was measuring a rule with
   * nothing to style, and reporting that as the almanac being compact. A test whose
   * subject no longer renders is worse than no test: it reads as coverage.
   *
   * The almanac above the fold is now `PanchangCard`, in the hero, and its height is
   * governed by the hero budget above.
   */
  it('renders the almanac inside the hero, not as a band above the catalogue', async () => {
    const { container } = withRegion(<Home />);
    await screen.findByRole('heading', { name: /What are you looking for/i });
    expect(container.querySelector('.hero .pcard-hero')).not.toBeNull();
    expect(css).not.toContain('panchang-strip');
  });
});

describe('the home page leads with something to book', () => {
  it('puts the categories above the calendar', async () => {
    const { container } = withRegion(<Home />);
    await screen.findByRole('heading', { name: /What are you looking for/i });

    const order = [...container.querySelectorAll('h2')].map((h) => h.textContent ?? '');
    const categories = order.findIndex((t) => /What are you looking for/i.test(t));
    const calendar = order.findIndex((t) => /Good days to book/i.test(t));

    expect(categories, 'categories section is missing').toBeGreaterThanOrEqual(0);
    // -1 when the panchang fixture is empty, which is also "not above categories".
    if (calendar >= 0) expect(calendar).toBeGreaterThan(categories);
  });

  it('reaches a bookable card before the offers block', async () => {
    const { container } = withRegion(<Home />);
    await screen.findAllByRole('link', { name: /Book Now/i });

    const nodes = [...container.querySelectorAll('.svc-card, .offer')];
    expect(nodes[0]?.className, 'the offer banner outranks the services').toContain('svc-card');
  });

  it('still sends every Book Now into the flow carrying its ritual', async () => {
    withRegion(<Home />);
    for (const a of await screen.findAllByRole('link', { name: /Book Now/i })) {
      expect(a.getAttribute('href')).toMatch(/^\/book\?ritual=[a-z0-9-]+(&day=[\d-]+)?$/);
    }
  });

  it('keeps Learn More and Book Now on different destinations', async () => {
    withRegion(<Home />);
    for (const card of await screen.findAllByText(/Learn More/i)) {
      const actions = card.closest('.svc-actions');
      const links = [...(actions?.querySelectorAll('a') ?? [])];
      expect(new Set(links.map((l) => l.getAttribute('href'))).size).toBe(links.length);
    }
  });
});

describe('hero search matches what people actually type', () => {
  const catalogue = [
    { slug: 'griha-prabesh', name: 'Griha Prabesh', aliases: ['housewarming', 'new house'] },
    { slug: 'biye', name: 'Biye', aliases: ['wedding', 'marriage'] },
    { slug: 'ganesh-puja', name: 'Ganesh Puja' },
  ];

  it('finds a ritual by its English name', () => {
    expect(matchServices(catalogue, 'housewarming').map((r) => r.slug)).toEqual(['griha-prabesh']);
  });

  it('matches a word inside the name, not just the start', () => {
    expect(matchServices(catalogue, 'puja').map((r) => r.slug)).toContain('ganesh-puja');
  });

  it('ranks a prefix hit above a substring hit', () => {
    const hits = matchServices(
      [{ slug: 'a', name: 'Kali Puja' }, { slug: 'b', name: 'Puja Samagri' }], 'puja',
    );
    expect(hits[0]?.slug).toBe('b');
  });

  it('stays quiet until there is enough to go on', () => {
    expect(matchServices(catalogue, 'g')).toEqual([]);
  });

  it('offers suggestions as the devotee types', async () => {
    withRegion(<Home />);
    const input = await screen.findByRole('combobox', { name: /Search poojas/i });
    await userEvent.type(input, 'pu');

    const list = await screen.findByRole('listbox');
    expect(within(list).getAllByRole('option').length).toBeGreaterThan(0);
    expect(input).toHaveAttribute('aria-expanded', 'true');
  });
});

/**
 * The hero carries no imagery.
 *
 * It has been a row of text pills ("Popular right now"), then four drawn ritual
 * tiles, and is now neither — the hero is the headline, the search and the
 * almanac. This asserts the removal was complete rather than leaving a component
 * nothing renders and rules nothing matches, which is how the last three
 * iterations each left something behind.
 */
describe('the hero carries no imagery', () => {
  it('renders no tile strip', async () => {
    const { container } = withRegion(<Home />);
    await screen.findAllByRole('link', { name: /Book Now/i });

    expect(container.querySelector('.hero-art')).toBeNull();
    expect(container.querySelector('.rt-art')).toBeNull();
    expect(screen.queryByText('Popular right now')).not.toBeInTheDocument();
  });

  it('leaves no styling for it behind', () => {
    for (const dead of ['.hero-art', '.rt-art', '.rt-photo', '.motif-flame', 'rt-in']) {
      expect(css, `${dead} still has rules with nothing to style`).not.toContain(dead);
    }
  });

  /** The component was only ever used by the hero, so it goes with it. */
  it('removes the component rather than orphaning it', () => {
    expect(existsSync(join(__dirname, '..', 'components', 'home', 'ritual-art.tsx')))
      .toBe(false);
  });
});
