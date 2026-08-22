import { Controller, Get, Post, Body, Inject } from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import { z } from 'zod';
import { ulid } from 'ulid';
import { DB } from '../../common/tokens';
import type { Db } from '../../db/client';
import { panditProfiles, kycRecords } from '../../db/schema/index';
import { CurrentUser, Roles } from '../auth/guards';
import type { JwtClaims } from '../auth/auth.service';
import { DomainError, ErrorCode } from '@themaithil/contracts';
import {
  type ObjectStore, documentKey, isAllowedDocType, ALLOWED_DOC_TYPES,
} from '../storage/object-store';

/**
 * Purohit identity verification.
 *
 * NOTHING EVER CREATED A KYC RECORD. `grep 'insert(kycRecords)'` returned nothing
 * across the whole repository. The table was designed in ADR 0010, the admin queue
 * counted documents per purohit — a count that could only ever render zero — and the
 * queue filtered on `kyc_status IN ('pending','submitted')` where `submitted` was
 * unreachable, because nothing could move a purohit into it. There was no upload
 * anywhere in the product.
 *
 * So an admin approved a purohit on the strength of a name and a self-declared
 * number of years. "Verified purohit" is the central claim on the home page of a
 * service that sends a stranger into a family's home for a religious ceremony, and
 * it meant an operator had clicked a button.
 *
 * WHAT IS STORED. Never a raw Aadhaar number — ADR 0010 calls this non-negotiable
 * and it is enforced here rather than left to a reviewer's discipline: the API
 * accepts four digits and rejects anything longer, so a full number cannot be
 * submitted even by a client that tries. The document image lives in object storage
 * under a key we hold, and is deleted 30 days after a decision.
 */

/**
 * Which documents we ask for.
 *
 * `demo` is a recording of the purohit performing — the credential that actually
 * distinguishes a purohit, and the one no government database holds. `credential`
 * is a paramparā or pathshala certificate.
 */
const DOC_KINDS = ['identity', 'bank', 'credential', 'demo'] as const;

const UploadUrlInput = z.object({
  kind: z.enum(DOC_KINDS),
  contentType: z.string().refine(isAllowedDocType, {
    message: `document must be one of ${ALLOWED_DOC_TYPES.join(', ')}`,
  }),
});

const AttachInput = z.object({
  kind: z.enum(DOC_KINDS),
  /** Returned by `upload-url`. Not a client-chosen path. */
  docKey: z.string().min(8).max(300),
  /**
   * The LAST FOUR DIGITS. Not the number.
   *
   * Exactly four, so a client sending a full Aadhaar or PAN is rejected by the
   * schema rather than relying on the caller to have truncated it. ADR 0010: "No
   * raw Aadhaar number is ever stored. Ever." A validator is how that survives
   * contact with a future contributor who has not read the ADR.
   */
  identifierLast4: z.string().regex(/^\d{4}$/, 'send only the last four digits').optional(),
});

@Controller('v1/me/purohit/kyc')
@Roles('pandit')
export class PurohitKycController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject('OBJECT_STORE') private readonly store: ObjectStore,
  ) {}

  /** What they have given us, and where they are in the process. */
  @Get()
  async status(@CurrentUser() user: JwtClaims) {
    const [profile] = await this.db
      .select({ status: panditProfiles.kycStatus, verifiedAt: panditProfiles.kycVerifiedAt })
      .from(panditProfiles).where(eq(panditProfiles.userId, user.sub)).limit(1);

    const docs = await this.db.select({
      id: kycRecords.id, kind: kycRecords.type, status: kycRecords.status,
      last4: kycRecords.identifierLast4, notes: kycRecords.reviewNotes,
      createdAt: kycRecords.createdAt,
    })
      .from(kycRecords).where(eq(kycRecords.panditId, user.sub))
      .orderBy(desc(kycRecords.createdAt));

    return {
      status: profile?.status ?? 'pending',
      verifiedAt: profile?.verifiedAt ?? null,
      documents: docs,
      /** The one thing that gates submission, so the UI never has to infer it. */
      hasIdentity: docs.some((d) => d.kind === 'identity'),
    };
  }

  /**
   * A signed URL to upload one document to.
   *
   * The bytes go from the purohit's browser straight to storage. Proxying a scan of
   * someone's identity document through this process would put it in our memory, in
   * our logs on failure, and on our bandwidth bill, and buy nothing.
   */
  @Post('upload-url')
  async uploadUrl(@CurrentUser() user: JwtClaims, @Body() body: unknown) {
    const input = UploadUrlInput.parse(body);

    const [profile] = await this.db.select({ status: panditProfiles.kycStatus })
      .from(panditProfiles).where(eq(panditProfiles.userId, user.sub)).limit(1);
    if (profile?.status === 'verified') {
      throw new DomainError(
        ErrorCode.INVALID_TRANSITION,
        'you are already verified — contact support if your documents have changed',
      );
    }

    // The key is ours, never the client's: a client-supplied path is a client that
    // can write over another purohit's document.
    return this.store.presignUpload({
      key: documentKey({
        panditId: user.sub, kind: input.kind, contentType: input.contentType,
      }),
      contentType: input.contentType,
    });
  }

  /**
   * Record that a document was uploaded.
   *
   * Separate from `upload-url` because the upload happens between the two and can
   * fail: signing a URL is not evidence that anything was stored. Only a client that
   * completed its PUT calls this.
   */
  @Post('documents')
  async attach(@CurrentUser() user: JwtClaims, @Body() body: unknown) {
    const input = AttachInput.parse(body);

    /*
     * The key must be one we issued for THIS purohit.
     *
     * `documentKey` namespaces by pandit id, so checking the prefix is what stops a
     * purohit attaching another purohit's document to their own record and inheriting
     * a verification they did not earn. Cheap check; the alternative is a stored
     * reference we cannot trust.
     */
    if (!input.docKey.startsWith(`kyc/${user.sub}/`)) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'that document key is not yours');
    }

    const id = ulid();
    await this.db.insert(kycRecords).values({
      id,
      panditId: user.sub,
      type: input.kind,
      status: 'pending',
      provider: 'manual',           // ADR 0010; becomes 'digilocker' with no migration
      docKey: input.docKey,
      ...(input.identifierLast4 ? { identifierLast4: input.identifierLast4 } : {}),
    });

    return { id, kind: input.kind };
  }

  /**
   * Hand the account to the review queue.
   *
   * `submitted` was an unreachable state: the admin queue has always filtered on
   * `IN ('pending','submitted')` and nothing could ever set the second. It matters
   * as a distinct state because `pending` means "has not started" and `submitted`
   * means "waiting on us" — an operator sorting a queue needs to tell those apart,
   * and a purohit refreshing their screen needs to know which one they are in.
   */
  @Post('submit')
  async submit(@CurrentUser() user: JwtClaims) {
    const [identity] = await this.db.select({ id: kycRecords.id })
      .from(kycRecords)
      .where(and(eq(kycRecords.panditId, user.sub), eq(kycRecords.type, 'identity')))
      .limit(1);

    if (!identity) {
      throw new DomainError(
        ErrorCode.KYC_INCOMPLETE,
        'upload a photo ID before submitting for review',
      );
    }

    const [profile] = await this.db.select({ status: panditProfiles.kycStatus })
      .from(panditProfiles).where(eq(panditProfiles.userId, user.sub)).limit(1);
    if (profile?.status === 'verified') return { status: 'verified' as const };

    await this.db.update(panditProfiles).set({ kycStatus: 'submitted' })
      .where(eq(panditProfiles.userId, user.sub));

    return { status: 'submitted' as const };
  }
}
