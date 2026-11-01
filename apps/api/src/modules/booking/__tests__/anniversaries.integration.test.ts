import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ulid } from 'ulid';
import { makeHarness, type Harness } from '../../../test/harness';
import { bookings } from '../../../db/schema/index';
import { BookingReadController } from '../booking-read.controller';

let h: Harness;
let ctl: BookingReadController;
let devoteeId: string;

const daysAgo = (n: number) =>
  new Date(Date.now() - n * 86_400_000 + 5.5 * 3600_000).toISOString().slice(0, 10);

/** A completed booking on a given date, for the harness devotee. */
const completed = async (date: string, over: Record<string, unknown> = {}) => {
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
    state: 'completed',
    samagriOption: 'pandit_brings',
    paymentMode: 'cash',
    panjikaSchool: 'gupta_press',
    price: { totalPaise: 100000, tokenPaise: 10000 },
    /*
     * `cash_completion_records_amount` in 9999_guards.sql: a completed cash booking
     * must record what was collected. The constraint is right and the fixture was
     * sloppy — a completed cash job with no recorded amount is a purohit holding
     * money the ledger cannot account for.
     */
    cashCollectedPaise: 100000,
    ...over,
  } as never);
};

beforeEach(async () => {
  h = await makeHarness();
  // Only the anniversaries read model is under test here; the booking service and
  // the geocoder are not on that path.
  ctl = new BookingReadController(h.db, null as never, null as never);
  devoteeId = h.ids.devoteeId;
}, 60_000);
afterEach(async () => { await h?.pg.close(); });

/**
 * Almost every ritual here is annual — Lakshmi Puja each Diwali, a shraddha on the
 * same tithi each year — and the product made a returning family search the
 * catalogue from scratch every time, treating the most predictable demand in the
 * business as a cold visit.
 */
describe('what this household did last year', () => {
  const asUser = () => ({ sub: devoteeId } as never);

  it('is empty for a devotee who has booked nothing', async () => {
    expect(await ctl.anniversaries(asUser())).toEqual([]);
  });

  it('surfaces a puja completed about a year ago', async () => {
    await completed(daysAgo(360));
    const out = await ctl.anniversaries(asUser());

    expect(out).toHaveLength(1);
    expect(out[0]!.dueNow).toBe(true);
    expect(out[0]!.name).toBeTruthy();
  });

  /** A booking from last month is a recent booking, not an anniversary. */
  it('ignores anything booked recently', async () => {
    await completed(daysAgo(30));
    expect(await ctl.anniversaries(asUser())).toEqual([]);
  });

  /** Ten months out is worth showing, but it is not due yet. */
  it('shows an approaching one without calling it due', async () => {
    await completed(daysAgo(260));
    const out = await ctl.anniversaries(asUser());
    expect(out).toHaveLength(1);
    expect(out[0]!.dueNow).toBe(false);
  });

  /**
   * Suggesting a repeat of a puja that was cancelled — or one we failed to staff —
   * is the platform reminding somebody of a bad experience and calling it a
   * recommendation.
   */
  it('never suggests repeating a booking that did not happen', async () => {
    // The enum has no bare 'cancelled'; who cancelled is part of the state.
    await completed(daysAgo(360), { state: 'cancelled_devotee' });
    expect(await ctl.anniversaries(asUser())).toEqual([]);
  });

  it('counts repeats and reports the most recent occurrence', async () => {
    await completed(daysAgo(740));
    await completed(daysAgo(370));
    const out = await ctl.anniversaries(asUser());

    expect(out).toHaveLength(1);
    expect(out[0]!.times).toBe(2);
    expect(out[0]!.lastBookedOn).toBe(daysAgo(370));
  });

  it('never leaks another household’s history', async () => {
    await completed(daysAgo(360));
    expect(await ctl.anniversaries({ sub: 'someone-else' } as never)).toEqual([]);
  });
});
