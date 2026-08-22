import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeHarness, daysFromNow, type Harness } from '../../../test/harness';
import { bookings, paymentIntents, webhookEvents, ledgerEntries, availability } from '../../../db/schema/index';
import { PaymentsService } from '../payments.service';
import { FakeGateway } from '../razorpay.client';

let h: Harness;
let gateway: FakeGateway;
let payments: PaymentsService;
const DATE = daysFromNow(10);

const draftAndSubmit = async () => {
  const d = await h.bookings.createDraft({
    panditId: h.ids.panditId, ritualId: h.ids.ritualId, addressId: h.ids.addressId,
    date: DATE, slotIdx: 1, samagriOption: 'pandit_brings', paymentMode: 'cash',
    attendeeCount: 20, devoteeId: h.ids.devoteeId, citySlug: 'kolkata',
  } as never);
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
});
