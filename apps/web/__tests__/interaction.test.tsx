import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RegionProvider } from '@/lib/region-context';
import { Nav } from '@/app/nav';
import LoginPage from '@/app/login/page';

const withRegion = (node: React.ReactNode) => render(<RegionProvider>{node}</RegionProvider>);

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), {
  status, headers: { 'content-type': 'application/json' },
});

beforeEach(() => { localStorage.clear(); });

describe('city selection', () => {
  it('starts unset and prompts the user to choose', () => {
    withRegion(<Nav />);
    expect(screen.getByRole('button', { name: /Select your city/i })).toBeInTheDocument();
  });

  it('opens a searchable list of every serviced city', async () => {
    const user = userEvent.setup();
    withRegion(<Nav />);
    await user.click(screen.getByRole('button', { name: /Select your city/i }));

    const dialog = screen.getByPlaceholderText(/Search city or state/i);
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Bengaluru/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Chennai/ })).toBeInTheDocument();
  });

  it('filters by state as well as by city name', async () => {
    const user = userEvent.setup();
    withRegion(<Nav />);
    await user.click(screen.getByRole('button', { name: /Select your city/i }));
    await user.type(screen.getByPlaceholderText(/Search city or state/i), 'Bihar');
    expect(screen.getByRole('button', { name: /Patna/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Chennai/ })).not.toBeInTheDocument();
  });

  it('persists the choice and shows it in the header', async () => {
    const user = userEvent.setup();
    withRegion(<Nav />);
    await user.click(screen.getByRole('button', { name: /Select your city/i }));
    await user.click(screen.getByRole('button', { name: /Chennai/ }));
    expect(localStorage.getItem('themaithil.city')).toBe('chennai');
    expect(screen.getByRole('button', { name: /Chennai/ })).toBeInTheDocument();
  });

  it('says so plainly when a city is not served, instead of showing nothing', async () => {
    const user = userEvent.setup();
    withRegion(<Nav />);
    await user.click(screen.getByRole('button', { name: /Select your city/i }));
    await user.type(screen.getByPlaceholderText(/Search city or state/i), 'Reykjavik');
    expect(screen.getByText(/not in that city yet/i)).toBeInTheDocument();
  });
});

