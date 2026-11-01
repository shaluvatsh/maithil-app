import { setSearch, bookableTimes, TODAY } from './setup';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RegionProvider } from '@/lib/region-context';
import { auth } from '@/lib/api';
import BookPage from '@/app/book/page';

const CATEGORIES = [
  { id: 'festival-pujas', en: 'Festival Pujas', blurb: 'Durga, Kali, Lakshmi', emoji: '🪔', tint: '#eee', count: 10 },
  { id: 'life-ceremonies', en: 'Life Ceremonies', blurb: 'Naming, first rice', emoji: '👶', tint: '#eee', count: 4 },
];

const RITUALS = [{
  id: 'r1', slug: 'satyanarayan-puja', name: 'Satyanarayan Puja',
  shortDescription: 'Full katha and puja with sinni',
  durationMin: 120, defaultSlotSpan: 1, bomTotalPaise: 80000,
  priceBand: { minPaise: 110000, maxPaise: 250000, defaultPaise: 150000 },
}];

/** Routes each endpoint to a fixture so the flow can actually be walked. */
function mockApi() {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body =
      url.includes('/v1/categories') ? CATEGORIES
      : url.includes('/v1/rituals') ? RITUALS
      : url.includes('/v1/panchang') ? []
      : url.includes('/v1/availability/times') ? bookableTimes()
      : url.includes('/v1/search/pandits') ? { results: [{ id: 'p1', name: 'Sri Test' }] }
      : [];
    return new Response(JSON.stringify(body), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

const open = () => render(<RegionProvider><BookPage /></RegionProvider>);

/**
 * Service cards now carry two actions — Details and Select — because "Learn More"
 * and "Book Now" previously did the same thing. Clicking the title is no longer a
 * selection.
 */
async function selectService(user: ReturnType<typeof userEvent.setup>) {
  const card = (await screen.findByText('Satyanarayan Puja'))
    .closest('.svc-card') as HTMLElement;
  await user.click(within(card).getByRole('button', { name: /select/i }));
}

beforeEach(() => { // /book opens on the occasion picker now; these suites test the catalogue.
  setSearch('browse=1');
  localStorage.clear(); mockApi(); });

describe('booking flow, signed out', () => {
  it('loads the catalogue and shows a service card', async () => {
    open();
    expect(await screen.findByText('Satyanarayan Puja')).toBeInTheDocument();
  });

  it('shows skeletons first rather than an empty page', () => {
    open();
    expect(document.querySelectorAll('.skeleton-card').length).toBeGreaterThan(0);
  });

  it('reveals the date strip as a labelled horizontal scroller', async () => {
    const user = userEvent.setup();
    open();
    await selectService(user);

    const strip = await screen.findByRole('group', { name: /Choose a date/i });
    expect(strip).toBeInTheDocument();
    // It must scroll inside itself, not widen the page.
    expect(strip).toHaveClass('daystrip');
  });

  it('shows the sticky mobile action bar once a service is chosen', async () => {
    const user = userEvent.setup();
    open();
    await selectService(user);
    await waitFor(() => expect(document.querySelector('.mobile-cta')).toBeTruthy());
    expect(document.querySelector('.mobile-cta')!.textContent).toMatch(/Choose a date/i);
  });

  it('keeps the running estimate in the summary panel', async () => {
    const user = userEvent.setup();
    open();
    await selectService(user);
    expect(await screen.findByText(/Estimated total/i)).toBeInTheDocument();
  });

  it('says so plainly when a search matches nothing', async () => {
    const user = userEvent.setup();
    open();
    await screen.findByText('Satyanarayan Puja');
    await user.type(screen.getByPlaceholderText(/Search services/i), 'zzzz');
    expect(await screen.findByText(/No services match those filters/i)).toBeInTheDocument();
  });

  it('offers category chips that narrow the catalogue', async () => {
    const user = userEvent.setup();
    open();
    await screen.findByText('Satyanarayan Puja');
    const bar = await screen.findByRole('group', { name: /Filter by category/i });
    expect(within(bar).getByRole('button', { name: /All services/i })).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: /Festival Pujas/i })).toBeInTheDocument();
    await user.click(within(bar).getByRole('button', { name: /Festival Pujas/i }));
    // Filtering happens server-side, so the request must carry the category.
    const urls = (global.fetch as unknown as { mock: { calls: unknown[][] } })
      .mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('category=festival-pujas'))).toBe(true);
  });

  it('never nests interactive elements once the flow is open', async () => {
    const user = userEvent.setup();
    const { container } = open();
    await selectService(user);
    expect(container.querySelectorAll('a button, button a, button button, a a')).toHaveLength(0);
  });
});

