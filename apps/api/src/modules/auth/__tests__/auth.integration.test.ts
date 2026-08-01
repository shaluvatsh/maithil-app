import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeHarness, TEST_CONFIG, type Harness } from '../../../test/harness';
import { users } from '../../../db/schema/index';
import { MemoryKv } from '../../../common/kv';
import { OtpService } from '../otp.service';
import { AuthService } from '../auth.service';

let h: Harness;
let auth: AuthService;
let kv: MemoryKv;

beforeEach(async () => {
  h = await makeHarness();
  kv = new MemoryKv();
  auth = new AuthService(h.db, new OtpService(kv, 'otp-secret', true), TEST_CONFIG);
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
