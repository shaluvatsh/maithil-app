import { pgEnum } from 'drizzle-orm/pg-core';

export const localeEnum = pgEnum('locale', ['bn', 'hi', 'en']);

/**
 * The panjika a household follows. First-class dimension - see ADR 0003.
 *
 * Not merely competing opinions. Mithila and Banaras keep the classical PURNIMANT
 * system, where a month ends at the full moon rather than the new moon. That shifts
 * which month a krishna-paksha tithi belongs to, and therefore shifts festival dates
 * and names - a structural difference, not a calibration one.
 *
 * This list held only the three Bengal-and-Mithila values while `packages/region`
 * had already been expanded pan-India, so twelve cities declared almanacs the
 * database could not store. The materialiser fell back to `bisuddha_siddhanta` for
 * all of them, which every city could store and no city outside Bengal offers, so
 * the rows were written and then never found. This list and
 * `packages/region/src/types.ts` must agree; `panjika-parity.test.ts` enforces it.
 */
export const panjikaSchoolEnum = pgEnum('panjika_school', [
  'bisuddha_siddhanta',
  'gupta_press',
  'mithila',
  'vikram_banaras',
  'tamil_vakya',
  'drik_generic',
]);

export const userRoleEnum = pgEnum('user_role', ['devotee', 'pandit', 'admin', 'ops']);
export const kycStatusEnum = pgEnum('kyc_status', [
  'pending', 'submitted', 'verified', 'rejected', 'expired',
]);
export const kycTypeEnum = pgEnum('kyc_type', ['identity', 'bank', 'credential', 'demo']);

export const bookingStateEnum = pgEnum('booking_state', [
  'draft', 'pending_accept', 'confirmed', 'in_progress', 'completed', 'reviewed',
  'cancelled_devotee', 'cancelled_pandit', 'expired',
]);
export const paymentModeEnum = pgEnum('payment_mode', [
  'digital_full', 'digital_token_balance', 'cash',
]);
export const samagriOptionEnum = pgEnum('samagri_option', ['none', 'pandit_brings']);
export const slotStatusEnum = pgEnum('slot_status', ['open', 'closed', 'booked', 'buffer']);
export const slotSourceEnum = pgEnum('slot_source', [
  'default', 'manual', 'recurring', 'travel_buffer', 'booking',
]);

export const panchangKindEnum = pgEnum('panchang_kind', [
  'tithi', 'nakshatra', 'yoga', 'karana',
]);
export const panchangSourceEnum = pgEnum('panchang_source', [
  'api', 'manual_panjika', 'pandit_override',
]);

export const ledgerDirectionEnum = pgEnum('ledger_direction', ['debit', 'credit']);
export const ledgerAccountTypeEnum = pgEnum('ledger_account_type', [
  'platform', 'pandit', 'devotee_credit', 'escrow', 'tax',
]);
export const ledgerEntryTypeEnum = pgEnum('ledger_entry_type', [
  'token', 'balance', 'commission', 'payout', 'refund',
  'credit_grant', 'credit_redeem',
  'cash_due', 'cash_recovery', 'cash_settled_direct',
  'tds', 'tds_carry', 'instant_payout_fee', 'adjustment',
]);

export const paymentIntentKindEnum = pgEnum('payment_intent_kind', [
  'token', 'balance', 'self_settle',
]);
export const paymentIntentStatusEnum = pgEnum('payment_intent_status', [
  'created', 'attempted', 'captured', 'failed', 'refunded',
]);
export const payoutMethodEnum = pgEnum('payout_method', ['bank_account', 'upi']);
export const payoutStatusEnum = pgEnum('payout_status', [
  'pending', 'processing', 'paid', 'failed', 'reversed',
]);
export const disputeTypeEnum = pgEnum('dispute_type', [
  'cash_mismatch', 'no_show', 'quality', 'refund', 'other',
]);
export const disputeStateEnum = pgEnum('dispute_state', [
  'open', 'awaiting_evidence', 'resolved', 'rejected',
]);
