import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RegionProvider } from '@/lib/region-context';
import ForgotPasswordPage from '@/app/forgot-password/page';
import ResetPasswordPage from '@/app/reset-password/page';
import { setSearch } from './setup';

const withRegion = (node: React.ReactNode) => render(<RegionProvider>{node}</RegionProvider>);

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), {
  status, headers: { 'content-type': 'application/json' },
});

beforeEach(() => { setSearch(''); });

describe('requesting a reset by email', () => {
  it('disables the button until the email looks real', async () => {
    const user = userEvent.setup();
    withRegion(<ForgotPasswordPage />);
    const submit = screen.getByRole('button', { name: /Send reset link/i });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText(/Email address/i), 'not-an-email');
    expect(submit).toBeDisabled();
    await user.clear(screen.getByLabelText(/Email address/i));
    await user.type(screen.getByLabelText(/Email address/i), 'a@b.com');
    expect(submit).toBeEnabled();
  });

  it('shows the same confirmation screen it would for an unregistered email, since it cannot tell the difference itself', async () => {
    const user = userEvent.setup();
    global.fetch = vi.fn(async () => json({ ok: true })) as unknown as typeof fetch;
    withRegion(<ForgotPasswordPage />);
    await user.type(screen.getByLabelText(/Email address/i), 'someone@example.com');
    await user.click(screen.getByRole('button', { name: /Send reset link/i }));

    expect(await screen.findByText(/Check your email/i)).toBeInTheDocument();
    expect(screen.getByText(/someone@example\.com/)).toBeInTheDocument();
  });

  it('surfaces a rate-limit error instead of hanging or pretending it worked', async () => {
    const user = userEvent.setup();
    global.fetch = vi.fn(async () => json(
      { error: { code: 'PASSWORD_RESET_RATE_LIMITED', message: 'too many reset requests for this address; try again in an hour' } },
      429,
    )) as unknown as typeof fetch;
    withRegion(<ForgotPasswordPage />);
    await user.type(screen.getByLabelText(/Email address/i), 'someone@example.com');
    await user.click(screen.getByRole('button', { name: /Send reset link/i }));

    expect(await screen.findByText(/try again in an hour/i)).toBeInTheDocument();
    expect(screen.queryByText(/Check your email/i)).not.toBeInTheDocument();
  });
});

describe('finishing a reset', () => {
  it('refuses to even try without a token in the link', async () => {
    withRegion(<ResetPasswordPage />);
    expect(await screen.findByText(/This link is incomplete/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/New password/i)).not.toBeInTheDocument();
  });

  it('requires a real 8 characters before the button enables', async () => {
    setSearch('token=abc123');
    const user = userEvent.setup();
    withRegion(<ResetPasswordPage />);
    const submit = await screen.findByRole('button', { name: /Set new password/i });
    expect(submit).toBeDisabled();
    await user.type(await screen.findByLabelText(/New password/i), 'short');
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText(/New password/i), 'er-phrase');
    expect(submit).toBeEnabled();
  });

  it('can reveal the new password rather than trusting a typo blind', async () => {
    setSearch('token=abc123');
    const user = userEvent.setup();
    withRegion(<ResetPasswordPage />);
    const pw = await screen.findByLabelText(/New password/i);
    expect(pw).toHaveAttribute('type', 'password');
    await user.click(screen.getByRole('button', { name: /Show password/i }));
    expect(pw).toHaveAttribute('type', 'text');
  });

  it('confirms success and sends them on to sign in', async () => {
    setSearch('token=abc123');
    const user = userEvent.setup();
    global.fetch = vi.fn(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { token: string; password: string };
      expect(body.token).toBe('abc123');
      return json({ ok: true });
    }) as unknown as typeof fetch;
    withRegion(<ResetPasswordPage />);
    await user.type(await screen.findByLabelText(/New password/i), 'a long enough passphrase');
    await user.click(screen.getByRole('button', { name: /Set new password/i }));

    expect(await screen.findByText(/Password changed/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Sign in/i })).toHaveAttribute('href', '/login');
  });

  it('offers a fresh link rather than a dead end when the token is expired or already used', async () => {
    setSearch('token=stale');
    const user = userEvent.setup();
    global.fetch = vi.fn(async () => json(
      { error: { code: 'PASSWORD_RESET_INVALID', message: 'this link has expired or was already used; request a new one' } },
      400,
    )) as unknown as typeof fetch;
    withRegion(<ResetPasswordPage />);
    await user.type(await screen.findByLabelText(/New password/i), 'a long enough passphrase');
    await user.click(screen.getByRole('button', { name: /Set new password/i }));

    await waitFor(() => expect(screen.getByText(/expired or was already used/i)).toBeInTheDocument());
    expect(screen.getByRole('link', { name: /Request a new link/i })).toHaveAttribute('href', '/forgot-password');
  });
});
