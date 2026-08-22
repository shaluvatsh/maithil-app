import { setSearch } from './setup';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RegionProvider } from '@/lib/region-context';
import BookPage from '@/app/book/page';

/**
 * The front door.
 *
 * A family knows "we are moving into a new flat", not "Griha Prabesh". Opening on a
 * search box over Sanskrit names asks them to already know the answer they came for.
 * These tests pin the behaviour that replaces it.
 */
const RITUALS = [
  {
    id: 'r1', slug: 'griha-prabesh', name: 'Griha Prabesh',
    shortDescription: 'House-warming puja with homa', category: 'home-and-new-beginnings',
    durationMin: 180, defaultSlotSpan: 1, bomTotalPaise: 120000, deliveryMode: 'at_home',
    priceBand: { minPaise: 210000, maxPaise: 510000, defaultPaise: 310000 },
  },
  {
    id: 'r2', slug: 'bastu-puja', name: 'Bastu Puja',
    shortDescription: 'Vastu shanti', category: 'home-and-new-beginnings',
    durationMin: 180, defaultSlotSpan: 1, bomTotalPaise: 100000, deliveryMode: 'at_home',
    priceBand: { minPaise: 210000, maxPaise: 610000, defaultPaise: 310000 },
  },
  {
    id: 'r3', slug: 'satyanarayan-puja', name: 'Satyanarayan Puja',
    shortDescription: 'Full katha with sinni', category: 'festival-pujas',
    durationMin: 120, defaultSlotSpan: 1, bomTotalPaise: 80000, deliveryMode: 'at_home',
    priceBand: { minPaise: 110000, maxPaise: 250000, defaultPaise: 150000 },
  },
];

beforeEach(() => {
  setSearch('');                 // the real default: no query string
  localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as unknown as typeof window.matchMedia;
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes('/v1/rituals') ? RITUALS
      : url.includes('/v1/search/pandits') ? { results: [] }
      : [];
    return new Response(JSON.stringify(body), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

const open = () => render(<RegionProvider><BookPage /></RegionProvider>);

describe('booking opens with the occasion, not the catalogue', () => {
  it('asks what the occasion is', async () => {
    open();
    expect(await screen.findByText(/what is the occasion/i)).toBeInTheDocument();
  });

  it('does not put a catalogue of Sanskrit names in front of the devotee first', () => {
    open();
    expect(screen.queryByPlaceholderText(/search services/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Griha Prabesh')).not.toBeInTheDocument();
  });

  it('offers the situation in the words a family would use', async () => {
    open();
    expect(await screen.findByText(/moving into a new home/i)).toBeInTheDocument();
    expect(screen.getByText(/remembering someone who has passed/i)).toBeInTheDocument();
  });

  it('turns an occasion into the rituals it means, each saying what it does', async () => {
    open();
    await userEvent.click(await screen.findByText(/moving into a new home/i));

    expect(await screen.findByText('Griha Prabesh')).toBeInTheDocument();
    expect(screen.getByText('Bastu Puja')).toBeInTheDocument();
    expect(screen.getByText(/kalash, homa and the first cooking/i)).toBeInTheDocument();
  });

  /** The question every family has, that no competitor answers. */
  it('says whether you need more than one', async () => {
    open();
    await userEvent.click(await screen.findByText(/moving into a new home/i));
    expect(await screen.findByText(/Satyanarayan is often done a few days later/i))
      .toBeInTheDocument();
  });

  it('ranks what you usually want above what some families add', async () => {
    open();
    await userEvent.click(await screen.findByText(/moving into a new home/i));

    await screen.findByText('Griha Prabesh');
    const cards = document.querySelectorAll('.occ-ritual');
    expect(cards.length).toBeGreaterThan(1);

    const first = cards[0] as HTMLElement;
    expect(first).toHaveTextContent('Griha Prabesh');
    // The weight is stated, not merely implied by order.
    expect(within(first).getByText(/usually this one/i)).toBeInTheDocument();

    const last = cards[cards.length - 1] as HTMLElement;
    expect(last).toHaveTextContent('Satyanarayan Puja');
    expect(within(last).getByText(/some families/i)).toBeInTheDocument();
  });

  it('hides rituals this city does not sell rather than offering a dead end', async () => {
    // 'ancestors' suggests sraddha and tarpan; neither is in this fixture.
    open();
    await userEvent.click(await screen.findByText(/remembering someone who has passed/i));
    expect(await screen.findByText(/nothing listed for this yet/i)).toBeInTheDocument();
  });

  it('picking a ritual goes straight to the date step', async () => {
    open();
    await userEvent.click(await screen.findByText(/moving into a new home/i));
    await userEvent.click(await screen.findByText('Griha Prabesh'));

    expect(await screen.findByRole('heading', { name: /choose a date/i })).toBeInTheDocument();
  });

  it('lets someone who knows what they want skip the question entirely', async () => {
    open();
    await userEvent.click(await screen.findByText(/show me everything/i));
    expect(await screen.findByPlaceholderText(/search services/i)).toBeInTheDocument();
  });

  it('does not ask the question when the devotee already said what they want', async () => {
    setSearch('ritual=griha-prabesh');
    open();
    expect(await screen.findByRole('heading', { name: /choose a date/i })).toBeInTheDocument();
    expect(screen.queryByText(/what is the occasion/i)).not.toBeInTheDocument();
  });

  it('goes straight to the catalogue when arriving from a category link', async () => {
    setSearch('category=festival-pujas');
    open();
    expect(await screen.findByPlaceholderText(/search services/i)).toBeInTheDocument();
    expect(screen.queryByText(/what is the occasion/i)).not.toBeInTheDocument();
  });
});
