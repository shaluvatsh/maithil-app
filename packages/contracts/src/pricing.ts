import { type Paise, ZERO, add, sub, bps, scale, paise, max } from './money.js';
import type { PaymentMode, SamagriOption } from './enums.js';

/**
 * Pricing engine. Pure, deterministic, no I/O - so the devotee app can render an
 * accurate preview and the server can be authoritative using identical code.
 *
 * MODEL (this resolves an ambiguity left open in both source documents):
 * the platform fee is a SEPARATE LINE CHARGED TO THE DEVOTEE, on top of dakshina.
 * The purohit receives dakshina + samagri + travel in full.
 *
 * That is what makes cash safe and the token arithmetic trivial:
 *   token (cash / token+balance) = platform fee + kit value
 *   token (digital_full)         = the whole total — see `computePrice`
 *   cash balance (to purohit)    = dakshina + samagri + travel
 * The purohit is never asked to remit anything, so commission cannot leak.
 */

export const COMMISSION_BPS = { standard: 1500, fully_digital: 1200 } as const;
export const SURGE_CAP_BPS = 15_000;          // 1.5x hard ceiling
export const SAMAGRI_SOURCING_BPS = 500;      // 5% sourcing allowance, paid TO the purohit

export interface PriceInput {
  /** Purohit's listed price for this ritual, before surge. */
  dakshinaBasePaise: Paise;
  /** Sum of BOM line items at catalogue rates. Zero unless samagri is 'pandit_brings'. */
  bomTotalPaise: Paise;
  travelFeePaise: Paise;
  /** Surge in basis points. 10000 = 1.0x. Clamped to SURGE_CAP_BPS. */
  surgeBps: number;
  samagriOption: SamagriOption;
  paymentMode: PaymentMode;
  /**
   * Promo discount, applied to the PLATFORM FEE ONLY and capped at it.
   * Anything more generous is a devotee credit grant against the ledger, not a
   * price change - that keeps the purohit's payable independent of our marketing.
   */
  promoDiscountPaise?: Paise;
  /** Partner kit value. Always zero in R1 (kits are out of scope - ADR 0008). */
  kitValuePaise?: Paise;
  /**
   * Whether this deployment can take money online at all (`PAYMENTS_ENABLED`).
   *
   * Defaults to TRUE, so every existing caller and every existing test keeps the
   * behaviour it already had, and a deployment has to say out loud that it cannot
   * charge anybody.
   *
   * When false there is no gateway to charge, so the token is ZERO and the whole
   * total is collected in cash by the purohit on the day. That is the honest
   * arithmetic rather than a token nobody can pay.
   *
   * READ THE REVENUE CONSEQUENCE BEFORE TURNING THIS OFF. The model at the top of
   * this file puts the platform fee INSIDE the token, precisely so the purohit is
   * never asked to remit anything and commission cannot leak. With no token there
   * is no commission: `planSettlement`'s cash branch releases it only
   * `if (price.tokenPaise > 0)`, so every booking taken in this mode earns the
   * platform exactly nothing. Nothing is lost or mis-posted — the ledger stays
   * balanced and the purohit's TDS base stays correct — but the fee is not charged
   * and no due is recorded against it. Collecting in arrears would mean setting
   * `feeShortfallPaise`, which is a commercial decision about what purohits were
   * told, not an arithmetic one.
   */
  paymentsEnabled?: boolean;
}

export interface PriceBreakdown {
  dakshinaPaise: Paise;
  samagriPaise: Paise;
  travelPaise: Paise;
  platformFeePaise: Paise;
  discountPaise: Paise;
  totalPaise: Paise;
  /**
   * Charged online at confirmation, in every payment mode without exception. In
   * `digital_full` this IS the total, so nothing is left to collect afterwards.
   */
  tokenPaise: Paise;
  /** What is still owed on the day: cash to the purohit. Zero in `digital_full`. */
  balancePaise: Paise;
  /** Platform fee we failed to collect because a promo ate it. Becomes a cash_due. */
  feeShortfallPaise: Paise;
  surgeBps: number;
  commissionBps: number;
}

