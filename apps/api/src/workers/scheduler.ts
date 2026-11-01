import { Logger } from '@nestjs/common';
import type { LeaderLock } from './leader-lock';

/**
 * The periodic-job runner.
 *
 * There was none. `expireStaleAccepts`, `publishExpired`, `enforceCreditLimit` and
 * the KYC document purge were all written, tested, and referenced by nothing but
 * their own definitions — `main.ts` started the outbox relay and the panchang job
 * and stopped there. So accept windows never expired, one-sided reviews never
 * published (leaving a purohit's rating frozen whenever the other party stayed
 * quiet), cash credit limits were never enforced, and identity documents were kept
 * indefinitely against an ADR that promises a thirty-day purge.
 *
 * Every job here is a job that already existed. This is the wiring, not new
 * behaviour — with one exception, the anniversary nudge, which is new.
 *
 * WHY EACH JOB TAKES ITS OWN LOCK. `PanchangJob` already carries the argument for
 * leader election (see its constructor). The same reasoning applies to every job
 * below, but the lock has to be PER JOB, not one lock for the runner: a single
 * shared key would mean a slow purge sweep blocked the accept-expiry sweep on
 * another instance, and a job that runs hourly would starve one that runs every
 * minute. Distinct keys let two instances each make progress on different work.
 */
export interface ScheduledJob {
  /** Appears in the log line; keep it short and greppable. */
  name: string;
  intervalMs: number;
  /**
   * Any fixed bigint, distinct per job. Spelled as ASCII so a `pg_locks` row is
   * readable at 2am rather than being an anonymous number.
   */
  lockKey: number;
  /** Returning a count makes the log line useful; returning nothing is fine. */
  run(): Promise<number | void>;
  /**
   * Whether to run once at boot rather than waiting out the first interval.
   *
   * Default false, deliberately. A deploy restarts the process, and a job that
   * sweeps at boot turns a rolling deploy into a thundering herd of sweeps. Only
   * jobs whose lateness is actually costly (an accept window that should already
   * have expired) opt in.
   */
  runAtBoot?: boolean;
}

export class Scheduler {
  private readonly log = new Logger('scheduler');
  private readonly timers: NodeJS.Timeout[] = [];
  /** Guards against a slow run overlapping its own next tick. Keyed by job name. */
  private readonly running = new Set<string>();

  constructor(
    private readonly jobs: readonly ScheduledJob[],
    /**
     * Builds the lock for a job's key. A factory rather than a lock instance
     * because each job needs its own, and rather than a `Db` because that would
     * make every test of this class need a real Postgres to take a lock against.
     * Omitted means "always leader", which is only correct for a single instance.
     */
    private readonly lockFor?: (key: number) => LeaderLock,
  ) {}

  start() {
    for (const job of this.jobs) {
      if (job.runAtBoot) void this.tick(job);
      this.timers.push(setInterval(() => void this.tick(job), job.intervalMs));
    }
    this.log.log(`started ${this.jobs.length} jobs: ${this.jobs.map((j) => j.name).join(', ')}`);
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
  }

  /**
   * One attempt at one job.
   *
   * Public so a test can drive a single run deterministically instead of waiting
   * on a timer, and so an admin endpoint could later trigger a sweep by hand.
   */
  async tick(job: ScheduledJob): Promise<void> {
    if (this.running.has(job.name)) {
      // The previous run has not finished. Skipping is right: these are all
      // idempotent sweeps, so the next tick picks up whatever this one leaves.
      this.log.warn(`${job.name} is still running; skipping this tick`);
      return;
    }
    this.running.add(job.name);

    const lock = this.lockFor?.(job.lockKey);
    try {
      if (lock && !(await lock.tryAcquire())) return;   // another instance has it
      const result = await job.run();
      if (typeof result === 'number' && result > 0) {
        this.log.log(`${job.name}: ${result}`);
      }
    } catch (e) {
      /*
       * One job failing must never stop the others, and must never take the
       * process down. These run on a timer with no caller to return an error to,
       * so an unhandled rejection here is a crash of the API itself.
       */
      this.log.error(
        `${job.name} failed`,
        e instanceof Error ? e.stack : String(e),
      );
    } finally {
      await lock?.release();
      this.running.delete(job.name);
    }
  }
}

/**
 * Lock keys, one per job.
 *
 * Spelled as four ASCII bytes each, the same convention `main.ts` already uses for
 * the panchang job (`0x50414e43`, "PANC"). Collisions are silent and would show up
 * as a job mysteriously never running on a second instance, so they live together
 * here rather than being written inline at each call site.
 */
export const LOCK_KEYS = {
  /** "EXPS" — expire stale accepts. */
  expireAccepts: 0x45585053,
  /** "RVWS" — publish one-sided reviews past the window. */
  publishReviews: 0x52565753,
  /** "CRDT" — cash credit limits. */
  creditLimits: 0x43524454,
  /** "KYCG" — purge KYC document images past their retention date. */
  kycPurge: 0x4b594347,
  /** "ANIV" — the anniversary nudge. */
  anniversary: 0x414e4956,
  /** "JOIN" — chasing a missing join link on a remote booking. */
  joinLink: 0x4a4f494e,
  /** "RMND" — the day-before reminder to the devotee. */
  reminder: 0x524d4e44,
  /** "SERI" — issuing each later day's code in a multi-day series. */
  seriesCodes: 0x53455249,
} as const;
