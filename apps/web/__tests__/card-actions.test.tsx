import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { RegionProvider } from '@/lib/region-context';
import Home from '@/app/page';
import BookPage from '@/app/book/page';

let search = '';
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(search),
}));

const RITUALS = [
  {
    id: 'r1', slug: 'satyanarayan-puja', name: 'Satyanarayan Puja',
    shortDescription: 'Full katha and puja with sinni', category: 'festival-pujas',
    durationMin: 120, defaultSlotSpan: 1, bomTotalPaise: 80000, deliveryMode: 'at_home',
    priceBand: { minPaise: 110000, maxPaise: 250000, defaultPaise: 150000 },
  },
  {
    id: 'r2', slug: 'griha-prabesh', name: 'Griha Prabesh',
    shortDescription: 'House-warming puja with homa', category: 'home-and-new-beginnings',
    durationMin: 180, defaultSlotSpan: 1, bomTotalPaise: 120000, deliveryMode: 'at_home',
    priceBand: { minPaise: 210000, maxPaise: 510000, defaultPaise: 310000 },
  },
  {
    id: 'r3', slug: 'online-aarti', name: 'Online Aarti',
    shortDescription: 'Live aarti by video, joined from anywhere', category: 'online-services',
    durationMin: 45, defaultSlotSpan: 1, bomTotalPaise: 0, deliveryMode: 'virtual',
    priceBand: { minPaise: 39900, maxPaise: 89900, defaultPaise: 49900 },
  },
];

function mockApi() {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body =
      url.includes('/v1/categories') ? []
      : url.includes('/v1/rituals') ? RITUALS
      : url.includes('/v1/panchang') ? []
      : url.includes('/v1/search/pandits') ? { results: [] }
      : [];
    return new Response(JSON.stringify(body), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  localStorage.clear();
  search = '';
  mockApi();
  Element.prototype.scrollIntoView = vi.fn();
  window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as unknown as typeof window.matchMedia;
});

/**
 * The reported bug: every service card had "Learn More" and "Book Now", both
 * `href="/book"`. Two controls, one behaviour, and neither carried which ritual the
 * user had clicked.
 */
describe('service card actions', () => {
  it('gives the two buttons different destinations', async () => {
    render(<RegionProvider><Home /></RegionProvider>);
    /*
     * Scoped to a service card. The hero now offers the same rituals as quick-pick
     * chips — a deliberate second entry point — so the ritual's name is no longer
     * unique on the page, and an unscoped lookup matches the chip first.
     */
    const title = (await screen.findAllByText('Satyanarayan Puja'))
      .find((el) => el.closest('.svc-card'))!;
    const card = title.closest('.svc-card') as HTMLElement;

    const learn = within(card).getByRole('link', { name: /learn more/i });
    const book = within(card).getByRole('link', { name: /book now/i });

    expect(learn.getAttribute('href')).not.toBe(book.getAttribute('href'));
  });

  it('carries the ritual identity, so Book Now does not dump you at the catalogue',
    async () => {
      render(<RegionProvider><Home /></RegionProvider>);
      const card = (await screen.findAllByText('Satyanarayan Puja'))
        .find((el) => el.closest('.svc-card'))!
        .closest('.svc-card') as HTMLElement;

      expect(within(card).getByRole('link', { name: /learn more/i }))
        .toHaveAttribute('href', '/pooja/satyanarayan-puja');
      expect(within(card).getByRole('link', { name: /book now/i }))
        .toHaveAttribute('href', '/book?ritual=satyanarayan-puja');
    });

  it('leaves no card action pointing at a bare /book', async () => {
    const { container } = render(<RegionProvider><Home /></RegionProvider>);
    await screen.findAllByText('Satyanarayan Puja');

    const dead = Array.from(container.querySelectorAll('.svc-actions a'))
      .filter((a) => a.getAttribute('href') === '/book');
    expect(dead).toEqual([]);
  });

  it('shows only services that exist in the catalogue', async () => {
    render(<RegionProvider><Home /></RegionProvider>);
    await screen.findAllByText('Satyanarayan Puja');

    // These were hardcoded marketing cards whose Book Now led nowhere real.
    expect(screen.queryByText('Personalized Pooja')).not.toBeInTheDocument();
    expect(screen.queryByText('Virtual Consultation')).not.toBeInTheDocument();

    // The real seeded one appears exactly once — "Most booked" and "New and
    // noteworthy" must not draw from the same pool.
    expect(screen.getAllByText('Online Aarti')).toHaveLength(1);
  });

  /**
   * Asserted on the destination rather than the button's wording, so rewriting the
   * label is a copy change. What must hold is that short notice stays a filter over
   * the real catalogue and never becomes a service row nobody can perform.
   */
  it('routes the short-notice card to a filter rather than a fake service', async () => {
    const { container } = render(<RegionProvider><Home /></RegionProvider>);
    await screen.findByText('Online Aarti');

    expect(screen.queryByText('Express Booking')).not.toBeInTheDocument();
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/book?when=soon');
  });
});

describe('the booking page honours what the card asked for', () => {
  it('preselects the ritual from ?ritual= and skips straight to the date step', async () => {
    search = 'ritual=griha-prabesh';
    render(<RegionProvider><BookPage /></RegionProvider>);

    expect(await screen.findByRole('heading', { name: /choose a date/i })).toBeInTheDocument();
    expect(screen.getByText(/step 2 of 3/i)).toBeInTheDocument();
    expect(screen.getByText('Griha Prabesh')).toBeInTheDocument();
  });

  it('ignores an unknown slug instead of hanging on an empty step', async () => {
    search = 'ritual=not-a-real-ritual';
    render(<RegionProvider><BookPage /></RegionProvider>);

    // Falls back to the catalogue.
    expect(await screen.findByText('Satyanarayan Puja')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /choose a date/i })).not.toBeInTheDocument();
  });

  it('narrows the date strip to two days for ?when=soon', async () => {
    search = 'ritual=satyanarayan-puja&when=soon';
    render(<RegionProvider><BookPage /></RegionProvider>);

    const strip = await screen.findByRole('group', { name: /choose a date/i });
    expect(strip.querySelectorAll('button')).toHaveLength(2);
    expect(screen.getByText(/showing the next 2 days only/i)).toBeInTheDocument();
  });

  it('can widen back to the full 21 days', async () => {
    search = 'ritual=satyanarayan-puja&when=soon';
    render(<RegionProvider><BookPage /></RegionProvider>);
    const strip = await screen.findByRole('group', { name: /choose a date/i });

    (screen.getByRole('button', { name: /show all 21 days/i })).click();
    await vi.waitFor(() => expect(strip.querySelectorAll('button').length).toBe(21));
  });

  it('marks a remote service as online rather than promising a home visit', async () => {
    search = 'browse=1';   // this assertion is about the catalogue card
    render(<RegionProvider><BookPage /></RegionProvider>);
    const card = (await screen.findByText('Online Aarti')).closest('.svc-card') as HTMLElement;

    expect(within(card).getByText('💻 Online')).toBeInTheDocument();
    expect(within(card).queryByText(/at your home/i)).not.toBeInTheDocument();
  });
});
