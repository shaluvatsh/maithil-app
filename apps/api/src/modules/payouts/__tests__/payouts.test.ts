import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { makeHarness, daysFromNow, type Harness } from '../../../test/harness';
import { payouts, panditProfiles, ledgerEntries } from '../../../db/schema/index';
import { PayoutService, INSTANT_PAYOUT_FEE_PAISE } from '../payouts.service';

let h: Harness;
let service: PayoutService;

const completeOne = async (paymentMode: 'cash' | 'digital_full' = 'cash', slotIdx = 1) => {
  const d = await h.bookings.createDraft({
    panditId: h.ids.panditId, ritualId: h.ids.ritualId, addressId: h.ids.addressId,
    date: daysFromNow(5 + slotIdx), slotIdx, samagriOption: 'pandit_brings',
    paymentMode, attendeeCount: 10, devoteeId: h.ids.devoteeId, citySlug: 'kolkata',
  } as never);
  await h.bookings.submit(d.id, h.ids.devoteeId);
  await h.bookings.accept(d.id, h.ids.panditId);
  const c = await h.bookings.confirmOnTokenCapture({ bookingId: d.id, paymentIntentId: `pi_${d.id}` });
  await h.bookings.start({ bookingId: d.id, panditId: h.ids.panditId, otp: c.startOtp! });
  await h.bookings.complete({
    bookingId: d.id, panditId: h.ids.panditId, otp: c.completeOtp!,
    capturedAt: new Date().toISOString(),
    ...(paymentMode === 'cash' ? { cashCollectedPaise: d.price.balancePaise } : {}),
  });
  return d;
};

const ledgerBalanced = async () => {
  const r = await h.db.execute(sql`
    SELECT txn_id FROM ledger_entries GROUP BY txn_id HAVING
      SUM(CASE WHEN direction='debit' THEN amount_paise ELSE 0 END)
   <> SUM(CASE WHEN direction='credit' THEN amount_paise ELSE 0 END)`);
  return (((r as unknown as { rows?: unknown[] }).rows ?? r) as unknown[]).length === 0;
};

beforeEach(async () => {
  h = await makeHarness();
  service = new PayoutService(h.db, h.ledger);

  /*
   * A payout destination, because a payout now refuses without one.
   *
   * The harness creates a purohit with `linked_account_id` null, which was fine
   * while `run()` would post a full double-entry payout to nowhere. Every test in
   * this file was, without meaning to, asserting that we correctly deduct a
   * purohit's balance and move no money. The refusal is the behaviour under test in
   * its own describe block below; here it just has to be satisfied.
   */
  await h.db.update(panditProfiles)
    .set({ linkedAccountId: 'acc_test_purohit', payoutMethod: 'upi',
           payoutUpiVpa: 'purohit@upi', payoutHolderName: 'Test Purohit' })
    .where(eq(panditProfiles.userId, h.ids.panditId));
}, 60_000);
afterEach(async () => { await h?.pg.close(); });

/**
 * A payout with no destination is not a payout.
 *
 * `pandit_profiles.linked_account_id` has existed since the payments client was
 * written and nothing ever set it — there was no bank or UPI capture anywhere. So
 * `run()` would debit the purohit, credit the platform, clear their cash dues,
 * re-enable cash work and write a `payouts` row with `aggregator_ref` null and
 * status 'pending'. The ledger recorded that the purohit had been paid. Nothing had
 * moved, and nothing could, and the balance was already gone.
 *
 * Failing loudly is strictly better: the money is still on the books and the fix is
 * a form the purohit can fill in.
 */
describe('a payout requires somewhere to send the money', () => {
  const clearDestination = () => h.db.update(panditProfiles)
    .set({ linkedAccountId: null })
    .where(eq(panditProfiles.userId, h.ids.panditId));

  it('refuses, naming the missing thing', async () => {
    await completeOne('digital_full');
    await clearDestination();
    await expect(service.run({
      panditId: h.ids.panditId, periodStart: '2026-01-01', periodEnd: '2026-01-07',
    })).rejects.toThrow(/payout account/i);
  });

  it('carries a code the client can branch on, not just a message', async () => {
    await completeOne('digital_full');
    await clearDestination();
    await expect(service.run({
      panditId: h.ids.panditId, periodStart: '2026-01-01', periodEnd: '2026-01-07',
    })).rejects.toMatchObject({ code: 'PAYOUT_ACCOUNT_MISSING' });
  });

  /** The point of refusing early: the books must be untouched afterwards. */
  it('writes nothing at all — no ledger entries, no payout row', async () => {
    await completeOne('digital_full');
    await clearDestination();
    const before = await h.db.select().from(ledgerEntries);

    await service.run({
      panditId: h.ids.panditId, periodStart: '2026-01-01', periodEnd: '2026-01-07',
    }).catch(() => undefined);

    expect(await h.db.select().from(ledgerEntries)).toHaveLength(before.length);
    expect(await h.db.select().from(payouts)).toHaveLength(0);
    expect(await ledgerBalanced()).toBe(true);
  });

  it('goes through once a destination exists', async () => {
    await completeOne('digital_full');
    await clearDestination();
    await h.db.update(panditProfiles).set({ linkedAccountId: 'acc_added_later' })
      .where(eq(panditProfiles.userId, h.ids.panditId));

    const r = await service.run({
      panditId: h.ids.panditId, periodStart: '2026-01-01', periodEnd: '2026-01-07',
    });
    expect(r.netPaise).toBeGreaterThan(0);
  });
});

