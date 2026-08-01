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

  LAUNCH_CITY_SLUG: z.string().default('kolkata'),
  /**
   * ONE constant for both the availability and panchang materialisation jobs.
   * The original design used 60 and 90 respectively, which left a month where a
   * devotee could see an auspicious date on the panchang tab and then find no
   * bookable slots on it - not because none were free, but because the rows did
   * not exist.
   */
  BOOKING_HORIZON_DAYS: z.coerce.number().int().default(120),

  /** Dev only. Returns the OTP in the response so you can log in without an SMS. */
  OTP_DEV_BYPASS: z.coerce.boolean().default(false),
});

export type Config = z.infer<typeof Env> & { isProd: boolean };

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment:\n${issues.join('\n')}`);
  }
  const cfg = parsed.data;
  if (cfg.NODE_ENV === 'production' && cfg.OTP_DEV_BYPASS) {
    throw new Error('OTP_DEV_BYPASS must never be enabled in production');
  }
  return { ...cfg, isProd: cfg.NODE_ENV === 'production' };
}
