import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { makeHarness, daysFromNow, type Harness } from '../../../test/harness';
import { ulid } from 'ulid';
import {
  bookings, ledgerEntries, outbox, availability, users, panditProfiles, panditRituals,
} from '../../../db/schema/index';
import { DomainError } from '@themaithil/contracts';

let h: Harness;
const DATE = daysFromNow(10);

const draft = (over: Record<string, unknown> = {}) => h.bookings.createDraft({
  panditId: h.ids.panditId,
  ritualId: h.ids.ritualId,
  addressId: h.ids.addressId,
  date: DATE,
  slotIdx: 1,
  samagriOption: 'pandit_brings',
  paymentMode: 'cash',
  attendeeCount: 20,
  devoteeId: h.ids.devoteeId,
  citySlug: 'kolkata',
  ...over,
} as never);

const toConfirmed = async (over: Record<string, unknown> = {}) => {
  const d = await draft(over);
  await h.bookings.submit(d.id, h.ids.devoteeId);
  await h.bookings.accept(d.id, h.ids.panditId);
  const c = await h.bookings.confirmOnTokenCapture({
    bookingId: d.id, paymentIntentId: `pi_${d.id}`,
  });
  return { ...d, ...c };
};

/**
 * ADR 0011. Booking into a published slot accepts it; the purohit is not asked to
 * confirm what their own calendar already said.
 *
 * Nothing tested the previous gate either — removing it broke no test — so this
 * exists as much to pin the behaviour as to prove it.
 */
/**
 * ADR 0012. The devotee does not choose a purohit — "18 years" against "22 years"
 * is not a decision a family can make about a ceremony — so `panditId` is optional
 * and the platform assigns on rating, proximity, acceptance, experience and
 * availability.
 */
describe('auto-matching', () => {
  it('assigns a purohit when the devotee names none', async () => {
    const d = await draft({ panditId: undefined });

    const [row] = await h.db.select({ panditId: bookings.panditId })
      .from(bookings).where(eq(bookings.id, d.id));

    expect(row!.panditId).toBe(h.ids.panditId);
    // And says who, so a stranger is never unannounced at someone's door.
    expect(d.pandit?.id).toBe(h.ids.panditId);
  });

  it('still honours an explicitly named purohit — the separate flow', async () => {
    const d = await draft({ panditId: h.ids.panditId });
    const [row] = await h.db.select({ panditId: bookings.panditId })
      .from(bookings).where(eq(bookings.id, d.id));
    expect(row!.panditId).toBe(h.ids.panditId);
  });

  it('refuses the booking rather than inventing supply when nobody is free', async () => {
    // Close the purohit's calendar. The enum is open|closed|booked|buffer.
    await h.db.update(availability).set({ status: 'closed' })
      .where(eq(availability.panditId, h.ids.panditId));

    await expect(draft({ panditId: undefined }))
      .rejects.toThrow(/no purohit is free/i);
  });
});

/**
 * A purohit dropping out used to end the booking: refund issued, family left with
 * no purohit on the day of the ceremony. A refund is not a remedy for a missing
 * Annaprashan.
 */
