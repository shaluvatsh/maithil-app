import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeHarness, type Harness } from '../../test/harness';
import { MemoryKv, type KvStore } from '../../common/kv';
import { HealthController } from '../health.controller';

let h: Harness;
beforeEach(async () => { h = await makeHarness(); }, 60_000);
afterEach(async () => { await h?.pg.close(); });

/** A KV whose every operation fails, as an unreachable Redis does. */
const brokenKv = (): KvStore => ({
  setIfAbsent: () => Promise.reject(new Error('ECONNREFUSED')),
  get: () => Promise.reject(new Error('ECONNREFUSED')),
  del: () => Promise.reject(new Error('ECONNREFUSED')),
  incr: () => Promise.reject(new Error('ECONNREFUSED')),
});

/**
 * READINESS HAS TO ASK ABOUT REDIS, and used to ask only about Postgres.
 *
 * Readiness answers one question — should this instance be given traffic? Redis
 * holds the slot locks, the login OTP codes and every rate-limit counter, so an
 * instance whose Redis is unreachable was passing readiness and then being handed
 * requests it could not serve correctly: sign-in fails because the code cannot be
 * read back, and the rate limiter silently stops limiting. Neither surfaces as an
 * error the orchestrator can see, which is precisely why the probe has to.
 */
describe('readiness', () => {
  it('is ok when both dependencies answer', async () => {
    const c = new HealthController(h.db, new MemoryKv());
    const body = await c.readyz();
    expect(body.status).toBe('ok');
    expect(body.database).toBe('up');
    expect(body.redis).toBe('up');
  });

  it('refuses traffic when Redis is unreachable, rather than reporting healthy', async () => {
    const c = new HealthController(h.db, brokenKv());
    await expect(c.readyz()).rejects.toThrow();
  });

  it('names which dependency is down, so the page tells you where to look', async () => {
    const c = new HealthController(h.db, brokenKv());
    const body = await c.health();
    expect(body.status).toBe('degraded');
    expect(body.database).toBe('up');
    expect(body.redis).toBe('down');
  });

  /**
   * Liveness deliberately touches neither. A dependency blip must not make the
   * orchestrator kill and restart a process that is perfectly healthy — restarting
   * is the one response that cannot help and does reliably make things worse.
   */
  it('keeps liveness independent of both', async () => {
    const c = new HealthController(h.db, brokenKv());
    expect(c.livez().status).toBe('ok');
  });

  /**
   * The probe WRITES rather than reads. `get` on a missing key returns null from a
   * healthy Redis and from a half-broken one alike; `setIfAbsent` exercises the path
   * the OTP and slot-hold code actually depends on.
   */
  it('probes Redis with a write, not a read', async () => {
    const calls: string[] = [];
    const inner = new MemoryKv();
    const kv: KvStore = {
      setIfAbsent: async (k, v, t) => { calls.push(k); return inner.setIfAbsent(k, v, t); },
      get: (k) => inner.get(k),
      del: (k) => inner.del(k),
      incr: (k, t) => inner.incr(k, t),
    };

    await new HealthController(h.db, kv).health();
    expect(calls).toHaveLength(1);
    // Namespaced and per-process, so it cannot collide with real state.
    expect(calls[0]).toMatch(/^health:/);
  });
});
