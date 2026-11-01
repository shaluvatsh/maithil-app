/**
 * Small key-value abstraction over Redis.
 *
 * Two implementations: Redis in production, in-memory for tests. The interface is
 * deliberately tiny - we use Redis for exactly two things (slot holds and OTP rate
 * limiting) and correctness never depends on either. A Redis outage must degrade
 * the checkout experience, not allow a double-booking.
 */
export interface KvStore {
  /** SET key value NX EX ttl. Returns false if the key already existed. */
  setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<void>;
  /** Atomic increment with a TTL applied on first write. Used for rate limits. */
  incr(key: string, ttlSeconds: number): Promise<number>;
}

export class MemoryKv implements KvStore {
  private readonly map = new Map<string, { value: string; expiresAt: number }>();

  private live(key: string) {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= Date.now()) { this.map.delete(key); return undefined; }
    return e;
  }

  async setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    if (this.live(key)) return false;
    this.map.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    return true;
  }
  async get(key: string): Promise<string | null> { return this.live(key)?.value ?? null; }
  async del(key: string): Promise<void> { this.map.delete(key); }
  async incr(key: string, ttlSeconds: number): Promise<number> {
    const e = this.live(key);
    const next = Number(e?.value ?? 0) + 1;
    this.map.set(key, {
      value: String(next),
      expiresAt: e?.expiresAt ?? Date.now() + ttlSeconds * 1000,
    });
    return next;
  }
}

export class RedisKv implements KvStore {
  constructor(private readonly redis: {
    set(k: string, v: string, mode: 'EX', ttl: number, nx: 'NX'): Promise<'OK' | null>;
    get(k: string): Promise<string | null>;
    del(k: string): Promise<number>;
    incr(k: string): Promise<number>;
  }) {}

  async setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    return (await this.redis.set(key, value, 'EX', ttlSeconds, 'NX')) === 'OK';
  }
  async get(key: string) { return this.redis.get(key); }
  async del(key: string) { await this.redis.del(key); }
  /**
   * `INCR` then, on the first hit, a separate `EXPIRE` used to leave a window where a
   * crash or a dropped connection between the two calls left the key permanently
   * un-expiring - it only ever got an EXPIRE attempt when `n === 1`, and that moment
   * had already passed. For `otp:sends:${phone}`, the one place this really bites,
   * that turns a single transient blip into a phone number permanently unable to
   * request a login OTP again: every future call still increments a counter that
   * never resets, so it stays over MAX_SENDS_PER_HOUR forever.
   *
   * `SET key 0 EX ttl NX` establishes the TTL atomically WITH the key's creation, not
   * as a follow-up step - there is no window where the key exists without one. It
   * no-ops if the key is already there (an ordinary hit within the window), so this
   * two-round-trip version costs one extra call only on the very first increment.
   */
  async incr(key: string, ttlSeconds: number): Promise<number> {
    await this.redis.set(key, '0', 'EX', ttlSeconds, 'NX');
    return this.redis.incr(key);
  }
}
