import { z } from 'zod';

export const Locale = z.enum(['bn', 'hi', 'en']);
export type Locale = z.infer<typeof Locale>;

/**
 * Bengal's two panjika traditions. They publish different dates for the same
 * festival. See ADR 0003 - this is a first-class dimension, not a setting.
 */
export const PanjikaSchool = z.enum(['bisuddha_siddhanta', 'gupta_press']);
export type PanjikaSchool = z.infer<typeof PanjikaSchool>;

export const UserRole = z.enum(['devotee', 'pandit', 'admin', 'ops']);
export type UserRole = z.infer<typeof UserRole>;

export const KycStatus = z.enum(['pending', 'submitted', 'verified', 'rejected', 'expired']);
export type KycStatus = z.infer<typeof KycStatus>;

export const BookingState = z.enum([
  'draft',
  'pending_accept',
  'confirmed',
  'in_progress',
  'completed',
  'reviewed',
  'cancelled_devotee',
  'cancelled_pandit',
  'expired',
]);
export type BookingState = z.infer<typeof BookingState>;

export const TERMINAL_STATES = [
  'reviewed', 'cancelled_devotee', 'cancelled_pandit', 'expired',
] as const satisfies readonly BookingState[];

export const PaymentMode = z.enum(['digital_full', 'digital_token_balance', 'cash']);
export type PaymentMode = z.infer<typeof PaymentMode>;

export const SamagriOption = z.enum(['none', 'pandit_brings']);
export type SamagriOption = z.infer<typeof SamagriOption>;

export const SlotStatus = z.enum(['open', 'closed', 'booked', 'buffer']);
export type SlotStatus = z.infer<typeof SlotStatus>;

export const PanchangKind = z.enum(['tithi', 'nakshatra', 'yoga', 'karana']);
export type PanchangKind = z.infer<typeof PanchangKind>;

export const LedgerDirection = z.enum(['debit', 'credit']);
export type LedgerDirection = z.infer<typeof LedgerDirection>;

export const LedgerEntryType = z.enum([
  'token', 'balance', 'commission', 'payout', 'refund',
  'credit_grant', 'credit_redeem',
  'cash_due', 'cash_recovery',
  'cash_settled_direct',   // offsets the notional cash credit - see ADR 0004
  'tds', 'tds_carry',
  'instant_payout_fee',
  'adjustment',
]);
export type LedgerEntryType = z.infer<typeof LedgerEntryType>;

export const LedgerAccountType = z.enum([
  'platform', 'pandit', 'devotee_credit', 'escrow', 'tax',
]);
export type LedgerAccountType = z.infer<typeof LedgerAccountType>;
