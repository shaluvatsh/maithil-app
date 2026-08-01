import { ulid } from 'ulid';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { users, cities } from '../../db/schema/index';
import type { Config } from '../../common/config';
import type { OtpService } from './otp.service';
import {
  normalisePhone, DomainError, ErrorCode,
  type UserRole, type MeResponse,
} from '@themaithil/contracts';

export interface JwtClaims { sub: string; role: UserRole; typ: 'access' | 'refresh' }

export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly otp: OtpService,
    private readonly config: Config,
  ) {}

  async requestOtp(rawPhone: string) {
    const phone = normalisePhone(rawPhone);
    const requestId = ulid();
    const { otp, expiresInSec } = await this.otp.issue(phone, requestId);

    // TODO(P1-8): hand off to the WhatsApp BSP with SMS fallback. Until BSP template
    // approval lands (1-2 weeks, see P0-0) dev bypass is the only delivery channel.
    return {
      requestId,
      expiresInSec,
      ...(this.config.OTP_DEV_BYPASS ? { devOtp: otp } : {}),
    };
  }

  async verifyOtp(args: { requestId: string; phone: string; otp: string; role?: UserRole }) {
    const phone = normalisePhone(args.phone);
    await this.otp.verify(args.requestId, phone, args.otp);

    const existing = await this.db.select().from(users).where(eq(users.phone, phone)).limit(1);
    let user = existing[0];
    let isNew = false;

    if (!user) {
      const city = await this.db.select({ id: cities.id }).from(cities)
        .where(eq(cities.slug, this.config.LAUNCH_CITY_SLUG)).limit(1);

      const inserted = await this.db.insert(users).values({
        id: ulid(),
        phone,
        role: args.role ?? 'devotee',
        locale: 'bn',
        cityId: city[0]?.id ?? null,
        referralCode: ulid().slice(-8).toUpperCase(),
        // panjikaSchool deliberately left NULL: we ask "which panjika does your
        // family follow?" during onboarding rather than guessing. See ADR 0003.
      }).returning();
      user = inserted[0]!;
      isNew = true;
    }

    if (user.deletedAt) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'this account has been deleted');
    }

    return { tokens: this.issueTokens(user.id, user.role), user: this.toMe(user, isNew) };
  }

  issueTokens(userId: string, role: UserRole) {
    const access = jwt.sign(
      { sub: userId, role, typ: 'access' } satisfies JwtClaims,
      this.config.JWT_ACCESS_SECRET,
      { expiresIn: this.config.JWT_ACCESS_TTL } as jwt.SignOptions,
    );
    const refresh = jwt.sign(
      { sub: userId, role, typ: 'refresh' } satisfies JwtClaims,
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
      throw new DomainError(ErrorCode.FORBIDDEN, 'invalid or expired token');
    }
  }

  async refresh(token: string) {
    let claims: JwtClaims;
    try {
      claims = jwt.verify(token, this.config.JWT_REFRESH_SECRET) as JwtClaims;
      if (claims.typ !== 'refresh') throw new Error('wrong token type');
    } catch {
      throw new DomainError(ErrorCode.FORBIDDEN, 'invalid or expired refresh token');
    }
    const rows = await this.db.select().from(users).where(eq(users.id, claims.sub)).limit(1);
    const user = rows[0];
    if (!user || user.deletedAt) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'account is no longer active');
    }
    return this.issueTokens(user.id, user.role);
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
