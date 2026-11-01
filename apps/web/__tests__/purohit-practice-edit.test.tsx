import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RegionProvider } from '@/lib/region-context';
import PurohitSetupPage from '@/app/purohit/setup/page';
import PurohitRatesPage from '@/app/purohit/rates/page';
import { QuickActions } from '@/components/purohit/quick-actions';

/**
 * My Practice, in edit mode.
 *
 * Direct response to feedback: the form was too long, and saving left the same open
 * form on screen with nothing changed about it. Both are tested here as behaviour,
 * not as markup — a collapsed summary with an Edit button, and a form that closes
 * itself the moment a save actually lands.
 */
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), {
  status, headers: { 'content-type': 'application/json' },
});

const PROFILE_BODY = {
  citySlug: 'kolkata',
  profile: {
    bio: 'Smarta vidhi', experienceYears: 18, languages: ['bn', 'hi'],
    traditions: ['smarta'], serviceRadiusKm: 15, baseLat: 22.57, baseLng: 88.36,
    kycStatus: 'verified', cashJobsEnabled: true, autoAccept: false,
    chantingSampleUrl: 'https://example.test/a.mp3', chantingSampleLabel: 'Gayatri',
  },
  services: [{ ritualId: 'r1', pricePaise: 150000, active: true }],
  catalogue: [
    { id: 'r1', slug: 'satyanarayan-puja', bandMin: 110000, bandMax: 250000, bandDefault: 150000 },
    { id: 'r2', slug: 'griha-prabesh', bandMin: 210000, bandMax: 510000, bandDefault: 310000 },
  ],
};

function mountSetup(calls: Array<{ url: string; method: string; body: unknown }> = []) {
  localStorage.setItem('themaithil.token', 'test-token');
  localStorage.setItem('themaithil.role', 'pandit');
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.includes('/v1/me/purohit/profile') && method === 'GET') return json(PROFILE_BODY);
    if (url.includes('/v1/me/purohit/profile') && method === 'PUT') {
      return json({ ...PROFILE_BODY.profile });
    }
    if (url.includes('/v1/me/purohit/payout-account')) return json({ linked: false });
    if (url.includes('/v1/rituals')) return json([]);
    return json({ ok: true });
  }) as unknown as typeof fetch;
  return render(<RegionProvider><PurohitSetupPage /></RegionProvider>);
}

beforeEach(() => { localStorage.clear(); });

describe('a verified purohit sees a summary, not an open form', () => {
  it('opens collapsed, with Edit rather than a page of fields', async () => {
    mountSetup();
    const edit = await screen.findByRole('button', { name: 'Edit' });
    expect(edit).toBeInTheDocument();
    // The fields are not even in the document — this is the "too long" fix, not
    // just a CSS hide. A screen reader on this page never encounters them until
    // Edit is pressed.
    expect(screen.queryByLabelText('Years')).toBeNull();
  });

  it('the summary states what is actually saved', async () => {
    mountSetup();
    await screen.findByRole('button', { name: 'Edit' });
    expect(screen.getByText(/18 years/)).toBeInTheDocument();
    expect(screen.getByText(/Kolkata/)).toBeInTheDocument();
  });

  it('Edit reveals the form', async () => {
    const user = userEvent.setup();
    mountSetup();
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(screen.getByLabelText('Years')).toBeInTheDocument();
  });

  it('does not render the services, payout or calendar sections at all', async () => {
    const user = userEvent.setup();
    mountSetup();
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    // These moved to their own pages; a stray reference here would mean the split
    // did not actually happen.
    expect(screen.queryByText('What do you perform?')).toBeNull();
    expect(screen.queryByText('Where should we send your money?')).toBeNull();
  });
});

