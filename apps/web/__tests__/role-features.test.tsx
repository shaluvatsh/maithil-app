import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RegionProvider } from '@/lib/region-context';
import { EarningsPanel } from '@/components/purohit/earnings';
import { Anniversaries } from '@/components/home/anniversaries';
import { stateLabel, dayList } from '@/lib/format';
import { PanchangCalendar } from '@/components/panchang-calendar';

const css = readFileSync(join(__dirname, '..', 'app', 'globals.css'), 'utf8');

const withRegion = (n: React.ReactNode) => render(<RegionProvider>{n}</RegionProvider>);

const respond = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200, headers: { 'content-type': 'application/json' },
});

beforeEach(() => { localStorage.clear(); });

/**
 * `GET /v1/me/earnings` has existed since the payout job was built and nothing has
 * ever rendered it. A purohit could see the jobs they had done and had no way to
 * find out what they were owed for them.
 */
describe('a purohit can see what they are owed', () => {
  const earnings = {
    grossPaise: 500_000, duesPaise: 60_000, tdsCarryPaise: 5_000,
    alreadyPaidPaise: 0, netPayablePaise: 435_000,
  };

  beforeEach(() => {
    global.fetch = vi.fn(async () => respond(earnings)) as unknown as typeof fetch;
  });

  it('leads with the payable figure', async () => {
    const { container } = withRegion(<EarningsPanel />);
    await screen.findByText(/to be paid out/);
    // Deliberately the heading, not "somewhere on the page": the number a purohit
    // opens this for is the one that lands in their account, and it appears twice
    // — once as the headline and once as the last line of the breakdown.
    expect(container.querySelector('.earn-head h2')!.textContent).toMatch(/₹4,350/);
  });

  /**
   * The breakdown matters more than the total. On a cash job the purohit already
   * holds the devotee's money and owes the platform its commission, so gross and
   * payable differ by an amount they never received — showing only the net turns a
   * legible deduction into an unexplained shortfall.
   */
  it('explains the commission rather than silently netting it off', async () => {
    withRegion(<EarningsPanel />);
    expect(await screen.findByText(/Commission on cash jobs/)).toBeInTheDocument();
    expect(screen.getByText(/You collected this from the devotee/)).toBeInTheDocument();
    expect(screen.getByText('₹5,000')).toBeInTheDocument();     // gross, stated
  });

  it('names the statutory deduction and its section', async () => {
    withRegion(<EarningsPanel />);
    expect(await screen.findByText(/section 194-O/)).toBeInTheDocument();
  });

  it('hides deductions that are zero rather than printing −₹0', async () => {
    global.fetch = vi.fn(async () => respond({
      grossPaise: 0, duesPaise: 0, tdsCarryPaise: 0, alreadyPaidPaise: 0, netPayablePaise: 0,
    })) as unknown as typeof fetch;

    withRegion(<EarningsPanel />);
    await screen.findByText(/Nothing yet/);
    expect(screen.queryByText(/Commission on cash jobs/)).not.toBeInTheDocument();
    expect(screen.queryByText(/194-O/)).not.toBeInTheDocument();
  });

  it('says so when it cannot load, rather than showing nothing', async () => {
    global.fetch = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    withRegion(<EarningsPanel />);
    expect(await screen.findByText(/Could not load your earnings/)).toBeInTheDocument();
  });
});

/**
 * Almost every ritual here is annual, and the product made a returning family
 * search the catalogue from scratch every time.
 */
