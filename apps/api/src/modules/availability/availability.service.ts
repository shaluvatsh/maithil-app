import { ulid } from 'ulid';
import { eq, and, gte, lte, inArray, sql } from 'drizzle-orm';
import type { Db, Executor } from '../../db/client';
import { availability, slotDefs, panditProfiles } from '../../db/schema/index';
import { DomainError, ErrorCode, type IsoDate, type SlotView } from '@themaithil/contracts';

/** IST. Single-city launch, so the offset is a constant rather than a tz library. */
const IST_OFFSET = '+05:30';

export const slotInstant = (date: IsoDate, time: string): Date =>
  new Date(`${date}T${time.length === 5 ? `${time}:00` : time}${IST_OFFSET}`);

export const addDays = (date: IsoDate, n: number): IsoDate => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10) as IsoDate;
};

export const today = (): IsoDate =>
  new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10) as IsoDate;

export class AvailabilityService {
  constructor(
    private readonly db: Db,
    private readonly horizonDays: number,
  ) {}

  /**
   * Materialise availability rows out to the booking horizon.
   *
   * Materialised rather than lazy because the FOR UPDATE lock in SlotService needs
   * rows to lock, and because travel buffers need somewhere to live.
   *
   * The horizon is the SAME constant the panchang job uses. In the original design
   * availability ran 60 days and panchang 90, so for a month devotees could see
   * auspicious dates with no bookable slots behind them.
   */
  async materialise(args: { panditId: string; cityId: string; from?: IsoDate }): Promise<number> {
    const start = args.from ?? today();
    const defs = await this.db.select().from(slotDefs)
      .where(and(eq(slotDefs.cityId, args.cityId), eq(slotDefs.active, true)))
      .orderBy(slotDefs.idx);
    if (defs.length === 0) {
      throw new DomainError(ErrorCode.NOT_FOUND, 'no slot definitions for this city');
    }

    const rows = [];
    for (let d = 0; d < this.horizonDays; d++) {
      const date = addDays(start, d);
      for (const def of defs) {
        rows.push({
          id: ulid(),
          panditId: args.panditId,
          date,
          slotIdx: def.idx,
          status: 'open' as const,
          source: 'default' as const,
          startsAt: slotInstant(date, def.startTime).toISOString(),
          endsAt: slotInstant(date, def.endTime).toISOString(),
        });
      }
    }

    // Chunked so a 120-day x 4-slot materialisation does not build one enormous
    // statement. onConflictDoNothing makes re-running the job free.
    let written = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const res = await this.db.insert(availability).values(rows.slice(i, i + 500))
        .onConflictDoNothing().returning({ id: availability.id });
      written += res.length;
    }
    return written;
  }

  async forRange(args: { panditId: string; from: IsoDate; to: IsoDate }) {
    const rows = await this.db.select().from(availability)
      .where(and(
        eq(availability.panditId, args.panditId),
        gte(availability.date, args.from),
        lte(availability.date, args.to),
      ))
      .orderBy(availability.date, availability.slotIdx);

    const byDate = new Map<string, SlotView[]>();
    for (const r of rows) {
      const list = byDate.get(r.date) ?? [];
      list.push({
        slotIdx: r.slotIdx,
        startsAt: r.startsAt,
        endsAt: r.endsAt,
        status: r.status,
        // Panchang annotations are layered on by PanchangService, which needs the
        // purohit's panjika school - so they are not this service's business.
        containsAbhijit: false,
        overlapsRahuKaal: false,
        bookingId: r.bookingId,
      });
      byDate.set(r.date, list);
    }
    return [...byDate.entries()].map(([date, slots]) => ({ date: date as IsoDate, slots }));
  }

  /** Purohit toggling their own slots. Booked slots are not toggleable. */
  async setSlots(args: {
    panditId: string;
    changes: Array<{ date: IsoDate; slotIdx: number; status: 'open' | 'closed' }>;
  }): Promise<number> {
    let updated = 0;
    for (const c of args.changes) {
      const res = await this.db.update(availability)
        .set({ status: c.status, source: 'manual' })
        .where(and(
          eq(availability.panditId, args.panditId),
          eq(availability.date, c.date),
          eq(availability.slotIdx, c.slotIdx),
          inArray(availability.status, ['open', 'closed']),
        ))
        .returning({ id: availability.id });
      updated += res.length;
    }
    return updated;
  }

  /**
   * Travel buffer. On confirmation we mark the neighbouring slot unavailable when
   * the gap is too small to cross the city.
   *
   * Note the published slot boundaries leave only 30 minutes between slots, which
   * cross-Kolkata travel routinely exceeds. So this fires often, and effective
   * capacity is 2-3 slots/day rather than 4. That is expected, not a bug - but the
   * purohit income model has to use the real number. See ADR 0006.
   */
  async applyTravelBuffer(tx: Executor, args: {
    panditId: string; date: IsoDate; slotIdx: number; slotSpan: number;
    travelMinutes: number;
  }): Promise<void> {
    const GAP_MINUTES = 30;
    if (args.travelMinutes <= GAP_MINUTES) return;

    const neighbours = [args.slotIdx - 1, args.slotIdx + args.slotSpan]
      .filter((i) => i >= 0 && i <= 3);
    if (neighbours.length === 0) return;

    await tx.update(availability)
      .set({ status: 'buffer', source: 'travel_buffer' })
      .where(and(
        eq(availability.panditId, args.panditId),
        eq(availability.date, args.date),
        inArray(availability.slotIdx, neighbours),
        eq(availability.status, 'open'),
      ));
  }

  /** Release buffers when the booking that caused them goes away. */
  async releaseBuffers(tx: Executor, args: { panditId: string; date: IsoDate }): Promise<void> {
    await tx.update(availability)
      .set({ status: 'open', source: 'manual' })
      .where(and(
        eq(availability.panditId, args.panditId),
        eq(availability.date, args.date),
        eq(availability.status, 'buffer'),
      ));
  }
}
