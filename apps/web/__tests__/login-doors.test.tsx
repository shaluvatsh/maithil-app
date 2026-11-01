import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { RegionProvider } from '@/lib/region-context';
import LoginPage from '@/app/login/page';
import { setSearch } from './setup';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), {
  status, headers: { 'content-type': 'application/json' },
});

/** The login page asks `/v1/config` which doors this deployment can open. */
function mockConfig(otpLoginAvailable: boolean) {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/v1/config')) return json({ otpLoginAvailable, paymentsEnabled: true });
    return json({});
  }) as unknown as typeof fetch;
}

beforeEach(() => { setSearch(''); localStorage.clear(); });

/**
 * WHICH DOOR THE LOGIN SCREEN OPENS ON.
 *
 * Phone OTP is the right default for this market and stays the default wherever it
 * works — a purohit is likelier to have WhatsApp than an email habit (ADR 0009).
 * But it is the one sign-in path that depends on a messaging provider, and
 * WhatsApp's is gated behind Meta verification and 1–2 weeks of template approval.
 *
 * Until that lands, a hardcoded OTP default greets every visitor with the one door
 * that cannot open, while email and password — which need nothing but the database,
 * and have worked the whole time — sit behind a tab nobody clicks. The product read
 * as "login is broken" when it was only "login's default tab is broken".
 */
describe('the login screen opens on a door that works', () => {
  it('keeps phone OTP as the default wherever codes can be delivered', async () => {
    mockConfig(true);
    render(<RegionProvider><LoginPage /></RegionProvider>);

    expect(await screen.findByRole('button', { name: /phone otp/i })).toBeInTheDocument();
    // The OTP form, not the password one.
    await waitFor(() => expect(screen.getByLabelText(/mobile number/i)).toBeInTheDocument());
    expect(screen.queryByLabelText(/^password$/i)).not.toBeInTheDocument();
  });

  it('falls back to email and password when no code can be delivered', async () => {
    mockConfig(false);
    render(<RegionProvider><LoginPage /></RegionProvider>);

    await waitFor(() => expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument());
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
  });

  /**
   * Hidden rather than disabled. A disabled tab is an invitation to keep tapping
   * something that will never respond; its absence is simply a product with one
   * way in.
   */
  it('does not offer an OTP tab that cannot work', async () => {
    mockConfig(false);
    render(<RegionProvider><LoginPage /></RegionProvider>);

    await waitFor(() => expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /phone otp/i })).not.toBeInTheDocument();
  });

  /**
   * Optimistic while the answer is in flight: OTP is the normal case, so showing it
   * first avoids a visible flip on every load for deployments where it works.
   */
  it('shows the usual default before the server has answered', () => {
    global.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;
    render(<RegionProvider><LoginPage /></RegionProvider>);

    expect(screen.getByRole('button', { name: /phone otp/i })).toBeInTheDocument();
  });

  /** A failed config call must not lock anybody out of the page entirely. */
  it('still renders a way in when the config call fails', async () => {
    global.fetch = vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    render(<RegionProvider><LoginPage /></RegionProvider>);

    expect(await screen.findByRole('button', { name: /phone otp/i })).toBeInTheDocument();
  });
});
