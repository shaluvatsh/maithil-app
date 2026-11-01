import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryObjectStore } from '../object-store';
import { DevUploadsController } from '../dev-uploads.controller';

let store: InMemoryObjectStore;
let ctl: DevUploadsController;

beforeEach(() => {
  store = new InMemoryObjectStore('http://localhost:3000');
  ctl = new DevUploadsController(store);
});

/** Stands in for the Express request the PUT arrives on. */
const req = (body: Buffer) => ({ rawBody: body }) as never;

/**
 * Document upload could not work in local development at all.
 *
 * The dev store handed out `memory://upload/...`, and a browser cannot PUT to that:
 * `fetch` REJECTS on an unknown scheme rather than returning a failed response, so
 * the client's `if (!put.ok && !url.startsWith('memory://'))` escape hatch was
 * unreachable and every upload died on "Failed to fetch". Once verification began
 * requiring four documents, purohit onboarding could not be completed locally.
 */
describe('the development store is reachable from a browser', () => {
  it('signs a URL a browser can actually request', async () => {
    const signed = await store.presignUpload({ key: 'kyc/p1/id.jpg', contentType: 'image/jpeg' });
    expect(signed.url.startsWith('http://'), `browser cannot PUT to ${signed.url}`).toBe(true);
  });

  it('keeps the bytes it is given and serves them back', async () => {
    const signed = await store.presignUpload({ key: 'kyc/p1/id.jpg', contentType: 'image/jpeg' });
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    await ctl.upload(encodeURIComponent(signed.key), 'image/jpeg', req(bytes));

    const sent: Record<string, unknown> = {};
    const res = {
      setHeader: (k: string, v: string) => { sent[k] = v; },
      send: (b: Buffer) => { sent.body = b; },
      status: () => ({ json: () => { sent.notFound = true; } }),
    } as never;
    ctl.view(encodeURIComponent(signed.key), res);

    expect(sent.notFound).toBeUndefined();
    expect(Buffer.compare(sent.body as Buffer, bytes)).toBe(0);
    expect(sent['content-type']).toBe('image/jpeg');
  });

  /** The download URL is what the admin review screen opens. */
  it('serves the download URL the reviewer is given', async () => {
    const url = await store.presignDownload({ key: 'kyc/p1/id.jpg' });
    expect(url.startsWith('http://')).toBe(true);
  });

  it('404s a key nothing was uploaded to', () => {
    let notFound = false;
    const res = {
      setHeader: () => {}, send: () => {},
      status: (c: number) => ({ json: () => { notFound = c === 404; } }),
    } as never;
    ctl.view(encodeURIComponent('kyc/p1/never.jpg'), res);
    expect(notFound).toBe(true);
  });

  /**
   * The same restriction the real signing path applies, so a developer cannot get a
   * file in here that production would have refused.
   */
  it('refuses a content type a browser would execute', async () => {
    await expect(ctl.upload('kyc%2Fp1%2Fx.html', 'text/html', req(Buffer.from('<script>'))))
      .rejects.toThrow(/not allowed/);
  });

  /**
   * This endpoint is unauthenticated, because a presigned URL carries its own
   * authority. In production that would let anyone overwrite anyone's identity
   * document — so it must refuse to exist there. `loadConfig()` already blocks a
   * production boot without a real bucket; this is the second lock.
   */
  it('refuses to run in production', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(ctl.upload('k', 'image/jpeg', req(Buffer.from('x'))))
        .rejects.toThrow(/not available/);
    } finally { process.env.NODE_ENV = prev; }
  });

  /** And it must never wrap a real bucket, whatever the environment says. */
  it('refuses to run against real object storage', async () => {
    const real = new DevUploadsController({ presignUpload: async () => ({}) } as never);
    await expect(real.upload('k', 'image/jpeg', req(Buffer.from('x'))))
      .rejects.toThrow(/not available/);
  });
});
