import { setSearch } from './setup';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RegionProvider } from '@/lib/region-context';
import BookPage from '@/app/book/page';

const RITUALS = [{
  id: 'r1', slug: 'satyanarayan-puja', name: 'Satyanarayan Puja',
  shortDescription: 'Full katha and puja with sinni',
  durationMin: 120, defaultSlotSpan: 1, bomTotalPaise: 80000,
  priceBand: { minPaise: 110000, maxPaise: 250000, defaultPaise: 150000 },
}];

const PANDITS = [{
  id: 'p1', name: 'Ramesh Jha', experienceYears: 18, languages: ['Bengali', 'Hindi'],
  rating: 4.8, ratingCount: 62, pricePaise: 150000, distanceKm: 3.2, isNewPandit: false,
}];

/** Lets a test hold the pandit search open to observe the in-between state. */
let releaseSearch: (() => void) | null = null;

function mockApi(opts: { pandits?: unknown[]; slowSearch?: boolean } = {}) {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);

    if (url.includes('/v1/search/pandits')) {
      if (opts.slowSearch) {
        await new Promise<void>((resolve) => { releaseSearch = resolve; });
      }
      return new Response(JSON.stringify({ results: opts.pandits ?? PANDITS }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }

    const body =
      url.includes('/v1/categories') ? []
      : url.includes('/v1/rituals') ? RITUALS
      : url.includes('/v1/panchang') ? []
      : [];
    return new Response(JSON.stringify(body), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

const open = () => render(<RegionProvider><BookPage /></RegionProvider>);

/** Walks to the point where dates are on screen. */
async function toDateStep() {
  open();
  const card = (await screen.findByText('Satyanarayan Puja'))
    .closest('.svc-card') as HTMLElement;
  await userEvent.click(within(card).getByRole('button', { name: /select/i }));
  return screen.findByRole('group', { name: /choose a date/i });
}

const firstDay = (strip: HTMLElement) =>
  strip.querySelectorAll('button')[0] as HTMLButtonElement;

beforeEach(() => {
  // /book opens on the occasion picker now; these suites test the catalogue.
  setSearch('browse=1');
  localStorage.clear();
  releaseSearch = null;
  mockApi();
  // jsdom implements neither, and both are called on every step transition.
  Element.prototype.scrollIntoView = vi.fn();
  window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as unknown as typeof window.matchMedia;
});

describe('the booking flow tells you what to do next', () => {
  it('labels the stage so "date and time" is not one undifferentiated blob', async () => {
    await toDateStep();
    expect(screen.getByText(/step 2 of 3/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /choose a date/i })).toBeInTheDocument();
  });

  it('prompts for a date before showing any times', async () => {
    await toDateStep();
    expect(screen.getByText(/pick a date to see which times are open/i)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /choose a time/i })).not.toBeInTheDocument();
  });

  it('reveals the time grid once a date is picked, and says what it unlocks', async () => {
    const strip = await toDateStep();
    await userEvent.click(firstDay(strip));

    expect(await screen.findByRole('heading', { name: /choose a time on/i })).toBeInTheDocument();
    expect(screen.getByText(/pick a time/i)).toBeInTheDocument();
  });

  it('scrolls the newly revealed section into view rather than leaving it below the fold',
    async () => {
      const strip = await toDateStep();
      await userEvent.click(firstDay(strip));
      await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
    });

  /**
   * The original complaint. Choosing a time fired a search and rendered nothing until
   * it returned, so the click looked like it had failed.
   */
  it('acknowledges a time selection immediately instead of appearing to do nothing',
    async () => {
      mockApi({ slowSearch: true });
      const strip = await toDateStep();
      await userEvent.click(firstDay(strip));
      await userEvent.click((await screen.findAllByRole('button', { pressed: false }))
        .find((b) => /am|pm/i.test(b.textContent ?? ''))!);

      // Still in flight: the user must see that something is happening.
      expect(await screen.findByRole('status')).toHaveTextContent(/checking who is free/i);

      releaseSearch?.();
      // The devotee is not shown a list to pick from — the platform assigns and
      // the flow moves straight to confirmation. ADR 0012.
      expect(await screen.findByText(/step 3 of 3/i)).toBeInTheDocument();
      expect(screen.queryByText('Ramesh Jha')).not.toBeInTheDocument();
    });

  it('reports an empty slot beside the slots, not in a banner at the top of the page',
    async () => {
      mockApi({ pandits: [] });
      const strip = await toDateStep();
      await userEvent.click(firstDay(strip));
      await userEvent.click((await screen.findAllByRole('button', { pressed: false }))
        .find((b) => /am|pm/i.test(b.textContent ?? ''))!);

      const msg = await screen.findByText(/no pandit is free in that slot/i);
      expect(msg).toBeInTheDocument();
      // And it offers a way forward.
      expect(screen.getByRole('button', { name: /pick another time/i })).toBeInTheDocument();
    });

  it('keeps a running "next" cue in the summary at every stage', async () => {
    const strip = await toDateStep();
    expect(screen.getByText(/next: choose a date/i)).toBeInTheDocument();

    await userEvent.click(firstDay(strip));
    expect(await screen.findByText(/next: choose a time/i)).toBeInTheDocument();
  });

  it('lets a completed step be revisited from the stepper', async () => {
    const strip = await toDateStep();
    await userEvent.click(firstDay(strip));
    await screen.findByRole('heading', { name: /choose a time on/i });

    // Step 1 is behind us, so it is navigable. Exact name: "Change service" also
    // matches a loose /service/i.
    const service = screen.getByRole('button', { name: 'Service' });
    expect(service).toBeEnabled();
    await userEvent.click(service);

    expect(await screen.findByText('Satyanarayan Puja')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /choose a date/i })).not.toBeInTheDocument();
  });

  it('never disables the mobile action, so the one visible control always advances',
    async () => {
      const strip = await toDateStep();
      const cta = screen.getByRole('button', { name: /choose a date/i });
      expect(cta).toBeEnabled();

      await userEvent.click(firstDay(strip));
      expect(await screen.findByRole('button', { name: /choose a time/i })).toBeEnabled();
    });
});
