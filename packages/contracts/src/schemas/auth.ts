import { z } from 'zod';
import { UserRole, Locale, PanjikaSchool } from '../enums.js';
import { Ulid } from '../ids.js';

export const RequestOtpBody = z.object({
  phone: z.string().min(10).max(15),
  role: UserRole.exclude(['admin', 'ops']).default('devotee'),
});
export const RequestOtpResponse = z.object({
  requestId: z.string(),
  expiresInSec: z.number().int(),
  /** Only ever populated when OTP_DEV_BYPASS is on. Never in production. */
  devOtp: z.string().optional(),
});

export const VerifyOtpBody = z.object({
  requestId: z.string(),
  phone: z.string().min(10).max(15),
  otp: z.string().regex(/^\d{6}$/),
  /**
   * Where this account is. Optional, defaulting server-side to the launch city.
   *
   * Every new account — devotee and purohit alike — was assigned `LAUNCH_CITY_SLUG`
   * unconditionally, and nothing anywhere asked. For a devotee that made the city
   * picker cosmetic; for a purohit it was worse, because `matchPandit` joins on
   * `users.city_id`, so a purohit signing up in Mumbai landed in Kolkata's pool and
   * no Mumbai booking could ever reach them. Supply could not be built anywhere
   * except the one city a constant named.
   *
   * A slug rather than an id: the client already knows the slug from the region
   * config and never sees city ids. An unknown one is rejected by the service.
   */
  citySlug: z.string().min(2).max(40).optional(),
  /**
   * Which side of the marketplace this account is being created for.
   *
   * `verifyOtp` has always accepted a role and this schema never carried it, so
   * validation stripped it and every OTP signup defaulted to `devotee`. Phone OTP
   * is the DEFAULT tab on the login screen and the likeliest route for the purohit
   * persona (ADR 0009), so a purohit arriving through "For Pandits" was silently
   * made a devotee — with no way back, since nothing in the product changes a
   * role afterwards.
   *
   * Deliberately narrowed to the two public roles: `UserRole` also contains
   * `admin` and `ops`, and this is an unauthenticated endpoint. Self-selecting
   * `pandit` grants nothing on its own — a purohit is invisible to devotees until
   * an admin verifies their KYC (ADR 0010).
   *
   * Ignored entirely when the account already exists; it cannot escalate anyone.
   */
  role: z.enum(['devotee', 'pandit']).optional(),
});

export const RequestPasswordResetBody = z.object({
  email: z.string().email(),
});
export const RequestPasswordResetResponse = z.object({
  /**
   * Always `true` — see `AuthService.requestPasswordReset`. Whether the email
   * belongs to an account is never observable from this response; a client
   * cannot use it, or a timing or shape difference in it, to enumerate accounts.
   */
  ok: z.literal(true),
  /** Only ever populated when OTP_DEV_BYPASS is on, mirroring `devOtp` above. */
  devResetUrl: z.string().optional(),
});

export const ConfirmPasswordResetBody = z.object({
  token: z.string().min(20),
  password: z.string().min(8).max(200),
});

export const AuthTokens = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresInSec: z.number().int(),
});

export const MeResponse = z.object({
  id: Ulid,
  phone: z.string(),
  name: z.string().nullable(),
  role: UserRole,
  locale: Locale,
  /** Snapshotted onto every booking so a later change never rewrites history. */
  panjikaSchool: PanjikaSchool.nullable(),
  isNew: z.boolean(),
});

export type RequestOtpBody = z.infer<typeof RequestOtpBody>;
export type VerifyOtpBody = z.infer<typeof VerifyOtpBody>;
export type RequestPasswordResetBody = z.infer<typeof RequestPasswordResetBody>;
export type ConfirmPasswordResetBody = z.infer<typeof ConfirmPasswordResetBody>;
export type AuthTokens = z.infer<typeof AuthTokens>;
export type MeResponse = z.infer<typeof MeResponse>;
