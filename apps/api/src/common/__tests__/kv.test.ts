import { describe, it, expect } from 'vitest';
import { RedisKv } from '../kv';

/**
 * A minimal stand-in for the real Redis client, faithful to actual SET/INCR
 * semantics (including that INCR on a missing key creates it at 0 first) - just
 * enough to prove `RedisKv.incr`'s call sequence, not a Redis reimplementation.
 */
class FakeRedis {
  private store = new Map<string, { value: string; expiresAt: number | null }>();
  calls: string[] = [];

  private live(k: string) {
    const e = this.store.get(k);
    if (!e) return undefined;
    if (e.expiresAt !== null && e.expiresAt <= Date.now()) { this.store.delete(k); return undefined; }
    return e;
  }

  async set(k: string, v: string, _mode: 'EX', ttl: number, _nx: 'NX'): Promise<'OK' | null> {
    this.calls.push('set');
    if (this.live(k)) return null;   // NX: no-op, key already there
    this.store.set(k, { value: v, expiresAt: Date.now() + ttl * 1000 });
    return 'OK';
  }
  async get(k: string): Promise<string | null> { return this.live(k)?.value ?? null; }
  async del(k: string): Promise<number> { return this.store.delete(k) ? 1 : 0; }
  async incr(k: string): Promise<number> {
    this.calls.push('incr');
    const e = this.live(k);
    const next = Number(e?.value ?? 0) + 1;
    // Real INCR on a brand-new key creates it with NO TTL - this is exactly the gap
    // the old incr() only closed after the fact.
    this.store.set(k, { value: String(next), expiresAt: e?.expiresAt ?? null });
    return next;
  }

  /** Test hook: whether the key currently carries a TTL. */
  hasTtl(k: string): boolean { return (this.store.get(k)?.expiresAt ?? null) !== null; }
}

describe('RedisKv.incr', () => {
  it('carries a TTL from the very first increment, before any INCR call', async () => {
    const redis = new FakeRedis();
    const kv = new RedisKv(redis);
    expect(await kv.incr('otp:sends:+91900', 3600)).toBe(1);
    expect(redis.hasTtl('otp:sends:+91900')).toBe(true);
  });

  it('counts correctly across repeated calls within the window', async () => {
    const redis = new FakeRedis();
    const kv = new RedisKv(redis);
    await kv.incr('k', 60);
    await kv.incr('k', 60);
    expect(await kv.incr('k', 60)).toBe(3);
  });

  /**
   * The actual bug this closes: the old implementation called INCR first and only
   * attempted EXPIRE when the result was 1 - so a crash or dropped connection
   * between those two calls left a key with no TTL at all. Simulating exactly that
   * failure mode (INCR succeeds, the caller never gets to do anything with a TTL
   * because there is no separate TTL step left to skip) and confirming the key
   * still carries one, because SET NX established it up front.
   */
  it('still carries a TTL even if incr() is only ever called once and nothing follows', async () => {
    const redis = new FakeRedis();
    const kv = new RedisKv(redis);
    await kv.incr('otp:sends:+91900', 3600);
    // No second call, no explicit expire step - this IS the whole operation, and
    // the key must not be left to increment forever.
    expect(redis.hasTtl('otp:sends:+91900')).toBe(true);
    expect(redis.calls).toEqual(['set', 'incr']);
  });
});
