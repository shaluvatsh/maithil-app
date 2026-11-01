import {
  Controller, Put, Get, Param, Req, Res, Headers, Inject, HttpCode,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../auth/guards';
import { InMemoryObjectStore, isAllowedDocType } from './object-store';
import { DomainError, ErrorCode } from '@themaithil/contracts';

/**
 * Object storage, for development only.
 *
 * Without R2 credentials the store handed out `memory://upload/...`, and a browser
 * cannot PUT to that: `fetch` rejects on an unknown scheme rather than returning a
 * failed response, so the client's escape hatch for it was unreachable and every
 * upload died on "Failed to fetch". Document upload could not work locally at all —
 * and since verification began requiring four documents, neither could purohit
 * onboarding.
 *
 * `@Public` because a presigned URL carries its own authority: the real S3 path puts
 * the signature in the query string and sends no bearer token, and a dev stand-in
 * that demanded one would not be exercising the same client code.
 *
 * That is also exactly why this must never exist in production, where a public,
 * unsigned write endpoint would let anyone overwrite anyone's identity document.
 * `loadConfig()` already refuses to boot production without a real bucket, so this
 * controller is unreachable there — the guard below is the second lock.
 */
@Controller('v1/dev/uploads')
export class DevUploadsController {
  constructor(@Inject('OBJECT_STORE') private readonly store: unknown) {}

  private dev(): InMemoryObjectStore {
    if (process.env.NODE_ENV === 'production' || !(this.store instanceof InMemoryObjectStore)) {
      throw new DomainError(ErrorCode.NOT_FOUND, 'not available');
    }
    return this.store;
  }

  @Public()
  @Put(':key')
  @HttpCode(200)
  async upload(
    @Param('key') key: string,
    @Headers('content-type') contentType: string,
    @Req() req: Request & { rawBody?: Buffer },
  ) {
    const store = this.dev();

    // The same restriction the real signing path applies, so a developer cannot
    // upload something here that production would have refused.
    if (!contentType || !isAllowedDocType(contentType.split(';')[0]!.trim())) {
      throw new DomainError(ErrorCode.FORBIDDEN, `content type not allowed: ${contentType}`);
    }

    const body = req.rawBody ?? (await readBody(req));
    store.put(decodeURIComponent(key), contentType, new Uint8Array(body));
    return { ok: true, bytes: body.length };
  }

  /** Serves it back, so the admin review screen can open what was uploaded. */
  @Public()
  @Get(':key')
  view(@Param('key') key: string, @Res() res: Response) {
    const found = this.dev().get(decodeURIComponent(key));
    if (!found?.body) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'nothing uploaded here' } });
      return;
    }
    res.setHeader('content-type', found.contentType);
    res.send(Buffer.from(found.body));
  }
}

/**
 * Collects the raw body.
 *
 * Nest's JSON parser leaves a `image/jpeg` PUT untouched, so nothing has consumed
 * the stream by the time this runs — and the bytes must not be parsed anyway.
 */
function readBody(req: Request): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
