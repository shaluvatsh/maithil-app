import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import { makeHarness, daysFromNow, type Harness } from '../../../test/harness';
import {
  bookings, rituals, panditRituals, ritualTranslations, ledgerEntries, ledgerAccounts,
  ledgerTransactions,
} from '../../../db/schema/index';
import { SeriesCodesJob } from '../../../workers/series-codes.job';
import { BookingOtpService } from '../../auth/otp.service';
import { TEST_CONFIG } from '../../../test/harness';

let h: Harness;
const DATE = daysFromNow(10);

/** Durga Puja: four consecutive days, four hours each. */
let durgaId: string;

const draft = () => h.bookings.createDraft({
  ritualId: durgaId,
  addressId: h.ids.addressId,
  date: DATE,
  slotIdx: 0,
  samagriOption: 'pandit_brings',
  paymentMode: 'cash',
  attendeeCount: 40,
  devoteeId: h.ids.devoteeId,
} as never);

const confirmed = async () => {
  const d = await draft();
  await h.bookings.submit(d.id, h.ids.devoteeId);
  return h.bookings.confirmOnTokenCapture({ bookingId: d.id, paymentIntentId: `pi_${d.id}` });
};

/**
 * How many days have actually been settled.
 *
 * Counting settlement TRANSACTIONS rather than a net balance, because on a cash
 * booking the purohit is paid by the family in hand: the ledger posts a notional
 * credit and an offsetting `cash_settled_direct` debit, so their account nets to
 * minus the TDS carry. A negative balance is correct there and says nothing about
 * whether work was paid for. The number of settlements does.
 */
const settlementCount = async () => {
  const rows = await h.db.select({ n: sql<number>`count(*)::int` })
    .from(ledgerTransactions).where(eq(ledgerTransactions.kind, 'settlement'));
  return Number(rows[0]?.n ?? 0);
};

/** Any ledger movement at all on the purohit's account. */
const panditEntryCount = async () => {
  const rows = await h.db.select({ n: sql<number>`count(*)::int` })
    .from(ledgerEntries)
    .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
    .where(eq(ledgerAccounts.ownerType, 'pandit'));
  return Number(rows[0]?.n ?? 0);
};

const seriesRows = async (headId: string) =>
  h.db.select().from(bookings)
    .where(sql`COALESCE(${bookings.parentBookingId}, ${bookings.id}) = ${headId}`)
    .orderBy(bookings.slotStartAt);

beforeEach(async () => {
  h = await makeHarness();
  durgaId = ulid();
  await h.db.insert(rituals).values({
    id: durgaId, slug: 'durga-puja', durationMin: 240, defaultSlotSpan: 2, days: 4,
  });
  await h.db.insert(ritualTranslations).values({
    ritualId: durgaId, locale: 'bn', name: 'দুর্গা পূজা',
    shortDescription: 'চার দিনের পূজা', description: 'চার দিনের পূজা',
  });
  await h.db.insert(panditRituals).values({
    panditId: h.ids.panditId, ritualId: durgaId, pricePaise: 1500000, active: true,
  });
});
afterEach(async () => { await h.pg.close(); });

/**
 * `parent_booking_id` has been on `bookings` since the first migration, carrying
 * the comment "Multi-day rituals are linked bookings in R1", and nothing ever wrote
 * one. So the catalogue's answer to a four-day Durga Puja was the four-hour ghot
 * form, which is a different service.
 */
describe('a four-day puja is four linked bookings', () => {
  it('creates one row per day, on consecutive dates', async () => {
    const d = await draft();
    const rows = await seriesRows(d.id);

    expect(rows).toHaveLength(4);
    const dates = rows.map((r) => r.date);
    expect(new Set(dates).size).toBe(4);
    for (let i = 1; i < rows.length; i++) {
      const gap = (new Date(rows[i]!.slotStartAt).getTime()
                 - new Date(rows[i - 1]!.slotStartAt).getTime()) / 86_400_000;
      expect(gap).toBe(1);
    }
  });

  it('keeps the same purohit and the same hour every day', async () => {
    // The point of a series rather than four separate bookings: a family does not
    // want a different stranger on Ashtami.
    const d = await draft();
    const rows = await seriesRows(d.id);

    expect(new Set(rows.map((r) => r.panditId)).size).toBe(1);
    const hours = rows.map((r) => new Date(r.slotStartAt).toISOString().slice(11, 16));
    expect(new Set(hours).size).toBe(1);
  });

  it('points every later day at day one, and day one at nobody', async () => {
    const d = await draft();
    const rows = await seriesRows(d.id);

    expect(rows[0]!.parentBookingId).toBeNull();
    expect(rows.slice(1).every((r) => r.parentBookingId === rows[0]!.id)).toBe(true);
  });
});

/**
 * The reason for linked bookings rather than one row with a long span: settlement
 * runs per booking at completion, so a per-day row is what pays the purohit per day
 * AS THE DAY IS PERFORMED.
 */
