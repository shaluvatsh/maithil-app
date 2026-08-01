import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import type { KvStore } from '../../common/kv';
import { DomainError, ErrorCode } from '@themaithil/contracts';

export const OTP_TTL_SECONDS = 300;
const MAX_SENDS_PER_HOUR = 5;
const MAX_VERIFY_ATTEMPTS = 5;

/**
 * Phone OTP.
 *
 * OTPs are stored HASHED even in Redis, and compared in constant time. A 6-digit
 * code has only a million possibilities, so the rate limits are the real security
 * control, not the entropy - hence the separate send and verify counters.
 *
 * Note: this is 6 digits, not the 4 the original design specified. Four digits on
 * an endpoint that authorises money movement is too thin, and the UX cost is one
 * extra keystroke.
 */
export class OtpService {
  constructor(
    private readonly kv: KvStore,
    private readonly secret: string,
    private readonly devBypass = false,
  ) {}

  private hash(requestId: string, otp: string): string {
    return createHmac('sha256', this.secret).update(`${requestId}:${otp}`).digest('hex');
  }

  async issue(phone: string, requestId: string): Promise<{ otp: string; expiresInSec: number }> {
    const sends = await this.kv.incr(`otp:sends:${phone}`, 3600);
    if (sends > MAX_SENDS_PER_HOUR) {
      throw new DomainError(
        ErrorCode.OTP_RATE_LIMITED,
        'too many codes requested for this number; try again in an hour',
      );
    }

    // Fixed code in dev so you can log in without an SMS provider wired up.
    const otp = this.devBypass ? '123456' : String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.kv.setIfAbsent(`otp:${requestId}`, this.hash(requestId, otp), OTP_TTL_SECONDS);
    await this.kv.setIfAbsent(`otp:phone:${requestId}`, phone, OTP_TTL_SECONDS);
    return { otp, expiresInSec: OTP_TTL_SECONDS };
  }

  async verify(requestId: string, phone: string, otp: string): Promise<void> {
    const attempts = await this.kv.incr(`otp:tries:${requestId}`, OTP_TTL_SECONDS);
    if (attempts > MAX_VERIFY_ATTEMPTS) {
      await this.kv.del(`otp:${requestId}`);
      throw new DomainError(ErrorCode.OTP_RATE_LIMITED, 'too many attempts; request a new code');
    }

    const [stored, storedPhone] = await Promise.all([
      this.kv.get(`otp:${requestId}`),
      this.kv.get(`otp:phone:${requestId}`),
    ]);
    if (!stored || !storedPhone) {
      throw new DomainError(ErrorCode.OTP_INVALID, 'this code has expired; request a new one');
    }
    if (storedPhone !== phone) {
      throw new DomainError(ErrorCode.OTP_INVALID, 'code does not match this number');
    }

    const expected = Buffer.from(stored, 'hex');
    const actual = Buffer.from(this.hash(requestId, otp), 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new DomainError(ErrorCode.OTP_INVALID, 'incorrect code');
    }

    // Single use.
    await Promise.all([
      this.kv.del(`otp:${requestId}`),
      this.kv.del(`otp:phone:${requestId}`),
      this.kv.del(`otp:tries:${requestId}`),
    ]);
  }
}

/**
 * Booking OTPs (start and complete) are separate from login OTPs: they are bound to
 * a booking, live in Postgres rather than Redis, and the completion one authorises
 * settlement. Same hashing discipline.
 */
export class BookingOtpService {
  constructor(private readonly secret: string) {}

  generate(devBypass = false): string {
    return devBypass ? '123456' : String(randomInt(0, 1_000_000)).padStart(6, '0');
  }

  hash(bookingId: string, kind: 'start' | 'complete', otp: string): string {
    return createHmac('sha256', this.secret).update(`${bookingId}:${kind}:${otp}`).digest('hex');
  }

  matches(bookingId: string, kind: 'start' | 'complete', otp: string, storedHash: string): boolean {
    const a = Buffer.from(this.hash(bookingId, kind, otp), 'hex');
    const b = Buffer.from(storedHash, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
