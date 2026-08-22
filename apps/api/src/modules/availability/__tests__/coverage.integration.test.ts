import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { makeHarness, daysFromNow, type Harness } from '../../../test/harness';
import { availability, panditProfiles } from '../../../db/schema/index';
import { AvailabilityService } from '../availability.service';

let h: Harness;
let svc: AvailabilityService;
let panditId: string;
let cityId: string;
const DAY = daysFromNow(1);

beforeEach(async () => {
  h = await makeHarness();
  svc = new AvailabilityService(h.db, 30);
  ({ panditId, cityId } = h.ids);
  await svc.materialise({ panditId, cityId });
}, 60_000);
afterEach(async () => { await h?.pg.close(); });

/**
 * A purohit could open their whole calendar and had no way to close a single
 * afternoon. "Mark me unavailable next Tuesday" is the commonest thing a working
 * purohit needs to say, and both `forRange` and `setSlots` existed in this service
 * with no HTTP route reaching either.
 */
describe('a purohit editing their own slots', () => {
  it('closes one slot without touching the rest of the day', async () => {
    const updated = await svc.setSlots({
      panditId, changes: [{ date: DAY as never, slotIdx: 1, status: 'closed' }],
    });
    expect(updated).toBe(1);

    const [day] = await svc.forRange({ panditId, from: DAY as never, to: DAY as never });
    expect(day!.slots.find((s) => s.slotIdx === 1)!.status).toBe('closed');
    expect(day!.slots.find((s) => s.slotIdx === 0)!.status).toBe('open');
  });

  /**
   * The batching rewrite groups changes by target status. Without a (date, slotIdx)
   * pair predicate, closing slot 2 on Tuesday would close slot 2 on every date in
   * the batch — silently, and only visible when a devotee could not book.
   */
  it('applies each change to its own date, not to every date in the batch', async () => {
    const d1 = daysFromNow(1);
    const d2 = daysFromNow(2);
    await svc.setSlots({
      panditId,
      changes: [
        { date: d1 as never, slotIdx: 2, status: 'closed' },
        { date: d2 as never, slotIdx: 0, status: 'closed' },
      ],
    });

    const days = await svc.forRange({ panditId, from: d1 as never, to: d2 as never });
    const one = days.find((d) => d.date === d1)!;
    const two = days.find((d) => d.date === d2)!;

    expect(one.slots.find((s) => s.slotIdx === 2)!.status).toBe('closed');
    expect(one.slots.find((s) => s.slotIdx === 0)!.status).toBe('open');
    expect(two.slots.find((s) => s.slotIdx === 0)!.status).toBe('closed');
    expect(two.slots.find((s) => s.slotIdx === 2)!.status).toBe('open');
  });

  it('reopens a slot it closed', async () => {
    await svc.setSlots({ panditId, changes: [{ date: DAY as never, slotIdx: 1, status: 'closed' }] });
    const back = await svc.setSlots({
      panditId, changes: [{ date: DAY as never, slotIdx: 1, status: 'open' }],
    });
    expect(back).toBe(1);
  });

  /** A booked slot is somebody's confirmed puja; it is not a toggle. */
  it('refuses to change a booked slot', async () => {
    await h.db.update(availability).set({ status: 'booked' })
      .where(and(eq(availability.panditId, panditId), eq(availability.date, DAY as never),
        eq(availability.slotIdx, 3)));

    const updated = await svc.setSlots({
      panditId, changes: [{ date: DAY as never, slotIdx: 3, status: 'closed' }],
    });
    expect(updated, 'a confirmed booking was released by a calendar toggle').toBe(0);
  });

  it('never edits another purohit’s calendar', async () => {
    const updated = await svc.setSlots({
      panditId: 'someone-else',
      changes: [{ date: DAY as never, slotIdx: 0, status: 'closed' }],
    });
    expect(updated).toBe(0);
  });
});

/**
 * The console showed bookings and a ledger — records of what already happened.
 * Neither answers which days are about to run out of purohits, which is the only
 * version of the question that is still actionable.
 */
