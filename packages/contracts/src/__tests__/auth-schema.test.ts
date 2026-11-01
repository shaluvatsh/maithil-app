import { describe, it, expect } from 'vitest';
import { VerifyOtpBody } from '../schemas/auth.js';

const base = { requestId: '01J0000000000000000000000A', phone: '+919830000001', otp: '123456' };

/**
 * The schema is where this broke, and it broke silently.
 *
 * `verifyOtp` had always accepted a `role` for a new account, but `VerifyOtpBody`
 * did not declare one, so zod stripped it before the service ever saw it. Nothing
 * errored — the field simply evaporated, and every phone signup became a devotee.
 * A service-level test cannot catch this; it bypasses validation entirely.
 */
describe('VerifyOtpBody carries the signup role', () => {
  it('keeps a pandit role instead of stripping it', () => {
    expect(VerifyOtpBody.parse({ ...base, role: 'pandit' }).role).toBe('pandit');
  });

  it('keeps a devotee role', () => {
    expect(VerifyOtpBody.parse({ ...base, role: 'devotee' }).role).toBe('devotee');
  });

  it('stays optional, so existing sign-ins are unaffected', () => {
    expect(VerifyOtpBody.parse(base).role).toBeUndefined();
  });

  /**
   * This endpoint is unauthenticated. Accepting the full `UserRole` enum would let
   * anyone hand themselves `admin` or `ops` by typing it into the request, so the
   * schema admits only the two roles a member of the public may choose.
   */
  it('refuses a privileged role outright', () => {
    for (const role of ['admin', 'ops']) {
      expect(VerifyOtpBody.safeParse({ ...base, role }).success,
        `${role} was accepted from an unauthenticated request`).toBe(false);
    }
  });
});
