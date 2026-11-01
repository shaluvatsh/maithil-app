import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RegionProvider } from '@/lib/region-context';
import EventsPage from '@/app/events/page';
import HostEventPage from '@/app/events/new/page';
import { placeLabel } from '@/lib/events';
import { navFor, roleOf } from '@/lib/nav-model';
import { createTranslator, getRegion, DEFAULT_LOCALE, toLocalNumerals } from '@themaithil/region';

/**
 * Events discovery.
 *
 * The two things worth protecting here are both honesty rules: a city-precision
 * venue must never be given a distance, and a LISTING must never read as though the
 * platform stands behind it.
 */
const t = createTranslator(getRegion('kolkata'), DEFAULT_LOCALE);

const soon = new Date(Date.now() + 2 * 86_400_000).toISOString();

const HOSTED = {
  id: '01J000000000000000000000EA', kind: 'kirtan',
  title: 'সন্ধ্যা কীর্তন, বাগবাজার',
  description: 'Two hours of kirtan.', locale: 'bn',
  citySlug: 'kolkata', venueName: 'Bagbazar hall',
  startAt: soon, endAt: soon,
  panjikaSchool: null, registrationMode: 'rsvp',
  hostKind: 'pandit', hostName: 'Pandit Asim', hostVerified: true,
  distanceKm: 2.3, seatsLeft: 12, sessionCount: 1,
};

const LISTED = {
  ...HOSTED,
  id: '01J000000000000000000000EB',
  title: 'Para pandal kirtan',
  locale: 'en',
  hostKind: 'devotee', hostName: 'A Devotee', hostVerified: false,
  // City-precision venue: every event in the city shares that point.
  distanceKm: null, seatsLeft: null, registrationMode: 'none',
};