describe('mobile navigation', () => {
  it('exposes a menu button that toggles the links', async () => {
    const user = userEvent.setup();
    withRegion(<Nav />);
    const btn = screen.getByRole('button', { name: /Menu/i });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    await user.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('login form behaviour', () => {
  it('enables Send OTP only once a full number is entered', async () => {
    const user = userEvent.setup();
    withRegion(<LoginPage />);
    const send = screen.getByRole('button', { name: /Send OTP/i });
    expect(send).toBeDisabled();
    await user.type(screen.getByLabelText(/Mobile number/i), '9830012345');
    expect(send).toBeEnabled();
  });

  it('strips non-digits from the phone field', async () => {
    const user = userEvent.setup();
    withRegion(<LoginPage />);
    const input = screen.getByLabelText(/Mobile number/i);
    await user.type(input, '98a3b0-01 2345');
    expect(input).toHaveValue('9830012345');
  });

  it('switches to email and password, and requires both', async () => {
    const user = userEvent.setup();
    withRegion(<LoginPage />);
    await user.click(screen.getByRole('button', { name: /Email & password/i }));
    const submit = screen.getByRole('button', { name: /^Sign in$/i });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText(/Email address/i), 'a@b.com');
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText(/^Password$/i), 'a passphrase');
    expect(submit).toBeEnabled();
  });

  it('asks for name and phone when registering, since the pandit needs to reach you', async () => {
    const user = userEvent.setup();
    withRegion(<LoginPage />);
    await user.click(screen.getByRole('button', { name: /Create an account/i }));
    expect(screen.getByLabelText(/Full name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Mobile number/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create account/i })).toBeInTheDocument();
  });

  it('refuses an obviously malformed email before it ever reaches the server', async () => {
    const user = userEvent.setup();
    withRegion(<LoginPage />);
    await user.click(screen.getByRole('button', { name: /Email & password/i }));
    await user.type(screen.getByLabelText(/Email address/i), 'not-an-email');
    await user.type(screen.getByLabelText(/^Password$/i), 'a passphrase');
    expect(screen.getByText(/Enter a valid email address/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Sign in$/i })).toBeDisabled();
  });

  it('requires a real 8 characters to register, but not to sign in', async () => {
    const user = userEvent.setup();
    withRegion(<LoginPage />);
    await user.click(screen.getByRole('button', { name: /Create an account/i }));
    await user.type(screen.getByLabelText(/Full name/i), 'Debarati Sen');
    await user.type(screen.getByLabelText(/Mobile number/i), '9830012345');
    await user.type(screen.getByLabelText(/Email address/i), 'a@b.com');
    await user.type(screen.getByLabelText(/^Password$/i), 'short');
    expect(screen.getByRole('button', { name: /Create account/i })).toBeDisabled();
    await user.type(screen.getByLabelText(/^Password$/i), 'er-phrase');
    expect(screen.getByRole('button', { name: /Create account/i })).toBeEnabled();
  });

  it('will not let an empty name or a short phone number through at registration', async () => {
    const user = userEvent.setup();
    withRegion(<LoginPage />);
    await user.click(screen.getByRole('button', { name: /Create an account/i }));
    await user.type(screen.getByLabelText(/Email address/i), 'a@b.com');
    await user.type(screen.getByLabelText(/^Password$/i), 'a passphrase');
    const submit = screen.getByRole('button', { name: /Create account/i });
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText(/Full name/i), 'Debarati Sen');
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText(/Mobile number/i), '9830012345');
    expect(submit).toBeEnabled();
  });

  it('can reveal the password rather than trusting a typo blind', async () => {
    const user = userEvent.setup();
    withRegion(<LoginPage />);
    await user.click(screen.getByRole('button', { name: /Email & password/i }));
    const pw = screen.getByLabelText(/^Password$/i);
    expect(pw).toHaveAttribute('type', 'password');
    await user.click(screen.getByRole('button', { name: /Show password/i }));
    expect(pw).toHaveAttribute('type', 'text');
    await user.click(screen.getByRole('button', { name: /Hide password/i }));
    expect(pw).toHaveAttribute('type', 'password');
  });

  it('links a forgotten password to the real reset flow, not a dead end', async () => {
    const user = userEvent.setup();
    withRegion(<LoginPage />);
    await user.click(screen.getByRole('button', { name: /Email & password/i }));
    const link = screen.getByRole('link', { name: /Forgot your password/i });
    expect(link).toHaveAttribute('href', '/forgot-password');
  });

  it('cannot be used to exhaust the OTP rate limit with repeated resends', async () => {
    const user = userEvent.setup();
    global.fetch = vi.fn(async () => json({ requestId: 'req_1', devOtp: '123456' })) as unknown as typeof fetch;
    withRegion(<LoginPage />);
    await user.type(screen.getByLabelText(/Mobile number/i), '9830012345');
    await user.click(screen.getByRole('button', { name: /Send OTP/i }));

    const resend = await screen.findByRole('button', { name: /Resend OTP/i });
    expect(resend).toBeDisabled();
    expect(resend).toHaveTextContent(/Resend OTP in \d+s/);
  });

  it('never submits the OTP form before every digit is entered', async () => {
    const user = userEvent.setup();
    global.fetch = vi.fn(async () => json({ requestId: 'req_1' })) as unknown as typeof fetch;
    withRegion(<LoginPage />);
    await user.type(screen.getByLabelText(/Mobile number/i), '9830012345');
    await user.click(screen.getByRole('button', { name: /Send OTP/i }));

    await waitFor(() => expect(screen.getAllByLabelText(/Digit \d of 6/i)).toHaveLength(6));
    expect(screen.getByRole('button', { name: /Verify & continue/i })).toBeDisabled();
  });
});
