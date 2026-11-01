import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ulid } from 'ulid';
import { makeHarness, type Harness } from '../../../test/harness';
import { bookings } from '../../../db/schema/index';
import { BookingReadController } from '../booking-read.controller';
import type { BookingState } from '@themaithil/contracts';

let h: Harness;
let ctl: BookingReadController;

const daysAgo = (n: number) =>
  new Date(Date.now() - n * 86_400_000 + 5.5 * 3600_000).toISOString().slice(0, 10);
const daysFromNow = (n: number) => daysAgo(-n);

/** A booking on this purohit's job list, in whatever state the test needs. */
const job = async (
  date: string, state: BookingState, over: Record<string, unknown> = {},
) => {
  await h.db.insert(bookings).values({
    id: ulid(),
    devoteeId: h.ids.devoteeId,
    panditId: h.ids.panditId,
    ritualId: h.ids.ritualId,
    cityId: h.ids.cityId,
    addressId: h.ids.addressId,
    date, slotIdx: 0,
    slotStartAt: new Date(`${date}T04:00:00Z`).toISOString(),
    slotEndAt: new Date(`${date}T07:00:00Z`).toISOString(),
    state,
    samagriOption: 'pandit_brings',
    paymentMode: 'cash',
    panjikaSchool: 'gupta_press',
    price: { totalPaise: 100000, tokenPaise: 10000 },
    // See `cash_completion_records_amount` in 9999_guards.sql.
    ...(state === 'completed' ? { cashCollectedPaise: 100000 } : {}),
    ...over,
  } as never);
};

beforeEach(async () => {
  h = await makeHarness();
  // Only the inbox read model is under test; the booking service and the
  // geocoder are not on this path.
  ctl = new BookingReadController(h.db, null as never, null as never);
}, 60_000);
afterEach(async () => { await h?.pg.close(); });

/**
 * THE BUG THIS COVERS. `/v1/me/jobs` carried no limit and no date bound on
 * `completed` — the one state in its filter that only ever grows, never clears —
 * so a purohit's entire career of finished pujas was re-fetched on every visit to
 * the one page the product calls daily use. Plain ascending `slotStartAt` order
 * made it worse: that whole history sorted BEFORE any upcoming job, burying the
 * one thing actually worth acting on under months of old completions.
 */
describe('the job inbox does not grow with a purohit\'s whole career', () => {
  const asPandit = () => ({ sub: h.ids.panditId } as never);

  it('caps at fifty rows rather than returning every completed job ever', async () => {
    for (let i = 0; i < 55; i++) {
      await job(daysAgo(i + 10), 'completed', { slotIdx: i % 4 });
    }
    const out = await ctl.jobs(asPandit());
    expect(out).toHaveLength(50);
  }, 30_000);

  it('keeps every active job ahead of the cap, however much history there is', async () => {
    // Fifty-five completed rows alone would already fill the limit; the one job
    // actually awaiting this purohit must not be the row that gets dropped.
    for (let i = 0; i < 55; i++) {
      await job(daysAgo(i + 10), 'completed', { slotIdx: i % 4 });
    }
    await job(daysFromNow(3), 'pending_accept', { slotIdx: 5 });

    const out = await ctl.jobs(asPandit());
    expect(out.some((b) => b.state === 'pending_accept')).toBe(true);
  }, 30_000);

  it('sorts active jobs ahead of completed ones, soonest first', async () => {
    await job(daysAgo(5), 'completed', { slotIdx: 0 });
    await job(daysFromNow(10), 'confirmed', { slotIdx: 1 });
    await job(daysFromNow(2), 'pending_accept', { slotIdx: 2 });

    const out = await ctl.jobs(asPandit());
    expect(out.map((b) => b.state)).toEqual(['pending_accept', 'confirmed', 'completed']);
  });

  it('sorts completed jobs most-recent-first, not oldest-first', async () => {
    await job(daysAgo(400), 'completed', { slotIdx: 0 });
    await job(daysAgo(5), 'completed', { slotIdx: 1 });
    await job(daysAgo(100), 'completed', { slotIdx: 2 });

    const out = await ctl.jobs(asPandit());
    expect(out.map((b) => b.date)).toEqual([daysAgo(5), daysAgo(100), daysAgo(400)]);
  });

  it('never leaks another purohit\'s jobs', async () => {
    await job(daysFromNow(2), 'pending_accept', { slotIdx: 0 });
    expect(await ctl.jobs({ sub: 'someone-else' } as never)).toEqual([]);
  });
});
