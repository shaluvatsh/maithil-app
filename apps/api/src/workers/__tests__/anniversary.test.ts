import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ulid } from 'ulid';
import { eq } from 'drizzle-orm';
import { makeHarness, type Harness } from '../../test/harness';
import { bookings, users, anniversaryNudges } from '../../db/schema/index';
import { AnniversaryJob } from '../anniversary.job';

let h: Harness;
let job: AnniversaryJob;

/** A completed booking `daysAgo` in the past, which is the only input this reads. */
async function completedBooking(daysAgo: number, over: Record<string, unknown> = {}) {
  const date = new Date(Date.now() + 5.5 * 3600_000 - daysAgo * 86_400_000)
    .toISOString().slice(0, 10);
  const id = ulid();
  await h.db.insert(bookings).values({
    id,
    devoteeId: h.ids.devoteeId,
    panditId: h.ids.panditId,
    ritualId: h.ids.ritualId,
    cityId: h.ids.cityId,
    addressId: h.ids.addressId,
    date,
    slotIdx: 1,
    slotSpan: 1,
    slotStartAt: `${date}T04:00:00.000Z`,
    slotEndAt: `${date}T06:00:00.000Z`,
    state: 'completed',
    panjikaSchool: 'gupta_press',
    samagriOption: 'pandit_brings',
    price: { tokenPaise: 0, totalPaise: 0, balancePaise: 0 },
    paymentMode: 'cash',
    // `cash_completion_records_amount` refuses a completed cash booking that does
    // not say what was collected. The guard is right; the fixture satisfies it.
    completedAt: `${date}T06:00:00.000Z`,
    cashCollectedPaise: 0,
    ...over,
  } as never);
  return id;
}

const sentAnniversaries = () =>
  h.notifications.channel.sent.filter((m) => m.templateKey === 'booking.anniversary');

beforeEach(async () => {
  h = await makeHarness();
  job = new AnniversaryJob(h.db, h.notifications);
});
afterEach(async () => { await h.pg.close(); });

/**
 * `GET /v1/me/anniversaries` has computed "you did this last year and the tithi is
 * coming round" since it was written. It rendered in a card on the home page and
 * nothing ever sent it — so the most predictable demand in the business depended on
 * a family opening the site, unprompted, in the right fortnight.
 */
describe('the anniversary nudge', () => {
  it('messages a household whose puja is a year old', async () => {
    await completedBooking(340);
    expect(await job.run()).toBe(1);
    expect(sentAnniversaries()).toHaveLength(1);
  });

  it('says nothing about a puja from three months ago', async () => {
    await completedBooking(90);
    expect(await job.run()).toBe(0);
    expect(sentAnniversaries()).toHaveLength(0);
  });

  it('stops after two years rather than reminding a lapsed family forever', async () => {
    // A card is something you scroll past; a WhatsApp message is something that
    // arrives. Annual reminders to someone who left is how a useful nudge becomes
    // the reason somebody blocks the sender.
    await completedBooking(900);
    expect(await job.run()).toBe(0);
    expect(sentAnniversaries()).toHaveLength(0);
  });

  it('sends once, however many times the job runs that year', async () => {
    await completedBooking(340);
    expect(await job.run()).toBe(1);
    expect(await job.run()).toBe(0);
    expect(await job.run()).toBe(0);
    expect(sentAnniversaries()).toHaveLength(1);
  });

  it('claims BEFORE sending, so a crash mid-batch cannot double-message', async () => {
    // The claim is the row, not a flag set afterwards: the failure mode we accept is
    // a nudge nobody gets, never one somebody gets twice.
    const failing = new AnniversaryJob(h.db, {
      send: async () => { throw new Error('BSP down'); },
    } as never);

    await completedBooking(340);
    await expect(failing.run()).rejects.toThrow('BSP down');

    const claims = await h.db.select().from(anniversaryNudges);
    expect(claims).toHaveLength(1);
    expect(await job.run()).toBe(0);
    expect(sentAnniversaries()).toHaveLength(0);
  });

  it('ignores a cancelled booking', async () => {
    // Suggesting a repeat of a puja we failed to staff is the platform reminding
    // somebody of a bad experience and calling it a recommendation.
    await completedBooking(340, { state: 'cancelled_pandit', cashCollectedPaise: null });
    expect(await job.run()).toBe(0);
  });

  it('ignores a deleted account', async () => {
    await completedBooking(340);
    await h.db.update(users).set({ deletedAt: new Date().toISOString() })
      .where(eq(users.id, h.ids.devoteeId));
    expect(await job.run()).toBe(0);
  });

  it('counts the household’s MOST RECENT booking of a ritual, not its first', async () => {
    // Two Satyanarayan Pujas: one two years ago, one last month. The family is a
    // current customer and must not be told their puja is due.
    await completedBooking(700);
    await completedBooking(30);
    expect(await job.run()).toBe(0);
  });
});