describe('re-match when a purohit cancels', () => {
  /** A second verified purohit, free in the same slot. */
  const addBackup = async () => {
    const backupId = ulid();
    await h.db.insert(users).values({
      id: backupId, phone: '+919830000003', role: 'pandit', cityId: h.ids.cityId,
      name: 'Backup Purohit',
    });
    await h.db.insert(panditProfiles).values({
      userId: backupId, kycStatus: 'verified', cashJobsEnabled: true,
      baseLat: 22.5726, baseLng: 88.3639,
    });
    await h.db.insert(panditRituals).values({
      panditId: backupId, ritualId: h.ids.ritualId, pricePaise: 150000, active: true,
    });
    await h.availability.materialise({ panditId: backupId, cityId: h.ids.cityId });
    return backupId;
  };

  it('hands the booking to the next purohit instead of killing it', async () => {
    const backupId = await addBackup();
    const b = await toConfirmed();

    const res = await h.bookings.cancel({
      bookingId: b.id, actorId: h.ids.panditId, actorRole: 'pandit',
      reason: 'unwell',
    });

    expect(res.rematched).toBe(true);
    const [row] = await h.db.select({ state: bookings.state, panditId: bookings.panditId })
      .from(bookings).where(eq(bookings.id, b.id));

    expect(row!.state).toBe('confirmed');       // the devotee still has a booking
    expect(row!.panditId).toBe(backupId);       // with someone else
  });

  it('does not refund a booking it saved', async () => {
    await addBackup();
    const b = await toConfirmed();
    const res = await h.bookings.cancel({
      bookingId: b.id, actorId: h.ids.panditId, actorRole: 'pandit', reason: 'unwell',
    });
    expect(res.refund.refundPaise).toBe(0);
  });

  it('keeps the agreed price — a substitution must not reprice the devotee', async () => {
    await addBackup();
    const b = await toConfirmed();
    const [before] = await h.db.select({ price: bookings.price })
      .from(bookings).where(eq(bookings.id, b.id));

    await h.bookings.cancel({
      bookingId: b.id, actorId: h.ids.panditId, actorRole: 'pandit', reason: 'unwell',
    });

    const [after] = await h.db.select({ price: bookings.price })
      .from(bookings).where(eq(bookings.id, b.id));
    expect(after!.price).toEqual(before!.price);
  });

  it('tells the devotee, rather than letting them find out at the door', async () => {
    await addBackup();
    const b = await toConfirmed();
    await h.bookings.cancel({
      bookingId: b.id, actorId: h.ids.panditId, actorRole: 'pandit', reason: 'unwell',
    });

    const events = await h.db.select({ type: outbox.eventType })
      .from(outbox).where(eq(outbox.aggregateId, b.id));
    expect(events.map((e) => e.type)).toContain('booking.pandit_substituted');
  });

  it('falls back to cancel and refund when nobody else can take it', async () => {
    const b = await toConfirmed();   // no backup purohit exists

    const res = await h.bookings.cancel({
      bookingId: b.id, actorId: h.ids.panditId, actorRole: 'pandit', reason: 'unwell',
    });

    expect(res.rematched).toBe(false);
    expect(res.refund.refundPaise).toBeGreaterThan(0);
    const [row] = await h.db.select({ state: bookings.state })
      .from(bookings).where(eq(bookings.id, b.id));
    expect(row!.state).toBe('cancelled_pandit');
  });

  it('never re-offers the booking to someone who already dropped it', async () => {
    const backupId = await addBackup();
    const b = await toConfirmed();

    await h.bookings.cancel({
      bookingId: b.id, actorId: h.ids.panditId, actorRole: 'pandit', reason: 'unwell',
    });
    // Now the backup drops it too. Only two purohits exist, so this must end.
    const second = await h.bookings.cancel({
      bookingId: b.id, actorId: backupId, actorRole: 'pandit', reason: 'also unwell',
    });

    expect(second.rematched).toBe(false);
    expect(second.refund.refundPaise).toBeGreaterThan(0);
  });
});

describe('auto-accept', () => {
  it('lets the devotee pay immediately, with no separate acceptance', async () => {
    const d = await draft();
    const s = await h.bookings.submit(d.id, h.ids.devoteeId);

    expect(s.acceptedAt, 'submitting must accept').toBeTruthy();

    // The whole point: confirmOnTokenCapture used to throw here.
    const c = await h.bookings.confirmOnTokenCapture({
      bookingId: d.id, paymentIntentId: `pi_auto_${d.id}`,
    });
    expect(c.state).toBe('confirmed');
  });

  /**
   * The only exit a purohit has is `cancel()`. There is no lightweight `decline()`
   * for a job they never agreed to — see ADR 0011, "consequences". Auto-accept
   * makes that gap matter more, because the purohit is now committed by default.
   */
  it('still lets a purohit get out, so auto-accept is not a trap', async () => {
    const d = await draft();
    await h.bookings.submit(d.id, h.ids.devoteeId);

    await expect(h.bookings.cancel({
      bookingId: d.id, actorId: h.ids.panditId, actorRole: 'pandit',
      reason: 'already committed off-platform',
    })).resolves.toBeTruthy();

    const [row] = await h.db.select({ state: bookings.state })
      .from(bookings).where(eq(bookings.id, d.id));
    expect(row!.state).toBe('cancelled_pandit');
  });

  it('keeps a decline horizon on the booking for the expiry sweep', async () => {
    const d = await draft();
    const s = await h.bookings.submit(d.id, h.ids.devoteeId);
    expect(s.acceptDeadlineAt).toBeTruthy();
  });
});

