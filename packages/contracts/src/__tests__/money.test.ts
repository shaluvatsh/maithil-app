import { describe, it, expect } from 'vitest';
import { paise, rupees, bps, scale, splitExact, add, formatINR } from '../money.js';

describe('money', () => {
  it('rejects non-integer paise', () => {
    expect(() => paise(10.5)).toThrow(RangeError);
  });

  it('converts rupees without float drift', () => {
    expect(rupees(1500.55)).toBe(150055);
    expect(rupees(0.1 + 0.2)).toBe(30); // the classic float trap
  });

  it('computes commission in basis points, half-up', () => {
    expect(bps(paise(150000), 1500)).toBe(22500);  // 15% of Rs 1500
    expect(bps(paise(150000), 1200)).toBe(18000);  // 12% digital rate
    expect(bps(paise(333), 1500)).toBe(50);        // 49.95 -> 50
  });

  it('applies surge as a bps factor', () => {
    expect(scale(paise(150000), 12000)).toBe(180000); // 1.2x
    expect(scale(paise(150000), 10000)).toBe(150000); // 1.0x is identity
  });

  it('splits exactly - no paisa created or destroyed', () => {
    for (const amount of [100, 101, 999, 1, 7, 123457]) {
      const parts = splitExact(paise(amount), [1, 1, 1]);
      expect(add(...parts)).toBe(amount);
    }
  });

  it('formats for display', () => {
    expect(formatINR(paise(150000))).toContain('1,500');
  });
});
