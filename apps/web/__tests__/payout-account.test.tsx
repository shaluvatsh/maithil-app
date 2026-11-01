import './setup';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RegionProvider } from '@/lib/region-context';
import {
  PayoutAccountForm, PayoutAccountPanel, describeAccount, type PayoutAccount,
} from '@/components/purohit/payout-account';

const NONE: PayoutAccount = {
  linked: false, method: null, holderName: null, last4: null,
  ifsc: null, upiVpa: null, linkedAt: null,
};
const BANK: PayoutAccount = {
  linked: true, method: 'bank_account', holderName: 'R Chakraborty',
  last4: '7890', ifsc: 'HDFC0001234', upiVpa: null, linkedAt: '2026-08-01T00:00:00Z',
};

/** Every request the form makes, so a test can assert what left the browser. */
let sent: Array<{ url: string; body: unknown }> = [];

beforeEach(() => {
  localStorage.clear();
  sent = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.body) sent.push({ url, body: JSON.parse(String(init.body)) });
    const body = url.includes('payout-account')
      ? (init?.method === 'PUT' ? { linked: true } : NONE)
      : {};
    return new Response(JSON.stringify(body), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

const withRegion = (node: React.ReactNode) =>
  render(<RegionProvider>{node}</RegionProvider>);

/**
 * A purohit could not be paid at all before this existed.
 *
 * `pandit_profiles.linked_account_id` had been in the schema since the payments
 * client was written and NOTHING ever set it — there was no bank or UPI capture
 * anywhere in onboarding or the profile. Payouts computed a correct net payable with
 * no destination while the earnings screen promised weekly payouts.
 */
describe('the dashboard says plainly when we cannot pay', () => {
  it('warns while no account exists', async () => {
    withRegion(<PayoutAccountPanel />);
    expect(await screen.findByText(/cannot pay you yet/i)).toBeInTheDocument();
  });

  /**
   * The panel opens as a banner rather than an inline form — adding a payout
   * account is a once-ever task and it used to unfold four empty inputs above the
   * job inbox on every single visit. Both methods still have to be one tap away,
   * which is what this pins; the assertion moved behind that tap rather than being
   * dropped, because "can a purohit still reach UPI" is the thing worth keeping.
   */
  it('offers both a bank account and UPI once opened', async () => {
    const u = userEvent.setup();
    withRegion(<PayoutAccountPanel />);
    await u.click(await screen.findByRole('button', { name: /add account/i }));
    expect(await screen.findByRole('button', { name: /Bank account/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /UPI/i })).toBeInTheDocument();
  });

  /** The warning itself must not need a tap — it is the reason to tap. */
  it('states the problem without being opened', async () => {
    withRegion(<PayoutAccountPanel />);
    expect(await screen.findByText(/cannot pay you yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Bank account/i })).not.toBeInTheDocument();
  });

  it('goes quiet once an account is on file', () => {
    withRegion(<PayoutAccountForm account={BANK} onSaved={() => {}} />);
    expect(screen.queryByText(/cannot pay you/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Account ending 7890/)).toBeInTheDocument();
  });
});

/**
 * There is no checksum in an Indian account number: one transposed digit is
 * indistinguishable from a correct one until the money is in a stranger's account,
 * and the platform cannot pull it back. Re-entry is the only check available.
 */
describe('a mistyped account number cannot be submitted', () => {
  const fill = async (num: string, confirm: string) => {
    const u = userEvent.setup();
    withRegion(<PayoutAccountForm account={NONE} onSaved={() => {}} />);
    await u.type(screen.getByLabelText(/Name on the account/i), 'R Chakraborty');
    await u.type(screen.getByLabelText(/^Account number/i), num);
    await u.type(screen.getByLabelText(/Type it again/i), confirm);
    await u.type(screen.getByLabelText(/IFSC/i), 'HDFC0001234');
    return u;
  };

  it('keeps Save disabled and says why', async () => {
    await fill('50100234567890', '50100234567809');
    expect(screen.getByText(/do not match/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save payout account/i })).toBeDisabled();
  });

  it('enables Save when they agree', async () => {
    await fill('50100234567890', '50100234567890');
    expect(screen.getByRole('button', { name: /Save payout account/i })).toBeEnabled();
  });

  /** The IFSC's fifth character is a reserved zero; the commonest typo breaks it. */
  it('refuses an IFSC without the reserved zero', async () => {
    const u = userEvent.setup();
    withRegion(<PayoutAccountForm account={NONE} onSaved={() => {}} />);
    await u.type(screen.getByLabelText(/Name on the account/i), 'R Chakraborty');
    await u.type(screen.getByLabelText(/^Account number/i), '50100234567890');
    await u.type(screen.getByLabelText(/Type it again/i), '50100234567890');
    await u.type(screen.getByLabelText(/IFSC/i), 'HDFC1001234');
    expect(screen.getByRole('button', { name: /Save payout account/i })).toBeDisabled();
  });
});

describe('the account number does not linger', () => {
  it('is cleared from the form once sent', async () => {
    const u = userEvent.setup();
    withRegion(<PayoutAccountForm account={NONE} onSaved={() => {}} />);
    await u.type(screen.getByLabelText(/Name on the account/i), 'R Chakraborty');
    await u.type(screen.getByLabelText(/^Account number/i), '50100234567890');
    await u.type(screen.getByLabelText(/Type it again/i), '50100234567890');
    await u.type(screen.getByLabelText(/IFSC/i), 'HDFC0001234');
    await u.click(screen.getByRole('button', { name: /Save payout account/i }));

    const put = sent.find((r) => r.url.includes('payout-account'));
    expect(put?.body).toMatchObject({
      method: 'bank_account', accountNumber: '50100234567890', ifsc: 'HDFC0001234',
    });
  });

  /** Digits only. Spaces and dashes get pasted in constantly. */
  it('strips anything that is not a digit as it is typed', async () => {
    const u = userEvent.setup();
    withRegion(<PayoutAccountForm account={NONE} onSaved={() => {}} />);
    const input = screen.getByLabelText(/^Account number/i);
    await u.type(input, '5010 0234-5678');
    expect(input).toHaveValue('501002345678');
  });
});

describe('what a purohit reads back', () => {
  it('shows four digits and a branch code, never the number', () => {
    expect(describeAccount(BANK)).toBe('Account ending 7890 · HDFC0001234');
  });

  it('shows a UPI id in full, since it is made to be shared', () => {
    expect(describeAccount({
      ...NONE, linked: true, method: 'upi', upiVpa: 'ram@okaxis',
    })).toBe('ram@okaxis');
  });

  it('says so when there is nothing', () => {
    expect(describeAccount(NONE)).toMatch(/No payout account/i);
  });
});