describe('supply coverage for an operator', () => {
  it('counts open, booked and blocked slots per day', async () => {
    const rows = await svc.coverage({ cityId, from: DAY as never, to: DAY as never });
    const day = rows.find((r) => r.date === DAY)!;

    expect(day.purohits).toBe(1);
    expect(day.openSlots).toBeGreaterThan(0);
    expect(day.bookedSlots).toBe(0);
    expect(day.utilisation).toBe(0);
  });

  it('moves a slot from open to booked in the totals', async () => {
    const before = (await svc.coverage({ cityId, from: DAY as never, to: DAY as never }))[0]!;
    await h.db.update(availability).set({ status: 'booked' })
      .where(and(eq(availability.panditId, panditId), eq(availability.date, DAY as never),
        eq(availability.slotIdx, 0)));

    const after = (await svc.coverage({ cityId, from: DAY as never, to: DAY as never }))[0]!;
    expect(after.bookedSlots).toBeGreaterThan(before.bookedSlots);
    expect(after.openSlots).toBeLessThan(before.openSlots);
    expect(after.utilisation!).toBeGreaterThan(0);
  });

  /**
   * Counting pending KYC as supply is how a city looks covered and then cannot
   * fulfil — the operator rings nobody because the number looked fine.
   */
  it('counts only verified purohits as supply', async () => {
    await h.db.update(panditProfiles).set({ kycStatus: 'pending' });
    expect(await svc.coverage({ cityId, from: DAY as never, to: DAY as never })).toEqual([]);
  });

  it('returns nothing for a city with no calendars, rather than zeroes', async () => {
    expect(await svc.coverage({ cityId: 'nowhere', from: DAY as never, to: DAY as never }))
      .toEqual([]);
  });
});

/**
 * A purohit declaring a date the materialiser has never reached.
 *
 * Slots only came into existence through `materialise()` — an all-or-nothing "open
 * my whole calendar for the next 30 days" — and `setSlots` could only UPDATE what
 * already existed. So a purohit looking at any date outside that window was told
 * their calendar was not open, and the only remedy on offer opened every date at
 * once. "I am free on the 20th, morning only" had no expression at all.
 */
describe('opening a slot that does not exist yet', () => {
  const FAR = daysFromNow(90);

  /*
   * Cleared rather than assumed.
   *
   * The first version of this picked a date "past the horizon" and asserted the
   * range was empty — which failed, because the harness materialises with its own
   * `BOOKING_HORIZON_DAYS` and not the one this service was constructed with. A
   * test that guesses at a fixture's reach is testing the fixture. Deleting the
   * rows states the precondition instead of hoping for it.
   */
  beforeEach(async () => {
    await h.db.delete(availability).where(eq(availability.date, FAR as never));
  });

  it('creates the row when a purohit opens an undeclared slot', async () => {
    expect(await svc.forRange({ panditId, from: FAR as never, to: FAR as never })).toEqual([]);

    const created = await svc.setSlots({
      panditId, cityId,
      changes: [{ date: FAR as never, slotIdx: 1, status: 'open' }],
    });
    expect(created).toBe(1);

    const [day] = await svc.forRange({ panditId, from: FAR as never, to: FAR as never });
    expect(day!.slots).toHaveLength(1);
    expect(day!.slots[0]!.status).toBe('open');
  });

  /**
   * Times come from the city's own `slot_defs`, never from the request: a purohit
   * may only offer the hours the city publishes, and an arbitrary window in the
   * column the booking engine locks on is a double-booking waiting to happen.
   */
  it('takes the times from the city, not from the caller', async () => {
    await svc.setSlots({
      panditId, cityId, changes: [{ date: FAR as never, slotIdx: 0, status: 'open' }],
    });
    const [day] = await svc.forRange({ panditId, from: FAR as never, to: FAR as never });
    const slot = day!.slots.find((s) => s.slotIdx === 0)!;

    expect(slot.startsAt).toBeTruthy();
    expect(new Date(slot.endsAt).getTime())
      .toBeGreaterThan(new Date(slot.startsAt).getTime());
  });

  /**
   * Closing does not create. There is nothing to close, and writing a `closed` row
   * for every date a purohit merely looked at would fill the table with
   * declarations of absence.
   */
  it('does not write a row when closing an undeclared slot', async () => {
    const closed = await svc.setSlots({
      panditId, cityId,
      changes: [{ date: FAR as never, slotIdx: 2, status: 'closed' }],
    });
    expect(closed).toBe(0);
    expect(await svc.forRange({ panditId, from: FAR as never, to: FAR as never })).toEqual([]);
  });

  it('refuses a slot index the city does not publish', async () => {
    const created = await svc.setSlots({
      panditId, cityId,
      changes: [{ date: FAR as never, slotIdx: 7, status: 'open' }],
    });
    expect(created, 'an invented slot index became a lockable row').toBe(0);
  });

  it('is idempotent — opening the same slot twice writes one row', async () => {
    await svc.setSlots({ panditId, cityId, changes: [{ date: FAR as never, slotIdx: 1, status: 'open' }] });
    await svc.setSlots({ panditId, cityId, changes: [{ date: FAR as never, slotIdx: 1, status: 'open' }] });

    const [day] = await svc.forRange({ panditId, from: FAR as never, to: FAR as never });
    expect(day!.slots.filter((s) => s.slotIdx === 1)).toHaveLength(1);
  });

  /** Without a city we cannot know the hours, so we must not guess them. */
  it('creates nothing when no city is supplied', async () => {
    expect(await svc.setSlots({
      panditId, changes: [{ date: FAR as never, slotIdx: 1, status: 'open' }],
    })).toBe(0);
  });
});

