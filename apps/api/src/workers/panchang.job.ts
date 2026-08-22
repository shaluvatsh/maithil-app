import { Logger } from '@nestjs/common';
import { activeRegions } from '@themaithil/region';
import type { PanchangService } from '../modules/panchang/panchang.service';
import type { LeaderLock } from './leader-lock';

/**
 * Nightly panchang materialisation, for every city we serve.
 *
 * This took a single `citySlug` — LAUNCH_CITY_SLUG — and materialised only that.
 * The city picker offers fourteen, so thirteen of them had no panchang at all: the
 * home page's almanac card and the whole `/panchang` route rendered empty the
 * moment a devotee switched to Mumbai or Patna. Nothing errored. The feature was
 * simply absent everywhere except the one city a developer had seeded.
 *
 * Runs on the same BOOKING_HORIZON_DAYS the availability job uses, so a devotee can
 * never see an auspicious date on the panchang tab with no bookable slots behind it.
 */
export class PanchangJob {
  private readonly log = new Logger('panchang');
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly panchang: PanchangService,
    /** Materialised first, so the launch city is warm before the rest. */
    private readonly citySlug: string,
    private readonly horizonDays: number,
    /**
     * No leader election, ever - the single most severe finding in
     * docs/ARCHITECTURE-REVIEW.md. This job does DELETE then bulk INSERT over the
     * same date window, and `panchang_intervals` carries a GiST exclusion
     * constraint forbidding overlaps. Two instances running it concurrently
     * deadlock or violate the constraint, and in the window between delete and
     * insert the panchang tab serves nothing - and the moment a second Fly machine
     * starts for availability, not even for load, this is exactly what happens.
     *
     * Optional so every existing unit test - which fakes `PanchangService` and has
     * no real Postgres to take a lock against - keeps working unchanged; omitting
     * it means "always leader," which is only ever correct for a single-instance
     * caller. `main.ts` always constructs a real one.
     */
    private readonly lock?: LeaderLock,
  ) {}

  start(intervalMs = 6 * 3600_000) {
    void this.runOnce();                       // catch up at boot
    this.timer = setInterval(() => void this.runOnce(), intervalMs);
  }
  stop() { if (this.timer) clearInterval(this.timer); }

  /** Launch city first, then every other active region, each deduplicated. */
  private cities(): string[] {
    const rest = activeRegions().map((r) => r.slug).filter((s) => s !== this.citySlug);
    return [this.citySlug, ...rest];
  }

  async runOnce() {
    if (this.lock && !(await this.lock.tryAcquire())) {
      this.log.log('another instance already holds the panchang lock; skipping this run');
      return 0;
    }
    try {
      return await this.materialiseAll();
    } finally {
      await this.lock?.release();
    }
  }

  private async materialiseAll() {
    const from = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
    let ok = 0;

    /**
     * Sequential, not `Promise.all`. Each city is a few hundred upserts against one
     * pool; running fourteen at once at boot competes with the requests the process
     * is there to serve, and a slow start-up is cheaper than a stalled one.
     *
     * One city failing must not stop the others — a bad region config should cost
     * that city its almanac, not the whole country's.
     */
    for (const slug of this.cities()) {
      try {
        const res = await this.panchang.materialise({
          citySlug: slug, from: from as never, days: this.horizonDays,
        });
        await this.panchang.reconcileSchools(slug);
        ok++;
        this.log.log(`${slug}: ${res.days} days, ${res.intervals} intervals from ${from}`);
      } catch (e) {
        this.log.error(
          `${slug}: materialisation failed`,
          e instanceof Error ? e.stack : String(e),
        );
      }
    }

    this.log.log(`panchang materialised for ${ok}/${this.cities().length} cities`);
    return ok;
  }
}
