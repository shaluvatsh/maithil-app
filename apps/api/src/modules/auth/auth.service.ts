import { ulid } from 'ulid';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { users, cities, panditProfiles } from '../../db/schema/index';
import { sql } from 'drizzle-orm';
import { hashPassword, verifyPassword, passwordProblem } from './password';
import type { Config } from '../../common/config';
import type { OtpService } from './otp.service';
import type { PasswordResetService } from './password-reset.service';
import type { NotificationService } from '../notifications/notifications.service';
import type { EmailChannel } from '../notifications/email-channel';
import {
  normalisePhone, DomainError, ErrorCode,
  type UserRole, type MeResponse,
} from '@themaithil/contracts';

export interface JwtClaims {
  sub: string;
  role: UserRole;
  typ: 'access' | 'refresh';
  /**
   * The account's `token_version` when this token was minted.
   *
   * Optional because tokens issued before this existed have no `tv` and must keep
   * working until they expire — a deploy that signed every open session out would
   * be a self-inflicted outage. They are compared with `?? 0`, which is the column
   * default, so an old token stays valid exactly until someone bumps the counter.
   */
  tv?: number;
}

export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly otp: OtpService,
    private readonly config: Config,
    private readonly notify: NotificationService,
    private readonly passwordReset: PasswordResetService,
    private readonly mail: EmailChannel,
  ) {}

  async requestOtp(rawPhone: string) {
    const phone = normalisePhone(rawPhone);
    const requestId = ulid();
    const { otp, expiresInSec } = await this.otp.issue(phone, requestId);

    /*
     * Nothing ever sent this. The code was generated, hashed into Redis and then
     * returned to the caller only under `OTP_DEV_BYPASS` — so outside development
     * every login ended at a screen asking for six digits that had been delivered
     * nowhere. Sign-in was the first thing a real user would do and the first thing
     * that could not work.
     *
     * `sendToPhone`, not `send`: at signup there is no account to look up yet.
     *
     * The locale is the launch default rather than a preference we do not have —
     * the person is not signed in, so there is nothing to read one from. The
     * template falls back to Bengali per ADR 0009.
     *
     * Deliberately NOT awaited-and-thrown: a BSP outage must not take sign-in down
     * with it. The failure is recorded in `notifications` for ops to chase, and the
     * devotee sees the same "we sent you a code" they always would — they can
     * resend, and the fallback channel has already been tried by this point.
     */
    const delivery = await this.notify.sendToPhone({
      phone,
      templateKey: 'auth.otp',
      variables: { otp, minutes: String(Math.round(expiresInSec / 60)) },
      locale: 'bn',
    });

    return {
      requestId,
      expiresInSec,
      /**
       * Whether the code actually went out. The screen can then say "we could not
       * send it, try again" instead of leaving someone waiting for a message that
       * failed.
       */
      delivered: delivery.status === 'sent',
      ...(this.config.OTP_DEV_BYPASS ? { devOtp: otp } : {}),
    };
  }

  /**
   * The city a new account belongs to.
   *
   * Both signup paths used to read `LAUNCH_CITY_SLUG` directly, so every account in
   * the product was created in one city whatever the person had chosen. That is
   * merely cosmetic for a devotee — the booking's city comes from its address — but
   * it is structural for a purohit: `matchPandit` joins candidates on
   * `users.city_id`, so a purohit who signed up in Mumbai joined Kolkata's pool and
   * became unreachable by every Mumbai booking. Supply could only ever accumulate
   * in the launch city.
   *
   * An unrecognised slug is refused rather than quietly falling back. Silently
   * filing someone in the wrong city is the exact failure this replaces, and a
   * typo'd slug from a client is not a reason to repeat it.
   */
  private async cityIdFor(slug?: string): Promise<string | null> {
    const wanted = slug?.trim().toLowerCase();
    const rows = await this.db.select({ id: cities.id }).from(cities)
      .where(eq(cities.slug, wanted ?? this.config.LAUNCH_CITY_SLUG)).limit(1);

    if (!rows[0] && wanted) {
      throw new DomainError(ErrorCode.NOT_FOUND, `we do not serve ${wanted} yet`);
    }
    return rows[0]?.id ?? null;
  }

  /**
   * `role` is narrowed to the two PUBLIC roles, not `UserRole`.
   *
   * This is an unauthenticated endpoint; accepting the full enum would let a caller
   * hand themselves `admin` or `ops` simply by asking. It only ever applies to a
   * brand-new account, so it cannot escalate an existing one either.
   */
  async verifyOtp(args: {
    requestId: string; phone: string; otp: string;
    role?: 'devotee' | 'pandit' | undefined;
    /** Where they are. Only ever applies to a brand-new account. */
    citySlug?: string | undefined;
  }) {
    const phone = normalisePhone(args.phone);
    await this.otp.verify(args.requestId, phone, args.otp);

    const existing = await this.db.select().from(users).where(eq(users.phone, phone)).limit(1);
    let user = existing[0];
    let isNew = false;

    if (!user) {
      const cityId = await this.cityIdFor(args.citySlug);

      const inserted = await this.db.insert(users).values({
        id: ulid(),
        phone,
        role: args.role ?? 'devotee',
        locale: 'bn',
        cityId,
        referralCode: ulid().slice(-8).toUpperCase(),
        // panjikaSchool deliberately left NULL: we ask "which panjika does your
        // family follow?" during onboarding rather than guessing. See ADR 0003.
      }).returning();
      user = inserted[0]!;
      isNew = true;

      /**
       * A purohit needs a profile row before anything else works — search joins it,
       * pricing reads it, the setup wizard writes to it and the verification queue
       * is a view over it. `register()` has always created one; this path could not,
       * because the role never reached it, so the omission was invisible. It is not
       * once a purohit can sign up by phone, which is the likelier route for them.
       *
       * `kyc_status: 'pending'` deliberately: signing up does not make anyone
       * bookable. A human checks their documents first (ADR 0010).
       */
      if (user.role === 'pandit') {
        await this.db.insert(panditProfiles).values({
          userId: user.id,
          kycStatus: 'pending',
          cashJobsEnabled: false,
        }).onConflictDoNothing();
      }
    }

    if (user.deletedAt) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'this account has been deleted');
    }

    return {
      tokens: this.issueTokens(user.id, user.role, user.tokenVersion),
      user: this.toMe(user, isNew),
    };
  }

  issueTokens(userId: string, role: UserRole, tokenVersion = 0) {
    const access = jwt.sign(
      { sub: userId, role, typ: 'access', tv: tokenVersion } satisfies JwtClaims,
      this.config.JWT_ACCESS_SECRET,
      { expiresIn: this.config.JWT_ACCESS_TTL } as jwt.SignOptions,
    );
    const refresh = jwt.sign(
      { sub: userId, role, typ: 'refresh', tv: tokenVersion } satisfies JwtClaims,
      this.config.JWT_REFRESH_SECRET,
      { expiresIn: this.config.JWT_REFRESH_TTL } as jwt.SignOptions,
    );
    return { accessToken: access, refreshToken: refresh, expiresInSec: 15 * 60 };
  }

  verifyAccess(token: string): JwtClaims {
    try {
      const claims = jwt.verify(token, this.config.JWT_ACCESS_SECRET) as JwtClaims;
      if (claims.typ !== 'access') throw new Error('wrong token type');
      return claims;
    } catch {
      /*
       * UNAUTHENTICATED (401), not FORBIDDEN (403).
       *
       * This is the normal state of affairs fifteen minutes after signing in, and the
       * client's whole refresh-and-replay path hangs off the status code. As a 403 it
       * was indistinguishable from "not yours", so nothing ever refreshed.
       */
      throw new DomainError(ErrorCode.UNAUTHENTICATED, 'invalid or expired token');
    }
  }

  async refresh(token: string) {
    let claims: JwtClaims;
    try {
      claims = jwt.verify(token, this.config.JWT_REFRESH_SECRET) as JwtClaims;
      if (claims.typ !== 'refresh') throw new Error('wrong token type');
    } catch {
      throw new DomainError(ErrorCode.UNAUTHENTICATED, 'invalid or expired refresh token');
    }
    const rows = await this.db.select().from(users).where(eq(users.id, claims.sub)).limit(1);
    const user = rows[0];
    if (!user || user.deletedAt) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'account is no longer active');
    }
    /*
     * WHERE REVOCATION IS ENFORCED, and deliberately not in `verifyAccess`.
     *
     * `verifyAccess` runs on every authenticated request and is synchronous by
     * design — it touches no database. Checking a version there would put a query
     * on the hot path of the entire API to close a window that is already only
     * fifteen minutes wide.
     *
     * So the long-lived half is what carries the check. Refresh tokens live 30
     * days; access tokens live 15 minutes and cannot be refreshed once the version
     * moves. Bumping the counter therefore ends every session within one access
     * TTL, without costing anything per request.
     *
     * BE PRECISE ABOUT WHAT THIS DOES NOT DO: it is not instant. An attacker
     * holding a stolen ACCESS token keeps it for up to fifteen more minutes after
     * a password change. Closing that fully means either a per-request lookup or a
     * much shorter access TTL, and neither is worth it for a fifteen-minute window
     * against a thirty-day one.
     */
    if ((claims.tv ?? 0) !== user.tokenVersion) {
      throw new DomainError(
        ErrorCode.UNAUTHENTICATED,
        'this session has ended; please sign in again',
      );
    }
    return this.issueTokens(user.id, user.role, user.tokenVersion);
  }

  /**
   * End every session for an account.
   *
   * Used by "sign out of all devices" and, automatically, by any password change —
   * because changing a password is the action someone takes when they think the
   * account is compromised, and leaving the attacker's thirty-day refresh token
   * working would make it theatre.
   */
  async revokeSessions(userId: string): Promise<number> {
    const [row] = await this.db.update(users)
      .set({ tokenVersion: sql`${users.tokenVersion} + 1` })
      .where(eq(users.id, userId))
      .returning({ tokenVersion: users.tokenVersion });
    return row?.tokenVersion ?? 0;
  }

  // ---------------------------------------------------------------- email --
  /**
   * Register with email and password.
   *
   * A phone number is still required: it is how the purohit reaches the devotee and
   * how completion OTPs are delivered. Email is a second door into the same account,
   * not a parallel identity.
   *
   * WHAT THIS DELIBERATELY NO LONGER DOES.
   *
   * It used to "attach" the submitted password to an existing OTP-only account
   * whenever the phone matched, and hand back live tokens for it. Nothing in the
   * request proved the caller owned that number, so knowing a devotee's phone —
   * printed on any booking, or simply guessed — was enough to take their account:
   * post it with your own email and a password of your choosing and the API
   * authenticated you as them.
   *
   * Attaching a password to an existing account is a legitimate thing to want, and
   * the product already has a way to prove you own a number: the OTP. So that path
   * moved to `setPassword`, behind an access token, and this endpoint now only ever
   * creates genuinely new accounts.
   */
  async register(args: {
    name: string; email: string; phone: string; password: string;
    role?: 'devotee' | 'pandit';
    citySlug?: string | undefined;
  }) {
    const problem = passwordProblem(args.password);
    // WEAK_PASSWORD (422), not FORBIDDEN (403) - a client switching on `code` (the
    // whole point of a closed error-code set, per http-errors.ts) could not tell
    // this apart from "you are not allowed to register at all."
    if (problem) throw new DomainError(ErrorCode.WEAK_PASSWORD, problem);

    const email = args.email.trim().toLowerCase();
    const phone = normalisePhone(args.phone);

    const byEmail = await this.db.select().from(users)
      .where(sql`lower(${users.email}) = ${email}`).limit(1);
    if (byEmail[0]?.passwordHash) {
      throw new DomainError(ErrorCode.ACCOUNT_EXISTS, 'An account with this email already exists');
    }

    const passwordHash = await hashPassword(args.password);
    const existing = (await this.db.select().from(users)
      .where(eq(users.phone, phone)).limit(1))[0] ?? byEmail[0];

    /*
     * One message for both cases, on purpose. "That number already has a password"
     * versus "that number exists but has no password" tells an enumerating caller
     * which numbers are registered and how, which is exactly what they want to know.
     */
    if (existing) {
      throw new DomainError(
        ErrorCode.ACCOUNT_EXISTS,
        'An account with this number already exists. Sign in with the code we send '
        + 'to your phone, then add a password from your account.',
      );
    }

    const cityId = await this.cityIdFor(args.citySlug);

    const role = args.role ?? 'devotee';
    const created = (await this.db.insert(users).values({
      id: ulid(), phone, email, passwordHash, name: args.name,
      role, locale: 'en', cityId,
      referralCode: ulid().slice(-8).toUpperCase(),
    }).returning())[0]!;

    /**
     * A purohit needs a profile row before anything else works — search joins it,
     * pricing reads it, and the verification queue is a view over it. Created here
     * at `kyc_status: 'pending'`, which is what puts them in front of an admin.
     */
    if (role === 'pandit') {
      await this.db.insert(panditProfiles).values({
        userId: created.id,
        // Deliberately NOT verified. Onboarding fills the rest in; a human decides.
        kycStatus: 'pending',
        cashJobsEnabled: false,
      }).onConflictDoNothing();
    }

    return {
      tokens: this.issueTokens(created.id, created.role, created.tokenVersion),
      user: this.toMe(created, true),
    };
  }

  async loginWithPassword(args: { email: string; password: string }) {
    const email = args.email.trim().toLowerCase();
    const user = (await this.db.select().from(users)
      .where(sql`lower(${users.email}) = ${email}`).limit(1))[0];

    // One message for both "no such account" and "wrong password", and the hash is
    // still computed when the user is missing - otherwise response timing tells an
    // attacker which emails are registered.
    const stored = user?.passwordHash
      ?? 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAA==';
    const ok = await verifyPassword(args.password, stored);

    if (!user || !user.passwordHash || !ok) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'Incorrect email or password');
    }
    if (user.deletedAt) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'This account has been deleted');
    }
    return {
      tokens: this.issueTokens(user.id, user.role, user.tokenVersion),
      user: this.toMe(user, false),
    };
  }

  /**
   * Sets or replaces the caller's own password.
   *
   * This is the safe half of what `register()` used to do implicitly. The caller
   * holds an access token, which they can only have obtained by completing an OTP
   * challenge on their own number or by knowing an existing password — so ownership
   * is already proven before this runs, which is exactly what registration could not
   * establish.
   *
   * Replacing an existing password requires the current one. Without that check, a
   * borrowed or stolen access token could be upgraded into permanent credentials;
   * with it, the 15-minute token expires and the account is still theirs.
   */
  async setPassword(args: {
    userId: string; password: string; currentPassword?: string | undefined;
  }) {
    const problem = passwordProblem(args.password);
    if (problem) throw new DomainError(ErrorCode.WEAK_PASSWORD, problem);

    const user = (await this.db.select().from(users)
      .where(eq(users.id, args.userId)).limit(1))[0];
    if (!user || user.deletedAt) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'account is no longer active');
    }

    if (user.passwordHash) {
      const ok = args.currentPassword
        ? await verifyPassword(args.currentPassword, user.passwordHash)
        : false;
      if (!ok) {
        throw new DomainError(ErrorCode.FORBIDDEN, 'Your current password is incorrect');
      }
    }

    await this.db.update(users)
      .set({ passwordHash: await hashPassword(args.password) })
      .where(eq(users.id, args.userId));

    /*
     * EVERY OTHER SESSION ENDS HERE.
     *
     * Changing a password is the action someone takes when they believe the account
     * is compromised. Leaving the attacker's thirty-day refresh token working would
     * make the whole gesture theatre — they would still be signed in tomorrow.
     *
     * The caller is handed a fresh pair carrying the new version, so the one device
     * that just proved it knows the current password is the one that stays in. Every
     * other refresh token is now a version behind and dies at its next refresh,
     * which is within one access TTL.
     */
    const tokenVersion = await this.revokeSessions(args.userId);
    return { ok: true as const, tokens: this.issueTokens(args.userId, user.role, tokenVersion) };
  }

  /**
   * Starts a password reset. Returns the SAME shape whether or not the email
   * belongs to an account — see `loginWithPassword`'s own "one message for both
   * cases" and `register()`'s, for the identical reasoning applied here. An
   * endpoint that answers differently for a registered and an unregistered email
   * is an account-existence oracle wearing a "forgot password" label.
   */
  async requestPasswordReset(rawEmail: string) {
    const email = rawEmail.trim().toLowerCase();
    // Counted before the lookup below, and unconditionally — see
    // `PasswordResetService.checkRate`'s own comment on why.
    await this.passwordReset.checkRate(email);

    const user = (await this.db.select().from(users)
      .where(sql`lower(${users.email}) = ${email}`).limit(1))[0];

    let devResetUrl: string | undefined;
    // An OTP-only account has no password to reset, so there is nothing to send —
    // and saying so would be exactly the oracle this method exists to avoid.
    if (user?.passwordHash) {
      const token = await this.passwordReset.issue(user.id);
      const resetUrl = `${this.config.WEB_BASE_URL ?? ''}/reset-password?token=${token}`;
      try {
        await this.mail.send({
          to: email,
          subject: 'Reset your TheMaithil password',
          body: `We received a request to reset your TheMaithil password.\n\n`
            + `Open this link within 30 minutes to choose a new one:\n${resetUrl}\n\n`
            + `If you did not ask for this, you can ignore this email — your `
            + `password will not change.`,
        });
      } catch {
        /*
         * Swallowed on purpose, matching `requestOtp`'s own "a provider outage
         * must not take sign-in down with it". There is no SMS-style fallback
         * channel for email, so the best this can do on a provider failure is
         * what it would do for an unregistered address anyway: say the same
         * thing and let them try again or use phone OTP instead.
         */
      }
      if (this.config.OTP_DEV_BYPASS) devResetUrl = resetUrl;
    }

    return { ok: true as const, ...(devResetUrl ? { devResetUrl } : {}) };
  }

  /**
   * Finishes a reset: a valid token proves the caller controls the account's
   * email the same way a verified OTP proves they control the phone, so this
   * needs no current password — unlike `setPassword`, which is reached with an
   * ordinary session and therefore does require one.
   */
  async confirmPasswordReset(args: { token: string; password: string }) {
    const problem = passwordProblem(args.password);
    if (problem) throw new DomainError(ErrorCode.WEAK_PASSWORD, problem);

    // Consumed BEFORE the existence check, not after: a token is single-use the
    // moment it is spent, whether or not the account it names turns out to still
    // be active. Checking first would let the same token be retried once for
    // each reason it could fail.
    const userId = await this.passwordReset.consume(args.token);

    const user = (await this.db.select().from(users).where(eq(users.id, userId)).limit(1))[0];
    if (!user || user.deletedAt) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'account is no longer active');
    }

    await this.db.update(users)
      .set({ passwordHash: await hashPassword(args.password) })
      .where(eq(users.id, userId));

    /*
     * And here especially. Someone resetting a forgotten password is the case where
     * an attacker is most likely to already hold a session — the reset is often the
     * response to noticing one. No tokens are returned: unlike `setPassword` there
     * is no caller session to preserve, and they sign in with the new password.
     */
    await this.revokeSessions(userId);
    return { ok: true as const };
  }

  async me(userId: string): Promise<MeResponse> {
    const rows = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!rows[0]) throw new DomainError(ErrorCode.NOT_FOUND, 'user not found');
    return this.toMe(rows[0], false);
  }

  private toMe(u: typeof users.$inferSelect, isNew: boolean): MeResponse {
    return {
      id: u.id, phone: u.phone, name: u.name, role: u.role,
      locale: u.locale, panjikaSchool: u.panjikaSchool, isNew,
    };
  }
}
