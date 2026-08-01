import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { idempotencyKeys } from '../db/schema/index';
import { DomainError, ErrorCode } from '@themaithil/contracts';

const TTL_HOURS = 24;

/**
 * Idempotency for mutations.
 *
 * The original design specified idempotency keys on payment endpoints and webhooks
 * only. But /complete is the endpoint MOST likely to be retried - it sits on the
 * offline-sync path - and in token+balance mode it triggers a charge. Same for
 * /confirm and /cancel. All of them go through here.
 *
 * Replaying a key with a DIFFERENT body is a client bug and returns 409 rather than
 * silently doing the wrong thing.
 */
export class IdempotencyService {
  constructor(private readonly db: Db) {}

  private static hash(body: unknown): string {
    return createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
  }

  async run<T>(args: {
    key: string;
    userId: string;
    endpoint: string;
    body: unknown;
    handler: () => Promise<T>;
  }): Promise<T> {
    const requestHash = IdempotencyService.hash(args.body);

    const existing = await this.db.select().from(idempotencyKeys)
      .where(eq(idempotencyKeys.key, args.key)).limit(1);

    if (existing[0]) {
      const row = existing[0];
      if (row.requestHash !== requestHash || row.endpoint !== args.endpoint) {
        throw new DomainError(
          ErrorCode.IDEMPOTENCY_CONFLICT,
          'this idempotency key was already used with a different request',
          { key: args.key },
        );
      }
      if (row.responseBody === null) {
        // A previous attempt is still in flight, or crashed mid-way. Tell the client
        // to retry rather than starting a second copy of the same mutation.
        throw new DomainError(
          ErrorCode.IDEMPOTENCY_CONFLICT,
          'a request with this key is already in progress',
          { key: args.key },
        );
      }
      return row.responseBody as T;
    }

    // Claim the key first. If two requests race, the unique PK means exactly one
    // proceeds and the other takes the branch above.
    const claimed = await this.db.insert(idempotencyKeys).values({
      key: args.key,
      userId: args.userId,
      endpoint: args.endpoint,
      requestHash,
      expiresAt: new Date(Date.now() + TTL_HOURS * 3600_000).toISOString(),
    }).onConflictDoNothing().returning({ key: idempotencyKeys.key });

    if (claimed.length === 0) {
      throw new DomainError(
        ErrorCode.IDEMPOTENCY_CONFLICT,
        'a request with this key is already in progress',
        { key: args.key },
      );
    }

    const result = await args.handler();

    await this.db.update(idempotencyKeys)
      .set({ responseStatus: 200, responseBody: result as object })
      .where(eq(idempotencyKeys.key, args.key));

    return result;
  }
}
