import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RegionProvider } from '@/lib/region-context';
import { Nav } from '@/app/nav';
import AccountPage from '@/app/account/page';

const replace = vi.fn();
const push = vi.fn();
let pathname = '/';
/**
 * The query the page is mounted with. Mutable because the account page now reads
 * BOTH `?tab=` and `?booking=` from it to restore what the reader was looking at,
 * and a test cannot cover that against a hardcoded empty string.
 */
let search = '';

// Stable identity on purpose: a fresh object each call is what turned a mount-only
// fetch into an unbounded render loop.
const router = { replace, push };
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams(search),
}));

/**
 * Dates are RELATIVE to the run, never literals.
 *
 * `b1` was pinned to 2026-09-14 with the comment "comfortably more than 24h from
 * any real test-run wall clock" — an assumption with an expiry date on it. Once the
 * calendar passed the 14th the booking was in the past, the 24-hour reschedule gate
 * correctly hid "Change date", and two tests began failing for a reason that had
 * nothing to do with the code they cover.
 *
 * A fixture that encodes "far enough in the future" has to compute it.
 */
const inDays = (n: number, hhmm = '09:30') => {
  const d = new Date(Date.now() + n * 86_400_000);
  return `${d.toISOString().slice(0, 10)}T${hhmm}:00+05:30`;
};
const isoDate = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

