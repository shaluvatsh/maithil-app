import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  DATABASE_URL: z.string().min(1),
  /**
   * A single instance's whole DB budget: every request handler AND both
   * background workers (the outbox relay, the panchang job) share this one pool.
   * It was a bare constant with no way to raise it for a busier deployment short
   * of editing code and redeploying - see the strict concurrency review, finding
   * #7. 10 stays the default so an unset env var changes nothing.
   */
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  REDIS_URL: z.string().optional(),

  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),

  // Payments. Absent in development, in which case a fake gateway is used and the
  // app refuses to start in production - see the check below.
  /**
   * The assistant. Absent means the assistant is off, not broken — every entry
   * point checks for it and declines politely rather than erroring, so a
   * deployment without a key still serves the rest of the product.
   */
  ANTHROPIC_API_KEY: z.string().optional(),
  /** Where the assistant sends people to review and pay for a draft booking. */
  WEB_BASE_URL: z.string().optional(),
  /** Verifies that an inbound WhatsApp webhook really came from the BSP. */
  WHATSAPP_INBOUND_SECRET: z.string().optional(),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),

  /*
   * Object storage for KYC documents (Cloudflare R2, S3-compatible).
   *
   * Optional in development, where an in-memory store stands in — the same shape as
   * the payment gateway, and for the same reason: the flow has to be exercisable in
   * CI without a bucket. Production refuses to start without it, because a purohit
   * who uploads identity documents into a store that forgets them has been told they
   * are in review when they are not.
   */
  R2_ENDPOINT: z.string().optional(),
  R2_BUCKET: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),

  // Notifications
  WHATSAPP_API_URL: z.string().optional(),
  WHATSAPP_API_KEY: z.string().optional(),
  WHATSAPP_SENDER: z.string().optional(),
  MSG91_AUTH_KEY: z.string().optional(),
  MSG91_SENDER_ID: z.string().default('MAITHL'),
  /**
   * Transactional email — password reset today, nothing else yet. Optional in
   * every environment, unlike the WhatsApp/SMS pair: sign-in does not depend on
   * it (phone OTP always works), so an unconfigured deployment degrades to
   * logging the reset link instead of emailing it, rather than refusing to boot.
   * The same three fields `HttpEmailChannel` needs; see that file for why a
   * generic HTTP POST rather than a vendor SDK.
   */
  EMAIL_API_URL: z.string().optional(),
  EMAIL_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),

  LAUNCH_CITY_SLUG: z.string().default('kolkata'),
  /**
   * ONE constant for both the availability and panchang materialisation jobs.
   * The original design used 60 and 90 respectively, which left a month where a
   * devotee could see an auspicious date on the panchang tab and then find no
   * bookable slots on it - not because none were free, but because the rows did
   * not exist.
   */
  BOOKING_HORIZON_DAYS: z.coerce.number().int().default(120),

  /*
   * COMMUNITY. Deployment knobs, all with defaults, so an unset variable changes
   * nothing — the DB_POOL_MAX precedent. Bounds that the web app must also enforce
   * (page-size min/max, body lengths) are NOT here: those are a contract, and they
   * live in packages/contracts where both sides read one copy.
   */

  /**
   * The feed page size when the client does not ask for one.
   *
   * A knob rather than a constant because it is tuned against real latency on real
   * devices, and the honest answer differs between a metro on 5G and a district town
   * on 3G. The MIN and MAX a client may request are a contract; this is the default
   * inside them.
   */
  COMMUNITY_FEED_PAGE_SIZE: z.coerce.number().int().positive().default(20),

  /**
   * How long an account must exist before it may ASK a question.
   *
   * The trust ladder's cheapest rung and the one that removes most spam: replying is
   * open immediately, starting a thread is not. Tunable because the right number is
   * whatever the spam actually forces, and discovering that must not need a deploy.
   */
  COMMUNITY_TRUST_ASK_AFTER_HOURS: z.coerce.number().int().nonnegative().default(24),

  /*
   * Intermediary obligations under the IT Rules 2021: acknowledge a grievance within
   * 24 hours, resolve within 15 days. Configuration rather than constants because
   * these are legal windows set outside this codebase — if they change, they must
   * change without a release, and a shorter internal target must be settable too.
   */
  /**
   * How long a seat is held while someone pays for it.
   *
   * The same shape as a slot hold, and for the same reason: the seat must not be
   * sellable twice while a payment is in flight, and it must not be lost for ever if
   * the payment is abandoned. Swept by Redis TTL rather than by a job.
   */
  /**
   * How far back the purohit dashboard looks for demand, in days.
   *
   * Recent bookings are the only forward-looking signal available: upcoming ones are
   * already allocated, so they are not opportunity. Ninety days is long enough to
   * survive a quiet fortnight and short enough that a neighbourhood which stopped
   * booking drops out. A knob because the right window is whatever the data says.
   */
  PUROHIT_DEMAND_WINDOW_DAYS: z.coerce.number().int().positive().default(90),

  COMMUNITY_HOLD_TTL_SECONDS: z.coerce.number().int().positive().default(600),

  /**
   * How far to overbook a FREE session, in basis points. 12000 = 1.2x.
   *
   * Free RSVP events no-show at 40-60%. An event that shows "full" and then runs
   * half empty teaches a host that the platform does not work, which costs more than
   * the occasional over-attendance it prevents. Never applied to a paid session,
   * where a seat someone bought must exist.
   */
  COMMUNITY_FREE_EVENT_OVERBOOK_BPS: z.coerce.number().int().min(10000).default(12000),

  COMMUNITY_GRIEVANCE_ACK_HOURS: z.coerce.number().int().positive().default(24),
  COMMUNITY_GRIEVANCE_RESOLVE_DAYS: z.coerce.number().int().positive().default(15),

  /**
   * Dev only. Returns the OTP in the response so you can log in without an SMS.
   *
   * NOT z.coerce.boolean(): that is Boolean(value), so the string "false" coerces to
   * TRUE. On a flag that disables an authentication control, that is exactly the kind
   * of quiet inversion you never notice until it matters.
   */
  /**
   * Whether this deployment can take money online.
   *
   * TRUE BY DEFAULT, and parsed the same careful way as `OTP_DEV_BYPASS` below —
   * NOT `z.coerce.boolean()`, which is `Boolean(value)` and so turns the string
   * "false" into TRUE. On a flag that decides whether anybody is charged, that
   * inversion would mean a deployment meaning to run free pilots silently
   * demanding money, or the reverse. Either is the kind of quiet wrong nobody
   * notices until it is in somebody's bank statement.
   *
   * Setting this false puts the product in CASH-ONLY mode: no token is charged, a
   * booking confirms on submission, and the devotee pays the purohit in full on
   * the day. See `computePrice` for the revenue consequence — in this mode the
   * platform fee is not collected and no due is recorded for it.
   */
  PAYMENTS_ENABLED: z
    .union([z.boolean(), z.string()])
    .default(true)
    .transform((v) => (typeof v === 'boolean' ? v : !['0', 'false', 'no', 'off'].includes(v.trim().toLowerCase()))),

  OTP_DEV_BYPASS: z
    .union([z.boolean(), z.string()])
    .default(false)
    .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase()))),
});