const ledgerBalanced = async () => {
  const r = await h.db.execute(sql`
    SELECT txn_id,
           SUM(CASE WHEN direction='debit'  THEN amount_paise ELSE 0 END)
         - SUM(CASE WHEN direction='credit' THEN amount_paise ELSE 0 END) AS drift
      FROM ledger_entries GROUP BY txn_id HAVING
           SUM(CASE WHEN direction='debit'  THEN amount_paise ELSE 0 END)
         <> SUM(CASE WHEN direction='credit' THEN amount_paise ELSE 0 END)`);
  return ((r as unknown as { rows?: unknown[] }).rows ?? (r as unknown[])).length === 0;
};

beforeEach(async () => { h = await makeHarness(); }, 60_000);
afterEach(async () => { await h?.pg.close(); });

describe('booking lifecycle', () => {
  it('runs the happy path draft -> completed and settles', async () => {
    const b = await toConfirmed();
    expect(b.state).toBe('confirmed');

    await h.bookings.start({ bookingId: b.id, panditId: h.ids.panditId, otp: b.startOtp! });

    const done = await h.bookings.complete({
      bookingId: b.id,
      panditId: h.ids.panditId,
      otp: b.completeOtp!,
      cashCollectedPaise: b.price.balancePaise,
      capturedAt: new Date().toISOString(),
    });

    expect(done.state).toBe('completed');
    expect(await ledgerBalanced()).toBe(true);
  });

  it('prices a Kolkata Satyanarayan correctly end to end', async () => {
    const d = await draft();
    // dakshina 1500 + samagri (800 + 5%) + fee 15% of 1500
    expect(d.price.dakshinaPaise).toBe(150_000);
    expect(d.price.samagriPaise).toBe(84_000);
    expect(d.price.platformFeePaise).toBe(22_500);
    expect(d.price.tokenPaise).toBe(22_500);
    expect(d.price.balancePaise).toBe(234_000);
  });

  it('takes the slot only at confirmation, never at draft', async () => {
    const d = await draft();
    const before = await h.db.select().from(availability)
      .where(eq(availability.bookingId, d.id));
    expect(before).toHaveLength(0);

    await h.bookings.submit(d.id, h.ids.devoteeId);
    await h.bookings.accept(d.id, h.ids.panditId);
    await h.bookings.confirmOnTokenCapture({ bookingId: d.id, paymentIntentId: 'pi_1' });

    const after = await h.db.select().from(availability)
      .where(eq(availability.bookingId, d.id));
    expect(after).toHaveLength(1);
    expect(after[0]!.status).toBe('booked');
  });

  it('refuses a second booking on a slot that is already taken', async () => {
    await toConfirmed();
    // A second devotee is blocked by the Redis soft hold...
    await expect(toConfirmed()).rejects.toThrow(/checking out/);

    // ...and still blocked with the hold cleared, which is the point: correctness
    // lives in the FOR UPDATE lock, not in Redis. A Redis outage must degrade
    // checkout, never double-book a purohit.
    for (let i = 0; i < 4; i++) await h.kv.del(`hold:${h.ids.panditId}:${DATE}:${i}`);
    await expect(toConfirmed()).rejects.toThrow(/taken while you were checking out/);
  });

  it('BLOCKS settlement when the cash amount does not match', async () => {
    const b = await toConfirmed();
    await h.bookings.start({ bookingId: b.id, panditId: h.ids.panditId, otp: b.startOtp! });

    await expect(h.bookings.complete({
      bookingId: b.id, panditId: h.ids.panditId, otp: b.completeOtp!,
      cashCollectedPaise: b.price.balancePaise - 5000,
      capturedAt: new Date().toISOString(),
    })).rejects.toThrow(/does not match/);

    // and the booking is untouched - the whole transaction rolled back
    const row = await h.db.select().from(bookings).where(eq(bookings.id, b.id));
    expect(row[0]!.state).toBe('in_progress');
    expect(row[0]!.completedAt).toBeNull();
    const entries = await h.db.select().from(ledgerEntries)
      .where(eq(ledgerEntries.bookingId, b.id));
    expect(entries.every((e) => e.type === 'token')).toBe(true);
  });

  it('withholds TDS on a CASH booking - the s.194-O fix', async () => {
    const b = await toConfirmed();
    await h.bookings.start({ bookingId: b.id, panditId: h.ids.panditId, otp: b.startOtp! });
    const done = await h.bookings.complete({
      bookingId: b.id, panditId: h.ids.panditId, otp: b.completeOtp!,
      cashCollectedPaise: b.price.balancePaise,
      capturedAt: new Date().toISOString(),
    });
    expect(done.settlement!.tdsPaise).toBeGreaterThan(0);
    const carried = await h.db.select().from(ledgerEntries)
      .where(eq(ledgerEntries.type, 'tds_carry'));
    expect(carried.length).toBeGreaterThan(0);
  });

  it('creates NO cash due on an ordinary cash booking', async () => {
    const b = await toConfirmed();
    await h.bookings.start({ bookingId: b.id, panditId: h.ids.panditId, otp: b.startOtp! });
    const done = await h.bookings.complete({
      bookingId: b.id, panditId: h.ids.panditId, otp: b.completeOtp!,
      cashCollectedPaise: b.price.balancePaise,
      capturedAt: new Date().toISOString(),
    });
    expect(done.settlement!.cashDuePaise).toBe(0);
    expect(await h.ledger.openDues(h.ids.panditId)).toBe(0);
  });

  it('rejects a wrong OTP and counts the attempt', async () => {
    const b = await toConfirmed();
    await expect(h.bookings.start({
      bookingId: b.id, panditId: h.ids.panditId, otp: '000000',
    })).rejects.toThrow(/incorrect code/);
    const row = await h.db.select().from(bookings).where(eq(bookings.id, b.id));
    expect(row[0]!.otpAttempts).toBe(1);
    expect(row[0]!.state).toBe('confirmed');
  });

  it('refuses to complete a booking that never started', async () => {
    const b = await toConfirmed();
    await expect(h.bookings.complete({
      bookingId: b.id, panditId: h.ids.panditId, otp: b.completeOtp!,
      cashCollectedPaise: b.price.balancePaise,
      capturedAt: new Date().toISOString(),
    })).rejects.toThrow(/cannot complete_otp_verified a booking that is confirmed/);
  });

  it('refuses a booking beyond the horizon', async () => {
    await expect(draft({ date: daysFromNow(200) })).rejects.toThrow(/120 days/);
  });

  it('refuses a job for someone else', async () => {
    const b = await toConfirmed();
    await expect(h.bookings.start({
      bookingId: b.id, panditId: h.ids.devoteeId, otp: b.startOtp!,
    })).rejects.toThrow(/not assigned to you/);
  });

  it('emits every domain event through the outbox, transactionally', async () => {
    const b = await toConfirmed();
    await h.bookings.start({ bookingId: b.id, panditId: h.ids.panditId, otp: b.startOtp! });
    await h.bookings.complete({
      bookingId: b.id, panditId: h.ids.panditId, otp: b.completeOtp!,
      cashCollectedPaise: b.price.balancePaise,
      capturedAt: new Date().toISOString(),
    });
    const events = await h.db.select().from(outbox).where(eq(outbox.aggregateId, b.id));
    const types = events.map((e) => e.eventType);
    expect(types).toEqual([
      'booking.submitted', 'booking.accepted', 'booking.confirmed',
      'booking.started', 'booking.completed',
    ]);
    expect(events.every((e) => e.publishedAt === null)).toBe(true);
  });

  it('treats a webhook replay of token capture as a no-op', async () => {
    const d = await draft();
    await h.bookings.submit(d.id, h.ids.devoteeId);
    await h.bookings.accept(d.id, h.ids.panditId);
    await h.bookings.confirmOnTokenCapture({ bookingId: d.id, paymentIntentId: 'pi_x' });
    const again = await h.bookings.confirmOnTokenCapture({ bookingId: d.id, paymentIntentId: 'pi_x' });
    expect(again.state).toBe('confirmed');
    const tokenEntries = await h.db.select().from(ledgerEntries)
      .where(eq(ledgerEntries.type, 'token'));
    expect(tokenEntries).toHaveLength(2);   // one debit, one credit. Not four.
  });
});