describe('a returning devotee is shown last year’s pujas', () => {
  const items = [{
    slug: 'lakshmi-puja', name: 'Lakshmi Puja', lastBookedOn: '2025-10-20',
    daysSince: 360, times: 2, dueNow: true,
  }];

  it('renders nothing for a visitor with no token', async () => {
    global.fetch = vi.fn(async () => respond(items)) as unknown as typeof fetch;
    const { container } = withRegion(<Anniversaries />);
    await waitFor(() => expect(container.querySelector('.anniv')).toBeNull());
  });

  it('renders nothing for a devotee with no history', async () => {
    localStorage.setItem('themaithil.auth', JSON.stringify({ token: 't', role: 'devotee' }));
    global.fetch = vi.fn(async () => respond([])) as unknown as typeof fetch;
    const { container } = withRegion(<Anniversaries />);
    await waitFor(() => expect(container.querySelector('.anniv')).toBeNull());
  });

  /** A purohit has no household history; asking for one is a wasted request. */
  it('does not ask on behalf of a purohit', async () => {
    localStorage.setItem('themaithil.auth', JSON.stringify({ token: 't', role: 'pandit' }));
    const fetchMock = vi.fn(async () => respond(items));
    global.fetch = fetchMock as unknown as typeof fetch;

    withRegion(<Anniversaries />);
    await waitFor(() => expect(fetchMock).not.toHaveBeenCalled());
  });
});

/**
 * Every incident already lives in `booking_events`, written in the same
 * transaction that made the change, and nothing read it. A re-match that succeeds
 * is routine; one that fails is a devotee with no purohit and a slot getting closer.
 */
describe('the console surfaces cancellations', () => {
  const admin = readFileSync(join(__dirname, '..', 'app', 'admin', 'page.tsx'), 'utf8');

  it('has a tab for them', () => {
    expect(admin).toMatch(/\['incidents', 'Cancellations'\]/);
    expect(admin).toMatch(/\/v1\/admin\/incidents/);
  });

  it('separates the ones that were covered from the ones that were not', () => {
    expect(admin).toMatch(/Needs a purohit/);
    expect(admin).toMatch(/Covered automatically/);
    expect(admin, 'a failed re-match must be visually distinct, not just worded so')
      .toMatch(/i\.needsAttention \? 'inc-row bad'/);
  });
});

/**
 * `pending_accept` was labelled "Awaiting purohit" for everyone. Under ADR 0011 the
 * purohit accepted the moment they published the slot — `submit()` sets
 * `acceptedAt` in the same transaction — and what the booking is really waiting for
 * is the devotee's payment.
 *
 * So a purohit opened their jobs, read "awaiting purohit" against a job they had
 * already accepted, looked for the accept button the ADR deliberately removed, and
 * concluded the app was broken. A devotee read the same words and blamed the
 * purohit for their own unpaid token.
 */
describe('booking states say who is actually being waited on', () => {
  it('never tells a purohit they are the ones holding it up', () => {
    expect(stateLabel('pending_accept', 'pandit')).not.toMatch(/purohit|pandit/i);
    expect(stateLabel('pending_accept', 'pandit')).toMatch(/payment/i);
  });

  it('tells the devotee what they have to do', () => {
    expect(stateLabel('pending_accept', 'devotee')).toMatch(/pay/i);
  });

  it('does not blame the purohit in the default label either', () => {
    expect(stateLabel('pending_accept')).not.toMatch(/awaiting purohit/i);
  });

  it('falls back to the shared wording for states with no per-role text', () => {
    for (const a of ['devotee', 'pandit', 'admin'] as const) {
      expect(stateLabel('confirmed', a)).toBe('Confirmed');
      expect(stateLabel('completed', a)).toBe('Completed');
    }
  });

  it('returns the raw state rather than blank for one it does not know', () => {
    expect(stateLabel('some_new_state', 'pandit')).toBe('some_new_state');
  });

  /** A purohit releasing a job is not the same act as a devotee cancelling one. */
  it('distinguishes a release from a cancellation', () => {
    expect(stateLabel('cancelled_pandit')).toMatch(/released/i);
    expect(stateLabel('cancelled_devotee')).toMatch(/cancelled/i);
  });
});

