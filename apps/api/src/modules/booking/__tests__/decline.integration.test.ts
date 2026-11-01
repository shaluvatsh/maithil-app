import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import { makeHarness, daysFromNow, type Harness } from '../../../test/harness';
import { bookings, bookingEvents, panditProfiles } from '../../../db/schema/index';

let h: Harness;

beforeEach(async () => {
  h = await makeHarness();
  /*
   * THE HARNESS'S SEEDED PUROHIT HAS NO DECLARED WORKING HOURS, and under ADR 0013
   * that makes them unbookable through the window-based search — the same fixture
   * gap the re-match tests in lifecycle.integration.test.ts had to close. Onboarding
   * calls `ensureWorkingHours` for every real purohit, so a purohit without them is
   * a fixture artefact rather than a state production can produce.
   *
   * Without this the booking below is assigned to whichever purohit the test adds,
   * and there is nobody left to re-match to — which looks exactly like a broken
   * decline path and is not.
   */
  await h.availability.ensureWorkingHours({
    panditId: h.ids.panditId, cityId: h.ids.cityId,
  });
}, 60_000);
afterEach(async () => { await h?.pg.close(); });

/** A second verified purohit who could take the work, with real working hours. */
const addBackup = async () => {
  const id = ulid();
  await h.db.execute(sql`
    INSERT INTO users (id, phone, role, city_id, name, referral_code)
    VALUES (${id}, '+919830007777', 'pandit', ${h.ids.cityId}, 'Backup Purohit', 'REFBK')`);
  await h.db.execute(sql`
    INSERT INTO pandit_profiles (user_id, kyc_status, cash_jobs_enabled, base_lat, base_lng,
                                 experience_years)
    VALUES (${id}, 'verified', true, 22.5726, 88.3639, 15)`);
  await h.db.execute(sql`
    INSERT INTO pandit_rituals (pandit_id, ritual_id, price_paise, active)
    VALUES (${id}, ${h.ids.ritualId}, 150000, true)`);
  await h.availability.materialise({ panditId: id, cityId: h.ids.cityId });
  await h.availability.ensureWorkingHours({ panditId: id, cityId: h.ids.cityId });
  return id;
};

const submitted = async () => {
  const d = await h.bookings.createDraft({
    devoteeId: h.ids.devoteeId, ritualId: h.ids.ritualId, addressId: h.ids.addressId,
    date: daysFromNow(10), slotIdx: 1, samagriOption: 'pandit_brings',
    paymentMode: 'cash', attendeeCount: 20,
  } as never);
  await h.bookings.submit(d.id, h.ids.devoteeId);
  return d.id;
};

/**
 * A PUROHIT DECLINING AN AUTO-ASSIGNED JOB.
 *
 * ADR 0011 removed the accept step — publishing a slot IS the acceptance — and was
 * explicit that a decline path must remain. `booking.service` has pointed at a
 * `decline()` in its comments ever since, and there was none.
 *
 * The consequence was not neutral. A purohit who genuinely could not attend had one
 * route: the full cancel flow, which charges a cancellation penalty for a job they
 * never individually agreed to. That makes the honest early "I can't" cost more than
 * going quiet — and going quiet is what ends with nobody at a family's door.
 */
