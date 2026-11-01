import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  makeHarness, notifier, mailer, resetService, seedTemplates, TEST_CONFIG, type Harness,
} from '../../../test/harness';
import { AuthService } from '../auth.service';
import { OtpService } from '../otp.service';
import { MemoryKv } from '../../../common/kv';

let h: Harness;
let auth: AuthService;
let notify: ReturnType<typeof notifier>;

beforeEach(async () => {
  h = await makeHarness();
  await seedTemplates(h.db);
  notify = notifier(h.db);
  auth = new AuthService(
    h.db, new OtpService(new MemoryKv(), 'otp-secret', true), TEST_CONFIG, notify,
    resetService(h.kv), mailer(),
  );
}, 60_000);
afterEach(async () => { await h?.pg.close(); });

/**
 * The login code has to reach the person asking for it.
 *
 * `requestOtp` generated a code, hashed it into Redis, and then handed it back to
 * the caller only under `OTP_DEV_BYPASS`. Nothing else ever sent it. Outside
 * development every sign-in ended at a screen asking for six digits that had been
 * delivered nowhere — the first thing a real user does, and the first thing that
 * could not work.
 */
describe('the login code is actually sent', () => {
  it('sends a message to the number that asked', async () => {
    await auth.requestOtp('+919830000001');
    expect(notify.channel.sent).toHaveLength(1);
    expect(notify.channel.sent[0]!.to).toBe('+919830000001');
    expect(notify.channel.sent[0]!.templateKey).toBe('auth.otp');
  });

  it('puts the code in the message', async () => {
    const r = await auth.requestOtp('+919830000001');
    expect(notify.channel.sent[0]!.body).toContain(r.devOtp!);
  });

  /**
   * Signup is the case that matters: the whole point of a login code is that the
   * person may not have an account yet, so a delivery path that needs a `userId`
   * would fail exactly when it is most needed.
   */
  it('reaches a number with no account at all', async () => {
    const before = await h.db.execute(sql`SELECT count(*)::int AS n FROM users`);
    await auth.requestOtp('+919899990001');
    expect(notify.channel.sent).toHaveLength(1);

    const after = await h.db.execute(sql`SELECT count(*)::int AS n FROM users`);
    const n = (r: unknown) => (((r as { rows?: Array<{ n: number }> }).rows ?? r) as Array<{ n: number }>)[0]!.n;
    expect(n(after), 'requesting a code created an account').toBe(n(before));
  });

  /** The screen needs to know, so it can offer a resend rather than a blank wait. */
  it('reports whether delivery succeeded', async () => {
    expect((await auth.requestOtp('+919830000001')).delivered).toBe(true);
  });

  /**
   * The code must never be written down.
   *
   * `notifications.payload` keeps every variable so ops can see what was sent, and
   * OtpService stores only an HMAC precisely so a copy of the database is not a list
   * of valid codes. Persisting the plaintext here would hand back exactly what the
   * hashing protects — for a login code, that is account takeover.
   */
  it('never stores the code in the database', async () => {
    const r = await auth.requestOtp('+919830000001');
    const rows = await h.db.execute(sql`
      SELECT payload::text AS p FROM notifications WHERE template_key = 'auth.otp'`);
    const list = ((rows as { rows?: Array<{ p: string }> }).rows ?? rows) as Array<{ p: string }>;
    expect(list).toHaveLength(1);
    expect(list[0]!.p, 'the plaintext login code was persisted').not.toContain(r.devOtp!);
    expect(list[0]!.p).toContain('redacted');
  });

  /**
   * A messaging outage must not take sign-in down with it. The failure is recorded
   * for ops; the caller still gets a requestId and can resend.
   */
  it('still returns a request when the channel fails', async () => {
    notify.channel.send = async () => { throw new Error('BSP down'); };
    const r = await auth.requestOtp('+919830000001');
    expect(r.requestId).toBeTruthy();
    expect(r.delivered).toBe(false);
  });
});
