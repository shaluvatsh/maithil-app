import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DB, KV } from '../common/tokens';
import type { Db } from '../db/client';
import type { KvStore } from '../common/kv';
import { Public } from './auth/guards';

@Controller()
export class HealthController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(KV) private readonly kv: KvStore,
  ) {}

  /**
   * Liveness: is the process up? Deliberately does NOT touch the database - a DB
   * blip should not make the orchestrator kill and restart a healthy process.
   */
  @Public()
  @Get('livez')
  livez() {
    return { status: 'ok', uptimeSec: Math.round(process.uptime()) };
  }

  /** Readiness: should this instance receive traffic? This one does check the DB. */
  @Public()
  @Get('readyz')
  async readyz() {
    const body = await this.health();
    if (body.status !== 'ok') throw new ServiceUnavailableException(body);
    return body;
  }

  @Public()
  @Get('health')
  async health() {
    /*
     * REDIS IS CHECKED HERE TOO, and used not to be.
     *
     * Readiness answers one question — should this instance be given traffic? —
     * and it was answering it from Postgres alone. Redis holds the slot locks,
     * the login OTP codes and every rate-limit counter, so an instance whose
     * Redis is unreachable passes readiness and is then handed requests it
     * cannot serve correctly: sign-in fails because the code cannot be read back,
     * and the rate limiter silently stops limiting.
     *
     * Both are probed concurrently. A readiness check that takes the sum of its
     * dependencies' latencies is a readiness check that starts timing out under
     * exactly the load it exists to protect against.
     */
    const [database, redis] = await Promise.all([
      this.probe(() => this.db.execute(sql`SELECT 1`)),
      /*
       * A write, not a read. `get` on a missing key returns null from a healthy
       * Redis and from a half-broken one alike; `setIfAbsent` exercises the path
       * the OTP and slot-hold code actually depends on. Namespaced and given a
       * short TTL so it cannot collide with real state or outlive the check.
       */
      this.probe(() => this.kv.setIfAbsent(`health:${process.pid}`, '1', 10)),
    ]);

    const ok = database === 'up' && redis === 'up';
    return {
      status: ok ? 'ok' : 'degraded',
      database,
      redis,
      at: new Date().toISOString(),
    };
  }

  private async probe(run: () => Promise<unknown>): Promise<'up' | 'down'> {
    try {
      await run();
      return 'up';
    } catch {
      return 'down';
    }
  }
}
