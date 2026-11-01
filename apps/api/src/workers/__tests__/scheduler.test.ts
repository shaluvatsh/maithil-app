import { describe, it, expect, vi } from 'vitest';
import { Scheduler, LOCK_KEYS, type ScheduledJob } from '../scheduler';
import type { LeaderLock } from '../leader-lock';

const job = (over: Partial<ScheduledJob> = {}): ScheduledJob => ({
  name: 'test-job',
  intervalMs: 60_000,
  lockKey: 0x54455354,
  run: async () => 1,
  ...over,
});

/** A lock that grants or refuses, and records how it was used. */
function fakeLock(granted: boolean) {
  const calls = { acquired: 0, released: 0 };
  const lock: LeaderLock = {
    tryAcquire: async () => { calls.acquired++; return granted; },
    release: async () => { calls.released++; },
  };
  return { lock, calls };
}

describe('the scheduler', () => {
  it('runs a job', async () => {
    const run = vi.fn(async () => 3);
    await new Scheduler([job({ run })]).tick(job({ run }));
    expect(run).toHaveBeenCalledOnce();
  });

  it('does not run a job whose lock another instance holds', async () => {
    const run = vi.fn(async () => 1);
    const { lock, calls } = fakeLock(false);
    const j = job({ run });

    await new Scheduler([j], () => lock).tick(j);

    expect(run).not.toHaveBeenCalled();
    expect(calls.acquired).toBe(1);
    // Released even though it was never held, so the reserved connection goes back.
    expect(calls.released).toBe(1);
  });

  it('releases the lock when the job throws', async () => {
    // These run on a timer with no caller to return an error to, so a leaked lock
    // here would silently stop the job running on every instance, forever.
    const { lock, calls } = fakeLock(true);
    const j = job({ run: async () => { throw new Error('boom'); } });

    await new Scheduler([j], () => lock).tick(j);

    expect(calls.released).toBe(1);
  });

  it('swallows a failure rather than taking the process down with it', async () => {
    const j = job({ run: async () => { throw new Error('boom'); } });
    // No rejection: an unhandled one here is a crash of the API itself.
    await expect(new Scheduler([j]).tick(j)).resolves.toBeUndefined();
  });

  it('does not start a second run while the first is still going', async () => {
    let running = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });

    const j = job({
      run: async () => { running++; peak = Math.max(peak, running); await gate; running--; },
    });
    const scheduler = new Scheduler([j]);

    const first = scheduler.tick(j);
    await scheduler.tick(j);          // overlapping tick, must be skipped
    release();
    await first;

    expect(peak).toBe(1);
  });

  it('lets a skipped job run again on the next tick', async () => {
    // The skip must not be sticky — these are idempotent sweeps and the next tick
    // is what picks up whatever the last one left.
    const run = vi.fn(async () => 1);
    const j = job({ run });
    const scheduler = new Scheduler([j]);

    await scheduler.tick(j);
    await scheduler.tick(j);

    expect(run).toHaveBeenCalledTimes(2);
  });

  it('gives every job a distinct lock key', () => {
    // A collision is silent, and shows up as a job that mysteriously never runs on
    // a second instance.
    const keys = Object.values(LOCK_KEYS);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('takes a different lock for each job, so one slow sweep cannot block another', async () => {
    const seen: number[] = [];
    const scheduler = new Scheduler(
      [job({ name: 'a', lockKey: 1 }), job({ name: 'b', lockKey: 2 })],
      (key) => { seen.push(key); return fakeLock(true).lock; },
    );

    await scheduler.tick(job({ name: 'a', lockKey: 1 }));
    await scheduler.tick(job({ name: 'b', lockKey: 2 }));

    expect(seen).toEqual([1, 2]);
  });

  it('runs a runAtBoot job immediately and leaves the others to their timer', async () => {
    const eager = vi.fn(async () => 1);
    const patient = vi.fn(async () => 1);
    const scheduler = new Scheduler([
      job({ name: 'eager', run: eager, runAtBoot: true }),
      job({ name: 'patient', run: patient }),
    ]);

    scheduler.start();
    await vi.waitFor(() => expect(eager).toHaveBeenCalledOnce());
    expect(patient).not.toHaveBeenCalled();
    scheduler.stop();
  });
});