const BOOKINGS = [
  {
    id: 'b1', state: 'confirmed', date: isoDate(14), slotIdx: 1, slotSpan: 1,
    ritualName: 'Satyanarayan Puja', ritualSlug: 'satyanarayan-puja', paymentMode: 'cash',
    price: { totalPaise: 250000, tokenPaise: 25500, balancePaise: 224500 },
    panditName: 'Sri Nabakumar Chakraborty', panditPhone: '+919830000102',
    panditId: 'pandit-1', deliveryMode: 'at_home',
    // Two weeks out: past the 24-hour reschedule gate whenever this runs.
    slotStartAt: inDays(14, '09:30'),
    // The API returns both. The fixture carried only the start.
    slotEndAt: inDays(14, '12:30'),
  },
  {
    id: 'b2', state: 'completed', date: isoDate(-100), slotIdx: 0, slotSpan: 1,
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
  /* Virtual: still carries a saved address, because nothing clears it. */
  b6: {
    id: 'b6', state: 'confirmed', date: '2026-09-29', slotIdx: 0, slotSpan: 1,
    ritualName: 'Virtual Consultation', ritualSlug: 'virtual-consultation',
    paymentMode: 'digital_full', deliveryMode: 'virtual',
    price: {
      dakshinaPaise: 110000, samagriPaise: 0, travelPaise: 0,
      platformFeePaise: 13200, discountPaise: 0, totalPaise: 123200,
      tokenPaise: 13200, balancePaise: 110000, commissionBps: 1200,
    },
    panditName: 'Sri Nabakumar Chakraborty', panditPhone: '+919830000102',
    cashCollectedPaise: null,
    panditProfile: {
      experienceYears: 15, languages: ['bn'], traditions: ['smarta'],
      chantingSampleUrl: null, chantingSampleLabel: null,
    },
    timeline: [],
    myReviewSubmitted: false,
    venue: {
      label: 'Home', line1: '12 Hindusthan Park', line2: null,
      pincode: '700029', lat: 22.51, lng: 88.36,
    },
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

/**
 * The same purohit's calendar for a reschedule. Two open days, one full day,
 * so a test can assert the full day is offered no slots and the open day is.
 */
const AVAILABILITY = [
  { date: '2026-09-16', slots: [{ slotIdx: 0, status: 'open' }, { slotIdx: 1, status: 'booked' }] },
  { date: '2026-09-17', slots: [{ slotIdx: 0, status: 'booked' }, { slotIdx: 1, status: 'booked' }] },
];

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
    if (method === 'POST' && idMatch && url.includes('/reschedule')) {
      const b = DETAIL_BY_ID[idMatch[1]!] as Record<string, unknown> | undefined;
      const parsed = JSON.parse(String(init?.body ?? '{}')) as { date: string; slotIdx: number };
      if (b) {
        b.date = parsed.date; b.slotIdx = parsed.slotIdx;
        // The one booking this file uses to reproduce the "confirmation swallowed
        // by the new 24h rule" bug: its post-reschedule slot lands soon, the way
        // "the next open slot" often genuinely does.
        if (idMatch[1] === 'b9') b.slotStartAt = new Date(Date.now() + 3 * 3_600_000).toISOString();
      }
      return new Response(JSON.stringify({ id: idMatch[1], state: 'confirmed', ...parsed }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    if (method === 'POST' && url.includes('/v1/me/addresses')) {
      const sent = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      // Shaped like the real response: the API resolves `citySlug` to a city and
      // returns the NAME, so the row it hands back can go straight into the list.
      return new Response(JSON.stringify({
        id: 'addr-new', ...sent, city: 'Kolkata',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (method === 'GET' && url.includes('/v1/availability')) {
      return new Response(JSON.stringify(AVAILABILITY), {
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
  search = '';
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

  /**
   * The name stays on the row; the phone number moved into the detail view.
   * Ten rows of raw digits is not something anyone reads at a glance, and it
   * was not tappable on the one device that could have dialled it — the detail
   * view now offers it as a Call button instead.
   */
  it("shows the assigned purohit's name on a live booking, and can call them from the detail", async () => {
    signIn();
    const user = userEvent.setup();
    render(<RegionProvider><AccountPage /></RegionProvider>);

    await screen.findByText('Satyanarayan Puja');
    expect(screen.getByText(/Sri Nabakumar Chakraborty/)).toBeInTheDocument();

    await user.click(screen.getByText('Satyanarayan Puja'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('link', { name: /^call$/i }))
      .toHaveAttribute('href', 'tel:+919830000102');
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
    const user = userEvent.setup();
    render(<RegionProvider><AccountPage /></RegionProvider>);

    // b1 is confirmed — cancellable, and the refund rule is stated BEFORE the
    // decision rather than in a confirm() after it.
    await user.click(await screen.findByText('Satyanarayan Puja'));
    let dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: /cancel booking/i })).toBeInTheDocument();
    expect(within(dialog).getByText(/full refund/i)).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    // b2 is completed — nothing to cancel, and the backend would reject it.
    await user.click(screen.getByText('Griha Prabesh'));
    dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('button', { name: /cancel booking/i })).not.toBeInTheDocument();
  });

  /**
   * Cancelling is destructive and used to sit inside a card whose entire surface
   * is a button, directly beneath the price. On a phone that is one mis-tap from
   * "open my booking" to "cancel my booking".
   */
  /**
   * A remote service keeps whatever address the devotee had saved — nothing
   * clears it, because nobody is travelling to it. Rendering the venue and the
   * online note independently put "Where: 12 Hindusthan Park" directly above
   * "Where: Online" on the same booking.
   */
  it('shows one Where, and for a virtual booking it is the online one', async () => {
    signIn();
    const user = userEvent.setup();
    mockApi([{ ...DETAIL_BY_ID.b6 as object }]);
    render(<RegionProvider><AccountPage /></RegionProvider>);

    await user.click(await screen.findByText('Virtual Consultation'));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getAllByText('Where')).toHaveLength(1);
    expect(within(dialog).getByText(/sends the video link/i)).toBeInTheDocument();
    expect(within(dialog).queryByText(/Hindusthan Park/)).not.toBeInTheDocument();
  });

  /**
   * The line under "Where" used to promise that "joining details are sent on
   * WhatsApp before the ceremony" — for a ₹499 product with no video anywhere in
   * the system: no meeting link, no recording, on the booking row or any other.
   * A devotee could pay for a live aarti and neither side had a way to reach the
   * other. Once the purohit sets a link, the screen shows the link rather than
   * describing a message.
   */
  it('shows the actual join link once the purohit has sent one', async () => {
    signIn();
    const user = userEvent.setup();
    // The detail view is always served from DETAIL_BY_ID, so the override has to
    // go on the fixture rather than on the list passed to mockApi().
    const b6 = DETAIL_BY_ID.b6 as Record<string, unknown>;
    b6.joinUrl = 'https://meet.google.com/abc-defg-hij';
    // The LIST has to carry b6 for the row to be clickable; the DETAIL comes from
    // the fixture above, which is what the dialog actually renders.
    mockApi([{ ...b6 }]);
    try {
      render(<RegionProvider><AccountPage /></RegionProvider>);

      await user.click(await screen.findByText('Virtual Consultation'));
      const dialog = await screen.findByRole('dialog');

      const link = within(dialog).getByRole('link', { name: /join the ceremony/i });
      expect(link).toHaveAttribute('href', 'https://meet.google.com/abc-defg-hij');
      expect(within(dialog).queryByText(/sends the video link/i)).not.toBeInTheDocument();
    } finally {
      delete b6.joinUrl;
    }
  });

  /**
   * For a puja nobody was in the room for, the recording is what the devotee
   * actually bought — and what a family booking from abroad for their parents is
   * paying for. It had nowhere to live until the booking row carried it.
   */
  it('offers the recording once the purohit has attached one', async () => {
    signIn();
    const user = userEvent.setup();
    const b6 = DETAIL_BY_ID.b6 as Record<string, unknown>;
    b6.recordingUrl = 'https://drive.example.com/aarti';
    mockApi([{ ...b6 }]);
    try {
      render(<RegionProvider><AccountPage /></RegionProvider>);

      await user.click(await screen.findByText('Virtual Consultation'));
      const dialog = await screen.findByRole('dialog');

      expect(within(dialog).getByRole('link', { name: /watch your puja/i }))
        .toHaveAttribute('href', 'https://drive.example.com/aarti');
    } finally {
      delete b6.recordingUrl;
    }
  });

  it('keeps the destructive action off the tappable list row', async () => {
    signIn();
    render(<RegionProvider><AccountPage /></RegionProvider>);
    await screen.findByText('Satyanarayan Puja');

    expect(screen.queryByRole('button', { name: /^cancel$/i })).not.toBeInTheDocument();
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

  /**
   * "Free rescheduling up to 24 hours before" has been on the membership plan
   * since the catalogue was seeded, with no endpoint or UI behind it — cancel
   * and rebook from scratch was the only way to move a date.
   */
  it('reschedules a confirmed booking to a new open slot with the same purohit', async () => {
    signIn();
    const user = userEvent.setup();
    // A booking of its own, not `b1` - the mock mutates its DETAIL_BY_ID entry
    // in place to simulate the server-side move, and that must not leak into
    // any other test that reads `b1`.
    mockApi([{ ...BOOKINGS[0], id: 'b8' }]);
    DETAIL_BY_ID.b8 = { ...DETAIL_BY_ID.b1 as object, id: 'b8' };
    render(<RegionProvider><AccountPage /></RegionProvider>);

    await user.click(await screen.findByText('Satyanarayan Puja'));
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('button', { name: /change date/i }));
    // 16 Sep has an open slot; 17 Sep is fully booked and must not appear.
    expect(await within(dialog).findByText('16')).toBeInTheDocument();
    expect(within(dialog).queryByText('17')).not.toBeInTheDocument();

    await user.click(within(dialog).getByText('16'));
    // Only the open slot (idx 0) is offered — idx 1 is booked on this day.
    const slotButtons = within(dialog).getAllByRole('button').filter(
      (b) => /^\d{1,2}(:\d{2})?\s*(am|pm)/i.test(b.textContent ?? ''),
    );
    expect(slotButtons.length).toBeGreaterThan(0);
    await user.click(slotButtons[0]!);

    await user.click(within(dialog).getByRole('button', { name: /move to/i }));
    await within(dialog).findByText(/rescheduled to/i);

    const calls = (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const posted = calls.find((c) =>
      String(c[0]).endsWith('/v1/bookings/b8/reschedule')
      && (c[1] as RequestInit | undefined)?.method === 'POST');
    expect(posted).toBeTruthy();
  });

  /**
   * Caught live, driving the real app: "the next open slot" a devotee picks is
   * very often tomorrow morning - itself less than 24 hours from the moment of
   * confirming. `detail` refetches right after a successful reschedule, and the
   * confirmation banner sat in the SAME branch as the "starts too soon to move
   * again" notice - whichever the freshly-refetched booking now qualified for,
   * the other was never rendered. A devotee could move their booking and see no
   * acknowledgement it worked, only "this can no longer be rescheduled."
   */
  it('still confirms success when the new slot itself now falls inside 24 hours', async () => {
    signIn();
    const user = userEvent.setup();
    mockApi([{ ...BOOKINGS[0], id: 'b9' }]);
    DETAIL_BY_ID.b9 = { ...DETAIL_BY_ID.b1 as object, id: 'b9' };
    render(<RegionProvider><AccountPage /></RegionProvider>);

    await user.click(await screen.findByText('Satyanarayan Puja'));
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('button', { name: /change date/i }));
    await user.click(await within(dialog).findByText('16'));
    const slotButtons = within(dialog).getAllByRole('button').filter(
      (b) => /^\d{1,2}(:\d{2})?\s*(am|pm)/i.test(b.textContent ?? ''),
    );
    await user.click(slotButtons[0]!);
    await user.click(within(dialog).getByRole('button', { name: /move to/i }));

    // Both must be true at once: the confirmation, AND the now-correct "too
    // soon to move again" notice for the slot it was just moved to.
    await within(dialog).findByText(/rescheduled to/i);
    expect(within(dialog).getByText(/under 24 hours/i)).toBeInTheDocument();
  });

  it('explains why reschedule is unavailable inside the 24-hour window, without hiding it', async () => {
    signIn();
    const user = userEvent.setup();
    mockApi([
      { ...BOOKINGS[0], id: 'b7', slotStartAt: new Date(Date.now() + 3 * 3_600_000).toISOString() },
    ]);
    DETAIL_BY_ID.b7 = {
      ...DETAIL_BY_ID.b1 as object, id: 'b7',
      slotStartAt: new Date(Date.now() + 3 * 3_600_000).toISOString(),
    };
    render(<RegionProvider><AccountPage /></RegionProvider>);

    await user.click(await screen.findByText('Satyanarayan Puja'));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByText(/need to reschedule/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/under 24 hours/i)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /change date/i })).not.toBeInTheDocument();
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

/**
 * The dashboard's own ordering, URL and address book — each of these covers a
 * promise the page made and could not keep.
 */
describe('account dashboard', () => {
  /**
   * `GET /v1/bookings` orders by `created_at DESC` (booking-read.controller.ts
   * `mine()`) and nothing re-sorted the live ones, so the Upcoming list was in
   * BOOKING order, not ceremony order: a puja booked this morning for next month
   * sat above tomorrow's, and the top of the list was the thing needing attention
   * last. The purohit's `me/jobs` endpoint already sorts active jobs soonest-first
   * in SQL, with a comment explaining why; the devotee's side never did.
   */
  it('puts the soonest upcoming booking first, whatever order the API returned', async () => {
    signIn();
    // Creation order (what the API returns) is deliberately the reverse of
    // ceremony order, which is the whole point of the fixture.
    mockApi([
      {
        ...BOOKINGS[0], id: 'later', ritualName: 'Later Puja',
        date: isoDate(20), slotStartAt: inDays(20, '09:30'), slotEndAt: inDays(20, '12:30'),
      },
      {
        ...BOOKINGS[0], id: 'sooner', ritualName: 'Sooner Puja',
        date: isoDate(3), slotStartAt: inDays(3, '09:30'), slotEndAt: inDays(3, '12:30'),
      },
    ]);
    render(<RegionProvider><AccountPage /></RegionProvider>);

    await screen.findByText('Sooner Puja');
    const titles = screen.getAllByText(/(Sooner|Later) Puja/).map((el) => el.textContent);
    expect(titles).toEqual(['Sooner Puja', 'Later Puja']);
  });

  /**
   * `?tab=` was already READ on mount — the header's account menu links to
   * `/account?tab=profile` — and never written back. So the address bar and the
   * screen disagreed the moment anyone touched a tab: a refresh dropped the reader
   * back on Bookings, and a copied link pointed at the wrong section.
   */
  it('writes the open tab to the URL so a refresh or a shared link lands there', async () => {
    signIn();
    render(<RegionProvider><AccountPage /></RegionProvider>);
    await screen.findByText('Satyanarayan Puja');

    await userEvent.click(screen.getByRole('tab', { name: /preferences/i }));
    expect(replace).toHaveBeenCalledWith('/account?tab=preferences', { scroll: false });

    // 'bookings' is the default and stays OUT of the URL, rather than making every
    // shared link carry a parameter that changes nothing.
    await userEvent.click(screen.getByRole('tab', { name: /my bookings/i }));
    expect(replace).toHaveBeenCalledWith('/account', { scroll: false });
  });

  it('restores the tab named in the URL', async () => {
    signIn();
    search = 'tab=preferences';
    render(<RegionProvider><AccountPage /></RegionProvider>);

    expect(await screen.findByText(/which almanac/i)).toBeInTheDocument();
  });

  /**
   * The detail view was the thing most worth linking to and had no URL at all, so
   * a refresh — or tapping the WhatsApp support link inside it and coming back —
   * closed the booking being read, with no way back but finding the row again.
   */
  it('puts the open booking in the URL and reopens it from there', async () => {
    signIn();
    render(<RegionProvider><AccountPage /></RegionProvider>);

    await userEvent.click(await screen.findByText('Satyanarayan Puja'));
    await screen.findByRole('dialog');
    expect(replace).toHaveBeenCalledWith('/account?booking=b1', { scroll: false });

    // And the reverse: mounted at that URL, the booking is already open.
    search = 'booking=b1';
    render(<RegionProvider><AccountPage /></RegionProvider>);
    const dialogs = await screen.findAllByRole('dialog');
    expect(within(dialogs[0]!).getByText('Dakshina')).toBeInTheDocument();
  });

  /**
   * `POST /v1/me/addresses` exists precisely because people could not save one —
   * its own docstring records that before it, anyone who registered their own
   * account "reached the end of the booking flow and hit 'no saved address', with
   * no way anywhere in the product to add one". It fixed that for `/book` only.
   * The tab literally named Addresses stayed read-only, so the one screen for
   * managing addresses was the one place you could not add an address, and a
   * family moving house had to start a booking they did not want.
   */
  it('lets a devotee add an address from the Addresses tab', async () => {
    signIn();
    const user = userEvent.setup();
    render(<RegionProvider><AccountPage /></RegionProvider>);
    await screen.findByText('Satyanarayan Puja');

    await user.click(screen.getByRole('tab', { name: /addresses/i }));
    await user.click(await screen.findByRole('button', { name: /add an address/i }));

    await user.type(screen.getByLabelText(/flat, building, street/i), '7 Lake Road');
    await user.type(screen.getByLabelText(/pincode/i), '700029');
    await user.click(screen.getByRole('button', { name: /save address/i }));

    // The city comes from the API's response, not from the header's selected
    // region — `/book` used to label every saved address with the latter.
    expect(await screen.findByText(/7 Lake Road.*Kolkata.*700029/)).toBeInTheDocument();

    const calls = (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const posted = calls.find((c) =>
      String(c[0]).includes('/v1/me/addresses')
      && (c[1] as RequestInit | undefined)?.method === 'POST');
    expect(posted).toBeTruthy();
    // The API resolves `citySlug` against `cities.slug` and 404s on anything else,
    // so this must be the region's slug and never a display name or free text.
    expect(JSON.parse(String((posted![1] as RequestInit).body))).toMatchObject({
      line1: '7 Lake Road', pincode: '700029', citySlug: 'kolkata',
    });
  });

  /**
   * The server rejects `line1` under 4 characters and any non-six-digit pincode
   * (`AddressInput`). Submit was enabled from the moment the form opened, so the
   * quickest way to discover either rule was to submit and read a 422 written for
   * an API client.
   */
  it('does not offer to save an address the server would reject', async () => {
    signIn();
    const user = userEvent.setup();
    render(<RegionProvider><AccountPage /></RegionProvider>);
    await screen.findByText('Satyanarayan Puja');

    await user.click(screen.getByRole('tab', { name: /addresses/i }));
    await user.click(await screen.findByRole('button', { name: /add an address/i }));

    expect(screen.getByRole('button', { name: /save address/i })).toBeDisabled();

    await user.type(screen.getByLabelText(/flat, building, street/i), '7 Lake Road');
    await user.type(screen.getByLabelText(/pincode/i), '7000');
    expect(screen.getByRole('button', { name: /save address/i })).toBeDisabled();

    await user.type(screen.getByLabelText(/pincode/i), '29');
    expect(screen.getByRole('button', { name: /save address/i })).not.toBeDisabled();
  });

  /**
   * The empty state promised "your start and completion codes" appear here. They
   * cannot: `bookings` stores only `start_otp_hash`/`complete_otp_hash` and the
   * codes are sent over WhatsApp and discarded. A devotee who read this and came
   * back for their code found no codes and no explanation.
   */
  it('does not promise codes the dashboard is unable to show', async () => {
    signIn();
    mockApi([]);
    render(<RegionProvider><AccountPage /></RegionProvider>);

    await screen.findByText(/no bookings yet/i);
    expect(screen.getByText(/codes are sent to you on whatsapp/i)).toBeInTheDocument();
  });

  /**
   * The reschedule confirmation read `slotLabel(detail.slotIdx)` — the exact bug
   * the booking card above documents fixing. Since ADR 0013 a booking is a pair of
   * instants and `slot_idx` is vestigial, so a 12:30 move lands in one of Kolkata's
   * slot gaps, the index falls back to 0, and the confirmation reported it as
   * "6am–9am" — a wrong time, in the one message whose job is confirming the time.
   */
  it('confirms a reschedule with the real window, not the vestigial slot index', async () => {
    signIn();
    const user = userEvent.setup();
    mockApi([{ ...BOOKINGS[0], id: 'b10' }]);
    // slotIdx 0 is Kolkata's 6am-9am slot; the instants say 12:30pm. Before this
    // fix the notice rendered the former.
    DETAIL_BY_ID.b10 = {
      ...DETAIL_BY_ID.b1 as object, id: 'b10', slotIdx: 0,
      slotStartAt: inDays(14, '12:30'), slotEndAt: inDays(14, '13:15'),
    };
    render(<RegionProvider><AccountPage /></RegionProvider>);

    await user.click(await screen.findByText('Satyanarayan Puja'));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /change date/i }));
    await user.click(await within(dialog).findByText('16'));
    const slots = within(dialog).getAllByRole('button').filter(
      (b) => /^\d{1,2}(:\d{2})?\s*(am|pm)/i.test(b.textContent ?? ''),
    );
    await user.click(slots[0]!);
    await user.click(within(dialog).getByRole('button', { name: /move to/i }));

    const notice = await within(dialog).findByText(/rescheduled to/i);
    expect(notice.textContent).toMatch(/12:30/);
    expect(notice.textContent).not.toMatch(/6am/i);
  });
});