describe('the purohit job list', () => {
  const page = readFileSync(join(__dirname, '..', 'app', 'purohit', 'page.tsx'), 'utf8');

  it('explains that a pending job is waiting on the devotee', () => {
    expect(page).toMatch(/We are waiting for the devotee to pay/);
  });

  it('keeps the release path available before payment clears', () => {
    expect(page).toMatch(/j\.state === 'pending_accept' \|\| j\.state === 'confirmed'/);
    expect(page).toMatch(/I cannot take this/);
  });

  /**
   * A read-only 14×4 grid of "booked / buffer / closed" duplicated the panchang
   * calendar, which shows the same rows AND can edit them. Two calendars meant
   * holding both in your head and editing neither from the one you were reading.
   */
  it('no longer keeps a second, read-only calendar', () => {
    expect(page).not.toMatch(/Next fortnight/);
    expect(page, 'it also stopped fetching the data that grid needed')
      .not.toMatch(/v1\/availability\?panditId/);
    expect(page).toMatch(/Open my calendar/);
  });
});

/**
 * "Auspicious for 14 rituals" told a devotee a number and gave them nowhere to go
 * with it — they still had to open the catalogue and guess which fourteen. And the
 * pill itself was `display: inline-block` inside a flex row, which a flex container
 * ignores: it became a block-level flex item and stretched to the full height of
 * the heading beside it, so a one-line label sat in an 80px green oval.
 */
describe('the auspicious count is a way in, not a dead number', () => {
  const RITUALS = new Map([
    ['r1', { slug: 'lakshmi-puja', name: 'Lakshmi Puja' }],
    ['r2', { slug: 'ganesh-puja', name: 'Ganesh Puja' }],
  ]);
  const time = (iso: string) => new Date(iso).toISOString().slice(11, 16);
  const days = dayList(3, 0).map((d) => ({
    date: d, bengaliDate: null, tithiAtSunrise: 'Shukla Tritiya',
    nakshatraAtSunrise: 'Uttara Phalguni', sunrise: `${d}T00:21:00Z`, sunset: `${d}T13:32:00Z`,
    abhijit: { startsAt: `${d}T06:30:00Z`, endsAt: `${d}T07:23:00Z` },
    rahuKaal: { startsAt: `${d}T03:39:00Z`, endsAt: `${d}T05:18:00Z` },
    auspiciousForRitualIds: ['r1', 'r2'],
  }));

  const open = async () => {
    const view = withRegion(
      <PanchangCalendar days={days} time={time} ritualsById={RITUALS} />,
    );
    await userEvent.click(await screen.findByRole('button', { name: /Auspicious for 2 rituals/ }));
    return view;
  };

  it('opens a dialog rather than sitting there as a label', async () => {
    await open();
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('names the rituals instead of counting them', async () => {
    await open();
    expect(await screen.findByRole('link', { name: /Lakshmi Puja/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Ganesh Puja/ })).toBeInTheDocument();
  });

  /** Picking one has to carry both the ritual and the day it was good for. */
  it('carries the ritual and the date into the booking', async () => {
    await open();
    const href = (await screen.findByRole('link', { name: /Lakshmi Puja/ })).getAttribute('href')!;
    expect(href).toMatch(/^\/book\?ritual=lakshmi-puja&day=\d{4}-\d{2}-\d{2}$/);
  });

  it('closes on Escape, so it is not a trap on a phone', async () => {
    await open();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  /** A ritual withdrawn from this city must not render as a raw id. */
  it('says something human when a ritual cannot be resolved', async () => {
    withRegion(<PanchangCalendar days={days} time={time} ritualsById={new Map()} />);
    await userEvent.click(await screen.findByRole('button', { name: /Auspicious for 2/ }));
    // Two unresolvable ids, two rows — the point is that neither shows a raw id.
    expect(await screen.findAllByText(/no longer offered here/)).toHaveLength(2);
    expect(screen.queryByText('r1')).toBeNull();
    // Scoped to the dialog: the day panel has its own booking link behind it.
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryAllByRole('link')).toEqual([]);
  });

  it('lays the day heading out from the top, so the pill is not stretched', () => {
    const rule = /\.cd-head\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule, 'inline-block is a no-op on a flex child; the container must not stretch it')
      .toMatch(/align-items:\s*flex-start/);
  });
});
