import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index';

export type Db = ReturnType<typeof createDb>;

/**
 * A drizzle transaction handle. Services that must participate in a caller's
 * transaction take `Executor` rather than `Db`, so the ledger write and the state
 * change it describes always commit together.
 */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type Executor = Db | Tx;

export function createDb(url: string) {
  const client = postgres(url, {
    max: 10,
    // The ledger's deferred constraint trigger needs real transactions, so no
    // statement-level pooling weirdness. Keep prepared statements off for pgbouncer
    // compatibility if we ever put one in front.
    prepare: false,
  });
  return drizzle(client, { schema });
}

export { schema };
