import { ExceptionFilter, Catch, ArgumentsHost, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { ZodError } from 'zod';
import { DomainError, ErrorCode } from '@themaithil/contracts';

/**
 * DomainError -> HTTP status. Clients switch on `code`, never on message text or
 * status, which is why the codes are a closed set in the contracts package.
 */
const STATUS: Record<ErrorCode, number> = {
  [ErrorCode.SLOT_UNAVAILABLE]: 409,
  [ErrorCode.HOLD_EXPIRED]: 409,
  [ErrorCode.INVALID_TRANSITION]: 409,
  [ErrorCode.IDEMPOTENCY_CONFLICT]: 409,
  [ErrorCode.CASH_AMOUNT_MISMATCH]: 409,
  /*
   * Registration used to throw FORBIDDEN (403) for both of these - indistinguishable
   * from an authentication failure on the client, for two responses that are
   * neither: a weak password is a validation problem, and an existing account is a
   * conflict, not a permissions question.
   */
  [ErrorCode.WEAK_PASSWORD]: 422,
  /** Well-formed, but not a rate we can advertise. Unprocessable, not malformed. */
  [ErrorCode.RATE_OUT_OF_BAND]: 422,
  [ErrorCode.ACCOUNT_EXISTS]: 409,
  [ErrorCode.OTP_INVALID]: 400,
  [ErrorCode.OTP_RATE_LIMITED]: 429,
  [ErrorCode.PASSWORD_RESET_INVALID]: 400,
  [ErrorCode.PASSWORD_RESET_RATE_LIMITED]: 429,
  [ErrorCode.PAYMENT_NOT_CAPTURED]: 402,
  /** Never surfaces meaningfully to a client - Razorpay is what retries the webhook. */
  [ErrorCode.PAYMENT_AMOUNT_MISMATCH]: 402,
  [ErrorCode.KYC_INCOMPLETE]: 403,
  /*
   * 409, not 403. The request is permitted and well formed; the account is simply
   * not in a state that can satisfy it yet, and the fix is a form the purohit can
   * fill in rather than a permission they lack. A 403 would send a client to a
   * "you are not allowed" screen for something they are entirely allowed to do.
   */
  [ErrorCode.PAYOUT_ACCOUNT_MISSING]: 409,
  [ErrorCode.CASH_JOBS_PAUSED]: 403,
  /*
   * 409, for the reason PAYOUT_ACCOUNT_MISSING is 409 and on the same logic: the
   * request is permitted and well formed, the account simply is not old enough or
   * established enough yet, and the fix is time or a completed booking rather than a
   * permission the person lacks. A 403 would send a first-time devotee to a "you are
   * not allowed" screen for something they will be allowed to do tomorrow, and that
   * is the reading that makes them leave and not come back.
   */
  /** 409: the item is well formed, its editorial state is not ready. */
  [ErrorCode.KNOWLEDGE_NOT_PUBLISHABLE]: 409,
  [ErrorCode.COMMUNITY_TRUST_REQUIRED]: 409,
  /** 403, and genuinely so: a space only verified purohits may write in. */
  [ErrorCode.COMMUNITY_SPACE_CLOSED]: 403,
  /** The post exists and is not open for this; a state conflict, not a permission. */
  [ErrorCode.COMMUNITY_CONTENT_HELD]: 409,

  /** 401, so a client knows to refresh rather than to give up. */
  [ErrorCode.UNAUTHENTICATED]: 401,
  [ErrorCode.FORBIDDEN]: 403,
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.OUT_OF_HORIZON]: 400,
  [ErrorCode.RESCHEDULE_WINDOW_CLOSED]: 409,
  /** Never surfaces to a client: it means our own books do not add up. */
  [ErrorCode.LEDGER_IMBALANCE]: 500,
};

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly log = new Logger('http');

  catch(err: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();

    if (err instanceof DomainError) {
      const status = STATUS[err.code] ?? 400;
      if (status >= 500) this.log.error(`${err.code}: ${err.message}`, err.stack);
      return res.status(status).json({ error: { code: err.code, message: err.message, ...err.meta } });
    }

    if (err instanceof ZodError) {
      return res.status(422).json({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'request failed validation',
          issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      });
    }

    if (err instanceof HttpException) {
      const body = err.getResponse();
      return res.status(err.getStatus()).json(
        typeof body === 'string' ? { error: { code: 'HTTP_ERROR', message: body } } : body,
      );
    }

    this.log.error('unhandled error', err instanceof Error ? err.stack : String(err));
    return res.status(500).json({
      error: { code: 'INTERNAL', message: 'something went wrong on our side' },
    });
  }
}

/**
 * Exported for one assertion: that UNAUTHENTICATED and FORBIDDEN do not share a
 * status. They did, and the consequence was that no client could ever tell "refresh
 * your session" from "this is not yours" — so nothing refreshed and users were signed
 * out fifteen minutes after signing in.
 */
export const STATUS_FOR_TEST: Readonly<Record<ErrorCode, number>> = STATUS;
