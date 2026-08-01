import {
  type Paise, paise, add, sub, bps, ZERO,
  type PaymentMode, type PriceBreakdown, DomainError, ErrorCode,
} from '@themaithil/contracts';
import type { Leg } from './ledger';

/**
 * SETTLEMENT. Pure planner: takes a completed booking and returns the ledger legs.
 * No I/O, so the whole thing is table-testable - which matters more here than
 * anywhere else in the codebase.
 *
 * This corrects two defects in the original algorithm:
 *
 * 1. TDS ON CASH. The original computed TDS over `sum of pandit ledger credits`.
 *    In cash mode the dakshina never becomes a ledger credit, so the cash portion
 *    escaped withholding entirely. But s.194-O deems the e-commerce operator to have
 *    made the payment even when the purchaser pays the participant directly.
 *    Fix: post a NOTIONAL credit for the cash dakshina plus an offsetting
 *    `cash_settled_direct` debit. Net cash effect zero, TDS base correct, and the
 *    purohit's earnings dashboard finally shows real totals.
 *
 * 2. DUES ARE EXCEPTIONAL. Because the token always contains the full platform fee,
 *    a normal cash booking creates NO due. Dues arise only when a promo waived part
 *    of the fee (feeShortfallPaise > 0). This is the model the handoff intended and
 *    the PRD contradicted.
 */

/** s.194-O: 0.1% of gross (excluding commission), w.e.f. 1 Oct 2024. */
export const TDS_BPS = 10;

export interface SettlementInput {
  bookingId: string;
  panditId: string;
  devoteeId: string;
  paymentMode: PaymentMode;
  price: PriceBreakdown;
  /** What the purohit reported collecting. Required in cash mode. */
  cashCollectedPaise?: Paise;
  /** Below the s.194-O annual threshold, no withholding applies. */
  tdsApplicable: boolean;
}

export interface SettlementPlan {
  legs: Leg[];
  /** Non-zero only when a promo ate part of the fee. */
  cashDuePaise: Paise;
  tdsPaise: Paise;
  panditNetPaise: Paise;
}

export function planSettlement(input: SettlementInput): SettlementPlan {
  const { price, panditId } = input;
  const legs: Leg[] = [];

  // What the purohit is owed for the service itself, regardless of how it was paid.
  const panditGross = add(price.dakshinaPaise, price.samagriPaise, price.travelPaise);

  const tds = input.tdsApplicable ? bps(panditGross, TDS_BPS) : ZERO;

  const platform = { type: 'platform' as const, ownerId: null };
  const escrow = { type: 'escrow' as const, ownerId: null };
  const pandit = { type: 'pandit' as const, ownerId: panditId };
  const tax = { type: 'tax' as const, ownerId: null };

  if (input.paymentMode === 'cash') {
    const expected = price.balancePaise;
    const collected = input.cashCollectedPaise ?? ZERO;
    if (collected !== expected) {
      // Settlement is BLOCKED, not adjusted. The mismatch becomes a dispute and a
      // human decides. Silently settling a mismatch is how commission leaks.
      throw new DomainError(
        ErrorCode.CASH_AMOUNT_MISMATCH,
        `cash collected ${collected} does not match expected balance ${expected}`,
        { bookingId: input.bookingId, expected, collected },
      );
    }

    // The token (= platform fee) is already in escrow. Release it to the platform.
    if (price.tokenPaise > 0) {
      legs.push(
        { account: escrow, direction: 'debit', amount: price.tokenPaise, type: 'commission' },
        { account: platform, direction: 'credit', amount: price.tokenPaise, type: 'commission' },
      );
    }

    // Notional credit + offsetting debit. Net zero, but the TDS base and the
    // purohit's earnings history are now correct. This is fix (1) above.
    if (panditGross > 0) {
      legs.push(
        { account: platform, direction: 'debit', amount: panditGross, type: 'balance',
          meta: { notional: true, reason: 'cash_collected_on_site' } },
        { account: pandit, direction: 'credit', amount: panditGross, type: 'balance',
          meta: { notional: true } },
        { account: pandit, direction: 'debit', amount: panditGross, type: 'cash_settled_direct' },
        { account: platform, direction: 'credit', amount: panditGross,
          type: 'cash_settled_direct', meta: { notional: true } },
      );
    }

    // Withholding cannot be taken from money we never held, so it carries forward
    // against the next digital payout.
    if (tds > 0) {
      legs.push(
        { account: pandit, direction: 'debit', amount: tds, type: 'tds_carry' },
        { account: tax, direction: 'credit', amount: tds, type: 'tds_carry' },
      );
    }
  } else {
    // Digital: the full amount sits in escrow. Split it.
    if (price.platformFeePaise > 0) {
      legs.push(
        { account: escrow, direction: 'debit', amount: price.platformFeePaise, type: 'commission' },
        { account: platform, direction: 'credit', amount: price.platformFeePaise, type: 'commission' },
      );
    }
    if (panditGross > 0) {
      legs.push(
        { account: escrow, direction: 'debit', amount: panditGross, type: 'balance' },
        { account: pandit, direction: 'credit', amount: panditGross, type: 'balance' },
      );
    }
    if (tds > 0) {
      legs.push(
        { account: pandit, direction: 'debit', amount: tds, type: 'tds' },
        { account: tax, direction: 'credit', amount: tds, type: 'tds' },
      );
    }
  }

  // Fix (2): a due arises only from an exception, never from cash per se.
  const cashDue = price.feeShortfallPaise;
  if (cashDue > 0) {
    legs.push(
      { account: pandit, direction: 'debit', amount: cashDue, type: 'cash_due',
        meta: { reason: 'promo_waived_platform_fee' } },
      { account: platform, direction: 'credit', amount: cashDue, type: 'cash_due' },
    );
  }

  const panditNet =
    input.paymentMode === 'cash' ? sub(ZERO, add(tds, cashDue)) : sub(panditGross, add(tds, cashDue));

  return { legs, cashDuePaise: cashDue, tdsPaise: tds, panditNetPaise: paise(panditNet) };
}

/** Escrow entries at token capture. Money enters the system here and nowhere else. */
export function planTokenCapture(args: {
  bookingId: string; devoteeId: string; amount: Paise;
}): Leg[] {
  if (args.amount <= 0) return [];
  return [
    { account: { type: 'devotee_credit', ownerId: args.devoteeId },
      direction: 'debit', amount: args.amount, type: 'token' },
    { account: { type: 'escrow', ownerId: null },
      direction: 'credit', amount: args.amount, type: 'token' },
  ];
}
