import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeHarness, daysFromNow, type Harness } from '../../../test/harness';
import { reviews, panditProfiles, bookings } from '../../../db/schema/index';
import { ReviewsService } from '../reviews.service';

let h: Harness;
let service: ReviewsService;

const completed = async (slotIdx = 1) => {
  const d = await h.bookings.createDraft({
    panditId: h.ids.panditId, ritualId: h.ids.ritualId, addressId: h.ids.addressId,
    date: daysFromNow(5 + slotIdx), slotIdx, samagriOption: 'pandit_brings',
    paymentMode: 'cash', attendeeCount: 10,
    devoteeId: h.ids.devoteeId, citySlug: 'kolkata',
  } as never);
  await h.bookings.submit(d.id, h.ids.devoteeId);
  await h.bookings.accept(d.id, h.ids.panditId);
  const c = await h.bookings.confirmOnTokenCapture({ bookingId: d.id, paymentIntentId: `pi_${d.id}` });
  await h.bookings.start({ bookingId: d.id, panditId: h.ids.panditId, otp: c.startOtp! });
  await h.bookings.complete({
    bookingId: d.id, panditId: h.ids.panditId, otp: c.completeOtp!,
    cashCollectedPaise: d.price.balancePaise, capturedAt: new Date().toISOString(),
  });
  return d;
};

beforeEach(async () => {
  h = await makeHarness();
  service = new ReviewsService(h.db);
}, 60_000);
afterEach(async () => { await h?.pg.close(); });

describe('reviews', () => {
  it('stays UNPUBLISHED until both sides have submitted', async () => {
    const b = await completed();
    const res = await service.submit({
      bookingId: b.id, authorId: h.ids.devoteeId, panditStars: 5, text: 'খুব ভালো',
    });
    expect(res.published).toBe(false);

    const rows = await h.db.select().from(reviews).where(eq(reviews.bookingId, b.id));
    expect(rows[0]!.publishedAt).toBeNull();

    // and the purohit's public rating has not moved
    const p = await h.db.select().from(panditProfiles)
      .where(eq(panditProfiles.userId, h.ids.panditId));
    expect(p[0]!.ratingCount).toBe(0);
  });

  it('publishes both the moment the second one lands', async () => {
    const b = await completed();
    await service.submit({ bookingId: b.id, authorId: h.ids.devoteeId, panditStars: 4 });
    const res = await service.submit({
      bookingId: b.id, authorId: h.ids.panditId, devoteeStars: 5,
    });
    expect(res.published).toBe(true);

    const rows = await h.db.select().from(reviews).where(eq(reviews.bookingId, b.id));
    expect(rows.every((r) => r.publishedAt !== null)).toBe(true);

    const p = await h.db.select().from(panditProfiles)
      .where(eq(panditProfiles.userId, h.ids.panditId));
    expect(p[0]!.ratingCount).toBe(1);
    expect(p[0]!.ratingSum).toBe(4);
  });

  it('moves the booking to reviewed', async () => {
    const b = await completed();
    await service.submit({ bookingId: b.id, authorId: h.ids.devoteeId, panditStars: 5 });
    await service.submit({ bookingId: b.id, authorId: h.ids.panditId, devoteeStars: 5 });
    const row = await h.db.select().from(bookings).where(eq(bookings.id, b.id));
    expect(row[0]!.state).toBe('reviewed');
  });

  it('rates samagri separately, so it never drags down the purohit', async () => {
    const b = await completed();
    await service.submit({
      bookingId: b.id, authorId: h.ids.devoteeId, panditStars: 5, samagriStars: 2,
    });
    await service.submit({ bookingId: b.id, authorId: h.ids.panditId, devoteeStars: 5 });

    const p = await h.db.select().from(panditProfiles)
      .where(eq(panditProfiles.userId, h.ids.panditId));
    expect(p[0]!.ratingSum).toBe(5);      // the 2 for samagri is not folded in
  });

  it('will not let the same person review twice', async () => {
    const b = await completed();
    await service.submit({ bookingId: b.id, authorId: h.ids.devoteeId, panditStars: 5 });
    await expect(service.submit({
      bookingId: b.id, authorId: h.ids.devoteeId, panditStars: 1,
    })).rejects.toThrow(/already reviewed/);
  });

  it('refuses a review from someone who was not on the booking', async () => {
    const b = await completed();
    await expect(service.submit({
      bookingId: b.id, authorId: 'STRANGER', panditStars: 1,
    })).rejects.toThrow(/not your booking/);
  });

  it('refuses a review before the ritual has happened', async () => {
    const d = await h.bookings.createDraft({
      panditId: h.ids.panditId, ritualId: h.ids.ritualId, addressId: h.ids.addressId,
      date: daysFromNow(9), slotIdx: 0, samagriOption: 'pandit_brings',
      paymentMode: 'cash', attendeeCount: 10,
      devoteeId: h.ids.devoteeId, citySlug: 'kolkata',
    } as never);
    await expect(service.submit({
      bookingId: d.id, authorId: h.ids.devoteeId, panditStars: 5,
    })).rejects.toThrow(/once it has been completed/);
  });

  it('publishes a one-sided review after the window closes', async () => {
    const b = await completed();
    await service.submit({ bookingId: b.id, authorId: h.ids.devoteeId, panditStars: 3 });

    // Age the review past the 72-hour window.
    await h.db.update(reviews)
      .set({ submittedAt: new Date(Date.now() - 80 * 3600_000).toISOString() })
      .where(eq(reviews.bookingId, b.id));

    expect(await service.publishExpired()).toBe(1);
    const rows = await h.db.select().from(reviews).where(eq(reviews.bookingId, b.id));
    expect(rows[0]!.publishedAt).not.toBeNull();
  });

  it('only exposes published reviews on the public profile', async () => {
    const b = await completed();
    await service.submit({ bookingId: b.id, authorId: h.ids.devoteeId, panditStars: 5, text: 'হ্যাঁ' });
    expect(await service.forPandit(h.ids.panditId)).toHaveLength(0);

    await service.submit({ bookingId: b.id, authorId: h.ids.panditId, devoteeStars: 5 });
    const list = await service.forPandit(h.ids.panditId);
    expect(list).toHaveLength(1);
    expect(list[0]!.text).toBe('হ্যাঁ');
  });

  it('retires the cold-start boost as real ratings arrive', async () => {
    const before = (await h.db.select().from(panditProfiles)
      .where(eq(panditProfiles.userId, h.ids.panditId)))[0]!;
    const b = await completed();
    await service.submit({ bookingId: b.id, authorId: h.ids.devoteeId, panditStars: 5 });
    await service.submit({ bookingId: b.id, authorId: h.ids.panditId, devoteeStars: 5 });

    const after = (await h.db.select().from(panditProfiles)
      .where(eq(panditProfiles.userId, h.ids.panditId)))[0]!;
    expect(after.newSupplyBoostRemaining).toBe(before.newSupplyBoostRemaining - 1);
  });
});