/**
 * The gig-work shape: state a repeating shift once, let the system project it
 * forward, override single days by exception.
 *
 * Availability is stored per (date, slot) — right for booking, because a lock has
 * to land on a specific afternoon, and useless for declaring. "I work Tuesday and
 * Thursday mornings" is one sentence and took 120 taps to say.
 */
describe('a purohit’s usual working week', () => {
  const weekdayOf = (iso: string) => new Date(`${iso}T12:00:00Z`).getUTCDay();

  it('starts empty', async () => {
    expect(await svc.weeklyPattern(panditId)).toEqual([]);
  });

  it('stores what was set and reads it back', async () => {
    await svc.setWeeklyPattern({
      panditId, cityId,
      pattern: [{ weekday: 2, slotIdx: 0 }, { weekday: 4, slotIdx: 1 }],
    });
    expect(await svc.weeklyPattern(panditId)).toEqual([
      { weekday: 2, slotIdx: 0 },
      { weekday: 4, slotIdx: 1 },
    ]);
  });

  /** The whole point: one sentence fills a month. */
  it('projects the pattern across the horizon', async () => {
    await svc.setWeeklyPattern({ panditId, cityId, pattern: [{ weekday: 2, slotIdx: 0 }] });

    const days = await svc.forRange({ panditId, from: daysFromNow(0) as never, to: daysFromNow(20) as never });
    const tuesdays = days.filter((d) => weekdayOf(d.date) === 2);
    expect(tuesdays.length).toBeGreaterThan(1);

    for (const d of tuesdays) {
      expect(d.slots.find((s) => s.slotIdx === 0)!.status, `${d.date} slot 0`).toBe('open');
    }
  });

  /** A weekday the pattern is silent about is a weekday they do not work. */
  it('closes the slots the pattern does not name', async () => {
    await svc.setWeeklyPattern({ panditId, cityId, pattern: [{ weekday: 2, slotIdx: 0 }] });

    const days = await svc.forRange({ panditId, from: daysFromNow(0) as never, to: daysFromNow(20) as never });
    const wednesday = days.find((d) => weekdayOf(d.date) === 3)!;
    expect(wednesday.slots.every((s) => s.status !== 'open')).toBe(true);
  });

  /**
   * The other half of "only slots the pattern speaks about are changed" — a
   * purohit who opens a one-off day BY HAND, outside their normal pattern, must
   * not find it silently closed the next time they touch that pattern for an
   * unrelated reason. `applyWeeklyPattern` closed every (weekday, slot) the
   * pattern was silent about with no regard for how a currently-open row got that
   * way, so this exact exception used to vanish.
   */
  it('does not close a day the purohit opened by hand outside the pattern', async () => {
    await svc.setWeeklyPattern({ panditId, cityId, pattern: [{ weekday: 2, slotIdx: 0 }] });

    const days = await svc.forRange({ panditId, from: daysFromNow(0) as never, to: daysFromNow(20) as never });
    const saturday = days.find((d) => weekdayOf(d.date) === 6)!;
    // A favour: open one Saturday slot that is not part of the usual week.
    await svc.setSlots({
      panditId, cityId,
      changes: [{ date: saturday.date, slotIdx: 0, status: 'open' }],
    });

    // Editing an UNRELATED day (Thursday) regenerates the whole horizon.
    await svc.setWeeklyPattern({
      panditId, cityId,
      pattern: [{ weekday: 2, slotIdx: 0 }, { weekday: 4, slotIdx: 0 }],
    });

    const [after] = await svc.forRange({ panditId, from: saturday.date, to: saturday.date });
    expect(after!.slots.find((s) => s.slotIdx === 0)!.status,
      'a manually opened exception was closed by an unrelated pattern edit').toBe('open');
  });

  /**
   * The trap a naive fix for the test above falls into: tagging every pattern
   * write 'manual' (the same tag a purohit's OWN direct edit uses) would make a
   * day the pattern itself most recently opened indistinguishable from a genuine
   * one-off exception - so removing that day from the pattern on the very next
   * edit would wrongly leave it open forever. Pattern writes are tagged
   * 'recurring', precisely so this case is NOT protected the way a real manual
   * exception is.
   */
  it('does close a day the PATTERN itself opened, once the pattern removes it', async () => {
    await svc.setWeeklyPattern({
      panditId, cityId, pattern: [{ weekday: 2, slotIdx: 0 }, { weekday: 3, slotIdx: 0 }],
    });
    // Now remove Wednesday - a pattern edit, not a manual one-off.
    await svc.setWeeklyPattern({ panditId, cityId, pattern: [{ weekday: 2, slotIdx: 0 }] });

    const days = await svc.forRange({ panditId, from: daysFromNow(0) as never, to: daysFromNow(20) as never });
    const wednesday = days.find((d) => weekdayOf(d.date) === 3)!;
    expect(wednesday.slots.find((s) => s.slotIdx === 0)!.status,
      'a day the pattern itself opened was mistaken for a manual exception').toBe('closed');
  });

  /** Replacing the pattern means replacing it, not merging into the old one. */
  it('treats the saved pattern as the complete week', async () => {
    await svc.setWeeklyPattern({ panditId, cityId, pattern: [{ weekday: 2, slotIdx: 0 }] });
    await svc.setWeeklyPattern({ panditId, cityId, pattern: [{ weekday: 4, slotIdx: 0 }] });

    expect(await svc.weeklyPattern(panditId)).toEqual([{ weekday: 4, slotIdx: 0 }]);

    const days = await svc.forRange({ panditId, from: daysFromNow(0) as never, to: daysFromNow(20) as never });
    const tuesday = days.find((d) => weekdayOf(d.date) === 2)!;
    expect(tuesday.slots.find((s) => s.slotIdx === 0)!.status).toBe('closed');
  });

  /**
   * THE rule that matters. Regenerating a calendar from a pattern that has since
   * changed must never release a confirmed puja out from under a devotee — the
   * worst thing this codebase could do.
   */
  it('never releases a booked slot, whatever the pattern says', async () => {
    const day = daysFromNow(3);
    await h.db.update(availability).set({ status: 'booked' })
      .where(and(eq(availability.panditId, panditId), eq(availability.date, day as never),
        eq(availability.slotIdx, 0)));

    // A pattern that says they never work — the most destructive possible edit.
    await svc.setWeeklyPattern({ panditId, cityId, pattern: [] });

    const [after] = await svc.forRange({ panditId, from: day as never, to: day as never });
    expect(after!.slots.find((s) => s.slotIdx === 0)!.status,
      'a confirmed booking was released by a calendar rule').toBe('booked');
  });

  /**
   * The harness materialises every slot as `open`, so a first pattern save mostly
   * CLOSES things — `opened` is legitimately 0 because those Tuesdays were already
   * open. Asserting otherwise was testing my assumption about the fixture rather
   * than the behaviour.
   */
  it('reports what actually moved, not what was asked for', async () => {
    const first = await svc.setWeeklyPattern({
      panditId, cityId, pattern: [{ weekday: 2, slotIdx: 0 }],
    });
    expect(first.closed, 'everything not in the pattern should close').toBeGreaterThan(0);
    expect(first.opened, 'those Tuesdays were already open').toBe(0);

    // Now that the week is mostly closed, adding a day is a real opening.
    const second = await svc.setWeeklyPattern({
      panditId, cityId,
      pattern: [{ weekday: 2, slotIdx: 0 }, { weekday: 4, slotIdx: 0 }],
    });
    expect(second.opened, 'adding Thursday should open Thursdays').toBeGreaterThan(0);
  });

  it('is idempotent — saving the same week twice changes nothing the second time', async () => {
    await svc.setWeeklyPattern({ panditId, cityId, pattern: [{ weekday: 2, slotIdx: 0 }] });
    const second = await svc.setWeeklyPattern({
      panditId, cityId, pattern: [{ weekday: 2, slotIdx: 0 }],
    });
    // Everything is already in the target state, so nothing is updated.
    expect(second.opened + second.closed).toBe(0);
  });

  it('can be re-applied as the horizon rolls forward, without re-saving', async () => {
    await svc.setWeeklyPattern({ panditId, cityId, pattern: [{ weekday: 2, slotIdx: 0 }] });
    await expect(svc.applyWeeklyPattern({ panditId, cityId })).resolves.toBeTruthy();
  });
});
