import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  makeHarness, notifier, mailer, resetService, TEST_CONFIG, type Harness,
} from '../../../test/harness';
import { users } from '../../../db/schema/index';
import { MemoryKv } from '../../../common/kv';
import { OtpService } from '../otp.service';
import { AuthService } from '../auth.service';
import { hashPassword, verifyPassword, passwordProblem } from '../password';

let h: Harness;
let auth: AuthService;

const REG = { name: 'Debarati Sen', email: 'Debarati@Example.com', phone: '9830012345', password: 'correct horse battery' };

beforeEach(async () => {
  h = await makeHarness();
  auth = new AuthService(
    h.db, new OtpService(new MemoryKv(), 'otp-secret', true), TEST_CONFIG, notifier(h.db),
    resetService(h.kv), mailer(),
  );
}, 60_000);
afterEach(async () => { await h?.pg.close(); });

describe('password hashing', () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('a good long password');
    expect(await verifyPassword('a good long password', hash)).toBe(true);
    expect(await verifyPassword('a good long passwerd', hash)).toBe(false);
  });

  it('salts, so the same password hashes differently every time', async () => {
    const a = await hashPassword('same password');
    const b = await hashPassword('same password');
    expect(a).not.toBe(b);
    expect(await verifyPassword('same password', a)).toBe(true);
    expect(await verifyPassword('same password', b)).toBe(true);
  });

  it('stores its parameters so they can be raised later', async () => {
    expect(await hashPassword('x'.repeat(12))).toMatch(/^scrypt\$16384\$8\$1\$/);
  });

  it('never throws on a malformed stored hash', async () => {
    for (const bad of ['', 'garbage', 'scrypt$1$2', 'bcrypt$x$y$z$a$b']) {
      expect(await verifyPassword('anything', bad)).toBe(false);
    }
  });

  it('enforces length rather than composition theatre', () => {
    expect(passwordProblem('short')).toMatch(/at least 8/);
    expect(passwordProblem('password')).toMatch(/too common/);
    expect(passwordProblem('a reasonable passphrase')).toBeNull();
  });
});

describe('register and login', () => {
  it('registers and returns a usable token', async () => {
    const res = await auth.register(REG);
    expect(res.user.isNew).toBe(true);
    expect(res.user.phone).toBe('+919830012345');
    expect(auth.verifyAccess(res.tokens.accessToken).sub).toBe(res.user.id);
  });

  it('stores the email lowercased and never stores the password', async () => {
    const res = await auth.register(REG);
    const row = (await h.db.select().from(users).where(eq(users.id, res.user.id)))[0]!;
    expect(row.email).toBe('debarati@example.com');
    expect(row.passwordHash).not.toContain(REG.password);
    expect(row.passwordHash).toMatch(/^scrypt\$/);
  });

  it('logs in, case-insensitively on the email', async () => {
    await auth.register(REG);
    const res = await auth.loginWithPassword({ email: 'DEBARATI@example.COM', password: REG.password });
    expect(res.user.phone).toBe('+919830012345');
  });

  it('gives the SAME message for unknown email and wrong password', async () => {
    await auth.register(REG);
    const a = await auth.loginWithPassword({ email: REG.email, password: 'wrong' })
      .catch((e: Error) => e.message);
    const b = await auth.loginWithPassword({ email: 'nobody@example.com', password: 'wrong' })
      .catch((e: Error) => e.message);
    expect(a).toBe('Incorrect email or password');
    expect(b).toBe(a);
  });

  it('refuses a second account on the same email', async () => {
    await auth.register(REG);
    await expect(auth.register({ ...REG, phone: '9830099999' }))
      .rejects.toThrow(/email already exists/);
  });

  it('refuses a weak password', async () => {
    await expect(auth.register({ ...REG, password: 'short' })).rejects.toThrow(/at least 8/);
  });

  /**
   * This test used to assert the opposite — that registering with an existing
   * OTP-only account's phone silently attached the submitted password to it and
   * returned that account's tokens. Nothing in the request proved the caller owned
   * the number, so it was an account-takeover endpoint: anyone who knew a devotee's
   * phone could claim their bookings and addresses.
   */
  it('refuses to attach a password to an existing account without proof of ownership', async () => {
    const otp = await auth.requestOtp('9830012345');
    const victim = await auth.verifyOtp({
      requestId: otp.requestId, phone: '9830012345', otp: '123456',
    });

    await expect(auth.register({ ...REG, phone: '9830012345', email: 'attacker@example.com' }))
      .rejects.toThrow(/already exists/);

    // Untouched: no password attached, and the attacker's email did not land on it.
    const all = await h.db.select().from(users).where(eq(users.phone, '+919830012345'));
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe(victim.user.id);
    expect(all[0]!.passwordHash).toBeNull();
    expect(all[0]!.email).not.toBe('attacker@example.com');
  });

  /**
   * The legitimate half of what registration used to do, now behind a token — which
   * can only be held by someone who passed an OTP challenge on this very number.
   */
  it('lets an OTP-only account add a password once it holds a token', async () => {
    const otp = await auth.requestOtp('9830012345');
    const session = await auth.verifyOtp({
      requestId: otp.requestId, phone: '9830012345', otp: '123456',
    });

    await auth.setPassword({ userId: session.user.id, password: 'correct horse battery' });

    await auth.register({ ...REG, phone: '9830099999', email: 'someone@example.com' });
    const rows = await h.db.select().from(users).where(eq(users.phone, '+919830012345'));
    expect(rows[0]!.passwordHash).toBeTruthy();
  });

  it('requires the current password before replacing an existing one', async () => {
    const res = await auth.register(REG);

    await expect(auth.setPassword({ userId: res.user.id, password: 'a new long password' }))
      .rejects.toThrow(/current password/i);

    await expect(auth.setPassword({
      userId: res.user.id, password: 'a new long password', currentPassword: 'not it',
    })).rejects.toThrow(/current password/i);

    await auth.setPassword({
      userId: res.user.id, password: 'a new long password', currentPassword: REG.password,
    });
    const after = await auth.loginWithPassword({
      email: REG.email, password: 'a new long password',
    });
    expect(after.user.id).toBe(res.user.id);
  });

  it('will not set a weak password', async () => {
    const res = await auth.register(REG);
    await expect(auth.setPassword({
      userId: res.user.id, password: 'short', currentPassword: REG.password,
    })).rejects.toThrow();
  });

  it('lets the same person use either door', async () => {
    await auth.register(REG);
    const otp = await auth.requestOtp(REG.phone);
    const viaOtp = await auth.verifyOtp({ requestId: otp.requestId, phone: REG.phone, otp: '123456' });
    const viaPassword = await auth.loginWithPassword({ email: REG.email, password: REG.password });
    expect(viaOtp.user.id).toBe(viaPassword.user.id);
  });

  it('locks out a deleted account', async () => {
    const res = await auth.register(REG);
    await h.db.update(users).set({ deletedAt: new Date().toISOString() })
      .where(eq(users.id, res.user.id));
    await expect(auth.loginWithPassword({ email: REG.email, password: REG.password }))
      .rejects.toThrow(/deleted/);
  });

  it('refuses a password login on an OTP-only account', async () => {
    const otp = await auth.requestOtp('9830055555');
    await auth.verifyOtp({ requestId: otp.requestId, phone: '9830055555', otp: '123456' });
    await expect(auth.loginWithPassword({ email: 'nothing@example.com', password: 'whatever' }))
      .rejects.toThrow(/Incorrect email or password/);
  });
});