describe('cancellation and refunds', () => {
  it('refunds the token in full when cancelled early', async () => {
    const b = await toConfirmed({ date: daysFromNow(10) });
    const res = await h.bookings.cancel({
      bookingId: b.id, actorId: h.ids.devoteeId, actorRole: 'devotee', reason: 'plans changed',
    });
    expect(res.refund.reason).toBe('over_48h_full');
    expect(res.refund.refundPaise).toBe(b.price.tokenPaise);
    expect(await ledgerBalanced()).toBe(true);
  });

  it('reopens the slot on cancellation', async () => {
    const b = await toConfirmed();
    await h.bookings.cancel({
      bookingId: b.id, actorId: h.ids.devoteeId, actorRole: 'devotee', reason: 'x',
    });
    const rows = await h.db.select().from(availability)
      .where(eq(availability.bookingId, b.id));
    expect(rows).toHaveLength(0);
  });

  it('makes the devotee whole when the purohit cancels', async () => {
    const b = await toConfirmed();
    const res = await h.bookings.cancel({
      bookingId: b.id, actorId: h.ids.panditId, actorRole: 'pandit', reason: 'unwell',
    });
    expect(res.refund.reason).toBe('platform_or_pandit_fault');
    expect(res.refund.refundPaise).toBe(b.price.tokenPaise);
    expect(res.state).toBe('cancelled_pandit');
  });
});

