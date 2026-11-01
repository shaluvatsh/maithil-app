import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { makeHarness, daysFromNow, type Harness } from '../../../test/harness';

let h: Harness;
beforeEach(async () => { h = await makeHarness(); }, 60_000);
afterEach(async () => { await h?.pg.close(); });

/** Takes a booking all the way to a captured token, which is what mints the codes. */
const confirm = async () => {
  const d = await h.bookings.createDraft({
    devoteeId: h.ids.devoteeId, ritualId: h.ids.ritualId,    addressId: h.ids.addressId, date: daysFromNow(6), slotIdx: 1,
    samagriOption: 'pandit_brings', paymentMode: 'cash',
    attendeeCount: 10,
  });
  await h.bookings.submit(d.id, h.ids.devoteeId);
  return h.bookings.confirmOnTokenCapture({
    bookingId: d.id, paymentIntentId: `pi_${d.id}`,
  });
};

const otpMessages = () =>
  h.notifications.channel.sent.filter((m) => m.templateKey.startsWith('booking.otp.'));

/**
 * The start and completion codes have to reach the devotee.
 *
 * `confirmOnTokenCapture` generated both, stored only their HMACs, and carried a
 * comment saying they go to the devotee over WhatsApp. Nothing sent them. Because
 * only hashes are kept, a code not delivered at that moment does not exist anywhere
 * afterwards — so a devotee who had already paid could not start their puja, and
 * the purohit could not settle it.
 */
describe('booking codes reach the devotee', () => {
  it('sends both codes when the payment is captured', async () => {
    await confirm();
    expect(otpMessages().map((m) => m.templateKey).sort())
      .toEqual(['booking.otp.complete', 'booking.otp.start']);
  });

  /**
   * Under the dev bypass every code is `123456`, so asserting the digits appear
   * proves little on its own — an unsubstituted `{{otp}}` is the failure that
   * actually happens, and it would still "contain" nothing recognisable. Both
   * checks together are what make this test mean something.
   */
  it('sends the real codes, not an unrendered template', async () => {
    const res = await confirm();
    const bodies = otpMessages().map((m) => m.body).join('\n');
    expect(bodies).toContain(res.startOtp!);
    expect(bodies).toContain(res.completeOtp!);
    expect(bodies, 'a variable was never substituted').not.toContain('{{');
    // The cash amount is the other variable, and it comes from a different source.
    expect(bodies).toMatch(/₹[\d,]+/);
  });

  it('sends them to the devotee, not the purohit', async () => {
    await confirm();
    const [devotee] = await h.db.execute(sql`
      SELECT phone FROM users WHERE id = ${h.ids.devoteeId}`).then(
        (r) => (((r as { rows?: Array<{ phone: string }> }).rows ?? r) as Array<{ phone: string }>));
    for (const m of otpMessages()) expect(m.to).toBe(devotee!.phone);
  });

  /**
   * Razorpay redelivers webhooks. The second delivery must not message the devotee
   * a second time — and it has no codes to send anyway, since they were never kept.
   */
  it('does not message again on a webhook replay', async () => {
    const d = await h.bookings.createDraft({
      devoteeId: h.ids.devoteeId, ritualId: h.ids.ritualId,      addressId: h.ids.addressId, date: daysFromNow(6), slotIdx: 1,
      samagriOption: 'pandit_brings', paymentMode: 'cash',
      attendeeCount: 10,
    });
    await h.bookings.submit(d.id, h.ids.devoteeId);
    await h.bookings.confirmOnTokenCapture({ bookingId: d.id, paymentIntentId: 'pi_1' });
    const afterFirst = otpMessages().length;

    await h.bookings.confirmOnTokenCapture({ bookingId: d.id, paymentIntentId: 'pi_1' });
    expect(otpMessages().length, 'a replayed webhook messaged the devotee again')
      .toBe(afterFirst);
  });

  /** Same rule as the login code: the plaintext must never be written down. */
  it('never stores a code in the database', async () => {
    const res = await confirm();
    const rows = await h.db.execute(sql`
      SELECT payload::text AS p FROM notifications WHERE template_key LIKE 'booking.otp.%'`);
    const list = ((rows as { rows?: Array<{ p: string }> }).rows ?? rows) as Array<{ p: string }>;
    expect(list.length).toBeGreaterThan(0);
    for (const r of list) {
      expect(r.p, 'a plaintext booking code was persisted').not.toContain(res.startOtp!);
      expect(r.p).not.toContain(res.completeOtp!);
    }
  });
});
