import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeHarness, daysFromNow, type Harness } from '../../../test/harness';
import { bookings, bookingEvents, ledgerEntries } from '../../../db/schema/index';
import { loadConfig } from '../../../common/config';
import { PaymentsService } from '../../payments/payments.service';
import { computePrice, paise, ZERO } from '@themaithil/contracts';

let h: Harness;

/*
 * Cleared after closing. The last two describes need no database at all, and
 * without this the hook would call `close()` a second time on the harness left
 * over from the previous block — which throws "PGlite is closed" and fails tests
 * that never opened one.
 */
afterEach(async () => {
  if (!h) return;
  await h.pg.close();
  h = undefined as unknown as Harness;
});

const draft = async (over: Record<string, unknown> = {}) => h.bookings.createDraft({
  devoteeId: h.ids.devoteeId,
  ritualId: h.ids.ritualId,
  addressId: h.ids.addressId,
  date: daysFromNow(10),
  slotIdx: 1,
  samagriOption: 'pandit_brings',
  paymentMode: 'cash',
  attendeeCount: 20,
  ...over,
} as never);

/**
 * CASH-ONLY MODE (`PAYMENTS_ENABLED=false`).
 *
 * A deployment with no payment gateway still has to be able to take bookings, and
 * the honest arithmetic for that is: no token, the whole amount collected in cash by
 * the purohit on the day. The alternative — pretending a payment happened so the
 * existing path works — would write money into the ledger that nobody paid, which is
 * the one thing this mode must not do.
 */
describe('a deployment with no payment gateway', () => {
  beforeEach(async () => {
    h = await makeHarness({ paymentsEnabled: false });
  }, 60_000);

  it('charges no token and bills the whole amount as cash', async () => {
    const d = await draft();
    const [row] = await h.db.select({ price: bookings.price })
      .from(bookings).where(eq(bookings.id, d.id));
    const price = row!.price as { tokenPaise: number; balancePaise: number; totalPaise: number };

    expect(price.tokenPaise).toBe(0);
    expect(price.balancePaise).toBe(price.totalPaise);
  });

  /**
   * `pending_accept` exists to hold a slot while the devotee pays. With nothing to
   * pay it has nothing to wait for, and leaving bookings parked there would have
   * `expireStaleAccepts` reap every one of them an hour later.
   */
  it('confirms the booking on submission rather than parking it', async () => {
    const d = await draft();
    const res = await h.bookings.submitAndConfirmUnpaid(d.id, h.ids.devoteeId);

    expect(res.state).toBe('confirmed');
    const [row] = await h.db.select({ state: bookings.state })
      .from(bookings).where(eq(bookings.id, d.id));
    expect(row!.state).toBe('confirmed');
  });

  /** Without codes the puja cannot be started or settled, paid or not. */
  it('still issues start and completion codes', async () => {
    const d = await draft();
    const res = await h.bookings.submitAndConfirmUnpaid(d.id, h.ids.devoteeId) as {
      startOtp?: string; completeOtp?: string;
    };

    expect(res.startOtp).toMatch(/^\d{6}$/);
    expect(res.completeOtp).toMatch(/^\d{6}$/);
  });

  /**
   * The point of the whole mode. `planTokenCapture` is where money enters the
   * system and nowhere else, so a cash-only confirmation must leave it untouched —
   * a zero-value or fabricated capture would record a payment no devotee made.
   */
  it('writes no money into the ledger', async () => {
    const d = await draft();
    await h.bookings.submitAndConfirmUnpaid(d.id, h.ids.devoteeId);

    const entries = await h.db.select().from(ledgerEntries);
    expect(entries).toHaveLength(0);
  });

  /**
   * A distinct trigger, so every booking taken on trust carries a permanent record
   * of why it confirmed without money. When the gateway is switched on, "which
   * bookings were cash-only" is a query rather than an inference from dates.
   */
  it('records in the audit spine that no payment was taken', async () => {
    const d = await draft();
    await h.bookings.submitAndConfirmUnpaid(d.id, h.ids.devoteeId);

    const events = await h.db.select().from(bookingEvents)
      .where(eq(bookingEvents.bookingId, d.id));
    const confirm = events.find((e) => e.toState === 'confirmed');

    expect(confirm?.trigger).toBe('confirmed_unpaid');
    expect(confirm?.trigger).not.toBe('token_captured');
    expect((confirm?.meta as { reason?: string } | null)?.reason).toBe('payments_disabled');
  });

  /** Nothing should be able to open a checkout that does not exist. */
  it('refuses to create a payment intent at all', async () => {
    const d = await draft();
    await h.bookings.submitAndConfirmUnpaid(d.id, h.ids.devoteeId);

    // Constructed here rather than on the harness: the refusal happens before the
    // gateway is ever touched, so a stub that would throw if called proves it.
    const payments = new PaymentsService(
      h.db,
      { createOrder: () => { throw new Error('gateway must not be reached'); } } as never,
      h.bookings,
      false,
    );

    await expect(payments.createTokenIntent({
      bookingId: d.id, userId: h.ids.devoteeId,
    })).rejects.toThrow(/not available|cash/i);
  });
});