describe('saving closes the form — it does not just disable a button', () => {
  it('collapses back to the summary on a successful save', async () => {
    const user = userEvent.setup();
    mountSetup();
    await user.click(await screen.findByRole('button', { name: 'Edit' }));

    const years = screen.getByLabelText('Years');
    await user.clear(years);
    await user.type(years, '19');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    // THE SECOND COMPLAINT: once saved, the open form must not still be there.
    await waitFor(() => expect(screen.queryByLabelText('Years')).toBeNull());
    expect(await screen.findByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByText(/19 years/)).toBeInTheDocument();
  });

  it('Cancel closes the form WITHOUT keeping the unsaved edit', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const user = userEvent.setup();
    mountSetup(calls);
    await user.click(await screen.findByRole('button', { name: 'Edit' }));

    const years = screen.getByLabelText('Years');
    await user.clear(years);
    await user.type(years, '99');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    // The summary must read the ORIGINAL value, not the abandoned edit — otherwise
    // Cancel would make it look like 99 had been saved when nothing was sent.
    expect(screen.getByText(/18 years/)).toBeInTheDocument();
    expect(screen.queryByText(/99 years/)).toBeNull();
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('a deep link with #practice opens the form directly', async () => {
    Object.defineProperty(window, 'location', {
      value: { ...window.location, hash: '#practice' }, writable: true, configurable: true,
    });
    mountSetup();
    await waitFor(() => expect(screen.getByLabelText('Years')).toBeInTheDocument());
  });
});

describe('services & rates moved to their own page', () => {
  function mountRates(calls: Array<{ url: string; method: string; body: unknown }> = []) {
    localStorage.setItem('themaithil.token', 'test-token');
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.includes('/v1/me/purohit/profile')) return json(PROFILE_BODY);
      return json({ ok: true });
    }) as unknown as typeof fetch;
    return render(<RegionProvider><PurohitRatesPage /></RegionProvider>);
  }

  it('summarises the current catalogue collapsed, by count and price range', async () => {
    mountRates();
    expect(await screen.findByText(/1 service/)).toBeInTheDocument();
  });

  it('expanding shows both the picker and the price list together', async () => {
    const user = userEvent.setup();
    mountRates();
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    // The name appears twice once the form is open — once as a picker option,
    // once as a rate-list row label — so a plain text match is ambiguous here.
    expect(screen.getByRole('button', { name: /Satyanarayan Puja/ })).toBeInTheDocument();
    expect(screen.getByLabelText(/Your dakshina for Satyanarayan Puja/)).toBeInTheDocument();
  });

  it('collapses again after a successful save', async () => {
    const user = userEvent.setup();
    mountRates();
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    await user.click(screen.getByText('Griha Prabesh'));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.queryByText('Satyanarayan Puja')).toBeNull());
    expect(await screen.findByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  it('refuses to save a rate outside the advertised band', async () => {
    const user = userEvent.setup();
    mountRates();
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const input = screen.getByLabelText(/Your dakshina for Satyanarayan Puja/);
    await user.clear(input);
    await user.type(input, '50000');
    // Same rule the devotee-facing page states: we do not let them be charged more
    // than we advertised, which starts with not letting the purohit save outside it.
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});

describe('the auto-accept toggle, previously a dead end', () => {
  function mountQuick() {
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/v1/me/purohit/profile')) {
        return json({ profile: { autoAccept: false } });
      }
      if (url.includes('/auto-accept')) {
        const body = JSON.parse(String(init?.body)) as { enabled: boolean };
        return json({ autoAccept: body.enabled });
      }
      return json({ slotsOpen: 340 });
    }) as unknown as typeof fetch;
    return render(<QuickActions />);
  }

  it('renders a real switch, not a link to a page with no control on it', async () => {
    mountQuick();
    expect(await screen.findByRole('switch')).toBeInTheDocument();
  });

  it('turns on and calls the dedicated endpoint, not the profile PUT', async () => {
    const user = userEvent.setup();
    mountQuick();
    const sw = await screen.findByRole('switch');
    expect(sw).toHaveAttribute('aria-checked', 'false');
    await user.click(sw);
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'true'));

    const call = (global.fetch as unknown as { mock: { calls: unknown[][] } })
      .mock.calls.find((c) => String(c[0]).includes('auto-accept'));
    expect(call?.[1]).toMatchObject({ method: 'PATCH' });
  });

  it('opening the calendar reports how many slots opened', async () => {
    const user = userEvent.setup();
    mountQuick();
    await user.click(await screen.findByRole('button', { name: /Open calendar/ }));
    expect(await screen.findByText(/340 slots open/)).toBeInTheDocument();
  });
});
