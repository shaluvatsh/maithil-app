import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RegionProvider } from '@/lib/region-context';
import { PanchangCalendar, type CalendarDay } from '@/components/panchang-calendar';
import { OfferCard, type Offer } from '@/components/home/offer-card';
import { dayList, todayIso } from '@/lib/format';

const css = readFileSync(join(__dirname, '..', 'app', 'globals.css'), 'utf8');
const withRegion = (n: React.ReactNode) => render(<RegionProvider>{n}</RegionProvider>);

beforeEach(() => {
  localStorage.clear();
  global.fetch = vi.fn(async () => new Response('[]', {
    status: 200, headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch;
});

/**
 * `dayList` starts tomorrow, which is correct for booking — a purohit cannot be
 * summoned for this afternoon. It is wrong for reading, and both the panchang page
 * and the home page's almanac card used the default. So the calendar began
 * tomorrow, today's cell never existed at all, and the hero card printed tomorrow's
 * tithi under the word "Today". Nothing looked broken; it was simply the wrong day,
 * every day.
 */
describe('today is in the window when the window is for reading', () => {
  it('still starts at tomorrow by default, because booking cannot start today', () => {
    expect(dayList(1)[0]).not.toBe(todayIso());
  });

  it('starts at today when asked to', () => {
    expect(dayList(1, 0)[0]).toBe(todayIso());
  });

  it('returns consecutive days from wherever it starts', () => {
    const d = dayList(4, 0);
    for (let i = 1; i < d.length; i++) {
      const gap = Date.parse(`${d[i]}T00:00Z`) - Date.parse(`${d[i - 1]}T00:00Z`);
      expect(gap).toBe(86_400_000);
    }
  });

  /**
   * `new Date().toISOString()` is UTC and rolls the date over at 05:30 IST, so
   * between midnight and half past five it reported tomorrow as today.
   */
  it('reads today in IST, not UTC', () => {
    const ist = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
    expect(todayIso()).toBe(ist);
  });
});

const day = (date: string, over: Partial<CalendarDay> = {}): CalendarDay => ({
  date, bengaliDate: '১ ভাদ্র', tithiAtSunrise: 'Shukla Saptami',
  nakshatraAtSunrise: 'Hasta', sunrise: `${date}T00:12:00Z`, sunset: `${date}T12:40:00Z`,
  abhijit: { startsAt: `${date}T06:12:00Z`, endsAt: `${date}T07:00:00Z` },
  rahuKaal: { startsAt: `${date}T03:30:00Z`, endsAt: `${date}T05:00:00Z` },
  auspiciousForRitualIds: [], ...over,
});

describe('the panchang calendar reads before it sells', () => {
  const days = dayList(10, 0).map((d, i) => day(d, i === 3 ? { auspiciousForRitualIds: ['r1'] } : {}));
  const time = (iso: string) => new Date(iso).toISOString().slice(11, 16);

  it('marks today', () => {
    const { container } = withRegion(<PanchangCalendar days={days} time={time} />);
    expect(container.querySelectorAll('.cal-cell.today')).toHaveLength(1);
  });

  it('opens on today without being asked', async () => {
    withRegion(<PanchangCalendar days={days} time={time} />);
    expect(await screen.findByText(/^Today ·/)).toBeInTheDocument();
  });

  /**
   * The bug: every cell was a link to `/book`, so tapping a date to look it up
   * dropped the reader into a checkout.
   */
  it('does not navigate away when a date is tapped', async () => {
    const { container } = withRegion(<PanchangCalendar days={days} time={time} />);
    const cells = [...container.querySelectorAll('.cal-cell:not(.empty)')];
    for (const c of cells) expect(c.tagName).toBe('BUTTON');
  });

  it('shows the day it was asked about, in place', async () => {
    const { container } = withRegion(<PanchangCalendar days={days} time={time} />);
    const cells = [...container.querySelectorAll('.cal-cell:not(.empty)')] as HTMLElement[];
    await userEvent.click(cells[5]!);

    const detail = container.querySelector('.cal-detail')!;
    expect(detail).toBeTruthy();
    expect(detail.textContent).toMatch(/Abhijit/);
    expect(detail.textContent).toMatch(/Rahu Kaal/);
  });

  it('offers exactly one route into booking, from the day chosen', async () => {
    const { container } = withRegion(<PanchangCalendar days={days} time={time} />);
    const links = [...container.querySelectorAll('a[href*="/book"]')];
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute('href')).toMatch(/^\/book\?day=\d{4}-\d{2}-\d{2}/);
  });

  it('renders nothing at all rather than an empty month', () => {
    const { container } = withRegion(<PanchangCalendar days={[]} time={time} />);
    expect(container.querySelector('.cal')).toBeNull();
  });
});

/**
 * Every number in this card used to be a literal typed into JSX — a price, a
 * discount, a saving and a countdown, none of them backed by a row anyone could
 * buy from. A price on a page is a representation.
 */
describe('the membership card only shows what the backend sent', () => {
  const money = (p: number) => `₹${(p / 100).toLocaleString('en-IN')}`;
  const offer: Offer = {
    slug: 'family-year', name: 'Family Membership',
    tagline: 'A year of priority booking', pricePaise: 149_900,
    durationDays: 365, discountBps: 1200,
    benefits: ['12% off dakshina', 'Priority during Durga Puja'],
    offerEndsOn: '2026-09-30', daysLeft: 46, purchasable: false,
    bundle: {
      rituals: [
        { slug: 'durga-puja-ghot', name: 'Durga Puja Ghot', pricePaise: 250_000 },
        { slug: 'kali-puja', name: 'Kali Puja', pricePaise: 180_000 },
      ],
      listPaise: 430_000, memberPaise: 378_400, savingPaise: 51_600,
    },
    netSavingPaise: 51_600 - 149_900,
  };

  it('renders nothing when there is no plan', () => {
    const { container } = render(<OfferCard offer={null} money={money} />);
    expect(container.firstChild).toBeNull();
  });

  /**
   * A truthy but malformed payload once took the whole home page down: an unguarded
   * `.map` in a render throws and React unmounts the tree. A promotional card must
   * not be able to remove the catalogue.
   */
  it('renders nothing for a payload that is not a plan', () => {
    for (const junk of [[], {}, { name: 'x' }, 'plan', 0]) {
      const { container } = render(<OfferCard offer={junk as never} money={money} />);
      expect(container.firstChild).toBeNull();
    }
  });

  /**
   * The card carries the decision, not the whole plan.
   *
   * Four benefits, six priced rituals and a three-line calculation used to sit
   * between the catalogue and the footer, for the overwhelming majority of
   * visitors who came to book a puja and have no interest in a subscription.
   */
  it('keeps the detail off the page until it is asked for', () => {
    render(<OfferCard offer={offer} money={money} />);
    expect(screen.queryByText('What you get')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Durga Puja Ghot' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('still states what it is, what it costs and the strongest reason', () => {
    render(<OfferCard offer={offer} money={money} />);
    expect(screen.getByText('Family Membership')).toBeInTheDocument();
    expect(screen.getByText('₹1,499')).toBeInTheDocument();
    expect(screen.getByText(/12% off the purohit/)).toBeInTheDocument();
  });

  const openDetail = async () => {
    render(<OfferCard offer={offer} money={money} />);
    await userEvent.click(screen.getByRole('button', { name: /See what's included/ }));
    return screen.findByRole('dialog');
  };

  it('shows the discount the plan actually carries', async () => {
    await openDetail();
    expect(await screen.findByText(/12% off these/)).toBeInTheDocument();
  });

  it('lists the rituals the bundle is priced from, each linked', async () => {
    await openDetail();
    expect(await screen.findByRole('link', { name: 'Durga Puja Ghot' }))
      .toHaveAttribute('href', '/pooja/durga-puja-ghot');
    expect(screen.getByRole('link', { name: 'Kali Puja' })).toBeInTheDocument();
  });

  it('shows what the plan includes once opened', async () => {
    await openDetail();
    expect(await screen.findByText('What you get')).toBeInTheDocument();
    for (const b of offer.benefits) expect(screen.getByText(b)).toBeInTheDocument();
  });

  /**
   * A dialog whose only exit is "Close" makes a reader who has just been convinced
   * undo their own interest to act on it.
   */
  it('offers the purchase inside the dialog too, not only behind it', async () => {
    const dialog = await openDetail();
    expect(within(dialog).getByRole('link', { name: /Tell me when it opens/ }))
      .toBeInTheDocument();
  });

  /**
   * The saving is stated NET of the membership fee. Here the bundle saves ₹516 and
   * the plan costs ₹1,499, so the honest number is negative and must not be dressed
   * up as a win.
   */
  it('does not claim a saving the membership swallows', async () => {
    await openDetail();
    expect(await screen.findByText(/After the membership fee/)).toBeInTheDocument();
    expect(screen.queryByText(/You keep/)).not.toBeInTheDocument();
  });

  it('says "you keep" only when the member is genuinely ahead', async () => {
    render(<OfferCard offer={{ ...offer, netSavingPaise: 90_000 }} money={money} />);
    await userEvent.click(screen.getByRole('button', { name: /See what's included/ }));
    expect(await screen.findByText(/You keep/)).toBeInTheDocument();
  });

  /**
   * Nothing charges for the membership and nothing applies the discount at booking
   * time, so a working Join button would take ₹1,499 for a benefit the pricing
   * engine never grants.
   */
  it('does not offer a purchase the platform cannot complete', () => {
    render(<OfferCard offer={offer} money={money} />);
    expect(screen.queryByRole('link', { name: /^Join for/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Tell me when it opens/ }))
      .toHaveAttribute('href', '/contact?about=membership');
  });

  it('survives a plan with no bundle to price against, opened', async () => {
    render(<OfferCard offer={{ ...offer, bundle: null, netSavingPaise: null }} money={money} />);
    await userEvent.click(screen.getByRole('button', { name: /See what's included/ }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('offers the purchase once the plan is marked purchasable', () => {
    render(<OfferCard offer={{ ...offer, purchasable: true }} money={money} />);
    expect(screen.getByRole('link', { name: /Join for ₹1,499/ })).toBeInTheDocument();
  });

  it('drops the countdown when there is no end date', () => {
    render(<OfferCard
      offer={{ ...offer, offerEndsOn: null, daysLeft: null }} money={money} />);
    expect(screen.queryByText(/days left/)).not.toBeInTheDocument();
  });

  it('survives a plan with no bundle to price against', () => {
    render(<OfferCard offer={{ ...offer, bundle: null, netSavingPaise: null }} money={money} />);
    expect(screen.getByText('Family Membership')).toBeInTheDocument();
  });
});

/**
 * Each of these is a control that fits at desktop width and silently squashes
 * below it. "It still renders" is not the same as "it is usable".
 */
describe('narrow screens', () => {
  /**
   * Every block at this breakpoint, concatenated.
   *
   * A stylesheet may declare the same `max-width` more than once — the footer has
   * its own 720px block and the narrow-screen repairs have another — and taking
   * only the first is how a rule that exists reads as missing.
   */
  const at = (bp: string) => {
    const marker = `@media (max-width: ${bp})`;
    const out: string[] = [];
    for (let i = css.indexOf(marker); i >= 0; i = css.indexOf(marker, i + 1)) {
      const j = css.indexOf('\n@media', i + marker.length);
      out.push(css.slice(i, j < 0 ? undefined : j));
    }
    return out.join('\n');
  };

  it('finds the breakpoints it is asserting against', () => {
    for (const bp of ['720px', '640px', '480px', '1000px']) {
      expect(at(bp).length, `no @media block at ${bp} — the helper is scanning nothing`)
        .toBeGreaterThan(0);
    }
  });

  it('lets every tab bar scroll, not just the account page', () => {
    const rules = at('720px');
    expect(rules, 'the admin console squashes four tabs into stubs')
      .toMatch(/(^|[^.\w])\.tabs\s*\{[^}]*overflow-x:\s*auto/m);
  });

  it('scrolls the category filter instead of wrapping it to three rows', () => {
    const rules = at('720px');
    expect(rules).toMatch(/\.catbar\s*\{[^}]*overflow-x:\s*auto/);
    expect(rules).toMatch(/\.catbar\s*\{[^}]*max-width:\s*100%/);
  });

  it('drops the membership price panel below the pitch rather than beside it', () => {
    expect(at('640px'))
      .toMatch(/\.plan\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });

  it('drops wizard step labels rather than truncating them into nonsense', () => {
    expect(at('480px')).toMatch(/\.wiz-rail\s+\.lb\s*\{[^}]*display:\s*none/);
  });

  it('keeps the sticky booking bar off the footer legal strip', () => {
    expect(css).toMatch(/footer\.site\s*\{[^}]*padding-bottom:\s*calc\([^)]*safe-area/);
  });

  it('scrolls the fourteen city chips instead of wrapping them to four rows', () => {
    expect(at('720px')).toMatch(/\.fcities\s+\.chips\s*\{[^}]*overflow-x:\s*auto/);
  });

  it('gives the footer masthead the full width once columns get tight', () => {
    expect(at('1000px')).toMatch(/\.fbrand\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/);
  });
});
