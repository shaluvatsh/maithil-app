import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { makeHarness, daysFromNow, type Harness } from '../../../test/harness';
import { RefundConsumer } from '../refund.consumer';
import { DomainError, ErrorCode } from '@themaithil/contracts';

let h: Harness;
let refundBooking: ReturnType<typeof vi.fn>;
let consumer: RefundConsumer;

beforeEach(async () => {
  h = await makeHarness();
  refundBooking = vi.fn(async () => ({ id: 'rfnd_1', amount: 0, status: 'processed' }));
  consumer = new RefundConsumer(h.db, h.outbox, { refundBooking } as never);
}, 60_000);
afterEach(async () => { await h?.pg.close(); });

const event = (over: Record<string, unknown> = {}) => ({
  id: 'evt_1', eventType: 'booking.refund_due', aggregateId: 'bk_1',
  payload: { refundPaise: 50000 }, ...over,
});

/**
 * A cancelled devotee has to get their money back.
 *
 * `booking.refund_due` has been in the state machine since the first commit, and
 * `refundBooking` carried the comment "Called by the refund consumer" — but no
 * consumer existed. Cancelling wrote a `devotee_credit` ledger entry and stopped.
 * The books recorded the debt, the cancellation message promised "we are refunding
 * the full amount", and no code path could ever move the money.
 */
describe('refunds actually leave the platform', () => {
  it('refunds the amount the cancellation recorded', async () => {
    await consumer.publish(event());
    expect(refundBooking).toHaveBeenCalledWith({ bookingId: 'bk_1', amountPaise: 50000 });
  });

  it('ignores events it is not responsible for', async () => {
    await consumer.publish(event({ eventType: 'booking.confirmed' }));
    expect(refundBooking).not.toHaveBeenCalled();
  });

  /** Inside the no-refund window nothing is owed; there is no zero-refund to attempt. */
  it('does nothing when no money is owed', async () => {
    await consumer.publish(event({ payload: { refundPaise: 0 } }));
    expect(refundBooking).not.toHaveBeenCalled();
  });

  /**
   * The relay delivers at least once. A redelivery that reached the gateway again
   * would refund a devotee twice.
   */
  it('refunds once even when the event is delivered twice', async () => {
    await consumer.publish(event());
    await consumer.publish(event());
    expect(refundBooking).toHaveBeenCalledTimes(1);
  });

  /**
   * A cash booking has no captured payment — the devotee never paid us, so there is
   * nothing to reverse. Settled, not retryable: releasing the claim would make it
   * retry forever.
   */
  it('settles a cash booking without retrying it', async () => {
    refundBooking.mockRejectedValueOnce(
      new DomainError(ErrorCode.PAYMENT_NOT_CAPTURED, 'nothing captured'));
    await consumer.publish(event());

    const rows = await h.db.execute(sql`
      SELECT count(*)::int AS n FROM processed_events
       WHERE consumer = 'refunds' AND event_id = 'evt_1'`);
    const n = (((rows as { rows?: Array<{ n: number }> }).rows ?? rows) as Array<{ n: number }>)[0]!.n;
    expect(n, 'the claim was released, so this will retry forever').toBe(1);
  });

  /** A gateway outage must be retried, not swallowed. */
  it('releases the claim so a failed refund is tried again', async () => {
    refundBooking.mockRejectedValueOnce(new Error('razorpay 503'));
    await consumer.publish(event());

    const rows = await h.db.execute(sql`
      SELECT count(*)::int AS n FROM processed_events
       WHERE consumer = 'refunds' AND event_id = 'evt_1'`);
    const n = (((rows as { rows?: Array<{ n: number }> }).rows ?? rows) as Array<{ n: number }>)[0]!.n;
    expect(n, 'a failed refund stayed claimed and will never retry').toBe(0);

    // And the retry succeeds.
    await consumer.publish(event());
    expect(refundBooking).toHaveBeenCalledTimes(2);
  });

  /** One consumer throwing must never stop the relay or the other consumers. */
  it('never throws out of publish', async () => {
    refundBooking.mockRejectedValueOnce(new Error('boom'));
    await expect(consumer.publish(event())).resolves.toBeUndefined();
  });
});

/**
 * The wiring, not the consumer.
 *
 * Every test above hands the consumer an event it constructed. This one cancels a
 * real booking and checks that what the state machine actually emits is a shape the
 * consumer acts on — the gap that let `refundBooking` sit unreferenced for so long
 * was never inside the consumer, it was that nothing connected the two.
 */
describe('a real cancellation reaches the refund consumer', () => {
  it('emits a refund_due event the consumer refunds against', async () => {
    const d = await h.bookings.createDraft({
      devoteeId: h.ids.devoteeId, ritualId: h.ids.ritualId,      addressId: h.ids.addressId, date: daysFromNow(20), slotIdx: 1,
      samagriOption: 'pandit_brings', paymentMode: 'cash', attendeeCount: 10,
    } as never);
    await h.bookings.submit(d.id, h.ids.devoteeId);
    await h.bookings.confirmOnTokenCapture({ bookingId: d.id, paymentIntentId: `pi_${d.id}` });

    await h.bookings.cancel({
      bookingId: d.id, actorId: h.ids.devoteeId, actorRole: 'devotee',
      reason: 'changed our plans',
    } as never);

    const rows = await h.db.execute(sql`
      SELECT id, event_type, payload::text AS payload FROM outbox
       WHERE aggregate_id = ${d.id} AND event_type = 'booking.refund_due'`);
    const events = ((rows as { rows?: Array<{ id: string; event_type: string; payload: string }> })
      .rows ?? rows) as Array<{ id: string; event_type: string; payload: string }>;
    expect(events, 'cancelling emitted no refund_due event').toHaveLength(1);

    await consumer.publish({
      id: events[0]!.id,
      eventType: events[0]!.event_type,
      aggregateId: d.id,
      payload: JSON.parse(events[0]!.payload),
    });

    expect(refundBooking, 'the emitted payload was not one the consumer acts on')
      .toHaveBeenCalledTimes(1);
    expect(refundBooking.mock.calls[0]![0]).toMatchObject({ bookingId: d.id });
    expect((refundBooking.mock.calls[0]![0] as { amountPaise: number }).amountPaise)
      .toBeGreaterThan(0);
  });
});