describe('idempotency', () => {
  it('returns the first result on replay instead of settling twice', async () => {
    const b = await toConfirmed();
    await h.bookings.start({ bookingId: b.id, panditId: h.ids.panditId, otp: b.startOtp! });

    const body = {
      otp: b.completeOtp!, cashCollectedPaise: b.price.balancePaise,
      capturedAt: new Date().toISOString(), idempotencyKey: 'idem-key-0123456789abcdef',
    };
    const run = () => h.idempotency.run({
      key: body.idempotencyKey, userId: h.ids.panditId,
      endpoint: 'POST /complete', body,
      handler: () => h.bookings.complete({
        bookingId: b.id, panditId: h.ids.panditId, otp: body.otp,
        cashCollectedPaise: body.cashCollectedPaise, capturedAt: body.capturedAt,
      }),
    });

    const first = await run();
    const second = await run();
    expect(second).toEqual(first);

    const settlements = await h.db.select().from(ledgerEntries)
      .where(eq(ledgerEntries.type, 'cash_settled_direct'));
    expect(settlements).toHaveLength(2);   // one debit, one credit, from ONE settlement
  });

  it('rejects the same key with a different body', async () => {
    const b = await toConfirmed();
    const key = 'idem-key-abcdef0123456789';
    await h.idempotency.run({
      key, userId: h.ids.panditId, endpoint: 'POST /complete',
      body: { a: 1 }, handler: async () => ({ ok: true }),
    });
    await expect(h.idempotency.run({
      key, userId: h.ids.panditId, endpoint: 'POST /complete',
      body: { a: 2 }, handler: async () => ({ ok: true }),
    })).rejects.toThrow(/different request/);
  });
});
