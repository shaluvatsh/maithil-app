import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RegionProvider } from '@/lib/region-context';
import { Nav } from '@/app/nav';
import AccountPage from '@/app/account/page';

const replace = vi.fn();
const push = vi.fn();
let pathname = '/';

// Stable identity on purpose: a fresh object each call is what turned a mount-only
// fetch into an unbounded render loop.
const router = { replace, push };
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams(''),
}));

const BOOKINGS = [
  {
    id: 'b1', state: 'confirmed', date: '2026-09-14', slotIdx: 1, slotSpan: 1,
    ritualName: 'Satyanarayan Puja', ritualSlug: 'satyanarayan-puja', paymentMode: 'cash',
    price: { totalPaise: 250000, tokenPaise: 25500, balancePaise: 224500 },
    panditName: 'Sri Nabakumar Chakraborty', panditPhone: '+919830000102', deliveryMode: 'at_home',
  },
  {
    id: 'b2', state: 'completed', date: '2026-06-02', slotIdx: 0, slotSpan: 1,
    ritualName: 'Griha Prabesh', ritualSlug: 'griha-prabesh', paymentMode: 'digital_full',
    price: { totalPaise: 410000, tokenPaise: 41000, balancePaise: 369000 },
    panditName: 'Sri Haradhan Ganguly', panditPhone: '+919830000101', deliveryMode: 'at_home',
  },
];

const ME = {
  id: 'u1', phone: '+919830000000', name: 'Om Prakash',
  role: 'devotee', locale: 'en', panjikaSchool: null,
};

const DETAIL_BY_ID: Record<string, unknown> = {
  b1: {
    ...BOOKINGS[0],
    cashCollectedPaise: null,
    price: {
      dakshinaPaise: 200000, samagriPaise: 40000, travelPaise: 0,
      platformFeePaise: 25500, discountPaise: 0, totalPaise: 250000,
      tokenPaise: 25500, balancePaise: 224500, commissionBps: 1500,
    },
    panditProfile: {
      experienceYears: 12, languages: ['bn', 'en'], traditions: ['smarta'],
      chantingSampleUrl: null, chantingSampleLabel: null,
    },
    timeline: [
      { id: 'e1', toState: 'pending_accept', trigger: 'submit', actorRole: 'devotee', at: '2026-09-01T00:00:00Z' },
      { id: 'e2', toState: 'confirmed', trigger: 'token_captured', actorRole: 'system', at: '2026-09-01T00:05:00Z' },
    ],
  },
  b2: {
    ...BOOKINGS[1],
    cashCollectedPaise: null,
    price: {
      dakshinaPaise: 350000, samagriPaise: 0, travelPaise: 0,
      platformFeePaise: 41000, discountPaise: 0, totalPaise: 410000,
      tokenPaise: 41000, balancePaise: 369000, commissionBps: 1000,
    },
    panditProfile: {
      experienceYears: 20, languages: ['bn'], traditions: ['vaishnava'],
      chantingSampleUrl: null, chantingSampleLabel: null,
    },
    timeline: [],
    myReviewSubmitted: false,
  },
  b4: {
    id: 'b4', state: 'draft', date: '2026-09-20', slotIdx: 2, slotSpan: 1,
    ritualName: 'Griha Prabesh', ritualSlug: 'griha-prabesh', paymentMode: 'cash',
    price: {
      dakshinaPaise: 200000, samagriPaise: 0, travelPaise: 0,
      platformFeePaise: 30000, discountPaise: 0, totalPaise: 230000,
      tokenPaise: 23000, balancePaise: 207000, commissionBps: 1500,
    },
    panditName: 'Sri Haradhan Ganguly', panditPhone: '+919830000101', deliveryMode: 'at_home',
    cashCollectedPaise: null,
    panditProfile: {
      experienceYears: 20, languages: ['bn'], traditions: ['vaishnava'],
      chantingSampleUrl: null, chantingSampleLabel: null,
    },
    timeline: [],
    myReviewSubmitted: false,
  },
  b5: {
    id: 'b5', state: 'reviewed', date: '2026-05-10', slotIdx: 0, slotSpan: 1,
    ritualName: 'Rudrabhishek', ritualSlug: 'rudrabhishek', paymentMode: 'cash',
    price: {
      dakshinaPaise: 300000, samagriPaise: 0, travelPaise: 0,
      platformFeePaise: 30000, discountPaise: 0, totalPaise: 330000,
      tokenPaise: 33000, balancePaise: 297000, commissionBps: 1500,
    },
    panditName: 'Sri Bipradas Bhattacharya', panditPhone: '+919876543211', deliveryMode: 'at_home',
    cashCollectedPaise: 297000,
    panditProfile: {
      experienceYears: 8, languages: ['hi'], traditions: ['smarta'],
      chantingSampleUrl: null, chantingSampleLabel: null,
    },
    timeline: [],
    // The purohit's side published via the 72h one-sided window; the devotee
    // never submitted anything - see reviews.service.ts publishExpired().
    myReviewSubmitted: false,
  },
};