/**
 * The flag must not change anything for a deployment that takes money — that is the
 * whole basis for defaulting it to true.
 */
describe('a deployment that takes payments is unaffected', () => {
  beforeEach(async () => { h = await makeHarness(); }, 60_000);

  it('still charges a token and waits for payment', async () => {
    const d = await draft();
    const [row] = await h.db.select({ price: bookings.price })
      .from(bookings).where(eq(bookings.id, d.id));
    const price = row!.price as { tokenPaise: number; balancePaise: number };
    expect(price.tokenPaise).toBeGreaterThan(0);

    const res = await h.bookings.submitAndConfirmUnpaid(d.id, h.ids.devoteeId);
    expect(res.state).toBe('pending_accept');
  });

  /**
   * The `payments_disabled` guard, enforced in the service where the state machine
   * says guards are enforced. Without it the unpaid path would be reachable while
   * payments are on — a booking confirmed for free on a deployment charging
   * everyone else.
   */
  it('refuses an unpaid confirmation outright', async () => {
    const d = await draft();
    await h.bookings.submit(d.id, h.ids.devoteeId);

    await expect(h.bookings.confirmOnTokenCapture({
      bookingId: d.id, paymentIntentId: null, unpaid: true,
    })).rejects.toThrow(/payments are enabled/i);
  });

  it('refuses a paid confirmation with no payment intent', async () => {
    const d = await draft();
    await h.bookings.submit(d.id, h.ids.devoteeId);

    await expect(h.bookings.confirmOnTokenCapture({
      bookingId: d.id, paymentIntentId: null,
    })).rejects.toThrow(/payment intent/i);
  });
});

/**
 * The flag is read from the environment, and the one way to get this wrong is the
 * reason `OTP_DEV_BYPASS` carries the same warning: `z.coerce.boolean()` is
 * `Boolean(value)`, so the string "false" coerces to TRUE. On a flag deciding
 * whether anybody is charged, that inversion is somebody's bank statement.
 */
describe('the flag itself', () => {
  const base = {
    NODE_ENV: 'development',
    DATABASE_URL: 'pglite://memory',
    JWT_ACCESS_SECRET: 'test-secret-that-is-long-enough-32ch',
    JWT_REFRESH_SECRET: 'test-refresh-secret-long-enough-32c',
  } as unknown as NodeJS.ProcessEnv;

  it('defaults to ON, so a deployment must say it cannot charge', () => {
    expect(loadConfig(base).PAYMENTS_ENABLED).toBe(true);
  });

  it.each(['false', 'FALSE', '0', 'no', 'off'])('treats %s as off', (v) => {
    expect(loadConfig({ ...base, PAYMENTS_ENABLED: v }).PAYMENTS_ENABLED).toBe(false);
  });

  it.each(['true', '1', 'yes', 'on'])('treats %s as on', (v) => {
    expect(loadConfig({ ...base, PAYMENTS_ENABLED: v }).PAYMENTS_ENABLED).toBe(true);
  });

  /**
   * The point of making the flag explicit: production may boot without Razorpay
   * credentials ONLY because it has declared it is not charging anybody.
   */
  it('lets production boot without payment credentials when payments are off', () => {
    const prod = {
      ...base,
      NODE_ENV: 'production',
      REDIS_URL: 'redis://localhost:6379',
      PAYMENTS_ENABLED: 'false',
      WHATSAPP_API_URL: 'https://bsp.example/send',
      WHATSAPP_API_KEY: 'k',
      R2_ENDPOINT: 'https://r2.example', R2_BUCKET: 'b',
      R2_ACCESS_KEY_ID: 'a', R2_SECRET_ACCESS_KEY: 's',
    } as unknown as NodeJS.ProcessEnv;

    expect(() => loadConfig(prod)).not.toThrow();
  });

  it('still demands payment credentials in production when payments are on', () => {
    const prod = {
      ...base,
      NODE_ENV: 'production',
      REDIS_URL: 'redis://localhost:6379',
      WHATSAPP_API_URL: 'https://bsp.example/send',
      WHATSAPP_API_KEY: 'k',
      R2_ENDPOINT: 'https://r2.example', R2_BUCKET: 'b',
      R2_ACCESS_KEY_ID: 'a', R2_SECRET_ACCESS_KEY: 's',
    } as unknown as NodeJS.ProcessEnv;

    expect(() => loadConfig(prod)).toThrow(/payment credentials/i);
  });
});

