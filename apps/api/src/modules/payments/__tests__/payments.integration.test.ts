import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeHarness, daysFromNow, type Harness } from '../../../test/harness';
import { bookings, paymentIntents, webhookEvents, ledgerEntries, availability } from '../../../db/schema/index';
import { PaymentsService } from '../payments.service';
import { FakeGateway, RazorpayClient } from '../razorpay.client';
import { holdKey } from '../../../domain/slots';

let h: Harness;
let gateway: FakeGateway;
let payments: PaymentsService;
const DATE = daysFromNow(10);

const draftAndSubmit = async () => {
  const d = await h.bookings.createDraft({
    panditId: h.ids.panditId, ritualId: h.ids.ritualId, addressId: h.ids.addressId,
    date: DATE, slotIdx: 1, samagriOption: 'pandit_brings', paymentMode: 'cash',
    attendeeCount: 20, devoteeId: h.ids.devoteeId,  } as never);
  await h.bookings.submit(d.id, h.ids.devoteeId);
  await h.bookings.accept(d.id, h.ids.panditId);
  return d;
};

const capturedEvent = (orderId: string, paymentId = 'pay_dev_1') => JSON.stringify({
  event: 'payment.captured',
  payload: { payment: { entity: { id: paymentId, order_id: orderId, method: 'upi', amount: 22500 } } },
});

beforeEach(async () => {
  h = await makeHarness();
  gateway = new FakeGateway();
  payments = new PaymentsService(h.db, gateway, h.bookings);
}, 60_000);
afterEach(async () => { await h?.pg.close(); });

