import { describe, it, expect, vi } from 'vitest';
import { activeRegions } from '@themaithil/region';
import { PanchangJob } from '../panchang.job';

/**
 * The job took a single `citySlug` and materialised only that one. The city picker
 * offers fourteen, so thirteen had no panchang at all: the home page's almanac card
 * and the whole `/panchang` route rendered empty the moment a devotee switched away
 * from the launch city. Nothing errored — the feature was simply absent everywhere
 * except where a developer had seeded it.
 */
const fake = (fail: string[] = []) => {
  const seen: string[] = [];
  const svc = {
    materialise: vi.fn(async ({ citySlug }: { citySlug: string }) => {
      seen.push(citySlug);
      if (fail.includes(citySlug)) throw new Error(`no config for ${citySlug}`);
      return { days: 30, intervals: 60 };
    }),
    reconcileSchools: vi.fn(async () => 0),
  };
  return { svc, seen };
};

describe('the nightly panchang job', () => {
  it('covers every active region, not just the launch city', async () => {
    const { svc, seen } = fake();
    await new PanchangJob(svc as never, 'kolkata', 30).runOnce();

    const expected = activeRegions().map((r) => r.slug).sort();
    expect(seen.length).toBeGreaterThan(1);
    expect([...seen].sort()).toEqual(expected);
  });

  it('materialises the launch city first, so it is warm soonest', async () => {
    const { svc, seen } = fake();
    await new PanchangJob(svc as never, 'kolkata', 30).runOnce();
    expect(seen[0]).toBe('kolkata');
  });

  it('does not materialise the launch city twice', async () => {
    const { seen, svc } = fake();
    await new PanchangJob(svc as never, 'kolkata', 30).runOnce();
    expect(seen.filter((s) => s === 'kolkata')).toHaveLength(1);
  });

  /** A bad region config should cost that city its almanac, not the country's. */
  it('carries on after one city fails', async () => {
    const all = activeRegions().map((r) => r.slug);
    const victim = all.find((s) => s !== 'kolkata')!;
    const { svc, seen } = fake([victim]);

    const ok = await new PanchangJob(svc as never, 'kolkata', 30).runOnce();

    expect(seen).toHaveLength(all.length);
    expect(ok).toBe(all.length - 1);
  });

  it('reconciles each city it materialised', async () => {
    const { svc } = fake();
    await new PanchangJob(svc as never, 'kolkata', 30).runOnce();
    expect(svc.reconcileSchools).toHaveBeenCalledTimes(activeRegions().length);
  });

  /**
   * `PgAdvisoryLock` itself needs a real Postgres connection to reserve (see
   * leader-lock.ts) and so cannot run against the pglite harness this suite uses -
   * but the JOB's contract with whatever lock it is given can be verified with a
   * fake one, which is the behaviour that actually matters here: does the job obey
   * the lock, not how the lock talks to Postgres.
   */
  it('does no work at all when another instance already holds the lock', async () => {
    const { svc, seen } = fake();
    const lock = { tryAcquire: vi.fn(async () => false), release: vi.fn(async () => {}) };

    const ok = await new PanchangJob(svc as never, 'kolkata', 30, lock).runOnce();

    expect(seen).toHaveLength(0);
    expect(ok).toBe(0);
    expect(lock.release).not.toHaveBeenCalled();
  });

  it('releases the lock after a successful run', async () => {
    const { svc, seen } = fake();
    const lock = { tryAcquire: vi.fn(async () => true), release: vi.fn(async () => {}) };

    await new PanchangJob(svc as never, 'kolkata', 30, lock).runOnce();

    expect(seen.length).toBeGreaterThan(0);
    expect(lock.release).toHaveBeenCalledTimes(1);
  });

  it('releases the lock even when materialisation throws', async () => {
    const svc = {
      materialise: vi.fn(async () => { throw new Error('boom'); }),
      reconcileSchools: vi.fn(async () => 0),
    };
    const lock = { tryAcquire: vi.fn(async () => true), release: vi.fn(async () => {}) };

    // Per-city failures are caught internally and do not throw out of runOnce, so
    // this exercises the `finally` path rather than an actual escaping error.
    await new PanchangJob(svc as never, 'kolkata', 30, lock).runOnce();

    expect(lock.release).toHaveBeenCalledTimes(1);
  });

  /** Sequential: fourteen concurrent batches at boot compete with real requests. */
  it('runs one city at a time', async () => {
    let inFlight = 0;
    let peak = 0;
    const svc = {
      materialise: vi.fn(async () => {
        peak = Math.max(peak, ++inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
        return { days: 1, intervals: 1 };
      }),
      reconcileSchools: vi.fn(async () => 0),
    };
    await new PanchangJob(svc as never, 'kolkata', 30).runOnce();
    expect(peak).toBe(1);
  });
});