function mockApi(bookings: unknown = BOOKINGS) {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const idMatch = /\/v1\/bookings\/([^/?]+)/.exec(url);

    if (method === 'POST' && idMatch && url.includes('/review')) {
      return new Response(JSON.stringify({ published: false }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    const body =
      url.includes('/v1/auth/me') ? ME
      : idMatch ? (DETAIL_BY_ID[idMatch[1]!] ?? null)
      : url.includes('/v1/bookings') ? bookings
      : url.includes('/v1/me/addresses') ? []
      : [];
    return new Response(JSON.stringify(body), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

const signIn = () => {
  localStorage.setItem('themaithil.token', 'test-token');
  localStorage.setItem('themaithil.role', 'devotee');
  localStorage.setItem('themaithil.name', 'Om Prakash');
};

beforeEach(() => {
  localStorage.clear();
  replace.mockClear(); push.mockClear();
  pathname = '/';
  mockApi();
});

/**
 * The regression this file exists for: the profile icon was `href={who ? '/book' : '/login'}`,
 * so a signed-in user tapping their own avatar landed on the booking form.
 */
describe('header account entry point', () => {
  it('never sends a signed-in user to the booking page from the account control', async () => {
    signIn();
    render(<RegionProvider><Nav /></RegionProvider>);

    const menu = await screen.findByLabelText('Account menu');
    await userEvent.click(menu);

    const items = await screen.findAllByRole('menuitem');
    const hrefs = items
      .map((el) => el.getAttribute('href'))
      .filter((h): h is string => h !== null);

    expect(hrefs.length).toBeGreaterThan(0);
    expect(hrefs.every((h) => h.startsWith('/account'))).toBe(true);
    expect(hrefs).not.toContain('/book');
  });

  it('offers bookings, profile and a sign out', async () => {
    signIn();
    render(<RegionProvider><Nav /></RegionProvider>);
    await userEvent.click(await screen.findByLabelText('Account menu'));

    expect(screen.getByRole('menuitem', { name: /my bookings/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /profile/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /sign out/i })).toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    signIn();
    render(<RegionProvider><Nav /></RegionProvider>);
    await userEvent.click(await screen.findByLabelText('Account menu'));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });

  it('sends a signed-out visitor to sign in, not to a dead menu', () => {
    render(<RegionProvider><Nav /></RegionProvider>);
    expect(screen.queryByLabelText('Account menu')).not.toBeInTheDocument();

    // The desktop header and the mobile menu each carry one.
    const signIn = screen.getAllByRole('link', { name: /sign in/i });
    expect(signIn.length).toBeGreaterThan(0);
    signIn.forEach((el) => expect(el).toHaveAttribute('href', '/login'));
  });

  it('points the bookings icon at the account page and badges what is live', async () => {
    signIn();
    render(<RegionProvider><Nav /></RegionProvider>);

    // One of the two fixtures is `confirmed`, the other `completed`.
    const link = await screen.findByLabelText(/my bookings, 1 upcoming/i);
    expect(link).toHaveAttribute('href', '/account');
  });
});

describe('account page', () => {
  it('bounces a signed-out visitor to login rather than rendering an empty shell', () => {
    render(<RegionProvider><AccountPage /></RegionProvider>);
    expect(replace).toHaveBeenCalledWith('/login?next=/account');
  });

  it('separates upcoming from past', async () => {
    signIn();
    render(<RegionProvider><AccountPage /></RegionProvider>);

    expect(await screen.findByText('Upcoming')).toBeInTheDocument();
    expect(screen.getByText('Past')).toBeInTheDocument();
    expect(screen.getByText('Satyanarayan Puja')).toBeInTheDocument();
    expect(screen.getByText('Griha Prabesh')).toBeInTheDocument();
  });

  it('asks for English ritual names, so history is not rendered in Bengali', async () => {
    signIn();
    render(<RegionProvider><AccountPage /></RegionProvider>);
    await screen.findByText('Satyanarayan Puja');

    const calls = (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const bookingCall = calls.map((c) => String(c[0])).find((u) => u.includes('/v1/bookings'));
    expect(bookingCall).toContain('locale=en');
  });

  it('gives a first-time user somewhere to go instead of a blank panel', async () => {
    signIn();
    mockApi([]);
    render(<RegionProvider><AccountPage /></RegionProvider>);

    expect(await screen.findByText(/no bookings yet/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /book a pooja/i })).toHaveAttribute('href', '/book');
  });

  it("shows the assigned purohit's name and phone on a live booking", async () => {
    signIn();
    render(<RegionProvider><AccountPage /></RegionProvider>);

    await screen.findByText('Satyanarayan Puja');
    expect(screen.getByText(/Sri Nabakumar Chakraborty/)).toBeInTheDocument();
    expect(screen.getByText(/\+919830000102/)).toBeInTheDocument();
  });

  /**
   * `cancel_devotee` is only declared in the state machine for draft,
   * pending_accept and confirmed - never in_progress. The Cancel button used
   * to show for `in_progress` too (grouped under the same "still upcoming"
   * set used for the Upcoming/Past split), so a devotee could click Cancel
   * while the purohit was mid-ritual at their door and get a 422 - a dead
   * button at the single worst moment to discover it doesn't work.
   */
  it('offers Cancel only for states the backend will actually accept', async () => {
    signIn();
    mockApi([
      {
        id: 'b3', state: 'in_progress', date: '2026-08-24', slotIdx: 0, slotSpan: 1,
        ritualName: 'Rudrabhishek', ritualSlug: 'rudrabhishek', paymentMode: 'cash',
        price: { totalPaise: 300000, tokenPaise: 30000, balancePaise: 270000 },
        panditName: 'Sri Bipradas Bhattacharya', panditPhone: '+919876543211', deliveryMode: 'at_home',
      },
      BOOKINGS[0],   // confirmed - still cancellable
    ]);
    render(<RegionProvider><AccountPage /></RegionProvider>);

    await screen.findByText('Rudrabhishek');
    await screen.findByText('Satyanarayan Puja');

    // Exactly one Cancel button: the confirmed booking's, not the in-progress one's.
    const cancelButtons = screen.getAllByRole('button', { name: /^cancel$/i });
    expect(cancelButtons).toHaveLength(1);
  });

  /**
   * A booking row showed a name, a date and a total - nothing about who was
   * coming beyond a phone number already fixed above, no itemised price, and
   * no way to see any of it again after the confirmation screen. Every field
   * asserted here already existed in the API response; none of it was ever
   * rendered anywhere a devotee could revisit.
   */
  it('opens a detail view on click with pandit profile, full price and timeline', async () => {
    signIn();
    render(<RegionProvider><AccountPage /></RegionProvider>);

    await userEvent.click(await screen.findByText('Satyanarayan Puja'));

    const dialog = await screen.findByRole('dialog');
    // Profile fields beyond the name/phone already on the card.
    expect(within(dialog).getByText(/12 years/)).toBeInTheDocument();
    expect(within(dialog).getByText(/bn, en/)).toBeInTheDocument();
    // Itemised price, not just the total the card already showed.
    expect(within(dialog).getByText('Dakshina')).toBeInTheDocument();
    expect(within(dialog).getByText('₹2,000')).toBeInTheDocument();
    expect(within(dialog).getByText('Pooja materials')).toBeInTheDocument();
    // The event timeline.
    expect(within(dialog).getByText(/awaiting payment|pay to confirm/i)).toBeInTheDocument();
    // Both the status tag and the timeline's own row read "Confirmed" - two
    // matches is the correct count, not an error to narrow away.
    expect(within(dialog).getAllByText(/^confirmed$/i).length).toBeGreaterThanOrEqual(2);
    // Support, using the site's one real WhatsApp number, not a placeholder.
    const wa = within(dialog).getByRole('link', { name: /whatsapp us/i });
    expect(wa).toHaveAttribute('href', expect.stringContaining('wa.me'));
  });

  it('closes the detail view on Escape', async () => {
    signIn();
    const user = userEvent.setup();
    render(<RegionProvider><AccountPage /></RegionProvider>);

    await user.click(await screen.findByText('Satyanarayan Puja'));
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  /** The endpoint already existed; nothing anywhere called it before this. */
  it('lets a devotee leave feedback on a completed booking', async () => {
    signIn();
    const user = userEvent.setup();
    render(<RegionProvider><AccountPage /></RegionProvider>);

    await user.click(await screen.findByText('Griha Prabesh'));
    const dialog = await screen.findByRole('dialog');

    const purohitGroup = within(dialog).getByRole('radiogroup', { name: 'The purohit' });
    await user.click(within(purohitGroup).getByRole('radio', { name: '5 stars' }));

    const submit = within(dialog).getByRole('button', { name: /submit feedback/i });
    expect(submit).not.toBeDisabled();
    await user.click(submit);

    await within(dialog).findByText(/thank you for your feedback/i);
  });

  /**
   * `/book`'s `book()` creates the booking then submits it as two separate
   * requests; if the tab closes or the connection drops between them, the
   * booking is left in `draft` forever - nothing sweeps it and `payment-intent`
   * (payments.service.ts) rejects anything that isn't `pending_accept`. The
   * account page's Pay button used to check `state === 'pending_accept'` only,
   * so a stuck draft had no way out at all.
   */
  it('offers a way to resume and pay a booking stuck in draft', async () => {
    signIn();
    const user = userEvent.setup();
    mockApi([
      { ...DETAIL_BY_ID.b4 as object },
    ]);
    render(<RegionProvider><AccountPage /></RegionProvider>);

    await user.click(await screen.findByText('Griha Prabesh'));
    const dialog = await screen.findByRole('dialog');

    const pay = within(dialog).getByRole('button', { name: /pay .* to confirm/i });
    await user.click(pay);

    await waitFor(() => expect(
      within(dialog).queryByRole('button', { name: /pay .* to confirm/i }),
    ).not.toBeInTheDocument());

    const calls = (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const posted = calls
      .filter((c) => (c[1] as RequestInit | undefined)?.method === 'POST')
      .map((c) => String(c[0]));
    expect(posted.some((u) => u.endsWith('/v1/bookings/b4/submit'))).toBe(true);
    expect(posted.some((u) => u.endsWith('/v1/bookings/b4/payment-intent'))).toBe(true);
  });

  /**
   * `state === 'reviewed'` used to be read as "you already left feedback," but
   * it also covers the 72-hour one-sided publish that fires off just the
   * purohit's review (reviews.service.ts publishExpired). A devotee who never
   * reviewed was shown "thank you for your feedback" for something they never
   * did, with no way to actually leave one - the backend has always accepted a
   * late review against a `reviewed` booking.
   */
  it('still offers the feedback form on a reviewed booking the devotee never rated', async () => {
    signIn();
    const user = userEvent.setup();
    mockApi([
      { ...DETAIL_BY_ID.b5 as object },
    ]);
    render(<RegionProvider><AccountPage /></RegionProvider>);

    await user.click(await screen.findByText('Rudrabhishek'));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByText(/how was it/i)).toBeInTheDocument();
    expect(within(dialog).queryByText(/thank you for your feedback/i)).not.toBeInTheDocument();
  });

  it('switches tabs without losing the loaded data', async () => {
    signIn();
    render(<RegionProvider><AccountPage /></RegionProvider>);
    await screen.findByText('Satyanarayan Puja');

    await userEvent.click(screen.getByRole('tab', { name: /profile/i }));
    // The header shows it too, so there are legitimately two.
    await waitFor(() => expect(screen.getAllByText('+919830000000').length).toBe(2));

    await userEvent.click(screen.getByRole('tab', { name: /my bookings/i }));
    expect(await screen.findByText('Satyanarayan Puja')).toBeInTheDocument();
  });
});
