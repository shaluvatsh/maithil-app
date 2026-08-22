import { Logger } from '@nestjs/common';
import type { Db } from '../db/client';

/**
 * Postgres advisory lock, held across ONE reserved connection for the whole time
 * this instance believes it is the leader.
 *
 * Session-level advisory locks are tied to the physical connection that took them,
 * not to a transaction - so acquiring on one pooled connection and releasing on
 * another (which `db.execute(...)` would do freely, since the pool hands out
 * whichever connection is free) can silently fail to release, leaking the lock
 * until that backend eventually disconnects. `sql.reserve()` pins one connection
 * for the lock's whole lifetime so acquire and release are provably the same
 * session.
 */
export interface LeaderLock {
  /** True if THIS instance now holds the lock and may proceed. */
  tryAcquire(): Promise<boolean>;
  release(): Promise<void>;
}

export class PgAdvisoryLock implements LeaderLock {
  private readonly log = new Logger('leader-lock');
  private conn: Awaited<ReturnType<Db['$client']['reserve']>> | undefined;

  constructor(
    private readonly db: Db,
    /** Any fixed bigint identifies this lock; distinct jobs need distinct keys. */
    private readonly key: number,
  ) {}

  async tryAcquire(): Promise<boolean> {
    const conn = await this.db.$client.reserve();
    const rows = await conn`select pg_try_advisory_lock(${this.key}) as locked`;
    const locked = Boolean((rows as unknown as Array<{ locked: boolean }>)[0]?.locked);
    if (!locked) {
      conn.release();
      return false;
    }
    this.conn = conn;
    return true;
  }

  async release(): Promise<void> {
    if (!this.conn) return;
    const conn = this.conn;
    this.conn = undefined;
    try {
      await conn`select pg_advisory_unlock(${this.key})`;
    } catch (e) {
      this.log.warn(`advisory unlock failed (connection will release it on close anyway): ${
        e instanceof Error ? e.message : e}`);
    } finally {
      conn.release();
    }
  }
}