const mount = (items: unknown[] = [HOSTED, LISTED]) => {
  global.fetch = vi.fn(async () => new Response(
    JSON.stringify({ items, nextCursor: null, scripts: ['bengali', 'latin'] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )) as unknown as typeof fetch;
  return render(<RegionProvider><EventsPage /></RegionProvider>);
};

beforeEach(() => {
  localStorage.clear();
  document.head.querySelectorAll('link[id^="font-"]').forEach((n) => n.remove());
});

describe('a calendar, not a feed', () => {
  it('leads every card with when it is', async () => {
    mount();
    await screen.findByText(HOSTED.title);
    expect(screen.getAllByText(/in 2 days/i).length).toBeGreaterThan(0);
  });

  it('typesets each event in the language it was written in', async () => {
    mount();
    const bn = await screen.findByText(HOSTED.title);
    expect(bn).toHaveAttribute('lang', 'bn');
    expect(screen.getByText(LISTED.title)).toHaveAttribute('lang', 'en');
  });

  it('loads only the scripts the page needs', async () => {
    mount();
    await screen.findByText(HOSTED.title);
    await waitFor(() => expect(document.getElementById('font-bengali')).toBeTruthy());
    expect(document.getElementById('font-tamil')).toBeNull();
  });
});

describe('distance is measured or it is absent', () => {
  it('shows a distance for a located venue', async () => {
    mount();
    await screen.findByText(HOSTED.title);
    expect(screen.getByText(/2\.3 km/)).toBeInTheDocument();
  });

  /**
   * The honesty rule. Every event in Kolkata without a pincode shares the city
   * centroid, so a computed distance is exactly zero — and "0.0 km away" is a number
   * a reader would act on.
   */
  it('names the city instead of inventing a zero', async () => {
    mount([LISTED]);
    await screen.findByText(LISTED.title);
    expect(screen.getByText(/Bagbazar hall, Kolkata/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/0 km|0\.0 km/);
  });

  it('is decided by the helper, not by each call site', () => {
    const n = (v: string | number) => toLocalNumerals(v, 'latn');
    expect(placeLabel({ distanceKm: null, citySlug: 'kolkata', venueName: 'Ghat' }, 'Kolkata', n))
      .toBe('Ghat, Kolkata');
    expect(placeLabel({ distanceKm: 4.2, citySlug: 'kolkata', venueName: 'Ghat' }, 'Kolkata', n))
      .toBe('Ghat · 4.2 km');
  });
});

describe('the liability tier is visible to the reader', () => {
  it('says who hosts a verified event', async () => {
    mount([HOSTED]);
    expect(await screen.findByText(t('events.hostedBy', { name: 'Pandit Asim' })))
      .toBeInTheDocument();
  });

  /**
   * A reader deciding whether to cross a city on a festival morning is entitled to
   * know whether we stand behind the event or are merely carrying the listing.
   */
  it('says plainly that a listing is unverified', async () => {
    mount([LISTED]);
    expect(await screen.findByText(/we have not verified this event/i)).toBeInTheDocument();
  });

  it('offers nothing to reserve on a listing', async () => {
    mount([LISTED]);
    await screen.findByText(LISTED.title);
    expect(screen.getByText(t('events.justTurnUp'))).toBeInTheDocument();
  });
});

describe('places are described honestly', () => {
  it('shows a seat count when capacity is finite', async () => {
    mount([HOSTED]);
    expect(await screen.findByText(/12 places left/i)).toBeInTheDocument();
  });

  it('says there is room for everyone when capacity is unlimited', async () => {
    mount([{ ...HOSTED, seatsLeft: null, registrationMode: 'rsvp' }]);
    expect(await screen.findByText(t('events.seatsUnlimited'))).toBeInTheDocument();
  });

  it('calls a full event a waiting list, not a closed door', async () => {
    mount([{ ...HOSTED, seatsLeft: 0 }]);
    // Full does not mean closed — the waitlist promotes the moment a place opens.
    expect(await screen.findByText(t('events.full'))).toBeInTheDocument();
  });
});

describe('scope', () => {
  it('opens on the chosen city and asks for a location only on request', async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByText(HOSTED.title);

    const calls = () => (global.fetch as unknown as { mock: { calls: unknown[][] } })
      .mock.calls.map((c) => String(c[0]));
    expect(calls().some((u) => u.includes('citySlug=kolkata'))).toBe(true);
    // No geolocation prompt until the reader asks for one.
    expect(calls().some((u) => u.includes('lat='))).toBe(false);

    expect(screen.getByRole('button', { name: t('events.near') })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^In / }));
    expect(calls().some((u) => u.includes('citySlug=kolkata'))).toBe(true);
  });

  it('says so when nothing is listed', async () => {
    mount([]);
    expect(await screen.findByText(t('events.empty'))).toBeInTheDocument();
  });
});

describe('the header', () => {
  it('offers events beside community, not inside it', () => {
    const hrefs = navFor(roleOf(false, null)).links.map((l) => l.href);
    expect(hrefs).toContain('/events');
    expect(hrefs).toContain('/community');
  });

  it('offers it to purohits, who fill empty time with group events', () => {
    expect(navFor(roleOf(true, 'pandit')).links.map((l) => l.href)).toContain('/events');
  });
});

/**
 * Listing an event.
 *
 * The two tests that matter are about what the form does NOT offer, and about the
 * timezone. A paid option would only ever be refused, and a `datetime-local` input
 * read in the device's zone would list a 6am tarpan at whatever hour the phone
 * happens to think it is.
 */