describe('payouts', () => {
  it('pays out a digital booking net of TDS', async () => {
    await completeOne('digital_full');
    const preview = await service.preview(h.ids.panditId);
    expect(preview.grossPaise).toBeGreaterThan(0);

    const res = await service.run({
      panditId: h.ids.panditId, periodStart: daysFromNow(0), periodEnd: daysFromNow(7),
    });
    expect(res.netPaise).toBe(preview.netPayablePaise);
    expect(await ledgerBalanced()).toBe(true);

    const rows = await h.db.select().from(payouts);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.netPaise).toBe(res.netPaise);
  });

  it('pays nothing extra for a CASH booking - the purohit already holds the money', async () => {
    await completeOne('cash');
    const preview = await service.preview(h.ids.panditId);
    // gross is the notional credit less the immediate cash_settled_direct debit,
    // so the only thing outstanding is the carried withholding.
    expect(preview.grossPaise).toBe(0);
    expect(preview.tdsCarryPaise).toBeGreaterThan(0);
    expect(preview.netPayablePaise).toBe(0);
  });

  it('recovers carried TDS from the next digital payout', async () => {
    await completeOne('cash', 1);       // creates a tds_carry
    await completeOne('digital_full', 3); // creates real payable earnings

    const preview = await service.preview(h.ids.panditId);
    expect(preview.tdsCarryPaise).toBeGreaterThan(0);

    const res = await service.run({
      panditId: h.ids.panditId, periodStart: daysFromNow(0), periodEnd: daysFromNow(7),
    });
    // net is gross minus the carry, not just gross
    expect(res.netPaise).toBe(preview.grossPaise - preview.tdsCarryPaise);
    expect(await ledgerBalanced()).toBe(true);
  });

  it('charges the instant payout fee', async () => {
    await completeOne('digital_full');
    const preview = await service.preview(h.ids.panditId);
    const res = await service.run({
      panditId: h.ids.panditId, periodStart: daysFromNow(0), periodEnd: daysFromNow(7),
      instant: true,
    });
    expect(res.netPaise).toBe(preview.netPayablePaise - INSTANT_PAYOUT_FEE_PAISE);
    const fee = await h.db.select().from(ledgerEntries)
      .where(eq(ledgerEntries.type, 'instant_payout_fee'));
    expect(fee).toHaveLength(2);
    expect(await ledgerBalanced()).toBe(true);
  });

  it('refuses to pay out when nothing is owed', async () => {
    await expect(service.run({
      panditId: h.ids.panditId, periodStart: daysFromNow(0), periodEnd: daysFromNow(7),
    })).rejects.toThrow(/nothing is payable/);
  });

  it('does not pay the same period twice', async () => {
    await completeOne('digital_full');
    await service.run({
      panditId: h.ids.panditId, periodStart: daysFromNow(0), periodEnd: daysFromNow(7),
    });
    // the first payout consumed the balance, so a second finds nothing owed
    await expect(service.run({
      panditId: h.ids.panditId, periodStart: daysFromNow(0), periodEnd: daysFromNow(7),
    })).rejects.toThrow(/nothing is payable/);
  });

  it('pauses cash work at the credit limit and resumes when dues clear', async () => {
    await h.db.update(panditProfiles).set({ cashCreditLimitPaise: 1 })
      .where(eq(panditProfiles.userId, h.ids.panditId));

    // No dues yet, so nothing is paused.
    expect(await service.enforceCreditLimit(h.ids.panditId)).toBe(false);

    await h.db.transaction(async (tx) => {
      await h.ledger.post(tx, {
        kind: 'test_due',
        legs: [
          { account: { type: 'pandit', ownerId: h.ids.panditId },
            direction: 'debit', amount: 50_000 as never, type: 'cash_due' },
          { account: { type: 'platform', ownerId: null },
            direction: 'credit', amount: 50_000 as never, type: 'cash_due' },
        ],
      });
    });

    expect(await service.enforceCreditLimit(h.ids.panditId)).toBe(true);
    const profile = await h.db.select().from(panditProfiles)
      .where(eq(panditProfiles.userId, h.ids.panditId));
    expect(profile[0]!.cashJobsEnabled).toBe(false);
  });
});
