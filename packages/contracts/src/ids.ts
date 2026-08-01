import { z } from 'zod';

/** ULID: 26 chars, Crockford base32, lexicographically sortable by time. */
export const Ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'invalid ULID');
export type Ulid = z.infer<typeof Ulid>;

/** Indian mobile, stored E.164. Devotees type 10 digits; we normalise. */
export const Phone = z.string().regex(/^\+91[6-9]\d{9}$/, 'invalid Indian mobile number');
export type Phone = z.infer<typeof Phone>;

export const normalisePhone = (raw: string): string => {
  const digits = raw.replace(/\D/g, '');
  const ten = digits.length > 10 ? digits.slice(-10) : digits;
  return `+91${ten}`;
};

/** A calendar date in the city's timezone. Never a Date object - those carry a zone. */
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
export type IsoDate = z.infer<typeof IsoDate>;
