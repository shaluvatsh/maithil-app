import { describe, it, expect } from 'vitest';
import { paise, rupees, ZERO } from '../money.js';
import { computePrice, computeRefund, COMMISSION_BPS, SURGE_CAP_BPS } from '../pricing.js';

const base = {
  dakshinaBasePaise: rupees(1500),
  bomTotalPaise: rupees(800),
  travelFeePaise: rupees(200),
  surgeBps: 10_000,
  samagriOption: 'pandit_brings' as const,
};

describe('pricing', () => {
  it('charges the platform fee to the devotee on top of dakshina', () => {
    const p = computePrice({ ...base, paymentMode: 'cash' });
    expect(p.dakshinaPaise).toBe(rupees(1500));
    expect(p.samagriPaise).toBe(rupees(840));                 // 800 + 5% sourcing
    expect(p.platformFeePaise).toBe(rupees(255));             // 15% of (1500 + 200)
    expect(p.totalPaise).toBe(rupees(1500 + 840 + 200 + 255));
  });

  it('THE CORE INVARIANT: token always covers the full platform fee', () => {
    for (const paymentMode of ['digital_full', 'digital_token_balance', 'cash'] as const) {
      for (const surgeBps of [10_000, 12_000, 15_000]) {
        const p = computePrice({ ...base, paymentMode, surgeBps });
        expect(p.tokenPaise).toBeGreaterThanOrEqual(p.platformFeePaise);
        expect(p.tokenPaise + p.balancePaise).toBe(p.totalPaise);
      }
    }
  });

  it('cash balance is exactly what the purohit collects on site', () => {
    const p = computePrice({ ...base, paymentMode: 'cash' });
    expect(p.balancePaise).toBe(p.dakshinaPaise + p.samagriPaise + p.travelPaise);
  });

  it('gives a real discount for paying fully digitally', () => {
    const cash = computePrice({ ...base, paymentMode: 'cash' });
    const digital = computePrice({ ...base, paymentMode: 'digital_full' });
    expect(digital.commissionBps).toBe(COMMISSION_BPS.fully_digital);
    expect(digital.totalPaise).toBeLessThan(cash.totalPaise);
  });

  it('clamps surge to the 1.5x cap and never below 1.0x', () => {
    expect(computePrice({ ...base, paymentMode: 'cash', surgeBps: 30_000 }).surgeBps)
      .toBe(SURGE_CAP_BPS);
    expect(computePrice({ ...base, paymentMode: 'cash', surgeBps: 5_000 }).surgeBps)
      .toBe(10_000);
  });

  it('caps a promo at the platform fee and records the shortfall', () => {
    const p = computePrice({
      ...base, paymentMode: 'cash', promoDiscountPaise: rupees(9999),
    });
    expect(p.platformFeePaise).toBe(0);
    expect(p.feeShortfallPaise).toBe(rupees(255));  // becomes a cash_due
    expect(p.tokenPaise).toBe(0);
  });

  it('excludes pass-through samagri from the commission base', () => {
    const withKit = computePrice({ ...base, paymentMode: 'cash' });
    const without = computePrice({ ...base, paymentMode: 'cash', samagriOption: 'none' });
    expect(withKit.platformFeePaise).toBe(without.platformFeePaise);
  });
});

describe('refund policy', () => {
  const breakdown = { tokenPaise: rupees(255), totalPaise: rupees(2795) };
  const paid = rupees(2795);

  it.each([
    [72, 'over_48h_full', rupees(2795)],
    [36, '24_48h_half', rupees(1397.5 as unknown as number)],
    [10, 'under_24h_token_forfeit', rupees(2540)],
  ])('devotee cancels at %ih -> %s', (hours, reason, expected) => {
    const r = computeRefund({
      breakdown, amountPaidPaise: paid, hoursUntilSlot: hours, cancelledBy: 'devotee',
    });
    expect(r.reason).toBe(reason);
    expect(r.refundPaise).toBe(expected);
  });

  it('always makes the devotee whole on purohit or platform fault, even inside 24h', () => {
    for (const cancelledBy of ['pandit', 'platform'] as const) {
      const r = computeRefund({ breakdown, amountPaidPaise: paid, hoursUntilSlot: 1, cancelledBy });
      expect(r.refundPaise).toBe(paid);
    }
  });

  it('never refunds more than was paid', () => {
    for (const h of [0, 1, 23, 24, 47, 48, 100]) {
      const r = computeRefund({
        breakdown, amountPaidPaise: paid, hoursUntilSlot: h, cancelledBy: 'devotee',
      });
      expect(r.refundPaise).toBeLessThanOrEqual(paid);
      expect(r.refundPaise).toBeGreaterThanOrEqual(ZERO);
    }
  });
});
