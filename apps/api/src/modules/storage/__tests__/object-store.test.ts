import { describe, it, expect } from 'vitest';
import {
  S3ObjectStore, InMemoryObjectStore, documentKey, isAllowedDocType, ALLOWED_DOC_TYPES,
} from '../object-store';

const store = () => new S3ObjectStore(
  {
    endpoint: 'https://acct.r2.cloudflarestorage.com',
    bucket: 'maithil-kyc',
    accessKeyId: 'AKIAEXAMPLE',
    secretAccessKey: 'secret',
  },
  fetch,
  () => new Date('2026-08-16T10:00:00.000Z'),
);

/**
 * The signer is hand-rolled over SigV4 rather than pulled from the AWS SDK, for the
 * same reason the Razorpay client is hand-rolled: the surface is two signed URLs and
 * a delete. That trade is only defensible if the recipe is actually tested, so these
 * assert the parts of the signature a mistake would silently break — a URL that is
 * wrong in any of them is simply rejected by storage, which surfaces to a purohit as
 * "the upload did not complete" with no way to tell why.
 */
describe('presigned URLs carry a complete SigV4 signature', () => {
  it('signs an upload with every required parameter', async () => {
    const { url } = await store().presignUpload({
      key: 'kyc/p1/identity-abc.jpg', contentType: 'image/jpeg',
    });
    const q = new URL(url).searchParams;
    expect(q.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(q.get('X-Amz-Credential')).toBe('AKIAEXAMPLE/20260816/auto/s3/aws4_request');
    expect(q.get('X-Amz-Date')).toBe('20260816T100000Z');
    expect(q.get('X-Amz-Signature')).toMatch(/^[a-f0-9]{64}$/);
  });

  /**
   * The content type is in the signature, so a client that asks for a signed JPEG
   * cannot then store HTML at that key. A document store that will serve
   * attacker-controlled HTML from a trusted origin is stored XSS with extra steps.
   */
  it('binds an upload to its content type', async () => {
    const { url } = await store().presignUpload({
      key: 'kyc/p1/identity-abc.jpg', contentType: 'image/jpeg',
    });
    expect(new URL(url).searchParams.get('X-Amz-SignedHeaders')).toBe('content-type;host');
  });

  it('does not sign a content type on a read', async () => {
    const url = await store().presignDownload({ key: 'kyc/p1/identity-abc.jpg' });
    expect(new URL(url).searchParams.get('X-Amz-SignedHeaders')).toBe('host');
  });

  /** Different bytes must produce a different signature, or nothing is being signed. */
  it('signs the key, not just the request shape', async () => {
    const a = await store().presignDownload({ key: 'kyc/p1/one.jpg' });
    const b = await store().presignDownload({ key: 'kyc/p1/two.jpg' });
    const sig = (u: string) => new URL(u).searchParams.get('X-Amz-Signature');
    expect(sig(a)).not.toBe(sig(b));
  });

  /**
   * Slashes in a key are real path separators and must survive encoding; everything
   * else must not. Getting this backwards yields a URL that signs correctly and
   * points at the wrong object.
   */
  it('keeps the key path intact in the URL', async () => {
    const url = await store().presignDownload({ key: 'kyc/p1/identity-abc.jpg' });
    expect(new URL(url).pathname).toBe('/maithil-kyc/kyc/p1/identity-abc.jpg');
  });

  it('expires an upload in minutes, not hours', async () => {
    const { url, expiresInSeconds } = await store().presignUpload({
      key: 'k', contentType: 'image/png',
    });
    expect(expiresInSeconds).toBeLessThanOrEqual(900);
    expect(Number(new URL(url).searchParams.get('X-Amz-Expires'))).toBe(expiresInSeconds);
  });

  /** One admin, one document, now. A longer window is a link that outlives the review. */
  it('expires a read faster than an upload', async () => {
    const read = await store().presignDownload({ key: 'k' });
    const write = await store().presignUpload({ key: 'k', contentType: 'image/png' });
    expect(Number(new URL(read).searchParams.get('X-Amz-Expires')))
      .toBeLessThan(Number(new URL(write.url).searchParams.get('X-Amz-Expires')));
  });
});

describe('document keys', () => {
  /**
   * Namespaced by purohit, so the API can verify a submitted key belongs to the
   * caller — which is what stops a purohit attaching someone else's document to
   * their own record and inheriting a verification they did not earn.
   */
  it('are namespaced by the purohit', () => {
    expect(documentKey({ panditId: 'p1', kind: 'identity', contentType: 'image/jpeg' }))
      .toMatch(/^kyc\/p1\/identity-/);
  });

  /** Unguessable as a second lock, behind the signed read. */
  it('are never the same twice', () => {
    const a = documentKey({ panditId: 'p1', kind: 'identity', contentType: 'image/jpeg' });
    const b = documentKey({ panditId: 'p1', kind: 'identity', contentType: 'image/jpeg' });
    expect(a).not.toBe(b);
  });

  it('carry an extension matching the content type', () => {
    expect(documentKey({ panditId: 'p1', kind: 'bank', contentType: 'application/pdf' }))
      .toMatch(/\.pdf$/);
    expect(documentKey({ panditId: 'p1', kind: 'bank', contentType: 'image/png' }))
      .toMatch(/\.png$/);
  });
});

describe('accepted document types', () => {
  it('allows scans and photographs only', () => {
    for (const t of ALLOWED_DOC_TYPES) expect(isAllowedDocType(t)).toBe(true);
  });

  it('refuses anything a browser would execute', () => {
    for (const t of ['text/html', 'image/svg+xml', 'application/javascript']) {
      expect(isAllowedDocType(t)).toBe(false);
    }
  });
});

/**
 * The fake is in the production file rather than a test helper, so the KYC flow runs
 * end to end in CI without a bucket — the same arrangement as `FakeGateway`.
 */
describe('the in-memory store', () => {
  /**
   * This asserted the URL began `memory://`, to stop anyone believing an upload had
   * succeeded where nothing was stored. Sound reasoning, wrong conclusion: a browser
   * cannot PUT to an unknown scheme — `fetch` REJECTS rather than returning a failed
   * response — so document upload could not work in development at all, and once
   * verification required four documents, neither could purohit onboarding.
   *
   * The store keeps and serves the bytes now, so the original worry is answered by
   * being true rather than by being obviously fake. What remains is that nobody
   * should mistake it for real object storage, and the URL still says so: it points
   * at this process, on a path marked `dev`.
   */
  it('hands out a URL a browser can reach, that is plainly not a bucket', async () => {
    const s = new InMemoryObjectStore('http://localhost:3000');
    const { url } = await s.presignUpload({ key: 'k', contentType: 'image/png' });
    expect(url.startsWith('http://'), `a browser cannot PUT to ${url}`).toBe(true);
    expect(url).toContain('/v1/dev/uploads/');
  });

  it('serves back exactly the bytes it was given', async () => {
    const s = new InMemoryObjectStore();
    await s.presignUpload({ key: 'kyc/p1/id.jpg', contentType: 'image/jpeg' });
    s.put('kyc/p1/id.jpg', 'image/jpeg', new Uint8Array([1, 2, 3]));
    expect(Array.from(s.get('kyc/p1/id.jpg')!.body!)).toEqual([1, 2, 3]);
  });

  it('records what was stored and what was purged', async () => {
    const s = new InMemoryObjectStore();
    await s.presignUpload({ key: 'kyc/p1/id.jpg', contentType: 'image/jpeg' });
    expect(s.uploads.has('kyc/p1/id.jpg')).toBe(true);
    await s.delete('kyc/p1/id.jpg');
    expect(s.uploads.has('kyc/p1/id.jpg')).toBe(false);
    expect(s.deleted).toEqual(['kyc/p1/id.jpg']);
  });
});
