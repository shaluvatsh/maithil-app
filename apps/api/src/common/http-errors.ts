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
  [ErrorCode.OTP_INVALID]: 400,
  [ErrorCode.OTP_RATE_LIMITED]: 429,
  [ErrorCode.PAYMENT_NOT_CAPTURED]: 402,
  [ErrorCode.KYC_INCOMPLETE]: 403,
  [ErrorCode.CASH_JOBS_PAUSED]: 403,
  [ErrorCode.FORBIDDEN]: 403,
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.OUT_OF_HORIZON]: 400,
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