/** The pricing engine on its own, with no database in the way. */
describe('computePrice with payments off', () => {
  const input = {
    dakshinaBasePaise: paise(150000),
    bomTotalPaise: paise(80000),
    travelFeePaise: ZERO,
    surgeBps: 10000,
    samagriOption: 'pandit_brings' as const,
    paymentMode: 'cash' as const,
  };

  it('moves the entire total into the cash balance', () => {
    const off = computePrice({ ...input, paymentsEnabled: false });
    expect(off.tokenPaise).toBe(0);
    expect(off.balancePaise).toBe(off.totalPaise);
  });

  it('leaves the total itself unchanged — only who collects it moves', () => {
    const on = computePrice(input);
    const off = computePrice({ ...input, paymentsEnabled: false });
    expect(off.totalPaise).toBe(on.totalPaise);
    expect(off.platformFeePaise).toBe(on.platformFeePaise);
  });

  /**
   * `digital_full` cannot occur in this mode — booking creation refuses it — but if
   * one slipped through it must collect nothing online rather than demand the whole
   * total through a checkout that does not exist.
   */
  it('collects nothing online even for a digital_full booking', () => {
    const off = computePrice({
      ...input, paymentMode: 'digital_full', paymentsEnabled: false,
    });
    expect(off.tokenPaise).toBe(0);
  });
});

/**
 * SIGNING IN WITHOUT A MESSAGING PROVIDER.
 *
 * The production boot check used to refuse to start without a WhatsApp BSP, on the
 * stated grounds that "login codes go to the server log and nobody can sign in".
 * The first half is true. The second has not been since email and password landed:
 * `register` issues tokens with no OTP and no message, and `loginWithPassword` needs
 * nothing but the database.
 *
 * That mattered because WhatsApp's provider is gated behind Meta verification and
 * 1–2 weeks of template approval, so the check put a fortnight of procurement in
 * front of a product that could already let people in.
 *
 * The real requirement is that at least one door opens AND anyone who walks through
 * it can get back in — which needs a way to send a reset, and email is one.
 */
describe('what production actually requires to let people in', () => {
  const base = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://u@localhost/db',
    REDIS_URL: 'redis://localhost:6379',
    JWT_ACCESS_SECRET: 'test-secret-that-is-long-enough-32ch',
    JWT_REFRESH_SECRET: 'test-refresh-secret-long-enough-32c',
    PAYMENTS_ENABLED: 'false',
    R2_ENDPOINT: 'https://r2.example', R2_BUCKET: 'b',
    R2_ACCESS_KEY_ID: 'a', R2_SECRET_ACCESS_KEY: 's',
  } as unknown as NodeJS.ProcessEnv;

  it('boots on email alone, with no messaging provider at all', () => {
    expect(() => loadConfig({
      ...base, EMAIL_API_URL: 'https://mail.example/send', EMAIL_API_KEY: 'k',
    })).not.toThrow();
  });

  it('still boots on a messaging provider alone', () => {
    expect(() => loadConfig({
      ...base, WHATSAPP_API_URL: 'https://bsp.example', WHATSAPP_API_KEY: 'k',
    })).not.toThrow();
  });

  it('accepts MSG91 as that provider, not only a WhatsApp BSP', () => {
    expect(() => loadConfig({ ...base, MSG91_AUTH_KEY: 'k' })).not.toThrow();
  });

  /** With neither, a locked-out devotee could never get back in. */
  it('refuses when there is no way to reach anybody', () => {
    expect(() => loadConfig(base)).toThrow(/way to reach people/i);
  });
});

/**
 * `otpLoginAvailable` is what stops the login screen opening on a door that cannot
 * open. Derived from three unrelated settings, so it is computed once here rather
 * than re-derived — subtly differently — by each caller.
 */
