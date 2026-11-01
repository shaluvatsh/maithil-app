import { createHmac, randomBytes } from 'node:crypto';
import type { KvStore } from '../../common/kv';
import { DomainError, ErrorCode } from '@themaithil/contracts';

export const PASSWORD_RESET_TTL_SECONDS = 1800; // 30 minutes — longer than an OTP's
// 5, because the medium is email rather than SMS and checking it takes longer.
const MAX_REQUESTS_PER_HOUR = 3;

/**
 * Password reset by email.
 *
 * Same discipline as `OtpService`, for the same reason: the token is never stored
 * raw, even in Redis — only its HMAC. Unlike a 6-digit OTP, brute-forcing the token
 * itself is not the threat model here (32 random bytes have nothing in common with
 * a million-combination code); the risk this guards against is a Redis snapshot or
 * a log line containing a value that is still a live reset link.
 */
export class PasswordResetService {
  constructor(
    private readonly kv: KvStore,
    private readonly secret: string,
  ) {}

  private hash(token: string): string {
    return createHmac('sha256', this.secret).update(token).digest('hex');
  }

  /**
   * Counts the request against the rate limit WITHOUT yet knowing whether the
   * email belongs to an account.
   *
   * Split from `issue()` on purpose. `AuthService.requestPasswordReset` must
   * behave identically whether or not the address is registered — same response,
   * same timing shape — and that includes rate limiting: if only real accounts
   * ever counted against the limit, a prober could tell an email is registered
   * simply by sending enough requests to trigger a 429 that never arrives for an
   * address with no account.
   */
  async checkRate(email: string): Promise<void> {
    const sends = await this.kv.incr(`pwreset:sends:${email}`, 3600);
    if (sends > MAX_REQUESTS_PER_HOUR) {
      throw new DomainError(
        ErrorCode.PASSWORD_RESET_RATE_LIMITED,
        'too many reset requests for this address; try again in an hour',
      );
    }
  }

  /** Issues a token for a KNOWN user. Never call this before `checkRate`. */
  async issue(userId: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.kv.setIfAbsent(`pwreset:${this.hash(token)}`, userId, PASSWORD_RESET_TTL_SECONDS);
    return token;
  }

  /** Single use: a consumed or unknown token behaves identically — expired. */
  async consume(token: string): Promise<string> {
    const key = `pwreset:${this.hash(token)}`;
    const userId = await this.kv.get(key);
    if (!userId) {
      throw new DomainError(
        ErrorCode.PASSWORD_RESET_INVALID,
        'this link has expired or was already used; request a new one',
      );
    }
    await this.kv.del(key);
    return userId;
  }
}
