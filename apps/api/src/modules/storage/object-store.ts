import { createHash, createHmac, randomUUID } from 'node:crypto';

/**
 * Object storage for KYC documents.
 *
 * There was none. `kyc_records.doc_key` has been in the schema since ADR 0010 and
 * nothing ever wrote one, because there was nowhere to put a document — so no
 * purohit could ever submit identity proof, `kyc_status` could never leave
 * `pending`, and an admin approved people on the strength of a name and a
 * years-of-experience number. For a service that sends a stranger into a family's
 * home, "verified purohit" meant an operator had clicked a button.
 *
 * A port with two implementations, the same shape as the payment gateway: an
 * S3-compatible signer for R2 in production, an in-memory one for development and
 * tests. That is what lets the KYC flow be exercised end to end in CI without a
 * bucket, and it is why the fake is in this file rather than in a test helper.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO.
 *
 * It never proxies file bytes through the API. The purohit's browser uploads
 * straight to storage with a short-lived signed URL, and an admin views the same
 * way. Streaming a scan of someone's Aadhaar card through our process would put it
 * in our memory, our logs on failure, and our bandwidth bill, for no benefit.
 */
export interface PresignedUpload {
  /** PUT the bytes here, with exactly the content type that was signed. */
  url: string;
  /** What to record against the KYC row. Never guessed by the client. */
  key: string;
  expiresInSeconds: number;
}

export interface ObjectStore {
  /**
   * A URL the purohit can PUT one file to.
   *
   * The content type is part of the signature, so a client that asks for a signed
   * JPEG cannot then upload an HTML file — which matters, because a document store
   * that will serve attacker-controlled HTML from a trusted origin is a stored-XSS
   * hole with extra steps.
   */
  presignUpload(args: {
    key: string; contentType: string; expiresInSeconds?: number;
  }): Promise<PresignedUpload>;

  /** A short-lived read URL, for the one admin looking at the document right now. */
  presignDownload(args: { key: string; expiresInSeconds?: number }): Promise<string>;

  /** Used by the purge job once a decision is 30 days old. */
  delete(key: string): Promise<void>;
}

/** Small, and enforced at signing time rather than trusted from the client. */
export const ALLOWED_DOC_TYPES = ['image/jpeg', 'image/png', 'application/pdf'] as const;
export type AllowedDocType = (typeof ALLOWED_DOC_TYPES)[number];

export const isAllowedDocType = (v: string): v is AllowedDocType =>
  (ALLOWED_DOC_TYPES as readonly string[]).includes(v);

const EXT: Record<AllowedDocType, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf',
};

/**
 * Where a document lives.
 *
 * Namespaced by purohit and given a random component, so two things hold: one
 * purohit's key can never collide with another's, and a key cannot be guessed from
 * a user id. Guessability matters even though every read is signed — an unguessable
 * key is the second lock.
 */
export function documentKey(args: {
  panditId: string; kind: string; contentType: AllowedDocType;
}): string {
  return `kyc/${args.panditId}/${args.kind}-${randomUUID()}.${EXT[args.contentType]}`;
}

/**
 * The purohit's public profile photo.
 *
 * A separate prefix from `kyc/` on purpose. KYC images are purged thirty days after a
 * decision; this one is permanent and public, and keeping them in one namespace is
 * how a purge sweep written later deletes every purohit's face.
 */
export function profilePhotoKey(args: {
  panditId: string; contentType: AllowedDocType;
}): string {
  return `profile/${args.panditId}/photo-${randomUUID()}.${EXT[args.contentType]}`;
}

/**
 * What a knowledge recording may be.
 *
 * A SEPARATE list from `ALLOWED_DOC_TYPES`, and a short one. The content type is part
 * of the presigned signature — see `presignUpload` — so this list is what actually
 * stops the library becoming a general file host. The note there applies with more
 * force here than on a KYC upload, because knowledge media is PUBLIC: a store that
 * will serve attacker-controlled HTML from a trusted origin is a stored-XSS hole,
 * and a public prefix is the version of that hole anyone can reach.
 *
 * Three formats, chosen for what a purohit's phone actually records: mp3 and m4a from
 * a voice recorder, mp4 for video. No wav (a 30-second chant is 5MB uncompressed) and
 * no ogg (Safari will not play it).
 */
export const ALLOWED_MEDIA_TYPES = ['audio/mpeg', 'audio/mp4', 'video/mp4'] as const;
export type AllowedMediaType = (typeof ALLOWED_MEDIA_TYPES)[number];

export const isAllowedMediaType = (v: string): v is AllowedMediaType =>
  (ALLOWED_MEDIA_TYPES as readonly string[]).includes(v);

const MEDIA_EXT: Record<AllowedMediaType, string> = {
  'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'video/mp4': 'mp4',
};

/**
 * Where a knowledge recording lives.
 *
 * Its own prefix, for the reason `profile/` has one: `kyc/` is purged thirty days
 * after a decision, and a published mantra recording must outlive that sweep. A
 * random component because a key should not be guessable from an author id even
 * though reads are signed — the unguessable key is the second lock.
 */
export function knowledgeMediaKey(args: {
  authorId: string; contentType: AllowedMediaType;
}): string {
  return `knowledge/${args.authorId}/media-${randomUUID()}.${MEDIA_EXT[args.contentType]}`;
}

const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');
const hmac = (key: Buffer | string, data: string) =>
  createHmac('sha256', key).update(data).digest();

/**
 * S3-compatible presigning (SigV4, query-string form). Works against R2.
 *
 * Hand-rolled over the AWS SDK for the same reason the Razorpay client is: the
 * surface we need is two signed URLs and a delete, and two SDK packages plus their
 * transitive dependencies is a large amount of code to carry — and to audit — for
 * that. SigV4 query signing is a fixed, well-specified recipe.
 */