describe('declining a job', () => {
  it('hands the booking to another purohit rather than killing it', async () => {
    await addBackup();
    const id = await submitted();
    const [before] = await h.db.select({ panditId: bookings.panditId })
      .from(bookings).where(eq(bookings.id, id));

    const res = await h.bookings.decline({
      bookingId: id, panditId: before!.panditId, reason: 'unwell',
    });

    expect(res.rematched).toBe(true);
    expect(res.state).toBe('pending_accept');

    const [after] = await h.db.select({ state: bookings.state, panditId: bookings.panditId })
      .from(bookings).where(eq(bookings.id, id));
    expect(after!.state).toBe('pending_accept');
    expect(after!.panditId).not.toBe(before!.panditId);
  });

  /** With nobody else free, the booking ends — but it ends saying why. */
  it('expires the booking when nobody can take it', async () => {
    const id = await submitted();
    const [b] = await h.db.select({ panditId: bookings.panditId })
      .from(bookings).where(eq(bookings.id, id));

    const res = await h.bookings.decline({
      bookingId: id, panditId: b!.panditId, reason: 'travelling',
    });

    expect(res.rematched).toBe(false);
    expect(res.state).toBe('expired');
  });

  /**
   * Recorded EVEN WHEN THE RE-MATCH SUCCEEDS. They still declined; the platform
   * merely absorbed it. Without this a purohit who declines everything looks
   * spotless because they were always rescued.
   */
  it('records the decline in the audit spine even when rescued', async () => {
    await addBackup();
    const id = await submitted();
    const [b] = await h.db.select({ panditId: bookings.panditId })
      .from(bookings).where(eq(bookings.id, id));

    await h.bookings.decline({ bookingId: id, panditId: b!.panditId, reason: 'unwell' });

    const events = await h.db.select().from(bookingEvents)
      .where(and(eq(bookingEvents.bookingId, id), eq(bookingEvents.trigger, 'pandit_decline')));
    expect(events).toHaveLength(1);
    expect((events[0]!.meta as { reason?: string } | null)?.reason).toBe('unwell');
  });

  /**
   * `acceptance_rate` is 15% of the match score and NOTHING HAS EVER WRITTEN IT —
   * every purohit scored the same `COALESCE(..., 0.8)` default, so the term
   * contributed an identical constant to every candidate and did nothing at all.
   */
  it('counts against the purohit\'s acceptance rate', async () => {
    const id = await submitted();
    const [b] = await h.db.select({ panditId: bookings.panditId })
      .from(bookings).where(eq(bookings.id, id));

    const [before] = await h.db.select({ rate: panditProfiles.acceptanceRate })
      .from(panditProfiles).where(eq(panditProfiles.userId, b!.panditId));
    expect(before!.rate).toBeNull();

    await h.bookings.decline({ bookingId: id, panditId: b!.panditId, reason: 'unwell' });

    const [after] = await h.db.select({ rate: panditProfiles.acceptanceRate })
      .from(panditProfiles).where(eq(panditProfiles.userId, b!.panditId));
    expect(Number(after!.rate)).toBeLessThan(0.8);
  });

  it('refuses a decline with no reason given', async () => {
    const id = await submitted();
    const [b] = await h.db.select({ panditId: bookings.panditId })
      .from(bookings).where(eq(bookings.id, id));

    await expect(h.bookings.decline({ bookingId: id, panditId: b!.panditId, reason: '' }))
      .rejects.toThrow(/why you cannot/i);
  });

  it('refuses a decline from someone the job is not assigned to', async () => {
    const other = await addBackup();
    const id = await submitted();
    const [b] = await h.db.select({ panditId: bookings.panditId })
      .from(bookings).where(eq(bookings.id, id));

    // Whichever of the two was assigned, decline as the OTHER one. Naming a fixed
    // purohit here would pass or fail on which way the ranking happened to go.
    const notAssigned = b!.panditId === other ? h.ids.panditId : other;
    await expect(h.bookings.decline({ bookingId: id, panditId: notAssigned, reason: 'unwell' }))
      .rejects.toThrow(/not assigned to you/i);
  });

  /**
   * A confirmed booking has been PAID FOR. Walking away from it refunds the devotee
   * and carries a penalty — that is `cancel`, and routing it through here would let
   * a purohit shed a paid job with no consequence at all.
   */
  it('refuses to decline a booking that is already paid for', async () => {
    const id = await submitted();
    const [b] = await h.db.select({ panditId: bookings.panditId })
      .from(bookings).where(eq(bookings.id, id));
    await h.bookings.confirmOnTokenCapture({ bookingId: id, paymentIntentId: `pi_${id}` });

    await expect(h.bookings.decline({ bookingId: id, panditId: b!.panditId, reason: 'unwell' }))
      .rejects.toThrow(/already paid for/i);
  });

  it('cannot be declined twice', async () => {
    const id = await submitted();
    const [b] = await h.db.select({ panditId: bookings.panditId })
      .from(bookings).where(eq(bookings.id, id));

    await h.bookings.decline({ bookingId: id, panditId: b!.panditId, reason: 'unwell' });
    await expect(h.bookings.decline({ bookingId: id, panditId: b!.panditId, reason: 'unwell' }))
      .rejects.toThrow();
  });
});
