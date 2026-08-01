import { sql, and, eq, inArray } from 'drizzle-orm';
import type { Db, Executor } from '../db/client';
import { availability } from '../db/schema/index';
import { DomainError, ErrorCode } from '@themaithil/contracts';

/**
 * Slot reservation. This is the one place in the system where two devotees can
 * genuinely race, so it gets the most defensive treatment in the codebase.
 *
 * Three layers, deliberately redundant:
 *  1. A Redis soft hold taken at checkout (10 min TTL) - UX only, not correctness.
 *  2. SELECT ... FOR UPDATE on every slot in the span, ORDERED BY slot_idx.
 *     The ordering is what prevents deadlock between two overlapping spans.
 *  3. A UNIQUE index on (pandit_id, date, slot_idx) as the final backstop.
 *
 * If layer 3 ever fires, that is a paging alert - it should be unreachable.
 */
export class SlotService {
  /**
   * Lock and book a contiguous span. Call inside a transaction; the locks are held
   * until it commits.
   */
  async lockAndBook(tx: Executor, args: {
    panditId: string;
    date: string;
    slotIdx: number;
    slotSpan: number;
    bookingId: string;
  }): Promise<void> {
    const indices = Array.from({ length: args.slotSpan }, (_, i) => args.slotIdx + i);
    if (indices.some((i) => i > 3)) {
      throw new DomainError(
        ErrorCode.SLOT_UNAVAILABLE,
        `span of ${args.slotSpan} from slot ${args.slotIdx} runs past the end of the day`,
      );
    }

    // ORDER BY slot_idx is load-bearing: two concurrent bookings with overlapping
    // spans acquire locks in the same order and one simply waits.
    const locked = await tx
      .select({ id: availability.id, slotIdx: availability.slotIdx, status: availability.status })
      .from(availability)
      .where(and(
        eq(availability.panditId, args.panditId),
        eq(availability.date, args.date),
        inArray(availability.slotIdx, indices),
      ))
      .orderBy(availability.slotIdx)
      .for('update');

    if (locked.length !== indices.length) {
      throw new DomainError(
        ErrorCode.SLOT_UNAVAILABLE,
        'some slots in this span do not exist - the availability horizon may not reach this date',
        { requested: indices, found: locked.map((r) => r.slotIdx) },
      );
    }

    const taken = locked.filter((r) => r.status !== 'open');
    if (taken.length > 0) {
      throw new DomainError(
        ErrorCode.SLOT_UNAVAILABLE,
        'one or more slots were taken while you were checking out',
        { taken: taken.map((r) => r.slotIdx) },
      );
    }

    await tx.update(availability)
      .set({ status: 'booked', source: 'booking', bookingId: args.bookingId })
      .where(inArray(availability.id, locked.map((r) => r.id)));
  }

  /** Release on cancellation or expiry. Idempotent. */
  async release(tx: Executor, bookingId: string): Promise<void> {
    await tx.update(availability)
      .set({ status: 'open', source: 'manual', bookingId: null })
      .where(eq(availability.bookingId, bookingId));
  }
}

/**
 * Redis soft hold. Purely a UX device - it stops two people staring at the same
 * slot during checkout. Correctness never depends on it, because a Redis failure
 * must not be able to double-book a purohit.
 */
export const holdKey = (panditId: string, date: string, slotIdx: number) =>
  `hold:${panditId}:${date}:${slotIdx}`;

export const HOLD_TTL_SECONDS = 600;
