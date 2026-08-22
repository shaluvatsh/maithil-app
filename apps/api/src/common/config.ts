import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().optional(),

  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),

  // Payments. Absent in development, in which case a fake gateway is used and the
  // app refuses to start in production - see the check below.
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

  LAUNCH_CITY_SLUG: z.string().default('kolkata'),
  /**
   * ONE constant for both the availability and panchang materialisation jobs.
   * The original design used 60 and 90 respectively, which left a month where a
   * devotee could see an auspicious date on the panchang tab and then find no
   * bookable slots on it - not because none were free, but because the rows did
   * not exist.
   */
  BOOKING_HORIZON_DAYS: z.coerce.number().int().default(120),

  /**
   * Dev only. Returns the OTP in the response so you can log in without an SMS.
   *
   * NOT z.coerce.boolean(): that is Boolean(value), so the string "false" coerces to
   * TRUE. On a flag that disables an authentication control, that is exactly the kind
   * of quiet inversion you never notice until it matters.
   */
  OTP_DEV_BYPASS: z
    .union([z.boolean(), z.string()])
    .default(false)
    .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase()))),
});

export type Config = z.infer<typeof Env> & { isProd: boolean };

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment:\n${issues.join('\n')}`);
  }
  const cfg = parsed.data;
  if (cfg.NODE_ENV === 'production') {
    // Fail at boot rather than discovering at the first booking that the app is
    // happily taking orders through a fake payment gateway.
    if (cfg.OTP_DEV_BYPASS) {
      throw new Error('OTP_DEV_BYPASS must never be enabled in production');
    }
    const missing = (['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'] as const)
      .filter((k) => !cfg[k]);
    if (missing.length) {
      throw new Error(`production requires real payment credentials; missing: ${missing.join(', ')}`);
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
  }
  return { ...cfg, isProd: cfg.NODE_ENV === 'production' };
}