describe('the purohit is paid per day, never in advance', () => {
  it('confirms every day on one payment', async () => {
    const c = await confirmed();
    const rows = await seriesRows(c.id);

    expect(c.days).toBe(4);
    expect(rows.every((r) => r.state === 'confirmed')).toBe(true);
  });

  it('captures the token ONCE for the series, not once per day', async () => {
    // N captures against one `paymentIntentId` would collide on the idempotency key
    // that makes a replayed webhook harmless.
    const c = await confirmed();
    const txns = await h.db.select({ n: sql<number>`count(*)::int` })
      .from(ledgerEntries).where(eq(ledgerEntries.type, 'token'));
    // One debit leg and one credit leg — a single balanced transaction.
    expect(Number(txns[0]!.n)).toBe(2);
    expect(c.days).toBe(4);
  });

  it('pays the purohit nothing until a day is actually performed', async () => {
    // The whole requirement. Before this, one row for the series meant settlement
    // fired once — on a booking whose later days had not happened.
    await confirmed();
    expect(await settlementCount()).toBe(0);
    expect(await panditEntryCount()).toBe(0);
  });

  it('pays for day one only after day one completes', async () => {
    const c = await confirmed();
    const rows = await seriesRows(c.id);
    const dayOne = rows[0]!;
    const price = dayOne.price as { balancePaise: number };

    await h.bookings.start({
      bookingId: dayOne.id, panditId: h.ids.panditId, otp: c.startOtp!,
    });
    await h.bookings.complete({
      bookingId: dayOne.id, panditId: h.ids.panditId, otp: c.completeOtp!,
      capturedAt: new Date().toISOString(),
      cashCollectedPaise: price.balancePaise,
    });

    // Exactly one day settled — not the series.
    expect(await settlementCount()).toBe(1);

    // And the later days are still untouched: confirmed, unperformed, unpaid.
    const still = await seriesRows(c.id);
    expect(still.slice(1).every((r) => r.state === 'confirmed')).toBe(true);
    expect(still.slice(1).every((r) => r.completedAt === null)).toBe(true);
  });

  it('binds each day to its own codes', async () => {
    /*
     * A shared completion code would let the purohit settle Dashami on Saptami
     * morning, which is what per-day settlement exists to prevent.
     *
     * Asserted on the stored HASHES rather than by replaying day one's code against
     * day four: `OTP_DEV_BYPASS` is on in tests, so every generated code is literally
     * `123456` and a cross-day replay would succeed here while failing in production
     * for the wrong reason. The hash is keyed on the booking id, so distinct hashes
     * are what actually proves each day stands alone.
     */
    const c = await confirmed();
    const rows = await seriesRows(c.id);

    const starts = rows.map((r) => r.startOtpHash);
    const completes = rows.map((r) => r.completeOtpHash);
    expect(starts.every(Boolean)).toBe(true);
    expect(new Set(starts).size).toBe(4);
    expect(new Set(completes).size).toBe(4);
  });
});

/**
 * Only day one's codes are delivered at confirmation; a family handed eight digits
 * for four days at once reads out the wrong one.
 */
describe('later days get their code on their own morning', () => {
  const job = () => new SeriesCodesJob(
    h.db, h.notifications, new BookingOtpService(TEST_CONFIG.JWT_ACCESS_SECRET), true,
  );

  it('sends nothing while the later days are still far off', async () => {
    await confirmed();
    expect(await job().run()).toBe(0);
  });

  it('sends a code for a later day once it is imminent', async () => {
    const c = await confirmed();
    const rows = await seriesRows(c.id);

    // Pull day two forward to a few hours from now. BOTH ends move: shifting only
    // the start leaves a ten-day interval that overlaps days three and four, and
    // the exclusion constraint rightly refuses it.
    await h.db.update(bookings).set({
      slotStartAt: new Date(Date.now() + 3600_000).toISOString(),
      slotEndAt: new Date(Date.now() + 5 * 3600_000).toISOString(),
    }).where(eq(bookings.id, rows[1]!.id));

    expect(await job().run()).toBe(1);
    const sent = h.notifications.channel.sent
      .filter((m) => m.templateKey === 'booking.series.day.devotee');
    expect(sent).toHaveLength(1);
  });

  it('never sends the same day twice, because sending rewrites the hash', async () => {
    // Re-running would invalidate a code the devotee is already holding, which is
    // worse than not sending at all.
    const c = await confirmed();
    const rows = await seriesRows(c.id);
    await h.db.update(bookings).set({
      slotStartAt: new Date(Date.now() + 3600_000).toISOString(),
      slotEndAt: new Date(Date.now() + 5 * 3600_000).toISOString(),
    }).where(eq(bookings.id, rows[1]!.id));

    expect(await job().run()).toBe(1);
    expect(await job().run()).toBe(0);
  });
});
