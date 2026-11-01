import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  makeHarness, notifier, mailer, resetService, TEST_CONFIG, type Harness,
} from '../../../test/harness';
import { users, cities } from '../../../db/schema/index';
import { ulid } from 'ulid';
import { ErrorCode } from '@themaithil/contracts';
import { MemoryKv } from '../../../common/kv';
import jwt from 'jsonwebtoken';
import { OtpService } from '../otp.service';
import { AuthService } from '../auth.service';

let h: Harness;
let auth: AuthService;
let kv: MemoryKv;
let mail: ReturnType<typeof mailer>;

beforeEach(async () => {
  h = await makeHarness();
  kv = new MemoryKv();
  mail = mailer();
  auth = new AuthService(
    h.db, new OtpService(kv, 'otp-secret', true), TEST_CONFIG, notifier(h.db),
    resetService(kv), mail,
  );
}, 60_000);
afterEach(async () => { await h?.pg.close(); });

describe('auth', () => {
  it('creates a devotee on first login and issues tokens', async () => {
    const { requestId, devOtp } = await auth.requestOtp('9830012345');
    const res = await auth.verifyOtp({ requestId, phone: '9830012345', otp: devOtp! });

    expect(res.user.isNew).toBe(true);
    expect(res.user.phone).toBe('+919830012345');
    expect(res.user.locale).toBe('bn');            // Bengali-first
    expect(res.user.panjikaSchool).toBeNull();     // asked during onboarding, never guessed
    expect(auth.verifyAccess(res.tokens.accessToken).sub).toBe(res.user.id);
  });

  it('recognises a returning user rather than duplicating them', async () => {
    const a = await auth.requestOtp('9830012345');
    const first = await auth.verifyOtp({ requestId: a.requestId, phone: '9830012345', otp: '123456' });
    const b = await auth.requestOtp('98300 12345');
    const second = await auth.verifyOtp({ requestId: b.requestId, phone: '+91 98300 12345', otp: '123456' });

    expect(second.user.id).toBe(first.user.id);
    expect(second.user.isNew).toBe(false);
    const all = await h.db.select().from(users).where(eq(users.phone, '+919830012345'));
    expect(all).toHaveLength(1);
  });

  it('rejects a wrong code, and burns the code after five tries', async () => {
    const { requestId } = await auth.requestOtp('9830099999');
    for (let i = 0; i < 5; i++) {
      await expect(auth.verifyOtp({ requestId, phone: '9830099999', otp: '000000' }))
        .rejects.toThrow(/incorrect code/);
    }
    await expect(auth.verifyOtp({ requestId, phone: '9830099999', otp: '123456' }))
      .rejects.toThrow(/too many attempts/);
  });

  it('is single-use: a code cannot be replayed', async () => {
    const { requestId } = await auth.requestOtp('9830088888');
    await auth.verifyOtp({ requestId, phone: '9830088888', otp: '123456' });
    await expect(auth.verifyOtp({ requestId, phone: '9830088888', otp: '123456' }))
      .rejects.toThrow(/expired/);
  });

  it('will not verify a code against a different number', async () => {
    const { requestId } = await auth.requestOtp('9830077777');
    await expect(auth.verifyOtp({ requestId, phone: '9830066666', otp: '123456' }))
      .rejects.toThrow(/does not match this number/);
  });

  it('rate-limits sends per number', async () => {
    for (let i = 0; i < 5; i++) await auth.requestOtp('9830055555');
    await expect(auth.requestOtp('9830055555')).rejects.toThrow(/too many codes/);
  });

  it('refuses an access token where a refresh token is expected, and vice versa', async () => {
    const { requestId } = await auth.requestOtp('9830044444');
    const { tokens } = await auth.verifyOtp({ requestId, phone: '9830044444', otp: '123456' });
    await expect(auth.refresh(tokens.accessToken)).rejects.toThrow(/invalid or expired/);
    expect(() => auth.verifyAccess(tokens.refreshToken)).toThrow(/invalid or expired/);
  });

  it('mints a fresh pair from a refresh token', async () => {
    const { requestId } = await auth.requestOtp('9830033333');
    const { tokens } = await auth.verifyOtp({ requestId, phone: '9830033333', otp: '123456' });
    const next = await auth.refresh(tokens.refreshToken);
    expect(auth.verifyAccess(next.accessToken).typ).toBe('access');
  });

  it('locks out a deleted account even with a valid code', async () => {
    const { requestId } = await auth.requestOtp('9830022222');
    const { user } = await auth.verifyOtp({ requestId, phone: '9830022222', otp: '123456' });
    await h.db.update(users).set({ deletedAt: new Date().toISOString() })
      .where(eq(users.id, user.id));
    const again = await auth.requestOtp('9830022222');
    await expect(auth.verifyOtp({ requestId: again.requestId, phone: '9830022222', otp: '123456' }))
      .rejects.toThrow(/deleted/);
  });
});

