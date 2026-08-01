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
 *   token (online, always) = platform fee + kit value
 *   cash balance (to purohit) = dakshina + samagri + travel
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
}

export interface PriceBreakdown {
  dakshinaPaise: Paise;
  samagriPaise: Paise;
  travelPaise: Paise;
  platformFeePaise: Paise;
  discountPaise: Paise;
  totalPaise: Paise;
  /** Charged online at confirmation, in every payment mode without exception. */
  tokenPaise: Paise;
  /** Cash or auto-charge at completion. total - token. */
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
  const token = add(platformFee, kitValue);
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
