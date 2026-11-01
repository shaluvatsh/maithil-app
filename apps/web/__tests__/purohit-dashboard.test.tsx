import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { RegionProvider } from '@/lib/region-context';
import { PurohitDashboard } from '@/components/purohit/dashboard';
import { createTranslator, getRegion, DEFAULT_LOCALE } from '@themaithil/region';
import { navFor } from '@/lib/nav-model';

/**
 * The purohit dashboard.
 *
 * Three of these assert a PROMISE rather than a behaviour: no other purohit is ever
 * named, an attention code is never rendered raw, and the cash dues line is shown
 * even at zero. Each of those is a thing that would be easy to "tidy up" into a bug.
 */
const BASE = {
  standing: {
    rating: 4.8, ratingCount: 23, acceptanceRate: 0.93,
    experienceYears: 18, kycStatus: 'verified', newSupplyBoostRemaining: 0,
  },
  money: {
    grossPaise: 4500000, duesPaise: 0, tdsCarryPaise: 0, alreadyPaidPaise: 0,
    netPayablePaise: 3800000, cashLimitPaise: 500000, cashHeadroomPaise: 500000,
  },
  work: {
    today: 2, upcoming: 7, awaitingAccept: 0,
    completedThisPeriod: 5, droppedThisPeriod: 0, periodDays: 7, horizonDays: 120,
  },
  allocation: {
    periodDays: 7, offered: 13, nearMiss: 4, declinedAway: 1, lastScored: null,
  },
  cohort: { size: 12, suppressed: false, medianAcceptance: 0.61, medianRating: 4.5 },
  demand: {
    windowDays: 90,
    serviceRadiusKm: 15,
    areas: [
      { pincode: '700005', bookings: 9, yours: 2, suppressed: false, distanceKm: 3.1, covered: true },
      { pincode: '700091', bookings: 7, yours: 0, suppressed: false, distanceKm: 18.4, covered: false },
      { pincode: '700029', bookings: null, yours: 1, suppressed: true, distanceKm: 2.2, covered: true },
      { pincode: '700047', bookings: 6, yours: 0, suppressed: false, distanceKm: null, covered: null },
    ],
    uncovered: [
      { pincode: '700091', bookings: 7, yours: 0, suppressed: false, distanceKm: 18.4, covered: false },
    ],
  },
  ladder: [
    { code: 'verified', earned: true, progress: null },
    { code: 'photo', earned: false, progress: null },
    { code: 'ten_pujas', earned: false, progress: { have: 4, need: 10 } },
    { code: 'community_voice', earned: false, progress: { have: 1, need: 3 } },
  ],
  attention: [] as Array<{ code: string; severity: 'blocking' | 'advice' }>,
};

