import { describe, it, expect } from 'vitest';
import { RazorpayClient, FakeGateway } from '../razorpay.client';

/**
 * The web app decides between opening a real Checkout and taking the local
 * simulate-capture shortcut purely on this value.
 *
 * Before it existed, the booking flow created a payment intent and then always
 * called `/v1/dev/bookings/:id/simulate-token-capture` — an endpoint that refuses to
 * run in production. Every devotee saw "Confirmed. Your booking is set." and no
 * money ever moved.
 */
describe('the gateway says how to check out', () => {
  it('hands the browser the publishable key', () => {
    const gw = new RazorpayClient('rzp_test_abc123', 'secret', 'whsec');
    expect(gw.checkoutKeyId()).toBe('rzp_test_abc123');
  });

  /**
   * The secret must never be the thing handed out. This is the check that survives
   * a future contributor "simplifying" the two into one accessor.
   */
  it('never hands out the secret', () => {
    const gw = new RazorpayClient('rzp_test_abc123', 'super-secret', 'whsec');
    expect(gw.checkoutKeyId()).not.toBe('super-secret');
  });

  /**
   * Null is the signal that there is no Checkout to open. Returning a plausible
   * fake key instead would send a developer to a Razorpay page that rejects it.
   */
  it('reports no checkout on the fake gateway', () => {
    expect(new FakeGateway().checkoutKeyId()).toBeNull();
  });
});
