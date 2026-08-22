import { describe, it, expect } from 'vitest';
import {
  PayoutAccountInputSchema, storableFields, requirePayoutDestination,
  IFSC, ACCOUNT_NUMBER, UPI_VPA,
} from '../payout-account';

const bank = {
  method: 'bank_account' as const,
  holderName: 'Ramakrishna Chakraborty',
  accountNumber: '50100234567890',
  accountNumberConfirm: '50100234567890',
  ifsc: 'HDFC0001234',
};

const upi = {
  method: 'upi' as const,
  holderName: 'Ramakrishna Chakraborty',
  vpa: 'ramakrishna@okaxis',
};

/**
 * The account number must not survive the request.
 *
 * It is sent to the payment provider once, in the call that creates the linked
 * account, and what we keep is the opaque id that comes back plus four digits a
 * purohit can recognise. This is the property worth testing directly rather than
 * inferring from a code review: it is easy to add a field to a persistence object
 * and very hard to notice that you have turned a table into a list of bank accounts.
 */
describe('what we keep', () => {
  it('never includes the account number', () => {
    const stored = storableFields(PayoutAccountInputSchema.parse(bank));
    const serialised = JSON.stringify(stored);
    expect(serialised).not.toContain(bank.accountNumber);
    expect(Object.keys(stored)).not.toContain('accountNumber');
  });

  it('keeps only the last four digits, so the purohit can recognise it', () => {
    const stored = storableFields(PayoutAccountInputSchema.parse(bank));
    expect(stored.payoutLast4).toBe('7890');
    expect(stored.payoutIfsc).toBe('HDFC0001234');
  });

  /** A VPA is designed to be shared in order to receive money; it is not a secret. */
  it('keeps a UPI id in full and no bank fields', () => {
    const stored = storableFields(PayoutAccountInputSchema.parse(upi));
    expect(stored.payoutUpiVpa).toBe('ramakrishna@okaxis');
    expect(stored.payoutLast4).toBeNull();
    expect(stored.payoutIfsc).toBeNull();
  });
});

/**
 * There is no checksum in an Indian account number, so a transposed digit is
 * indistinguishable from a correct one until the money is in a stranger's account —
 * which the platform cannot unwind. Re-entry is the only check available.
 */
describe('a mistyped account number is caught before the money moves', () => {
  it('refuses when the two entries disagree', () => {
    const r = PayoutAccountInputSchema.safeParse({
      ...bank, accountNumberConfirm: '50100234567809',
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]?.path).toEqual(['accountNumberConfirm']);
    }
  });

  it('accepts when they match', () => {
    expect(PayoutAccountInputSchema.safeParse(bank).success).toBe(true);
  });

  /** UPI carries no confirmation field, and requiring one would be theatre. */
  it('does not demand a confirmation for UPI', () => {
    expect(PayoutAccountInputSchema.safeParse(upi).success).toBe(true);
  });
});

describe('IFSC', () => {
  /**
   * The fifth character is reserved by RBI and is always zero. Checking it catches
   * the most common typo at the point the purohit can still fix it, rather than at a
   * failed transfer weeks later while they chase a missing payout.
   */
  it('requires the reserved zero in the fifth position', () => {
    expect(IFSC.test('HDFC0001234')).toBe(true);
    expect(IFSC.test('HDFC1001234')).toBe(false);
  });

  it('requires four leading letters and eleven characters', () => {
    expect(IFSC.test('SBIN0000001')).toBe(true);
    expect(IFSC.test('SBI0000001')).toBe(false);
    expect(IFSC.test('HDFC00012345')).toBe(false);
  });

  it('is accepted in lower case and stored upper', () => {
    const r = PayoutAccountInputSchema.parse({ ...bank, ifsc: 'hdfc0001234' });
    expect(r.method === 'bank_account' && r.ifsc).toBe('HDFC0001234');
  });
});

describe('account number and VPA shapes', () => {
  it('accepts 9 to 18 digits', () => {
    expect(ACCOUNT_NUMBER.test('123456789')).toBe(true);
    expect(ACCOUNT_NUMBER.test('123456789012345678')).toBe(true);
    expect(ACCOUNT_NUMBER.test('12345678')).toBe(false);
    expect(ACCOUNT_NUMBER.test('1234567890123456789')).toBe(false);
  });

  it('rejects anything but digits — spaces and dashes get pasted in constantly', () => {
    expect(ACCOUNT_NUMBER.test('5010 0234 5678')).toBe(false);
    expect(ACCOUNT_NUMBER.test('50100-234567')).toBe(false);
  });

  it('accepts a normal VPA and rejects an email', () => {
    expect(UPI_VPA.test('ramakrishna@okaxis')).toBe(true);
    expect(UPI_VPA.test('9830000000@ybl')).toBe(true);
    expect(UPI_VPA.test('someone@gmail.com')).toBe(false);
    expect(UPI_VPA.test('nobank')).toBe(false);
  });

  it('lower-cases a VPA, since handles are not case sensitive', () => {
    const r = PayoutAccountInputSchema.parse({ ...upi, vpa: 'RamaKrishna@OkAxis' });
    expect(r.method === 'upi' && r.vpa).toBe('ramakrishna@okaxis');
  });
});

describe('a purohit with no destination', () => {
  it('is refused with a code a client can branch on', () => {
    expect(() => requirePayoutDestination(null))
      .toThrow(/payout account/i);
    try {
      requirePayoutDestination(undefined);
    } catch (e) {
      expect((e as { code: string }).code).toBe('PAYOUT_ACCOUNT_MISSING');
    }
  });

  it('passes the handle through once one exists', () => {
    expect(requirePayoutDestination('acc_abc123')).toBe('acc_abc123');
  });
});