export type Config = z.infer<typeof Env> & {
  isProd: boolean;
  /**
   * Can a phone OTP actually REACH anybody?
   *
   * Derived rather than configured, because it is a consequence of three unrelated
   * settings and every caller that re-derived it would get it subtly wrong. True
   * when a BSP or MSG91 is wired up, or when the dev bypass is on — in which case
   * the code comes back in the API response and the devotee needs no message at all.
   *
   * THIS IS THE FACT THE LOGIN SCREEN NEEDS. Phone OTP is its default tab, so
   * without this a deployment with no messaging provider greets every visitor with
   * the one door that cannot open, while email and password — which depend on
   * nothing but the database — sit behind a tab nobody clicks.
   */
  otpLoginAvailable: boolean;
};

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment:\n${issues.join('\n')}`);
  }
  const cfg = parsed.data;
  if (cfg.NODE_ENV === 'production') {
    /*
     * THE PLACEHOLDER SECRETS MUST NOT REACH PRODUCTION.
     *
     * `min(32)` is a length check, and `.env.example` ships
     * `change-me-32-chars-minimum-please!!` — 35 characters, so it passes. Those
     * values are in the repository, which means they are public: anyone who can
     * read it can forge an access token for any user id and any role, including
     * `admin`. There is no exploit to write; it is a `jwt.sign` call.
     *
     * Checked by prefix rather than by exact value so a half-hearted edit
     * ("change-me-32-chars-minimum-please!!!") is caught too.
     */
    const placeholder = (['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'] as const)
      .filter((k) => cfg[k].toLowerCase().startsWith('change-me'));
    if (placeholder.length) {
      throw new Error(
        `refusing to start with the example JWT secret from .env.example — it is in `
        + `the repository, so anyone can forge a token for any account: `
        + `${placeholder.join(', ')}`,
      );
    }

    /*
     * REDIS IS NOT OPTIONAL IN PRODUCTION, and its absence is silent.
     *
     * `app.module.ts` falls back to `MemoryKv` when `REDIS_URL` is unset — in a
     * single-process dev server that is correct and convenient. In production it
     * means per-process state for three things that are only meaningful when
     * shared:
     *
     * - Rate limits, including the OTP send limit. Per-process limits on more than
     *   one instance are no limits at all: the same caller simply lands on another
     *   machine.
     * - OTP codes. Issued on one instance, verified on another, and the verify
     *   fails — sign-in becomes a coin toss the moment you scale past one.
     * - Slot holds, which are what stop two devotees paying for one window.
     *
     * None of that fails loudly. It degrades into intermittent, unreproducible
     * nonsense, which is the worst shape for an on-call engineer.
     */
    if (!cfg.REDIS_URL) {
      throw new Error(
        'production requires REDIS_URL: without it rate limits, OTP codes and slot '
        + 'holds are per-process, which silently breaks sign-in and slot locking the '
        + 'moment there is more than one instance',
      );
    }
    // Fail at boot rather than discovering at the first booking that the app is
    // happily taking orders through a fake payment gateway.
    if (cfg.OTP_DEV_BYPASS) {
      throw new Error('OTP_DEV_BYPASS must never be enabled in production');
    }
    /*
     * Payment credentials are required only when payments are ON.
     *
     * A deployment running cash-only has no gateway to hold credentials for, and
     * demanding them would mean inventing fake ones — which is strictly worse,
     * because then the boot check passes and the REAL question (can this instance
     * charge anybody?) has no answer anywhere.
     */
    if (cfg.PAYMENTS_ENABLED) {
      const missing = (['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'] as const)
        .filter((k) => !cfg[k]);
      if (missing.length) {
        throw new Error(`production requires real payment credentials; missing: ${missing.join(', ')}`);
      }
    }

    /*
     * Same treatment for document storage.
     *
     * The in-memory store hands out `memory://` URLs and forgets everything on
     * restart. Booting production without a bucket would give every purohit an
     * upload that appears to succeed and a verification that can never happen — and
     * they would have handed over a photo of their Aadhaar card to find that out.
     */
    const storage = (['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'] as const)
      .filter((k) => !cfg[k]);
    if (storage.length) {
      throw new Error(`production requires document storage; missing: ${storage.join(', ')}`);
    }

    /*
     * And for messaging, now that sign-in depends on it.
     *
     * With no BSP configured the primary channel is `ConsoleChannel`, which
     * "delivers" by writing to the server log. That was survivable while nothing
     * sent a login code; it is not now. Booting production without a BSP would give
     * every visitor a six-digit prompt and send the six digits to a log file they
     * cannot read — sign-in would be broken for everyone, and the app would report
     * every message as sent.
     *
     * SMS is not required: it is the fallback, and WhatsApp is the market. It is
     * worth having, but its absence degrades delivery rather than breaking it.
     */
    /*
     * THIS CHECK USED TO BE WRONG ABOUT ITS OWN CONSEQUENCE.
     *
     * It refused to boot without a BSP on the grounds that "login codes go to the
     * server log and nobody can sign in". The first half is true; the second is
     * not, and has not been since email and password landed. `register` creates an
     * account and issues tokens with no OTP and no message, and `loginWithPassword`
     * needs nothing but the database — both verified against a running instance
     * with no provider configured at all.
     *
     * The real requirement is not "WhatsApp": it is that AT LEAST ONE door opens,
     * and that anyone who walks through it can get back in. Password sign-in always
     * works, so the door is never missing — but a forgotten password is
     * unrecoverable without a way to send a reset link, and the two ways to send
     * one are a messaging provider and email.
     *
     * So production requires one of the two, not specifically the one with a
     * fortnight of template approval in front of it. That turns a 1-2 week
     * procurement blocker into an afternoon's DNS records, and WhatsApp goes back
     * to being what it is — the right channel for notifications, not a gate on
     * anybody signing in.
     */
    const hasMessaging = Boolean(
      (cfg.WHATSAPP_API_URL && cfg.WHATSAPP_API_KEY) || cfg.MSG91_AUTH_KEY,
    );
    const hasEmail = Boolean(cfg.EMAIL_API_URL && cfg.EMAIL_API_KEY);
    if (!hasMessaging && !hasEmail) {
      throw new Error(
        'production needs a way to reach people: configure a messaging provider '
        + '(WHATSAPP_API_URL + WHATSAPP_API_KEY, or MSG91_AUTH_KEY) for phone OTP, '
        + 'or email (EMAIL_API_URL + EMAIL_API_KEY) so a forgotten password can be '
        + 'reset. Email-and-password sign-in works without either, but nobody '
        + 'locked out could ever get back in.',
      );
    }
  }
  const otpLoginAvailable = Boolean(
    cfg.OTP_DEV_BYPASS
    || (cfg.WHATSAPP_API_URL && cfg.WHATSAPP_API_KEY)
    || cfg.MSG91_AUTH_KEY,
  );
  return { ...cfg, isProd: cfg.NODE_ENV === 'production', otpLoginAvailable };
}
