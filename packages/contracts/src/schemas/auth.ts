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
export type AuthTokens = z.infer<typeof AuthTokens>;
export type MeResponse = z.infer<typeof MeResponse>;