describe('listing an event', () => {
  const setup = () => {
    localStorage.setItem('themaithil.token', 'test-token');
    localStorage.setItem('themaithil.role', 'devotee');
    const calls: Array<{ url: string; body: unknown }> = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.includes('/publish')) {
        return new Response(JSON.stringify({ state: 'published' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ id: '01J000000000000000000000EC' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return { calls };
  };

  const fill = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.type(screen.getByLabelText(t('events.fTitle')), 'Evening kirtan at the hall');
    await user.type(
      screen.getByLabelText(t('events.fDescription')),
      'Two hours of kirtan, everybody welcome, prasad afterwards.',
    );
    await user.type(screen.getByLabelText(t('events.fVenueName')), 'Bagbazar hall');
    await user.type(screen.getByLabelText(t('events.fVenueLine')), '1 Bagbazar Street');
  };

  it('offers no paid option, and says why', async () => {
    setup();
    render(<RegionProvider><HostEventPage /></RegionProvider>);
    await screen.findByText(t('events.fMode'));

    expect(screen.getByLabelText(t('events.fModeNone'))).toBeInTheDocument();
    expect(screen.getByLabelText(t('events.fModeRsvp'))).toBeInTheDocument();
    // A control that only ever fails teaches people the product is broken.
    expect(screen.queryByText(/ticket/i)).toBeNull();
    expect(screen.getByText(t('events.fModeMoneyNote'))).toBeInTheDocument();
  });

  it('warns a devotee that their listing shows as unverified', async () => {
    setup();
    render(<RegionProvider><HostEventPage /></RegionProvider>);
    // Said up front, not discovered on the card afterwards.
    expect(await screen.findByText(t('events.hostDevoteeNote'))).toBeInTheDocument();
  });

  /**
   * The timezone rule. `datetime-local` is read in the DEVICE's zone; the event
   * happens on the city's clock. `slotInstant` builds it from the region offset, so
   * 18:00 in Kolkata is 12:30 UTC whatever the phone is set to.
   */
  it('sends the instant on the city’s clock, not the device’s', async () => {
    const { calls } = setup();
    const user = userEvent.setup();
    render(<RegionProvider><HostEventPage /></RegionProvider>);
    await screen.findByText(t('events.fMode'));

    await fill(user);
    await user.type(screen.getByLabelText(t('events.fDate')), '2026-11-14');
    await user.click(screen.getByRole('button', { name: t('events.publish') }));

    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/v1/events'))).toBe(true));
    const body = calls.find((c) => c.url.endsWith('/v1/events'))!.body as {
      startAt: string; endAt: string; citySlug: string;
    };
    // 18:00 IST is 12:30Z. Kolkata is +05:30.
    expect(body.startAt).toBe('2026-11-14T12:30:00.000Z');
    expect(body.endAt).toBe('2026-11-14T14:30:00.000Z');
    expect(body.citySlug).toBe('kolkata');
  });

  it('creates a draft and then publishes it, as two steps', async () => {
    const { calls } = setup();
    const user = userEvent.setup();
    render(<RegionProvider><HostEventPage /></RegionProvider>);
    await screen.findByText(t('events.fMode'));

    await fill(user);
    await user.type(screen.getByLabelText(t('events.fDate')), '2026-11-14');
    await user.click(screen.getByRole('button', { name: t('events.publish') }));

    // Two decisions: a listing goes live at once, anything we stand behind reviews.
    await waitFor(() => expect(calls.some((c) => c.url.includes('/publish'))).toBe(true));
  });

  it('will not submit an incomplete form', async () => {
    setup();
    render(<RegionProvider><HostEventPage /></RegionProvider>);
    await screen.findByText(t('events.fMode'));
    expect(screen.getByRole('button', { name: t('events.publish') })).toBeDisabled();
  });

  it('asks for a capacity only when places are reservable', async () => {
    setup();
    const user = userEvent.setup();
    render(<RegionProvider><HostEventPage /></RegionProvider>);
    await screen.findByText(t('events.fMode'));

    expect(screen.queryByLabelText(t('events.fCapacity'))).toBeNull();
    await user.click(screen.getByLabelText(t('events.fModeRsvp')));
    expect(screen.getByLabelText(t('events.fCapacity'))).toBeInTheDocument();
  });

  it('explains what the pincode is for rather than starring it', async () => {
    setup();
    render(<RegionProvider><HostEventPage /></RegionProvider>);
    // Without it the card can only name the city, because the fallback coordinate is
    // the city centroid.
    expect(await screen.findByText(t('events.fPincodeWhy'))).toBeInTheDocument();
  });
});
