import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RegionProvider } from '@/lib/region-context';
import { Nav } from '@/app/nav';
import LoginPage from '@/app/login/page';

const withRegion = (node: React.ReactNode) => render(<RegionProvider>{node}</RegionProvider>);

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
});