/**
 * Every new account — devotee and purohit alike — was filed under
 * `LAUNCH_CITY_SLUG` and nothing anywhere asked. Cosmetic for a devotee, since a
 * booking takes its city from its address; structural for a purohit, because
 * `matchPandit` joins candidates on `users.city_id`. Someone signing up in Patna
 * joined Kolkata's pool and no Patna booking could ever reach them, so supply could
 * only accumulate in the one city a constant named.
 */
describe('the city a new account belongs to', () => {
  beforeEach(async () => {
    await h.db.insert(cities).values({
      id: ulid(), slug: 'patna', name: 'Patna', defaultPanjikaSchool: 'mithila',
    });
  });

  it('honours the city they chose', async () => {
    const { requestId, devOtp } = await auth.requestOtp('9830022222');
    const res = await auth.verifyOtp({
      requestId, phone: '9830022222', otp: devOtp!, role: 'pandit', citySlug: 'patna',
    });

    const [row] = await h.db.select({ cityId: users.cityId })
      .from(users).where(eq(users.id, res.user.id));
    const [patna] = await h.db.select({ id: cities.id })
      .from(cities).where(eq(cities.slug, 'patna'));
    expect(row?.cityId).toBe(patna!.id);
  });

  it('falls back to the launch city when they did not choose one', async () => {
    const { requestId, devOtp } = await auth.requestOtp('9830033333');
    const res = await auth.verifyOtp({ requestId, phone: '9830033333', otp: devOtp! });

    const [row] = await h.db.select({ cityId: users.cityId })
      .from(users).where(eq(users.id, res.user.id));
    const [kolkata] = await h.db.select({ id: cities.id })
      .from(cities).where(eq(cities.slug, 'kolkata'));
    expect(row?.cityId).toBe(kolkata!.id);
  });

  it('refuses a city we do not serve rather than quietly filing them elsewhere', async () => {
    // Silently putting someone in the wrong city is the exact failure this
    // replaces; a typo from a client is not a reason to repeat it.
    const { requestId, devOtp } = await auth.requestOtp('9830044444');
    await expect(auth.verifyOtp({
      requestId, phone: '9830044444', otp: devOtp!, citySlug: 'atlantis',
    })).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  it('applies to password registration too', async () => {
    const res = await auth.register({
      name: 'Ram Jha', email: 'ram@example.com', phone: '9830055555',
      password: 'a-strong-passphrase-1', role: 'pandit', citySlug: 'patna',
    });

    const [row] = await h.db.select({ cityId: users.cityId })
      .from(users).where(eq(users.id, res.user.id));
    const [patna] = await h.db.select({ id: cities.id })
      .from(cities).where(eq(cities.slug, 'patna'));
    expect(row?.cityId).toBe(patna!.id);
  });
});

/**
 * The gap flagged on the login page: there was no self-service recovery for a
 * forgotten password at all. `devResetUrl` on the response is the email
 * equivalent of `devOtp` — populated only under `OTP_DEV_BYPASS`, which
 * `TEST_CONFIG` always sets, so these tests read the token the same way the
 * production flow reads it from the link in a real inbox.
 */
describe('password reset', () => {
  const REG = {
    name: 'Debarati Sen', email: 'reset-me@example.com',
    phone: '9830066666', password: 'correct horse battery',
  };

  const tokenFrom = (devResetUrl: string) => new URL(devResetUrl, 'http://x').searchParams.get('token')!;

  it('emails a working link for a real account', async () => {
    await auth.register(REG);
    const before = mail.sent.length;

    const res = await auth.requestPasswordReset(REG.email);
    expect(res.ok).toBe(true);
    expect(mail.sent.length).toBe(before + 1);
    expect(mail.sent.at(-1)?.to).toBe(REG.email);
    expect(mail.sent.at(-1)?.body).toContain('reset-password?token=');

    const token = tokenFrom(res.devResetUrl!);
    await auth.confirmPasswordReset({ token, password: 'a brand new passphrase' });

    const after = await auth.loginWithPassword({
      email: REG.email, password: 'a brand new passphrase',
    });
    expect(after.user.phone).toBe('+919830066666');
  });

  it('sends nothing, and reveals nothing in the response, for an email with no account', async () => {
    await auth.register(REG);

    const before = mail.sent.length;
    const unknown = await auth.requestPasswordReset('nobody@example.com');
    // Exactly `{ ok: true }` — no `devResetUrl`, because there is no token to
    // show: issuing one for an address with no account IS the leak.
    expect(unknown).toEqual({ ok: true });
    expect(mail.sent.length).toBe(before);

    // The REGISTERED address, by contrast, really is emailed and really does
    // carry a dev token — the two calls differ in what they DO, which is
    // invisible to an outside caller, never in what either one SAYS.
    const known = await auth.requestPasswordReset(REG.email);
    expect(known.devResetUrl).toBeTruthy();
    expect(mail.sent.length).toBe(before + 1);
  });

  it('refuses a reset on an OTP-only account, same as it has no password to lose', async () => {
    const { requestId } = await auth.requestOtp('9830077777');
    await auth.verifyOtp({ requestId, phone: '9830077777', otp: '123456' });

    const before = mail.sent.length;
    const res = await auth.requestPasswordReset('otp-only@example.com');
    expect(res).toEqual({ ok: true });
    expect(mail.sent.length).toBe(before);
  });

  it('is single-use — the same link cannot reset a password twice', async () => {
    await auth.register(REG);
    const { devResetUrl } = await auth.requestPasswordReset(REG.email);
    const token = tokenFrom(devResetUrl!);

    await auth.confirmPasswordReset({ token, password: 'first new passphrase' });
    await expect(auth.confirmPasswordReset({ token, password: 'second new passphrase' }))
      .rejects.toMatchObject({ code: ErrorCode.PASSWORD_RESET_INVALID });
  });

  it('rejects an unknown or already-expired token with the same message either way', async () => {
    await expect(auth.confirmPasswordReset({ token: 'not-a-real-token', password: 'a long enough password' }))
      .rejects.toMatchObject({ code: ErrorCode.PASSWORD_RESET_INVALID });
  });

  it('still enforces the password policy on the new password', async () => {
    await auth.register(REG);
    const { devResetUrl } = await auth.requestPasswordReset(REG.email);
    await expect(auth.confirmPasswordReset({ token: tokenFrom(devResetUrl!), password: 'short' }))
      .rejects.toMatchObject({ code: ErrorCode.WEAK_PASSWORD });
  });

  it('cannot be used to exhaust an inbox — more than three requests an hour are refused', async () => {
    await auth.register(REG);
    for (let i = 0; i < 3; i++) await auth.requestPasswordReset(REG.email);
    await expect(auth.requestPasswordReset(REG.email))
      .rejects.toMatchObject({ code: ErrorCode.PASSWORD_RESET_RATE_LIMITED });
  });

  it('counts an unregistered email against the same limit, or the limit itself would leak who is registered', async () => {
    for (let i = 0; i < 3; i++) await auth.requestPasswordReset('prober@example.com');
    await expect(auth.requestPasswordReset('prober@example.com'))
      .rejects.toMatchObject({ code: ErrorCode.PASSWORD_RESET_RATE_LIMITED });
  });

  it('does not reset a deleted account', async () => {
    const res = await auth.register(REG);
    const { devResetUrl } = await auth.requestPasswordReset(REG.email);
    await h.db.update(users).set({ deletedAt: new Date().toISOString() })
      .where(eq(users.id, res.user.id));

    await expect(auth.confirmPasswordReset({
      token: tokenFrom(devResetUrl!), password: 'a long enough password',
    })).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
  });
});

/**
 * SESSION REVOCATION.
 *
 * Refresh tokens live 30 days and carried nothing that could invalidate them, so a
 * password change left every already-issued token working for a month and "sign out
 * everywhere" could not be built at all. For a product whose primary sign-in is now
 * email and password, that is the wrong shape: changing a password is precisely what
 * someone does when they think an account is compromised.
 *
 * Enforced on REFRESH rather than on every request, deliberately. `verifyAccess` is
 * synchronous and touches no database; checking a version there would put a query on
 * the hot path of the whole API to close a window already only fifteen minutes wide.
 */
describe('ending a session', () => {
  const creds = { name: 'Revoke Test', email: 'revoke@example.com', phone: '9123456001' };

  it('keeps refreshing while the version is unchanged', async () => {
    const reg = await auth.register({ ...creds, password: 'correct-horse-9' });
    const again = await auth.refresh(reg.tokens.refreshToken);
    expect(again.accessToken).toBeTruthy();
  });

  it('kills every refresh token when sessions are revoked', async () => {
    const reg = await auth.register({ ...creds, password: 'correct-horse-9' });
    await auth.revokeSessions(reg.user.id);

    await expect(auth.refresh(reg.tokens.refreshToken))
      .rejects.toThrow(/session has ended/i);
  });

  /**
   * The point of the whole change: an attacker holding a thirty-day refresh token
   * must not survive the victim changing their password.
   */
  it('ends other sessions when the password changes', async () => {
    const reg = await auth.register({ ...creds, password: 'correct-horse-9' });
    const stolen = reg.tokens.refreshToken;

    await auth.setPassword({
      userId: reg.user.id,
      currentPassword: 'correct-horse-9',
      password: 'a-different-one-77',
    });

    await expect(auth.refresh(stolen)).rejects.toThrow(/session has ended/i);
  });

  /** The device that proved it knows the current password stays signed in. */
  it('hands the caller a working replacement', async () => {
    const reg = await auth.register({ ...creds, password: 'correct-horse-9' });
    const res = await auth.setPassword({
      userId: reg.user.id,
      currentPassword: 'correct-horse-9',
      password: 'a-different-one-77',
    });

    expect(res.tokens.refreshToken).toBeTruthy();
    await expect(auth.refresh(res.tokens.refreshToken)).resolves.toBeTruthy();
  });

  /**
   * Tokens minted before `tv` existed carry no version at all. They must keep
   * working until they expire — a deploy that signed every open session out would
   * be a self-inflicted outage — and `?? 0` matches the column default to do it.
   */
  it('does not sign out sessions that predate versioning', async () => {
    const reg = await auth.register({ ...creds, password: 'correct-horse-9' });
    const legacy = jwt.sign(
      { sub: reg.user.id, role: 'devotee', typ: 'refresh' },
      TEST_CONFIG.JWT_REFRESH_SECRET,
      { expiresIn: '30d' },
    );
    await expect(auth.refresh(legacy)).resolves.toBeTruthy();
  });

  it('but does sign them out once the version moves', async () => {
    const reg = await auth.register({ ...creds, password: 'correct-horse-9' });
    const legacy = jwt.sign(
      { sub: reg.user.id, role: 'devotee', typ: 'refresh' },
      TEST_CONFIG.JWT_REFRESH_SECRET,
      { expiresIn: '30d' },
    );
    await auth.revokeSessions(reg.user.id);
    await expect(auth.refresh(legacy)).rejects.toThrow(/session has ended/i);
  });
});
