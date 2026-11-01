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
  /** A password-reset link that is unknown, expired, or already used. One code for
   * all three: the fix is identical (request a new link) and the difference is not
   * the caller's to act on. */
  PASSWORD_RESET_INVALID: 'PASSWORD_RESET_INVALID',
  /** Too many reset emails requested for one address within the hour. */
  PASSWORD_RESET_RATE_LIMITED: 'PASSWORD_RESET_RATE_LIMITED',
  /**
   * A purohit's rate falls outside the per-city band devotees are shown.
   *
   * Its own code, not a generic validation failure, because the onboarding screen
   * has to point at the one rate that is wrong out of the forty on the page — and
   * because since ADR 0012 the platform assigns the purohit, so a rate the listing
   * never advertised is one the devotee cannot avoid by choosing someone else.
   */
  RATE_OUT_OF_BAND: 'RATE_OUT_OF_BAND',
  /**
   * The community trust ladder, not a ban.
   *
   * Distinct from FORBIDDEN, which means "not yours". This means "not yet": a
   * newcomer may react and reply but not ask, and asking unlocks with account age.
   * The client has to say WHICH, because "you can't do that" on a forum reads as a
   * punishment when it is actually a wait, and a devotee told the wrong one leaves.
   */
  /**
   * A knowledge item cannot publish yet, and the reason is editorial.
   *
   * Its own code because the fixes are different and a client has to say which: no
   * reviewer yet, a reviewer who is the author, a recording missing its transcript.
   * A generic FORBIDDEN would send an author looking for a permission they have.
   */
  KNOWLEDGE_NOT_PUBLISHABLE: 'KNOWLEDGE_NOT_PUBLISHABLE',
  COMMUNITY_TRUST_REQUIRED: 'COMMUNITY_TRUST_REQUIRED',
  /** The space's posting policy excludes this author — verified_only or pandit_only. */
  COMMUNITY_SPACE_CLOSED: 'COMMUNITY_SPACE_CLOSED',
  /**
   * Triage held the content for a human. NOT a removal, and the difference is the
   * whole moderation posture: nothing here auto-deletes, so this is always "someone
   * will look", never "we decided".
   */
  COMMUNITY_CONTENT_HELD: 'COMMUNITY_CONTENT_HELD',
  OUT_OF_HORIZON: 'OUT_OF_HORIZON',
  /**
   * Not signed in, or the access token has lapsed. DISTINCT FROM `FORBIDDEN`.
   *
   * Both used to be FORBIDDEN, which meant both arrived as 403 — and the web client
   * refreshes on 401. So fifteen minutes after signing in, every authenticated
   * request failed with "invalid or expired token", the thirty-day refresh token was
   * never used, and the only way out was to sign out and back in. The intent was
   * always right (`lib/api.ts`: "an expired access token is the normal case after
   * fifteen minutes, not an error the user should ever see") — the status code did
   * not match it.
   *
   * 401 means "prove who you are again"; 403 means "we know who you are and this is
   * not yours". A client cannot do the first if it cannot tell them apart.
   */
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  /**
   * Distinct from INVALID_TRANSITION: the booking's STATE is fine to reschedule
   * from, but the CURRENT slot is now too close for the purohit to safely lose
   * it. A client switching on `code` needs to tell "you cannot reschedule this
   * kind of booking" apart from "you cannot reschedule it this late."
   */
  RESCHEDULE_WINDOW_CLOSED: 'RESCHEDULE_WINDOW_CLOSED',
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
