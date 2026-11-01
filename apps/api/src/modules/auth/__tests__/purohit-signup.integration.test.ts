import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { makeHarness, notifier, mailer, resetService, type Harness } from '../../../test/harness';
import { AuthService } from '../auth.service';
import { OtpService } from '../otp.service';
import { users, panditProfiles } from '../../../db/schema/index';

let h: Harness;
let auth: AuthService;

beforeEach(async () => {
  h = await makeHarness();
  const otp = new OtpService(h.kv, 'test-secret', true);
  auth = new AuthService(h.db, otp, {
    LAUNCH_CITY_SLUG: 'kolkata', OTP_DEV_BYPASS: true,
    JWT_ACCESS_SECRET: 'test-access', JWT_REFRESH_SECRET: 'test-refresh',
    JWT_ACCESS_TTL: '15m', JWT_REFRESH_TTL: '30d',
  } as never, notifier(h.db), resetService(h.kv), mailer());
}, 60_000);
afterEach(async () => { await h?.pg.close(); });

/** Signs in by phone the way the login screen does. */
const signUp = async (phone: string, role?: 'devotee' | 'pandit') => {
  const { requestId } = await auth.requestOtp(phone);
  return auth.verifyOtp({ requestId, phone, otp: '123456', ...(role ? { role } : {}) });
};

/**
 * Supply has to be able to sign up the way supply actually signs up.
 *
 * `verifyOtp` always accepted a role and `VerifyOtpBody` never carried one, so
 * validation stripped it and EVERY phone signup became a devotee. Phone OTP is the
 * default tab on the login screen and the likeliest route for the purohit persona
 * (ADR 0009), so a purohit arriving through "For Pandits" was quietly put on the
 * wrong side of the marketplace — permanently, since nothing in the product
 * changes a role afterwards.
 */
describe('a purohit can sign up by phone', () => {
  it('creates them as a purohit when the role is given', async () => {
    const res = await signUp('+919830009001', 'pandit');
    expect(res.user.role).toBe('pandit');
  });

  it('still defaults to devotee when no role is given', async () => {
    const res = await signUp('+919830009002');
    expect(res.user.role).toBe('devotee');
  });

  /**
   * A purohit needs a profile row before anything else works: search joins it,
   * the setup wizard writes to it, the verification queue is a view over it.
   * `register()` has always created one; this path could not, because the role
   * never reached it.
   */
  it('gives them the profile row the rest of the product needs', async () => {
    const res = await signUp('+919830009003', 'pandit');
    const [profile] = await h.db.select().from(panditProfiles)
      .where(eq(panditProfiles.userId, res.user.id)).limit(1);
    expect(profile).toBeDefined();
  });

  /** Signing up does not make anyone bookable — a human checks first (ADR 0010). */
  it('does not make them bookable on signup', async () => {
    const res = await signUp('+919830009004', 'pandit');
    const [profile] = await h.db.select().from(panditProfiles)
      .where(eq(panditProfiles.userId, res.user.id)).limit(1);
    expect(profile!.kycStatus).toBe('pending');
    expect(profile!.cashJobsEnabled).toBe(false);
  });

  it('creates no purohit profile for a devotee', async () => {
    const res = await signUp('+919830009005');
    const rows = await h.db.select().from(panditProfiles)
      .where(eq(panditProfiles.userId, res.user.id));
    expect(rows).toHaveLength(0);
  });

  /**
   * The role only applies to a NEW account. Otherwise an unauthenticated endpoint
   * would let anyone promote an existing devotee — or themselves — by signing in
   * and asking.
   */
  it('cannot change the role of an account that already exists', async () => {
    await signUp('+919830009006');                       // devotee first
    const second = await signUp('+919830009006', 'pandit');
    expect(second.user.role).toBe('devotee');

    const [row] = await h.db.select({ role: users.role }).from(users)
      .where(eq(users.phone, '+919830009006')).limit(1);
    expect(row!.role).toBe('devotee');
  });

  it('leaves an existing purohit their single profile row', async () => {
    const first = await signUp('+919830009007', 'pandit');
    await signUp('+919830009007', 'pandit');
    const r = await h.db.execute(sql`
      SELECT count(*)::int AS n FROM pandit_profiles WHERE user_id = ${first.user.id}`);
    const rows = ((r as { rows?: Array<{ n: number }> }).rows ?? r) as Array<{ n: number }>;
    expect(rows[0]!.n).toBe(1);
  });
});
