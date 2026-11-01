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
const DOC_KINDS = [
  'identity', 'address', 'pan', 'qualification', 'bank', 'credential', 'demo',
] as const;

/**
 * What a purohit must give us before we will review them at all.
 *
 * Verification used to require ONE document — a photo ID — and everything else was
 * optional. "Verified purohit" is the central claim on the home page of a service
 * that sends a stranger into a family's home, and it could mean an operator had
 * glanced at a single Aadhaar photo.
 *
 * `bank` is deliberately NOT here: payout details are collected on their own screen,
 * forwarded to the payment provider and never stored by us, and blocking review on
 * them would stop a purohit who has not got an IFSC to hand — see the setup wizard,
 * which makes the same call for the same reason.
 *
 * `credential` and `demo` stay optional: a paramparā letter and a recording are the
 * things that distinguish a purohit, not the things that identify one.
 */
const REQUIRED_DOCS = ['identity', 'address', 'pan', 'qualification'] as const;

/** What to call each one when telling a purohit what is still outstanding. */
const DOC_LABEL = (kind: (typeof DOC_KINDS)[number]): string => ({
  identity: 'a photo ID',
  address: 'proof of address',
  pan: 'your PAN card',
  qualification: 'your qualification certificate',
  bank: 'your bank details',
  credential: 'your training certificate',
  demo: 'a recording',
}[kind]);

/**
 * Levels a purohit can claim. Each names a certificate that actually exists, because
 * selecting one obliges them to upload it.
 */
const QUALIFICATION_LEVELS = [
  '10th', '12th', 'diploma', 'graduate', 'post_graduate', 'doctorate', 'pathshala',
] as const;

const UploadUrlInput = z.object({
  kind: z.enum(DOC_KINDS),
  contentType: z.string().refine(isAllowedDocType, {
    message: `document must be one of ${ALLOWED_DOC_TYPES.join(', ')}`,
  }),
});

