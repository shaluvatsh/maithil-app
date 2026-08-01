import { describe, it, expect } from 'vitest';
import { computePrice, rupees, type Paise } from '@themaithil/contracts';
import { planSettlement, planTokenCapture, TDS_BPS } from '../settlement';
import type { Leg } from '../ledger';

const balanced = (legs: Leg[]) => {
  const d = legs.filter((l) => l.direction === 'debit').reduce((a, l) => a + l.amount, 0);
  const c = legs.filter((l) => l.direction === 'credit').reduce((a, l) => a + l.amount, 0);
  return d === c;
};
const sumOf = (legs: Leg[], type: string, dir: 'debit' | 'credit') =>
  legs.filter((l) => l.type === type && l.direction === dir).reduce((a, l) => a + l.amount, 0);

const price = (overrides: Partial<Parameters<typeof computePrice>[0]> = {}) =>
  computePrice({
    dakshinaBasePaise: rupees(1500),
    bomTotalPaise: rupees(800),
    travelFeePaise: rupees(200),
    surgeBps: 10_000,
    samagriOption: 'pandit_brings',
    paymentMode: 'cash',
    ...overrides,
  });

const base = { bookingId: 'B1', panditId: 'P1', devoteeId: 'D1', tdsApplicable: true };

describe('settlement', () => {
  it('every plan balances, in every mode', () => {
    for (const paymentMode of ['digital_full', 'digital_token_balance', 'cash'] as const) {
      const p = price({ paymentMode });
      const plan = planSettlement({
        ...base, paymentMode, price: p,
        cashCollectedPaise: p.balancePaise,
      });
      expect(balanced(plan.legs), `${paymentMode} does not balance`).toBe(true);
    }
  });

  it('THE FIX: cash bookings withhold TDS on the full service value', () => {
    const p = price({ paymentMode: 'cash' });
    const plan = planSettlement({
      ...base, paymentMode: 'cash', price: p, cashCollectedPaise: p.balancePaise,
    });
    const serviceValue = p.dakshinaPaise + p.samagriPaise + p.travelPaise;
    expect(plan.tdsPaise).toBe(Math.round((serviceValue * TDS_BPS) / 10_000));
    expect(plan.tdsPaise).toBeGreaterThan(0);
    // and it carries forward, because we never held the money
    expect(sumOf(plan.legs, 'tds_carry', 'debit')).toBe(plan.tdsPaise);
  });

  it('cash and digital withhold the same TDS on the same service value', () => {
    const cash = price({ paymentMode: 'cash' });
    const cashPlan = planSettlement({
      ...base, paymentMode: 'cash', price: cash, cashCollectedPaise: cash.balancePaise,
    });
    const digital = price({ paymentMode: 'digital_token_balance' });
    const digitalPlan = planSettlement({
      ...base, paymentMode: 'digital_token_balance', price: digital,
    });
    expect(cashPlan.tdsPaise).toBe(digitalPlan.tdsPaise);
  });

  it('the notional cash credit nets to zero', () => {
    const p = price({ paymentMode: 'cash' });
    const plan = planSettlement({
      ...base, paymentMode: 'cash', price: p, cashCollectedPaise: p.balancePaise,
    });
    const serviceValue = p.dakshinaPaise + p.samagriPaise + p.travelPaise;
    expect(sumOf(plan.legs, 'balance', 'credit')).toBe(serviceValue);
    expect(sumOf(plan.legs, 'cash_settled_direct', 'debit')).toBe(serviceValue);
  });

  it('a normal cash booking creates NO due', () => {
    const p = price({ paymentMode: 'cash' });
    const plan = planSettlement({
      ...base, paymentMode: 'cash', price: p, cashCollectedPaise: p.balancePaise,
    });
    expect(plan.cashDuePaise).toBe(0);
  });

  it('a waived-token promo is the only thing that creates a due', () => {
    const p = price({ paymentMode: 'cash', promoDiscountPaise: rupees(9999) });
    const plan = planSettlement({
      ...base, paymentMode: 'cash', price: p, cashCollectedPaise: p.balancePaise,
    });
    expect(plan.cashDuePaise).toBe(rupees(255));
    expect(balanced(plan.legs)).toBe(true);
  });

  it('BLOCKS settlement on a cash mismatch rather than adjusting silently', () => {
    const p = price({ paymentMode: 'cash' });
    expect(() => planSettlement({
      ...base, paymentMode: 'cash', price: p,
      cashCollectedPaise: (p.balancePaise - 100) as Paise,
    })).toThrow(/does not match/);
  });

  it('commission reaching the platform equals the fee the devotee paid', () => {
    for (const paymentMode of ['digital_full', 'cash'] as const) {
      const p = price({ paymentMode });
      const plan = planSettlement({
        ...base, paymentMode, price: p, cashCollectedPaise: p.balancePaise,
      });
      expect(sumOf(plan.legs, 'commission', 'credit')).toBe(p.platformFeePaise);
    }
  });

  it('skips withholding below the annual threshold', () => {
    const p = price({ paymentMode: 'cash' });
    const plan = planSettlement({
      ...base, tdsApplicable: false, paymentMode: 'cash', price: p,
      cashCollectedPaise: p.balancePaise,
    });
    expect(plan.tdsPaise).toBe(0);
    expect(balanced(plan.legs)).toBe(true);
  });

  it('token capture moves money into escrow and balances', () => {
    const legs = planTokenCapture({ bookingId: 'B1', devoteeId: 'D1', amount: rupees(255) });
    expect(balanced(legs)).toBe(true);
    expect(legs.find((l) => l.account.type === 'escrow')?.direction).toBe('credit');
  });
});
