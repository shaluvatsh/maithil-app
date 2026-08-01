/** Stable machine-readable error codes. Clients switch on these, never on message text. */
export const ErrorCode = {
  SLOT_UNAVAILABLE: 'SLOT_UNAVAILABLE',
  HOLD_EXPIRED: 'HOLD_EXPIRED',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  OTP_INVALID: 'OTP_INVALID',
  OTP_RATE_LIMITED: 'OTP_RATE_LIMITED',
  CASH_AMOUNT_MISMATCH: 'CASH_AMOUNT_MISMATCH',
  PAYMENT_NOT_CAPTURED: 'PAYMENT_NOT_CAPTURED',
  LEDGER_IMBALANCE: 'LEDGER_IMBALANCE',
  KYC_INCOMPLETE: 'KYC_INCOMPLETE',
  CASH_JOBS_PAUSED: 'CASH_JOBS_PAUSED',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
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