/**
 * The booking page used to end in a plain, unfiltered dump of the devotee's
 * entire booking history - duplicating /account, which already groups
 * upcoming/past and lets you cancel, and out of place on a page whose job is
 * starting ONE new booking. It's gone now; the confirmation step links out to
 * /account instead. This walks the real flow end to end so a regression that
 * silently breaks payment confirmation (wrong field name, stale closure, a
 * network call that should have been a no-op) fails loudly here.
 */
describe('booking flow, signed in — create, pay, confirm', () => {
  const ADDRESS = { id: 'addr1', label: 'Home', line1: '12 Hindusthan Park', line2: null, pincode: '700029' };
  const PANDIT_RESULT = {
    id: 'p1', name: 'Sharma ji', experienceYears: 12, languages: ['bn'],
    rating: 4.6, ratingCount: 20, pricePaise: 150000, distanceKm: 2, isNewPandit: false,
  };
  const PRICE = {
    dakshinaPaise: 150000, samagriPaise: 84000, travelPaise: 0, platformFeePaise: 22500,
    discountPaise: 0, totalPaise: 256500, tokenPaise: 22500, balancePaise: 234000,
    surgeBps: 10000, commissionBps: 1500,
  };

  function mockSignedInApi() {
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const json = (body: unknown) => new Response(JSON.stringify(body), {
        status: 200, headers: { 'content-type': 'application/json' },
      });

      // A panjika already on file, so the flow is not interrupted by the prompt.
      if (url.includes('/v1/auth/me')) return json({ panjikaSchool: 'gupta_press' });
      if (url.includes('/v1/me/addresses')) return json([ADDRESS]);
      if (url.includes('/v1/availability/times')) return json(bookableTimes());
      if (url.includes('/v1/categories')) return json(CATEGORIES);
      if (url.includes('/v1/rituals')) return json(RITUALS);
      if (url.includes('/v1/panchang')) return json([]);
      if (url.includes('/v1/search/pandits')) return json({ results: [PANDIT_RESULT] });
      if (/\/v1\/bookings$/.test(url) && method === 'GET') return json([]);   // nothing booked yet
      if (/\/v1\/bookings$/.test(url) && method === 'POST') {
        return json({ id: 'b1', price: PRICE, slotSpan: 1, pandit: { id: 'p1', name: 'Sharma ji', experienceYears: 12 } });
      }
      if (/\/v1\/bookings\/b1\/submit$/.test(url)) return json({ id: 'b1', state: 'pending_accept' });
      if (/\/v1\/bookings\/b1\/payment-intent$/.test(url)) return json({});
      if (/\/v1\/dev\/bookings\/b1\/simulate-token-capture$/.test(url)) {
        return json({ startOtp: '111111', completeOtp: '222222' });
      }
      return json([]);
    }) as unknown as typeof fetch;
  }

  beforeEach(() => {
    setSearch('browse=1');
    localStorage.clear();
    mockSignedInApi();
    auth.set('test-access-token', 'devotee', 'Test Devotee');
  });

  it('takes a booking through to a confirmed payment, then points at /account', async () => {
    const user = userEvent.setup();
    open();

    await selectService(user);

    const dateGroup = await screen.findByRole('group', { name: /Choose a date/i });
    await user.click(within(dateGroup).getAllByRole('button')[0]!);

    // The four fixed slots are gone; the devotee picks a time (ADR 0013).
    const timegrid = await waitFor(() => document.querySelector('.timegrid') as HTMLElement);
    await user.click(within(timegrid).getAllByRole('button')[0]!);

    // The search resolved with a match, and the options card is now on screen.
    // Two matches: the desktop options card AND the always-rendered mobile sticky
    // CTA - either fires the same `book()`, so which one is clicked is arbitrary.
    const [bookBtn] = await screen.findAllByRole('button', { name: /review and book/i });
    await user.click(bookBtn!);

    // Draft created and submitted - the "pay to confirm" step is up.
    await screen.findByText(/held for/i);
    await user.click(await screen.findByRole('button', { name: /pay.*to confirm/i }));

    // Paid and confirmed: the OTP codes render, and the way back to the
    // devotee's own booking list is a link to /account, not a second copy of
    // the list on this page.
    await screen.findByText(/confirmed\. your booking is set/i);
    const viewBookings = await screen.findByRole('link', { name: /view your bookings/i });
    expect(viewBookings).toHaveAttribute('href', '/account');
  });
});