describe('payments', () => {
  it('creates an order for exactly the token amount', async () => {
    const d = await draftAndSubmit();
    const intent = await payments.createTokenIntent({
      bookingId: d.id, userId: h.ids.devoteeId,
    });
    expect(intent.amountPaise).toBe(d.price.tokenPaise);
    expect(gateway.orders).toHaveLength(1);
    expect(gateway.orders[0]!.amount).toBe(d.price.tokenPaise);
  });

  it('never creates a second payable order for the same booking', async () => {
    const d = await draftAndSubmit();
    const a = await payments.createTokenIntent({ bookingId: d.id, userId: h.ids.devoteeId });
    const b = await payments.createTokenIntent({ bookingId: d.id, userId: h.ids.devoteeId });
    expect(b.orderId).toBe(a.orderId);
    expect(gateway.orders).toHaveLength(1);
  });

  /**
   * The client cannot open Checkout without this, and it must come back on BOTH
   * paths — a devotee who pressed pay, dismissed the sheet and pressed again gets
   * the existing intent, and that response was missing the key entirely.
   */
  it('returns the checkout key on a fresh intent and on a repeat', async () => {
    const d = await draftAndSubmit();
    // Stubbed transport: this is about what the response carries, not about
    // reaching Razorpay — and a test that makes a real network call is not a test.
    const stub = (async () => new Response(
      JSON.stringify({ id: 'order_x', amount: 1, currency: 'INR', status: 'created' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch;
    const real = new PaymentsService(
      h.db, new RazorpayClient('rzp_test_key', 's', 'w', stub), h.bookings,
    );
    const first = await real.createTokenIntent({ bookingId: d.id, userId: h.ids.devoteeId });
    expect(first.keyId).toBe('rzp_test_key');

    const again = await real.createTokenIntent({ bookingId: d.id, userId: h.ids.devoteeId });
    expect(again.orderId, 'a second order was created').toBe(first.orderId);
    expect(again.keyId, 'the repeat response could not open Checkout').toBe('rzp_test_key');
  });

  it("refuses to create an order for someone else's booking", async () => {
    const d = await draftAndSubmit();
    await expect(payments.createTokenIntent({ bookingId: d.id, userId: h.ids.panditId }))
      .rejects.toThrow(/not your booking/);
  });

  it('REJECTS a webhook with a bad signature', async () => {
    const body = capturedEvent('order_x');
    await expect(payments.handleWebhook({ rawBody: body, signature: 'deadbeef' }))
      .rejects.toThrow(/invalid webhook signature/);
    expect(await h.db.select().from(webhookEvents)).toHaveLength(0);
  });

  it('rejects a tampered body even with a previously valid signature', async () => {
    const body = capturedEvent('order_x');
    const signature = gateway.sign(body);
    const tampered = body.replace('22500', '1');
    await expect(payments.handleWebhook({ rawBody: tampered, signature }))
      .rejects.toThrow(/invalid webhook signature/);
  });

  it('confirms the booking when the token capture arrives', async () => {
    const d = await draftAndSubmit();
    const intent = await payments.createTokenIntent({ bookingId: d.id, userId: h.ids.devoteeId });

    const body = capturedEvent(intent.orderId!);
    const res = await payments.handleWebhook({ rawBody: body, signature: gateway.sign(body) });
    expect(res.status).toBe('processed');

    const b = await h.db.select().from(bookings).where(eq(bookings.id, d.id));
    expect(b[0]!.state).toBe('confirmed');

    // slot taken, token in escrow
    const slots = await h.db.select().from(availability).where(eq(availability.bookingId, d.id));
    expect(slots[0]!.status).toBe('booked');
    const token = await h.db.select().from(ledgerEntries).where(eq(ledgerEntries.type, 'token'));
    expect(token).toHaveLength(2);

    const pi = await h.db.select().from(paymentIntents).where(eq(paymentIntents.id, intent.paymentIntentId));
    expect(pi[0]!.status).toBe('captured');
    expect(pi[0]!.method).toBe('upi');
  });

  it('EXACTLY ONCE: a replayed capture does not double-confirm or double-post', async () => {
    const d = await draftAndSubmit();
    const intent = await payments.createTokenIntent({ bookingId: d.id, userId: h.ids.devoteeId });
    const body = capturedEvent(intent.orderId!);
    const sig = gateway.sign(body);

    const first = await payments.handleWebhook({ rawBody: body, signature: sig });
    const second = await payments.handleWebhook({ rawBody: body, signature: sig });
    const third = await payments.handleWebhook({ rawBody: body, signature: sig });

    expect(first.status).toBe('processed');
    expect(second.status).toBe('duplicate');
    expect(third.status).toBe('duplicate');

    const token = await h.db.select().from(ledgerEntries).where(eq(ledgerEntries.type, 'token'));
    expect(token).toHaveLength(2);   // one debit, one credit. Not six.
    expect(await h.db.select().from(webhookEvents)).toHaveLength(1);
  });

  it('marks a failed payment without touching the booking', async () => {
    const d = await draftAndSubmit();
    const intent = await payments.createTokenIntent({ bookingId: d.id, userId: h.ids.devoteeId });
    const body = JSON.stringify({
      event: 'payment.failed',
      payload: { payment: { entity: { id: 'pay_f', order_id: intent.orderId, method: 'upi' } } },
    });
    await payments.handleWebhook({ rawBody: body, signature: gateway.sign(body) });

    const b = await h.db.select().from(bookings).where(eq(bookings.id, d.id));
    expect(b[0]!.state).toBe('pending_accept');
    const pi = await h.db.select().from(paymentIntents).where(eq(paymentIntents.id, intent.paymentIntentId));
    expect(pi[0]!.status).toBe('failed');
  });

  it('acknowledges events it does not handle instead of erroring', async () => {
    const body = JSON.stringify({
      event: 'payment.authorized',
      payload: { payment: { entity: { id: 'pay_z', order_id: 'order_unknown' } } },
    });
    const res = await payments.handleWebhook({ rawBody: body, signature: gateway.sign(body) });
    expect(res.status).toBe('ignored');
  });

  it('refunds against the original captured payment', async () => {
    const d = await draftAndSubmit();
    const intent = await payments.createTokenIntent({ bookingId: d.id, userId: h.ids.devoteeId });
    const body = capturedEvent(intent.orderId!);
    await payments.handleWebhook({ rawBody: body, signature: gateway.sign(body) });

    const refund = await payments.refundBooking({
      bookingId: d.id, amountPaise: d.price.tokenPaise,
    });
    expect(refund.amount).toBe(d.price.tokenPaise);
    expect(gateway.refunds).toHaveLength(1);
  });

  it('will not refund a booking that never captured', async () => {
    const d = await draftAndSubmit();
    await expect(payments.refundBooking({ bookingId: d.id, amountPaise: 100 }))
      .rejects.toThrow(/nothing was captured/);
  });

  /**
   * The concurrency review's finding #2: the Redis hold that is supposed to stop two
   * devotees racing the same purohit+slot only protects the checkout window, not the
   * whole time a booking can sit unpaid - so a second booking for the identical
   * purohit+slot can still reach payment capture. Confirmed here by naming the same
   * purohit explicitly for both (which skips `matchPandit`'s own availability
   * filter, exactly like a client that already has a purohit in mind), rather than
   * by manipulating the Redis hold's TTL directly.
   */
  it('auto-refunds a captured payment when the slot was already taken by a faster booking', async () => {
    const draftFor = async () => {
      const d = await h.bookings.createDraft({
        panditId: h.ids.panditId, ritualId: h.ids.ritualId, addressId: h.ids.addressId,
        date: DATE, slotIdx: 2, samagriOption: 'pandit_brings', paymentMode: 'cash',
        attendeeCount: 20, devoteeId: h.ids.devoteeId,      } as never);
      await h.bookings.submit(d.id, h.ids.devoteeId);
      await h.bookings.accept(d.id, h.ids.panditId);
      return d;
    };

    const winner = await draftFor();
    // The Redis hold (10 min TTL) is what stops a SECOND draft for this exact
    // purohit+date+slot in the ordinary case - it is UX, not the correctness
    // guarantee (see slots.ts). Clearing it here is standing in for the hold
    // simply having expired before the winner finished paying, which is the
    // actual, plausible trigger for this race: nothing enforces that checkout
    // finishes inside 10 minutes.
    await h.kv.del(holdKey(h.ids.panditId, DATE, 2));
    const loser = await draftFor();   // same purohit, same date, same slot

    const winnerIntent = await payments.createTokenIntent({
      bookingId: winner.id, userId: h.ids.devoteeId,
    });
    const winnerBody = capturedEvent(winnerIntent.orderId!, 'pay_winner');
    const winnerRes = await payments.handleWebhook({
      rawBody: winnerBody, signature: gateway.sign(winnerBody),
    });
    expect(winnerRes.status).toBe('processed');

    const loserIntent = await payments.createTokenIntent({
      bookingId: loser.id, userId: h.ids.devoteeId,
    });
    const loserBody = capturedEvent(loserIntent.orderId!, 'pay_loser');
    const loserRes = await payments.handleWebhook({
      rawBody: loserBody, signature: gateway.sign(loserBody),
    });
    // Handled, not an error surfaced to Razorpay: the resolution IS the refund.
    expect(loserRes.status).toBe('processed');

    const loserBooking = await h.db.select().from(bookings).where(eq(bookings.id, loser.id));
    expect(loserBooking[0]!.state).toBe('pending_accept');   // never confirmed

    const loserPi = await h.db.select().from(paymentIntents)
      .where(eq(paymentIntents.id, loserIntent.paymentIntentId));
    expect(loserPi[0]!.status).toBe('refunded');
    expect(gateway.refunds).toHaveLength(1);
    expect(gateway.refunds[0]!.amount).toBe(loser.price.tokenPaise);
  });

  /**
   * Finding #3: the class's own docstring promises 200 once an event is claimed, so
   * Razorpay never retries something that will fail identically forever. A tampered
   * amount is claimed (it has a valid signature) but fails inside dispatch() - that
   * must come back as an acknowledged failure, not a thrown error the controller
   * would turn into a non-2xx.
   */
  it('acknowledges a claimed event that fails to dispatch, rather than throwing', async () => {
    const d = await draftAndSubmit();
    const intent = await payments.createTokenIntent({ bookingId: d.id, userId: h.ids.devoteeId });
    const body = JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: { entity: { id: 'pay_bad', order_id: intent.orderId, method: 'upi', amount: 1 } },
      },
    });
    const res = await payments.handleWebhook({ rawBody: body, signature: gateway.sign(body) });
    expect(res.status).toBe('failed');

    const b = await h.db.select().from(bookings).where(eq(bookings.id, d.id));
    expect(b[0]!.state).toBe('pending_accept');   // never confirmed off a mismatched amount

    const events = await h.db.select().from(webhookEvents);
    expect(events[0]!.processedAt).toBeNull();
    expect(events[0]!.lastError).toMatch(/does not match/);
  });
});
