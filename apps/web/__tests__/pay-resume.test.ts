import { describe, it, expect, vi } from 'vitest';
import { payForBooking } from '@/lib/checkout';

/**
 * The account page's "Pay now" — the path a devotee takes after abandoning
 * checkout — called `simulate-token-capture` with no `keyId` branch. That endpoint
 * refuses to run when `NODE_ENV=production`, so in production the one route back to
 * payment answered 403 to exactly the customers most worth recovering. Its own
 * docstring claimed it "mirrors /book's pay() exactly"; it never did.
 *
 * These pin the branch itself rather than either screen, because the bug was that
 * two copies of it drifted apart.
 */
const routes = (keyId: string | null) => {
  const seen: string[] = [];
  const request = vi.fn(async (path: string) => {
    seen.push(path);
    if (path.endsWith('/payment-intent')) {
      return { orderId: 'order_1', amountPaise: 55900, keyId };
    }
    if (path.endsWith('/simulate-token-capture')) {
      return { startOtp: '123456', completeOtp: '654321' };
    }
    if (path.endsWith('/submit')) return {};
    return { state: 'confirmed' };
  });
  return { request, seen };
};

describe('paying for a booking', () => {
  /**
   * Stands in for Razorpay's script, which cannot load in jsdom. Dismissing is the
   * cheapest real outcome to drive, and it settles the flow without pretending a
   * payment succeeded.
   */
  const stubCheckout = (behaviour: 'dismiss' | 'pay' = 'dismiss') => {
    (window as unknown as { Razorpay: unknown }).Razorpay = function (
      opts: { handler: (r: unknown) => void; modal: { ondismiss: () => void } },
    ) {
      return {
        open: () => (behaviour === 'dismiss'
          ? opts.modal.ondismiss()
          : opts.handler({ razorpay_payment_id: 'pay_1' })),
      };
    };
  };

  it('never calls the dev shortcut when a real Checkout key exists', async () => {
    // The whole bug, in one assertion: with a key configured, the
    // production-refused endpoint must not be reached.
    stubCheckout();
    const { request, seen } = routes('rzp_test_abc');

    const outcome = await payForBooking(
      { bookingId: 'b1', description: 'Online Aarti' }, request as never,
    );

    expect(outcome).toEqual({ status: 'dismissed' });
    expect(seen.some((p) => p.includes('simulate-token-capture'))).toBe(false);
    expect(seen.some((p) => p.includes('payment-intent'))).toBe(true);
  });

  it('confirms from the SERVER after Checkout, never from the browser handler', async () => {
    // Razorpay's handler runs on the devotee's phone and proves nothing; the money
    // is real only once the signed webhook has reached the API.
    stubCheckout('pay');
    const { request, seen } = routes('rzp_test_abc');

    const outcome = await payForBooking(
      { bookingId: 'b1', description: 'Online Aarti' }, request as never,
    );

    expect(outcome).toEqual({ status: 'confirmed', codes: {} });
    // The state was re-read from the API rather than assumed.
    expect(seen.filter((p) => p === '/v1/bookings/b1').length).toBeGreaterThan(0);
  });

  it('takes the local shortcut only when there is no key to open Checkout with', async () => {
    const { request, seen } = routes(null);
    const outcome = await payForBooking(
      { bookingId: 'b1', description: 'Online Aarti' }, request as never,
    );

    expect(seen.some((p) => p.includes('simulate-token-capture'))).toBe(true);
    expect(outcome).toEqual({
      status: 'confirmed', codes: { startOtp: '123456', completeOtp: '654321' },
    });
  });

  it('submits a draft first, because payment-intent rejects one outright', async () => {
    // `/book` issues create and submit as two requests; the second can be lost to a
    // closed tab, leaving a booking that can never be paid for without this.
    const { request, seen } = routes(null);
    await payForBooking(
      { bookingId: 'b1', description: 'Online Aarti', state: 'draft' }, request as never,
    );

    expect(seen[0]).toContain('/submit');
    expect(seen[1]).toContain('/payment-intent');
  });

  it('does not submit a booking that is already awaiting payment', async () => {
    const { request, seen } = routes(null);
    await payForBooking(
      { bookingId: 'b1', description: 'Online Aarti', state: 'pending_accept' },
      request as never,
    );

    expect(seen.some((p) => p.includes('/submit'))).toBe(false);
  });
});