const QualificationInput = z.object({
  level: z.enum(QUALIFICATION_LEVELS),
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
      .select({
        status: panditProfiles.kycStatus,
        verifiedAt: panditProfiles.kycVerifiedAt,
        highestQualification: panditProfiles.highestQualification,
        photoKey: panditProfiles.photoKey,
      })
      .from(panditProfiles).where(eq(panditProfiles.userId, user.sub)).limit(1);

    const docs = await this.db.select({
      id: kycRecords.id, kind: kycRecords.type, status: kycRecords.status,
      last4: kycRecords.identifierLast4, notes: kycRecords.reviewNotes,
      createdAt: kycRecords.createdAt,
    })
      .from(kycRecords).where(eq(kycRecords.panditId, user.sub))
      .orderBy(desc(kycRecords.createdAt));

    const held = new Set(docs.map((d) => d.kind));
    const missing = REQUIRED_DOCS.filter((k) => !held.has(k));

    /*
     * Documents the reviewer has asked for again.
     *
     * A flagged document still EXISTS, so it does not appear in `missing` — but the
     * purohit has to replace it before this can go back for review, and they have to
     * be told which one and why.
     */
    const flagged = docs.filter((d) => d.status === 'rejected');

    return {
      status: profile?.status ?? 'pending',
      verifiedAt: profile?.verifiedAt ?? null,
      highestQualification: profile?.highestQualification ?? null,
      documents: docs,
      /**
       * Exactly what is still outstanding, named — so the screen never has to infer
       * it and the purohit is never told "something is missing" without being told
       * which. `hasIdentity` used to be the whole of this, back when a photo ID was
       * the only thing required.
       */
      required: REQUIRED_DOCS,
      missing,
      /** A qualification claimed but unproved is not a qualification. */
      needsQualification: !profile?.highestQualification,
      /**
       * The face a family sees before they let someone into their home.
       *
       * Required, not optional: since ADR 0012 the devotee does not choose their
       * purohit, so a photograph is the only thing they have before the door opens.
       */
      needsPhoto: !profile?.photoKey,
      /** Signed per request, like every other object we hold. */
      photoUrl: profile?.photoKey
        ? await this.store.presignDownload({ key: profile.photoKey })
        : null,
      /**
       * A re-upload is required for anything the reviewer flagged, so a purohit
       * cannot answer a change request by pressing send again.
       */
      flagged: flagged.map((d) => ({ id: d.id, kind: d.kind, reason: d.notes })),
      canSubmit: missing.length === 0
        && Boolean(profile?.highestQualification)
        && Boolean(profile?.photoKey)
        && flagged.length === 0,
      /**
       * Where they are, in the words the tracker shows them.
       *
       * Derived here rather than in the browser: the rules that decide it — which
       * documents are required, what a flag means, what blocks submission — all live
       * on this side, and a second copy of them in the client is a second copy to
       * drift.
       */
      stage: profile?.status === 'verified' ? 'approved'
        : profile?.status === 'rejected' ? 'declined'
        : profile?.status === 'changes_requested' || flagged.length > 0 ? 'action_needed'
        : profile?.status === 'submitted' ? 'in_review'
        : missing.length === 0 && profile?.highestQualification && profile?.photoKey
          ? 'ready_to_submit'
        : 'collecting',
      /**
       * How long review takes, stated to the purohit rather than left to them to
       * guess. Two working days is the operating commitment in ADR 0010; it is here
       * so the screen and the message quote the same number.
       */
      reviewTargetHours: 48,
    };
  }

  /**
   * The qualification the purohit is claiming.
   *
   * Stored separately from the certificate that proves it, and set before the
   * upload so the two cannot disagree about what is being shown — and so it survives
   * the 30-day purge of the document image (ADR 0010), leaving a reviewer looking at
   * an old approval with a record of what was claimed.
   */
  @Post('qualification')
  async setQualification(@CurrentUser() user: JwtClaims, @Body() body: unknown) {
    const { level } = QualificationInput.parse(body);
    await this.db.update(panditProfiles)
      .set({ highestQualification: level })
      .where(eq(panditProfiles.userId, user.sub));
    return { highestQualification: level };
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
    // Everything short of verified may upload, including a purohit answering a
    // request for one document. That is the whole point of asking.


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

    /*
     * A new document of the same kind REPLACES the old one.
     *
     * Without this, answering a change request left the rejected record in place
     * beside the replacement — so the purohit stayed blocked by a document they had
     * already re-sent, and the reviewer saw two photo IDs with no way to tell which
     * was current. The rejection itself is not lost: the reason and the reviewer are
     * recorded in the audit log when the change is requested.
     */
    await this.db.delete(kycRecords).where(and(
      eq(kycRecords.panditId, user.sub),
      eq(kycRecords.type, input.kind),
    ));

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
    const [profile] = await this.db.select({
      status: panditProfiles.kycStatus,
      highestQualification: panditProfiles.highestQualification,
      photoKey: panditProfiles.photoKey,
    }).from(panditProfiles).where(eq(panditProfiles.userId, user.sub)).limit(1);

    /*
     * Already verified — nothing to check and nothing to do.
     *
     * This sat AFTER the requirement checks, which was harmless when the only
     * requirement was a photo ID they must already have had. It is not harmless now:
     * a purohit verified before these rules existed, or one whose document images
     * have since been purged (ADR 0010), would be told to upload four documents to
     * re-enter a state they are already in.
     */
    if (profile?.status === 'verified') return { status: 'verified' as const };

    const held = new Set(
      (await this.db.select({ type: kycRecords.type })
        .from(kycRecords).where(eq(kycRecords.panditId, user.sub)))
        .map((d) => d.type),
    );

    /*
     * Everything, not just a photo ID.
     *
     * This checked for `identity` alone, so a purohit could reach the review queue
     * having shown us one Aadhaar photo and nothing else — no address, no PAN, no
     * proof of the training they claim. The admin keeps full discretion to approve
     * or reject; this is about what reaches them, not about second-guessing them.
     *
     * The message names what is missing. "Your application is incomplete" sends
     * someone hunting through four upload tiles to find which one.
     */
    const missing = REQUIRED_DOCS.filter((k) => !held.has(k));
    if (missing.length > 0) {
      throw new DomainError(
        ErrorCode.KYC_INCOMPLETE,
        `upload ${missing.map(DOC_LABEL).join(', ')} before submitting for review`,
        { missing },
      );
    }

    /*
     * Anything the reviewer asked for again has to be REPLACED, not re-sent.
     *
     * `status()` already reported this as `canSubmit: false`, but that only greyed
     * out a button — the rule has to hold on this side too, or a purohit answering a
     * change request by pressing submit again puts the same rejected document back in
     * front of the reviewer and the loop never closes.
     */
    const flagged = await this.db.select({ type: kycRecords.type, notes: kycRecords.reviewNotes })
      .from(kycRecords)
      .where(and(eq(kycRecords.panditId, user.sub), eq(kycRecords.status, 'rejected')));
    if (flagged.length > 0) {
      throw new DomainError(
        ErrorCode.KYC_INCOMPLETE,
        `replace ${flagged.map((f) => DOC_LABEL(f.type)).join(', ')} before sending this back`,
        { flagged: flagged.map((f) => ({ kind: f.type, reason: f.notes })) },
      );
    }

    /*
     * A photograph, because the devotee never chose this person.
     *
     * Since ADR 0012 the platform assigns the purohit, so the family meets them for
     * the first time at their own door. It is also what the reviewer compares against
     * the photo ID, which is the whole of what identity verification means here.
     */
    if (!profile?.photoKey) {
      throw new DomainError(
        ErrorCode.KYC_INCOMPLETE,
        'add a photo of yourself before submitting for review',
        { missing: ['photo'] },
      );
    }

    /*
     * A certificate with no claim attached tells a reviewer nothing: they would be
     * looking at a document without knowing what it is meant to prove.
     */
    if (!profile?.highestQualification) {
      throw new DomainError(
        ErrorCode.KYC_INCOMPLETE,
        'choose your highest qualification before submitting for review',
        { missing: ['highestQualification'] },
      );
    }

    /*
     * `submittedAt` is what the review queue is ordered by. It is set on every
     * submission, including a re-submission after we asked for a document again —
     * a purohit who answers a request promptly should not be sent to the back of
     * the queue, but they should not keep their original place either while the
     * reviewer waits on them.
     */
    await this.db.update(panditProfiles)
      .set({ kycStatus: 'submitted', submittedAt: new Date().toISOString() })
      .where(eq(panditProfiles.userId, user.sub));

    return { status: 'submitted' as const };
  }
}