/**
 * Signing in MID-BOOKING, and coming back to what you had.
 *
 * This hand-off is the one place in the flow where a devotee is deliberately sent
 * away, so "resumes exactly where they left off" is a promise rather than a nicety.
 * It was broken by the ADR 0013 migration and nothing noticed, because the failure
 * is silent in three separate places at once.
 *
 * `book()` writes `startsAt` into `themaithil.pending`. The resume effect read
 * `p.slotIdx` — a field that payload has not carried since the flow stopped using
 * slot indices. So `slotIdx` was `undefined`, the search URL carried the literal
 * string "undefined", `z.coerce.number()` made it `NaN`, `.int()` rejected it, and
 * the resulting 422 was swallowed by `.catch(() => {})`.
 *
 * The devotee chose a ritual, a date and a time, signed in, came back — and found
 * the time blank and no purohits, at the exact moment they had decided to buy.
 */
describe('resuming a booking after signing in', () => {
  const PENDING = {
    ritualId: 'r1',
    date: TODAY,
    startsAt: `${TODAY}T09:00:00+05:30`,
    samagri: 'pandit_brings' as const,
    payment: 'cash' as const,
  };

  it('restores the chosen time, not just the ritual and date', async () => {
    auth.set('test-access-token', 'devotee', 'Om');
    sessionStorage.setItem('themaithil.pending', JSON.stringify(PENDING));
    open();

    // The purohit step only renders once a time is restored; before the fix the
    // flow stalled on the date step with the time unset.
    expect(await screen.findByText(/pandits? (is|are) free at this time/i))
      .toBeInTheDocument();
  });

  it('asks the server for the saved window, never a slot index', async () => {
    auth.set('test-access-token', 'devotee', 'Om');
    sessionStorage.setItem('themaithil.pending', JSON.stringify(PENDING));
    open();
    await screen.findByText(/pandits? (is|are) free at this time/i);

    const calls = (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const search = calls.map((c) => String(c[0]))
      .find((u) => u.includes('/v1/search/pandits'));

    expect(search).toBeTruthy();
    expect(search).toContain('startsAt=');
    expect(search).toContain('endsAt=');
    // The exact shape of the old bug, which a `.catch(() => {})` hid completely.
    expect(search).not.toContain('slotIdx');
    expect(search).not.toContain('undefined');
  });

  /**
   * The window can be taken by someone else while they are signing in — which is
   * precisely the gap this path opens. Better to say so here than to let them press
   * Review and book and meet `createBooking`'s refusal.
   */
  it('says so plainly when the saved time was taken during sign-in', async () => {
    auth.set('test-access-token', 'devotee', 'Om');
    sessionStorage.setItem('themaithil.pending', JSON.stringify(PENDING));
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body =
        url.includes('/v1/categories') ? CATEGORIES
        : url.includes('/v1/rituals') ? RITUALS
        : url.includes('/v1/panchang') ? []
        : url.includes('/v1/availability/times') ? bookableTimes()
        : url.includes('/v1/search/pandits') ? { results: [] }
        : [];
      return new Response(JSON.stringify(body), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    open();

    expect(await screen.findByText(/taken while you were signing in/i)).toBeInTheDocument();
  });

  /** A tab left open across a deploy carries the older payload; it must not throw. */
  it('still restores what it can from a payload with no saved time', async () => {
    auth.set('test-access-token', 'devotee', 'Om');
    const { startsAt: _omitted, ...legacy } = PENDING;
    sessionStorage.setItem('themaithil.pending', JSON.stringify(legacy));
    open();

    // The ritual is restored, so the flow continues from the date step rather than
    // resetting to the catalogue.
    expect(await screen.findByRole('group', { name: /Choose a date/i })).toBeInTheDocument();
  });
});
