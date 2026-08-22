import { z } from 'zod';
import { DomainError, ErrorCode } from '@themaithil/contracts';

/**
 * A purohit's payout destination.
 *
 * Split out of the controller because the validation is the interesting part, and
 * because it is the one place in this codebase that handles a bank account number.
 * The rule it enforces: the number arrives, is checked, is forwarded to the payment
 * provider, and is never written down. What we keep is the provider's opaque handle
 * plus the last four digits, which is enough for a purohit to recognise the account
 * and useless to anyone who steals the table.
 */

/**
 * IFSC: four letters, a literal zero, then six alphanumerics.
 *
 * The fifth character is reserved by RBI and is always `0`. Checking it costs
 * nothing and catches the most common typo — a transposition in the bank code — at
 * the point where the purohit can still fix it, rather than at a failed transfer
 * three weeks later when they are chasing a missing payout.
 */
export const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;

/**
 * Indian account numbers run 9–18 digits depending on the bank; there is no
 * checksum to verify against, which is exactly why the confirmation field below is
 * not optional politeness.
 */
export const ACCOUNT_NUMBER = /^\d{9,18}$/;

/** `name@bank`. Deliberately permissive on the handle, strict on the shape. */
export const UPI_VPA = /^[\w.\-]{2,64}@[a-zA-Z]{2,64}$/;

const BankAccount = z.object({
  method: z.literal('bank_account'),
  holderName: z.string().trim().min(2).max(120),
  accountNumber: z.string().trim().regex(ACCOUNT_NUMBER, 'account number must be 9 to 18 digits'),
  /**
   * Typed twice, and the two must match.
   *
   * There is no checksum in an Indian account number, so a single wrong digit is
   * indistinguishable from a correct one until money lands in a stranger's account.
   * Re-entry is the only validation available, and a payout to the wrong account is
   * not something the platform can unwind.
   */
  accountNumberConfirm: z.string().trim(),
  ifsc: z.string().trim().toUpperCase().regex(IFSC, 'that IFSC does not look right'),
});

const UpiAccount = z.object({
  method: z.literal('upi'),
  holderName: z.string().trim().min(2).max(120),
  vpa: z.string().trim().toLowerCase().regex(UPI_VPA, 'that UPI id does not look right'),
});

/*
 * The cross-field check hangs off the UNION, not off `BankAccount`.
 *
 * `z.discriminatedUnion` needs plain objects to read the discriminator from; a
 * `.refine` wraps its member in a `ZodEffects` and the union no longer typechecks.
 * Attaching it here keeps the fast discriminated dispatch and still refuses a
 * mistyped account number.
 */
export const PayoutAccountInputSchema = z.discriminatedUnion('method', [
  BankAccount, UpiAccount,
]).superRefine((v, ctx) => {
  if (v.method === 'bank_account' && v.accountNumber !== v.accountNumberConfirm) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['accountNumberConfirm'],
      message: 'the two account numbers do not match',
    });
  }
});

export type PayoutAccountRequest = z.infer<typeof PayoutAccountInputSchema>;

/**
 * What is safe to persist, derived from what was submitted.
 *
 * A function rather than an inline object so there is a single, testable answer to
 * "what did we keep?". A test can assert that the account number is not among the
 * keys, which is a much harder thing to break by accident than a code review of the
 * controller.
 */
export function storableFields(input: PayoutAccountRequest): {
  payoutMethod: 'bank_account' | 'upi';
  payoutHolderName: string;
  payoutLast4: string | null;
  payoutIfsc: string | null;
  payoutUpiVpa: string | null;
} {
  return input.method === 'bank_account'
    ? {
      payoutMethod: 'bank_account',
      payoutHolderName: input.holderName,
      payoutLast4: input.accountNumber.slice(-4),
      payoutIfsc: input.ifsc,
      payoutUpiVpa: null,
    }
    : {
      payoutMethod: 'upi',
      payoutHolderName: input.holderName,
      // The handle before the @ is the recognisable part, and a VPA is not a secret
      // in the way an account number is — it is designed to be shared to receive money.
      payoutLast4: null,
      payoutIfsc: null,
      payoutUpiVpa: input.vpa,
    };
}

/**
 * A purohit with no destination cannot be paid, and must be told so in those terms.
 *
 * Thrown from the payout path rather than checked in the UI: a payout that silently
 * computes a number and moves nothing is the failure this whole change exists to
 * remove.
 */
export function requirePayoutDestination(linkedAccountId: string | null | undefined): string {
  if (!linkedAccountId) {
    throw new DomainError(
      ErrorCode.PAYOUT_ACCOUNT_MISSING,
      'no payout account on file — add a bank account or UPI id before requesting a payout',
    );
  }
  return linkedAccountId;
}
