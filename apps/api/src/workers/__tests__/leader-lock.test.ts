import { describe, it, expect, vi } from 'vitest';
import { PgAdvisoryLock } from '../leader-lock';
import type { Db } from '../../db/client';

/**
 * `PgAdvisoryLock` needs a real reserved connection to mean anything, so these are
 * unit tests against a mock `$client.reserve()` rather than integration tests
 * against the PGlite harness - PGlite is single-connection, so it cannot
 * distinguish "the reserved connection was released" from "there was only ever
 * one connection to begin with." What matters here is purely `tryAcquire()`'s own
 * control flow: does it release what it reserved on every path, including the one
 * where the query itself throws.
 */
const fakeDb = (conn: { query: () => unknown; release: () => void }): Db => ({
  $client: { reserve: () => Promise.resolve(Object.assign(
    (..._args: unknown[]) => conn.query(),
    { release: conn.release },
  )) },
} as unknown as Db);

describe('PgAdvisoryLock', () => {
  it('acquires and releases cleanly on the happy path', async () => {
    const release = vi.fn();
    const db = fakeDb({ query: () => [{ locked: true }], release });
    const lock = new PgAdvisoryLock(db, 1);
    expect(await lock.tryAcquire()).toBe(true);
    expect(release).not.toHaveBeenCalled();   // held until release() is called

    await lock.release();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases the reserved connection when the lock is already held elsewhere', async () => {
    const release = vi.fn();
    const db = fakeDb({ query: () => [{ locked: false }], release });
    const lock = new PgAdvisoryLock(db, 1);
    expect(await lock.tryAcquire()).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
  });

  /**
   * The bug this closes: a transient failure on the lock query itself (a
   * statement timeout, a dropped connection) used to skip both existing release
   * paths - neither "did not get the lock" nor "got the lock" ran, because
   * neither was reached - permanently removing this reserved connection from the
   * pool. `main.ts` calls this every six hours for the process's whole lifetime,
   * so each occurrence quietly shrank an already-small ten-connection pool.
   */
  it('releases the reserved connection when the lock query itself throws', async () => {
    const release = vi.fn();
    const db = fakeDb({
      query: () => { throw new Error('statement timeout'); },
      release,
    });
    const lock = new PgAdvisoryLock(db, 1);
    await expect(lock.tryAcquire()).rejects.toThrow('statement timeout');
    expect(release).toHaveBeenCalledTimes(1);
  });
});