const mount = (over: Record<string, unknown> = {}) => {
  global.fetch = vi.fn(async () => new Response(JSON.stringify({ ...BASE, ...over }), {
    status: 200, headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch;
  return render(<RegionProvider><PurohitDashboard /></RegionProvider>);
};

const t = createTranslator(getRegion('kolkata'), DEFAULT_LOCALE);

beforeEach(() => { localStorage.clear(); });

describe('today comes first', () => {
  it('leads with what is booked today', async () => {
    mount();
    expect(await screen.findByText(/2 puja today/i)).toBeInTheDocument();
    expect(screen.getByText(/7 booked ahead/i)).toBeInTheDocument();
  });

  it('says so plainly when nothing is booked', async () => {
    mount({ work: { ...BASE.work, today: 0 } });
    expect(await screen.findByText(t('dash.todayNone'))).toBeInTheDocument();
  });

  it('raises a request that is waiting on an answer', async () => {
    mount({ work: { ...BASE.work, awaitingAccept: 3 } });
    // A deadline outranks everything else on the page.
    expect(await screen.findByText(/3 waiting for your answer/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: t('dash.answerNow') })).toBeInTheDocument();
  });
});

describe('money is broken down, not just totalled', () => {
  it('leads with what actually lands in their account', async () => {
    mount();
    await screen.findByText(t('dash.payable'));
    expect(screen.getByText('₹38,000')).toBeInTheDocument();
  });

  /**
   * Shown at zero on purpose. Cash jobs mean the purohit holds the devotee's money
   * and owes commission, so gross and net differ by an amount they never received —
   * hiding the line turns a legible deduction into an unexplained shortfall.
   */
  it('shows the cash-held line even when it is zero', async () => {
    mount();
    expect(await screen.findByText(t('dash.dues'))).toBeInTheDocument();
  });

  it('states the cash headroom', async () => {
    mount();
    expect(await screen.findByText(/Cash jobs available up to/i)).toBeInTheDocument();
  });
});

describe('it is not a leaderboard, and that is testable', () => {
  it('never renders another purohit’s name or id', async () => {
    mount();
    await screen.findByText(t('dash.allocation'));
    const text = document.body.textContent ?? '';
    // The API does not send peers; this asserts the component invents none either.
    expect(text).not.toMatch(/rank|position|#\d|leader/i);
  });

  it('says out loud that no one else is shown', async () => {
    mount();
    // The absence of a leaderboard is a promise, so it is stated rather than implied.
    expect(await screen.findByText(t('dash.allocationNote'))).toBeInTheDocument();
  });

  it('compares to a cohort median, never to a named peer', async () => {
    mount();
    expect(await screen.findByText(/Half the purohits in your city/i)).toBeInTheDocument();
  });

  it('explains the silence when the cohort is too small to anonymise', async () => {
    mount({ cohort: { size: 3, suppressed: true, medianAcceptance: null, medianRating: null } });
    // Rendering nothing would read as a broken panel; saying why does not.
    expect(await screen.findByText(t('dash.cohortSmall'))).toBeInTheDocument();
  });
});

describe('allocation explains the work', () => {
  it('shows offered, missed and declined as three equal tallies', async () => {
    mount();
    await screen.findByText(t('dash.offered'));
    expect(screen.getByText(t('dash.nearMiss'))).toBeInTheDocument();
    // Declined must be its own tally: a booking they turned down is not one they
    // were outranked on.
    expect(screen.getByText(t('dash.declinedAway'))).toBeInTheDocument();
  });

  it('says nothing has been allocated rather than showing three zeros', async () => {
    mount({ allocation: { periodDays: 7, offered: 0, nearMiss: 0, declinedAway: 0, lastScored: null } });
    expect(await screen.findByText(t('dash.allocationEmpty'))).toBeInTheDocument();
  });

  it('warns that the new-purohit boost is finite', async () => {
    mount({ standing: { ...BASE.standing, newSupplyBoostRemaining: 12 } });
    // A purohit who thinks this work rate is normal concludes the platform turned
    // against them when it expires.
    expect(await screen.findByText(/New-purohit boost/i)).toBeInTheDocument();
  });
});

describe('attention codes become language, or nothing', () => {
  it('renders a blocking problem with a route to fix it', async () => {
    mount({ attention: [{ code: 'payout_account_missing', severity: 'blocking' }] });
    expect(await screen.findByText(t('dash.attn.payout_account_missing'))).toBeInTheDocument();
    // Its own page under the profile menu, not a fragment. `/purohit/setup#payout`
    // was itself a fix for a worse version of this bug — but that page no longer has
    // a payout section at all; payouts moved to /purohit/payouts.
    expect(screen.getByRole('link', { name: t('dash.fix') })).toHaveAttribute(
      'href', '/purohit/payouts',
    );
  });

  it('never renders a raw code, not even for one it does not know', async () => {
    mount({ attention: [{ code: 'some_future_code', severity: 'advice' }] });
    await waitFor(() => expect(screen.getByText(t('dash.allocation'))).toBeInTheDocument());
    // A purohit must never be shown `cash_headroom_low`. An untranslated code is a
    // missing row, not a leaked identifier.
    expect(document.body.textContent).not.toContain('some_future_code');
  });

  it('separates advice from blocking', async () => {
    mount({
      attention: [
        { code: 'kyc_incomplete', severity: 'blocking' },
        { code: 'auto_accept_off', severity: 'advice' },
      ],
    });
    await screen.findByText(t('dash.attn.kyc_incomplete'));
    // Blocking sits above money, because a blocked purohit has no money to look at.
    const blocking = document.querySelector('.pd-attn.blocking');
    expect(blocking).toBeTruthy();
    expect(blocking!.textContent).toContain(t('dash.attn.kyc_incomplete'));
    expect(blocking!.textContent).not.toContain(t('dash.attn.auto_accept_off'));
  });
});

describe('demand tells them where to act, without naming a household', () => {
  it('lists neighbourhoods by demand', async () => {
    mount();
    await screen.findByText(t('dash.demand'));
    expect(screen.getByText('700005')).toBeInTheDocument();
    expect(screen.getByText('700091')).toBeInTheDocument();
  });

  it('says a total is withheld rather than showing a blank', async () => {
    mount();
    await screen.findByText(t('dash.demand'));
    // A blank cell reads as a bug; the reason is worth stating.
    expect(screen.getByText(t('dash.withheld'))).toBeInTheDocument();
  });

  it('never prints a number for a withheld bucket', async () => {
    mount();
    await screen.findByText(t('dash.demand'));
    const row = screen.getByText('700029').closest('li')!;
    // The suppressed row may show their own 1, never the withheld total.
    expect(row.textContent).toContain(t('dash.withheld'));
  });

  it('marks an area outside the radius and offers the fix', async () => {
    mount();
    await screen.findByText(t('dash.demand'));
    expect(screen.getByText(/outside your 15 km radius/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: t('dash.widenRadius') }))
      .toHaveAttribute('href', '/purohit/setup');
  });

  it('says the distance is unknown rather than claiming coverage', async () => {
    mount();
    await screen.findByText(t('dash.demand'));
    // Null coverage must not render as either "you cover this" or "outside".
    const row = screen.getByText('700047').closest('li')!;
    expect(row.textContent).toContain(t('dash.locationUnknown'));
    expect(row.textContent).not.toContain(t('dash.youCover'));
  });

  it('says so plainly when there is nothing to learn from yet', async () => {
    mount({ demand: { windowDays: 90, serviceRadiusKm: 15, areas: [], uncovered: [] } });
    expect(await screen.findByText(t('dash.demandEmpty'))).toBeInTheDocument();
  });

  it('offers no radius prompt when everything is covered', async () => {
    mount({
      demand: {
        windowDays: 90, serviceRadiusKm: 15,
        areas: [{ pincode: '700005', bookings: 9, yours: 2, suppressed: false, distanceKm: 3.1, covered: true }],
        uncovered: [],
      },
    });
    await screen.findByText(t('dash.demand'));
    expect(screen.queryByRole('link', { name: t('dash.widenRadius') })).toBeNull();
  });
});

describe('every prompt lands on the field it is about', () => {
  it('sends each problem to its own panel, not all to one page', async () => {
    mount({
      attention: [
        { code: 'payout_account_missing', severity: 'blocking' },
        { code: 'no_chanting_sample', severity: 'advice' },
      ],
    });
    await screen.findByText(t('dash.attn.payout_account_missing'));

    const hrefs = screen.getAllByRole('link', { name: t('dash.fix') })
      .map((a) => a.getAttribute('href'));
    // Five problems used to share one destination. Distinct routes is the fix.
    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect(hrefs).toContain('/purohit/payouts');
    expect(hrefs).toContain('/purohit/setup');
  });

  it('makes an unearned rung a link to what earns it', async () => {
    mount();
    await screen.findByText(t('dash.ladder'));
    // A rung is a thing to do, so it is one tap from the thing that does it.
    const photo = screen.getByText(t('dash.rung.photo'));
    expect(photo.tagName).toBe('A');
    expect(photo).toHaveAttribute('href', '/purohit/setup');
  });

  it('leaves an earned rung as plain text', async () => {
    mount();
    await screen.findByText(t('dash.ladder'));
    // A link that leads nowhere useful is worse than text.
    expect(screen.getByText(t('dash.rung.verified')).tagName).not.toBe('A');
  });
});

describe('the ladder states what every rung needs', () => {
  it('names each rung and says what it is for', async () => {
    mount();
    await screen.findByText(t('dash.ladder'));
    expect(screen.getByText(t('dash.rung.verified'))).toBeInTheDocument();
    // The criterion is the rule, not decoration: an unexplained badge is a mystery
    // to whoever has it and an insult to whoever does not.
    expect(screen.getByText(t('dash.rungWhy.photo'))).toBeInTheDocument();
  });

  it('keeps the criterion on an EARNED rung too', async () => {
    mount();
    await screen.findByText(t('dash.ladder'));
    // So a purohit knows what it was awarded for, not only that they have it.
    expect(screen.getByText(t('dash.rungWhy.verified'))).toBeInTheDocument();
  });

  it('shows progress where there is something to count, and not otherwise', async () => {
    mount();
    await screen.findByText(t('dash.ladder'));
    expect(screen.getByText('4 of 10')).toBeInTheDocument();
    // `verified` is a yes/no rung; "0 of 1" would read as a score.
    const verified = screen.getByText(t('dash.rung.verified')).closest('li')!;
    expect(verified.textContent).toContain(t('dash.rungDone'));
    expect(verified.textContent).not.toMatch(/\d+ of \d+/);
  });

  it('never renders a rung code, not even one it does not know', async () => {
    mount({
      ladder: [
        { code: 'verified', earned: true, progress: null },
        { code: 'some_future_rung', earned: false, progress: { have: 0, need: 5 } },
      ],
    });
    await screen.findByText(t('dash.ladder'));
    // A purohit must never be shown `samagri_accurate`; an untranslated rung is a
    // missing row, not a leaked identifier.
    expect(document.body.textContent).not.toContain('some_future_rung');
  });

  it('sits last, below everything about today', async () => {
    mount();
    await screen.findByText(t('dash.ladder'));
    const sections = [...document.querySelectorAll('.pd section')];
    // Long-horizon, read once a week — everything above it is about this morning.
    expect(sections[sections.length - 1]!.className).toContain('pd-ladder');
  });
});

describe('a dashboard failure does not take the page with it', () => {
  it('renders nothing when the request fails', async () => {
    global.fetch = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const { container } = render(<RegionProvider><PurohitDashboard /></RegionProvider>);
    await waitFor(() => expect(container.querySelector('.pd')).toBeNull());
  });
});

/**
 * Where "My practice" lives, and why it moves.
 *
 * Before approval the setup wizard IS the product — `PurohitOnboarding` replaces the
 * dashboard entirely, because a job inbox that cannot receive a job is three dead
 * panels — so the link belongs in the main bar where it cannot be missed. After
 * approval it is a settings page touched twice a year, and a purohit's main bar should
 * be the three things they use daily.
 */
describe('the purohit nav follows approval, not only role', () => {
  it('keeps setup in the main bar while they are not approved', () => {
    for (const kyc of [undefined, null, 'pending', 'submitted', 'rejected']) {
      const nav = navFor('pandit', kyc);
      expect(nav.links.map((l) => l.href), String(kyc)).toContain('/purohit/setup');
      expect(nav.account.map((l) => l.href), String(kyc)).not.toContain('/purohit/setup');
    }
  });

  it('moves it to the account menu once verified', () => {
    const nav = navFor('pandit', 'verified');
    expect(nav.links.map((l) => l.href)).not.toContain('/purohit/setup');
    expect(nav.account.map((l) => l.href)).toContain('/purohit/setup');
  });

  it('leaves the daily three in the bar either way', () => {
    for (const kyc of ['pending', 'verified']) {
      const hrefs = navFor('pandit', kyc).links.map((l) => l.href);
      expect(hrefs, kyc).toContain('/purohit');
      expect(hrefs, kyc).toContain('/panchang');
      expect(hrefs, kyc).toContain('/community');
    }
  });

  /**
   * Unknown must mean unapproved. Showing the link to somebody who no longer needs it
   * costs a line of chrome; hiding it from somebody who does costs them the only route
   * to becoming bookable.
   */
  it('treats an unknown status as unapproved', () => {
    expect(navFor('pandit').links.map((l) => l.href)).toContain('/purohit/setup');
  });

  it('changes nothing for the other roles', () => {
    expect(navFor('devotee', 'verified').links.map((l) => l.href))
      .toEqual(navFor('devotee').links.map((l) => l.href));
    expect(navFor('admin', 'verified').links.map((l) => l.href))
      .toEqual(navFor('admin').links.map((l) => l.href));
  });
});

/**
 * The expanded profile menu.
 *
 * Direct response to feedback: "My Practice section form is too long... can we
 * create a profile menu so dashboard, payouts, bookings and other relevant options
 * will be visible." Dashboard, Services & rates and Payouts all moved out of the two
 * pages that had grown too long and into destinations reachable from here.
 */
describe('the approved purohit profile menu', () => {
  it('offers Dashboard, Services & rates and Payouts, not only My practice', () => {
    const hrefs = navFor('pandit', 'verified').account.map((l) => l.href);
    expect(hrefs).toEqual([
      '/purohit/dashboard', '/purohit/setup', '/purohit/rates', '/purohit/payouts',
    ]);
  });

  it('does not duplicate My jobs, which already has the main bar', () => {
    const account = navFor('pandit', 'verified').account.map((l) => l.href);
    expect(account).not.toContain('/purohit');
  });

  it('stays empty while onboarding — the wizard is the whole product then', () => {
    expect(navFor('pandit', 'pending').account).toEqual([]);
  });
});