export class S3ObjectStore implements ObjectStore {
  constructor(
    private readonly cfg: {
      endpoint: string;      // https://<account>.r2.cloudflarestorage.com
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
      region?: string;       // 'auto' for R2
    },
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private sign(method: 'PUT' | 'GET' | 'DELETE', key: string, args: {
    expiresInSeconds: number; contentType?: string;
  }): string {
    const region = this.cfg.region ?? 'auto';
    const date = this.now();
    const amzDate = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const stamp = amzDate.slice(0, 8);
    const scope = `${stamp}/${region}/s3/aws4_request`;

    const url = new URL(`${this.cfg.endpoint}/${this.cfg.bucket}/${key}`);
    // Each path segment is encoded separately: the slashes in the key are real path
    // separators and must survive, everything else must not.
    const canonicalUri = url.pathname.split('/').map(encodeURIComponent).join('/')
      .replace(/%2F/g, '/');

    const host = url.host;
    // Signing the content type binds the upload to it; a signed JPEG URL cannot be
    // used to store HTML.
    const signedHeaders = contentTypeSigned(method, args.contentType)
      ? 'content-type;host' : 'host';

    const query: Record<string, string> = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${this.cfg.accessKeyId}/${scope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(args.expiresInSeconds),
      'X-Amz-SignedHeaders': signedHeaders,
    };
    const canonicalQuery = Object.keys(query).sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k]!)}`)
      .join('&');

    const canonicalHeaders = signedHeaders === 'content-type;host'
      ? `content-type:${args.contentType}\nhost:${host}\n`
      : `host:${host}\n`;

    const canonicalRequest = [
      method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders,
      'UNSIGNED-PAYLOAD',
    ].join('\n');

    const stringToSign = [
      'AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest),
    ].join('\n');

    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${this.cfg.secretAccessKey}`, stamp), region), 's3'),
      'aws4_request',
    );
    const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

    return `${url.origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
  }

  async presignUpload(args: {
    key: string; contentType: string; expiresInSeconds?: number;
  }): Promise<PresignedUpload> {
    // Ten minutes. Long enough for a slow upload on a poor connection, short enough
    // that a URL leaked from a browser history is not a standing write grant.
    const expiresInSeconds = args.expiresInSeconds ?? 600;
    return {
      url: this.sign('PUT', args.key, { expiresInSeconds, contentType: args.contentType }),
      key: args.key,
      expiresInSeconds,
    };
  }

  async presignDownload(args: { key: string; expiresInSeconds?: number }): Promise<string> {
    // Five minutes: this is one admin opening one document, now.
    return this.sign('GET', args.key, { expiresInSeconds: args.expiresInSeconds ?? 300 });
  }

  async delete(key: string): Promise<void> {
    const res = await this.fetchImpl(this.sign('DELETE', key, { expiresInSeconds: 60 }), {
      method: 'DELETE',
    });
    // 404 is success for our purposes: the object is not there, which is the goal.
    if (!res.ok && res.status !== 404) {
      throw new Error(`object delete failed (${res.status}) for ${key}`);
    }
  }
}

const contentTypeSigned = (method: string, contentType?: string) =>
  method === 'PUT' && Boolean(contentType);

/**
 * Development and tests.
 *
 * Records what would have been stored so a test can assert that a document was
 * attached, purged, or never uploaded at all — and so the whole KYC flow runs in CI
 * without a bucket. The URLs it hands out are obviously fake, which is deliberate:
 * a fake that returns a plausible-looking R2 URL invites someone to believe an
 * upload succeeded in an environment where nothing is stored.
 */
/**
 * The development store, when there is no bucket to talk to.
 *
 * It used to hand out `memory://upload/...`. A browser cannot PUT to that — `fetch`
 * REJECTS on an unknown scheme rather than returning a failed response, so the
 * client's `if (!put.ok && !url.startsWith('memory://'))` escape hatch was
 * unreachable and every upload died on "Failed to fetch". Document upload therefore
 * could not work in local development at all, and once verification began requiring
 * four documents, neither could purohit onboarding.
 *
 * So the URLs are real HTTP now, served by a dev-only controller against this same
 * instance. That keeps the two-step flow honest — sign, PUT the bytes, then attach —
 * and it means an admin reviewing an application can actually open the document,
 * which a scheme the browser refuses could never do.
 */
export class InMemoryObjectStore implements ObjectStore {
  readonly uploads = new Map<string, { contentType: string; body?: Uint8Array }>();
  readonly deleted: string[] = [];

  /**
   * Where this process answers. Uploads must go somewhere a browser can reach, and
   * only the process knows its own address.
   */
  constructor(private readonly baseUrl = 'http://localhost:3000') {}

  async presignUpload(args: {
    key: string; contentType: string; expiresInSeconds?: number;
  }): Promise<PresignedUpload> {
    this.uploads.set(args.key, { contentType: args.contentType });
    return {
      url: `${this.baseUrl}/v1/dev/uploads/${encodeURIComponent(args.key)}`,
      key: args.key,
      expiresInSeconds: args.expiresInSeconds ?? 600,
    };
  }

  async presignDownload(args: { key: string }): Promise<string> {
    return `${this.baseUrl}/v1/dev/uploads/${encodeURIComponent(args.key)}`;
  }

  /** Called by the dev upload endpoint once the bytes actually arrive. */
  put(key: string, contentType: string, body: Uint8Array): void {
    this.uploads.set(key, { contentType, body });
  }

  get(key: string): { contentType: string; body?: Uint8Array } | undefined {
    return this.uploads.get(key);
  }

  async delete(key: string): Promise<void> {
    this.uploads.delete(key);
    this.deleted.push(key);
  }
}