export function computePrice(input: PriceInput): PriceBreakdown {
  const surgeBps = Math.min(Math.max(input.surgeBps, 10_000), SURGE_CAP_BPS);
  const commissionBps =
    input.paymentMode === 'digital_full'
      ? COMMISSION_BPS.fully_digital
      : COMMISSION_BPS.standard;

  const dakshina = scale(input.dakshinaBasePaise, surgeBps);

  const samagri =
    input.samagriOption === 'pandit_brings'
      ? add(input.bomTotalPaise, bps(input.bomTotalPaise, SAMAGRI_SOURCING_BPS))
      : ZERO;

  const travel = input.travelFeePaise;

  // Commission is charged on the service, not on pass-through samagri.
  const commissionBase = add(dakshina, travel);
  const grossFee = bps(commissionBase, commissionBps);

  const requestedDiscount = input.promoDiscountPaise ?? ZERO;
  const discount = requestedDiscount > grossFee ? grossFee : requestedDiscount;
  const platformFee = sub(grossFee, discount);

  const kitValue = input.kitValuePaise ?? ZERO;
  const total = sub(add(dakshina, samagri, travel, grossFee), discount);

  /*
   * FULLY DIGITAL MEANS FULLY. The token is the whole amount, not the fee.
   *
   * This built the token from the platform fee in every mode, so `digital_full` —
   * the mode whose UI button says "Pay fully online" — charged only the commission
   * up front and left `balancePaise` to be "charged when the puja is done". Nothing
   * charges it: there is no balance payment intent anywhere, and the enum value for
   * one has never had a producer.
   *
   * The consequence is not a missing feature, it is a hole in the books.
   * `planSettlement`'s digital branch pays the purohit out of escrow on the stated
   * assumption that "the full amount sits in escrow" — so escrow was debited
   * `dakshina + samagri + travel` that was never credited to it, and the purohit was
   * credited money no devotee had paid. Measured on a live booking: ₹56.88 in, ₹474
   * out, every time.
   *
   * Charging the total here closes it exactly, with no second capture to build:
   * escrow receives `total`, and settlement debits `platformFee + panditGross`,
   * which IS `total` by construction. The balance falls to zero, which is what
   * "paid fully online" should have meant all along.
   */
  /*
   * No gateway means no token. `digital_full` cannot occur in this mode — booking
   * creation refuses it — but the branch is ordered so that even if one slipped
   * through it collects nothing online rather than demanding the entire total
   * through a checkout that does not exist.
   */
  const token = input.paymentsEnabled === false
    ? ZERO
    : input.paymentMode === 'digital_full'
      ? total
      : add(platformFee, kitValue);
  const balance = sub(total, token);

  return {
    dakshinaPaise: dakshina,
    samagriPaise: samagri,
    travelPaise: travel,
    platformFeePaise: platformFee,
    discountPaise: discount,
    totalPaise: total,
    tokenPaise: token,
    balancePaise: balance,
    feeShortfallPaise: discount,
    surgeBps,
    commissionBps,
  };
}

/** Refund policy. Returns the amount returned to the devotee. */
export function computeRefund(args: {
  breakdown: Pick<PriceBreakdown, 'tokenPaise' | 'totalPaise'>;
  amountPaidPaise: Paise;
  hoursUntilSlot: number;
  cancelledBy: 'devotee' | 'pandit' | 'platform';
}): { refundPaise: Paise; reason: string } {
  const { amountPaidPaise, hoursUntilSlot, cancelledBy } = args;

  // Purohit- or platform-caused cancellation is always made whole. No exceptions,
  // including inside 24h - that is precisely when trust is won or lost.
  if (cancelledBy !== 'devotee') {
    return { refundPaise: amountPaidPaise, reason: 'platform_or_pandit_fault' };
  }
  if (hoursUntilSlot > 48) {
    return { refundPaise: amountPaidPaise, reason: 'over_48h_full' };
  }
  if (hoursUntilSlot >= 24) {
    return { refundPaise: paise(Math.floor(amountPaidPaise / 2)), reason: '24_48h_half' };
  }
  const keptToken = args.breakdown.tokenPaise;
  return {
    refundPaise: max(sub(amountPaidPaise, keptToken), ZERO),
    reason: 'under_24h_token_forfeit',
  };
}