describe('whether a phone OTP can reach anybody', () => {
  const base = {
    NODE_ENV: 'development',
    DATABASE_URL: 'pglite://memory',
    JWT_ACCESS_SECRET: 'test-secret-that-is-long-enough-32ch',
    JWT_REFRESH_SECRET: 'test-refresh-secret-long-enough-32c',
  } as unknown as NodeJS.ProcessEnv;

  it('is false with no provider and no dev bypass', () => {
    expect(loadConfig({ ...base, OTP_DEV_BYPASS: 'false' }).otpLoginAvailable).toBe(false);
  });

  /** The dev bypass returns the code in the response, so no message is needed. */
  it('is true under the dev bypass', () => {
    expect(loadConfig({ ...base, OTP_DEV_BYPASS: 'true' }).otpLoginAvailable).toBe(true);
  });

  it('is true with a WhatsApp BSP', () => {
    expect(loadConfig({
      ...base, OTP_DEV_BYPASS: 'false',
      WHATSAPP_API_URL: 'https://bsp.example', WHATSAPP_API_KEY: 'k',
    }).otpLoginAvailable).toBe(true);
  });

  it('is true with MSG91 alone', () => {
    expect(loadConfig({
      ...base, OTP_DEV_BYPASS: 'false', MSG91_AUTH_KEY: 'k',
    }).otpLoginAvailable).toBe(true);
  });

  /** A URL with no key cannot send anything, so half a BSP is not a provider. */
  it('is false with half a BSP configured', () => {
    expect(loadConfig({
      ...base, OTP_DEV_BYPASS: 'false', WHATSAPP_API_URL: 'https://bsp.example',
    }).otpLoginAvailable).toBe(false);
  });
});

/**
 * THINGS A LAUNCH EXPOSES THAT A DEV MACHINE NEVER DOES.
 *
 * Both of these were reachable: the config would happily boot production with them,
 * and neither fails loudly afterwards. They are checked at boot because that is the
 * only moment anybody is looking.
 */
describe('production refuses to start in a state that only breaks later', () => {
  const ok = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://u@localhost/db',
    REDIS_URL: 'redis://localhost:6379',
    JWT_ACCESS_SECRET: 'a-genuinely-random-access-secret-32',
    JWT_REFRESH_SECRET: 'a-genuinely-random-refresh-secret-3',
    PAYMENTS_ENABLED: 'false',
    EMAIL_API_URL: 'https://mail.example/send', EMAIL_API_KEY: 'k',
    R2_ENDPOINT: 'https://r2.example', R2_BUCKET: 'b',
    R2_ACCESS_KEY_ID: 'a', R2_SECRET_ACCESS_KEY: 's',
  } as unknown as NodeJS.ProcessEnv;

  it('accepts a properly configured production environment', () => {
    expect(() => loadConfig(ok)).not.toThrow();
  });

  /**
   * `.env.example` ships `change-me-32-chars-minimum-please!!` — 35 characters, so
   * the `min(32)` length check passes it. The value is in the repository, so anyone
   * who can read it can sign an access token for any user id and any role,
   * including admin. There is no exploit to write; it is a `jwt.sign` call.
   */
  it('refuses the example JWT secret, which is long enough to pass validation', () => {
    expect(() => loadConfig({
      ...ok, JWT_ACCESS_SECRET: 'change-me-32-chars-minimum-please!!',
    })).toThrow(/forge a token/i);
  });

  it('catches a half-hearted edit of it too', () => {
    expect(() => loadConfig({
      ...ok, JWT_REFRESH_SECRET: 'change-me-too-32-chars-minimum!!!!',
    })).toThrow(/forge a token/i);
  });

  /**
   * No `REDIS_URL` falls back to `MemoryKv` silently. On one dev process that is
   * correct; on more than one production instance it makes rate limits per-process
   * (so the OTP send limit is bypassed by landing on another machine), OTP codes
   * unverifiable across instances, and slot holds unshared.
   */
  it('refuses to run without Redis, which it would otherwise fake in memory', () => {
    const { REDIS_URL: _dropped, ...noRedis } = ok as Record<string, string>;
    expect(() => loadConfig(noRedis as unknown as NodeJS.ProcessEnv))
      .toThrow(/REDIS_URL/);
  });

  /** None of this applies in development, where the fallbacks are the point. */
  it('leaves development alone', () => {
    expect(() => loadConfig({
      NODE_ENV: 'development',
      DATABASE_URL: 'pglite://memory',
      JWT_ACCESS_SECRET: 'change-me-32-chars-minimum-please!!',
      JWT_REFRESH_SECRET: 'change-me-too-32-chars-minimum!!!',
    } as unknown as NodeJS.ProcessEnv)).not.toThrow();
  });
});
