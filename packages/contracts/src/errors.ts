/** Stable machine-readable error codes. Clients switch on these, never on message text. */
export const ErrorCode = {
  SLOT_UNAVAILABLE: 'SLOT_UNAVAILABLE',
  HOLD_EXPIRED: 'HOLD_EXPIRED',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  OTP_INVALID: 'OTP_INVALID',
  OTP_RATE_LIMITED: 'OTP_RATE_LIMITED',
  CASH_AMOUNT_MISMATCH: 'CASH_AMOUNT_MISMATCH',
  PAYMENT_NOT_CAPTURED: 'PAYMENT_NOT_CAPTURED',
  /** The amount Razorpay says it captured does not match the order we created. */
  PAYMENT_AMOUNT_MISMATCH: 'PAYMENT_AMOUNT_MISMATCH',
  LEDGER_IMBALANCE: 'LEDGER_IMBALANCE',
  KYC_INCOMPLETE: 'KYC_INCOMPLETE',
  /**
   * A purohit has earnings and nowhere to send them.
   *
   * Distinct from KYC_INCOMPLETE, which is about whether they may work at all. This
   * one says the work is fine and the destination is missing, and the two have
   * different fixes — so collapsing them would send a verified purohit to a document
   * upload screen when what they need is a bank account form.
   */
  PAYOUT_ACCOUNT_MISSING: 'PAYOUT_ACCOUNT_MISSING',
  CASH_JOBS_PAUSED: 'CASH_JOBS_PAUSED',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  /** Registration with a password that fails the policy. Distinct from FORBIDDEN. */
  WEAK_PASSWORD: 'WEAK_PASSWORD',
  /** Registration where the email or phone is already a password-login account. */
  ACCOUNT_EXISTS: 'ACCOUNT_EXISTS',
  OUT_OF_HORIZON: 'OUT_OF_HORIZON',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly meta: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
