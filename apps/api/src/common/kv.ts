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
    expire(k: string, ttl: number): Promise<number>;
  }) {}

  async setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    return (await this.redis.set(key, value, 'EX', ttlSeconds, 'NX')) === 'OK';
  }
  async get(key: string) { return this.redis.get(key); }
  async del(key: string) { await this.redis.del(key); }
  async incr(key: string, ttlSeconds: number): Promise<number> {
    const n = await this.redis.incr(key);
    if (n === 1) await this.redis.expire(key, ttlSeconds);
    return n;
  }
}
