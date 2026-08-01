/**
 * Money. Paise only, integers only, no floats anywhere. See ADR 0004.
 *
 * `Paise` is a branded number so that passing a raw number across a module
 * boundary is a compile error. It costs one cast at the edge and buys the
 * guarantee that nobody ever accidentally adds rupees to paise.
 */
declare const brand: unique symbol;
export type Paise = number & { readonly [brand]: 'Paise' };

export const paise = (n: number): Paise => {
  if (!Number.isInteger(n)) throw new RangeError(`Paise must be an integer, got ${n}`);
  if (!Number.isSafeInteger(n)) throw new RangeError(`Paise out of safe range: ${n}`);
  return n as Paise;
};

export const rupees = (n: number): Paise => paise(Math.round(n * 100));
export const ZERO = paise(0);

export const add = (...xs: Paise[]): Paise => paise(xs.reduce((a, b) => a + b, 0));
export const sub = (a: Paise, b: Paise): Paise => paise(a - b);
export const neg = (a: Paise): Paise => paise(-a);
export const max = (a: Paise, b: Paise): Paise => (a > b ? a : b);
export const isPositive = (a: Paise): boolean => a > 0;

/**
 * Percentage of an amount, in basis points, rounded half-up.
 * Commission of 15% is 1500 bps. Using bps avoids float multiplication entirely.
 */
export const bps = (amount: Paise, basisPoints: number): Paise => {
  if (!Number.isInteger(basisPoints)) throw new RangeError('basisPoints must be an integer');
  return paise(Math.round((amount * basisPoints) / 10_000));
};

/** Multiply by a surge factor expressed in basis points (1.2x === 12000). */
export const scale = (amount: Paise, factorBps: number): Paise =>
  paise(Math.round((amount * factorBps) / 10_000));

/**
 * Split an amount into n parts whose sum is exactly the original.
 * Remainder paise go to the earliest parts. Used for vendor/tax splits so
 * rounding never creates or destroys a paisa.
 */
export const splitExact = (amount: Paise, weights: number[]): Paise[] => {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) throw new RangeError('weights must sum to a positive number');
  const parts = weights.map((w) => Math.floor((amount * w) / total));
  let remainder = amount - parts.reduce((a, b) => a + b, 0);
  for (let i = 0; remainder > 0; i = (i + 1) % parts.length, remainder--) {
    parts[i] = (parts[i] ?? 0) + 1;
  }
  return parts.map(paise);
};

/** Display only. Never use the result for arithmetic. */
export const formatINR = (p: Paise, locale = 'en-IN'): string =>
  new Intl.NumberFormat(locale, {
    style: 'currency', currency: 'INR', minimumFractionDigits: 0, maximumFractionDigits: 2,
  }).format(p / 100);
