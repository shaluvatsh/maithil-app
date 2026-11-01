/**
 * Razorpay Checkout.
 *
 * The booking flow created a payment intent and then called
 * `/v1/dev/bookings/:id/simulate-token-capture` — an endpoint that refuses to run in
 * production. So every devotee saw "Confirmed. Your booking is set." and no money
 * ever moved. The whole revenue path terminated in a dev stub.
 *
 * Two things this module is careful about:
 *
 * The handler is NOT the confirmation. Razorpay calls it in the devotee's browser,
 * and a browser can be closed, refreshed or lied to. The booking becomes confirmed
 * when the signed webhook reaches the API, which is why `pay()` below reports only
 * that the devotee finished the Checkout, and the page then asks the server what
 * actually happened.
 *
 * A dismissed Checkout is not a failure. Closing the sheet is an ordinary thing to
 * do, and it must leave the booking exactly as it was so the devotee can press pay
 * again — not strand them on an error screen.
 */

const SCRIPT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';

interface RazorpayInstance { open(): void }
interface RazorpayCtor { new (options: Record<string, unknown>): RazorpayInstance }

declare global {
  interface Window { Razorpay?: RazorpayCtor }
}

let loading: Promise<RazorpayCtor> | null = null;

/**
 * Loads Checkout once per page, and remembers the attempt rather than the result:
 * a devotee who presses pay, dismisses, and presses again must not pull the script
 * down a second time.
 */
function loadCheckout(): Promise<RazorpayCtor> {
  if (window.Razorpay) return Promise.resolve(window.Razorpay);
  if (loading) return loading;

  loading = new Promise<RazorpayCtor>((resolve, reject) => {
    const el = document.createElement('script');
    el.src = SCRIPT_SRC;
    el.async = true;
    el.onload = () => {
      if (window.Razorpay) resolve(window.Razorpay);
      else reject(new Error('Could not start the payment screen. Please try again.'));
    };
    el.onerror = () => {
      // Let the next attempt retry: a flaky connection on a phone is the common
      // case here, and caching the failure would make pay permanently dead.
      loading = null;
      reject(new Error('Could not reach the payment provider. Check your connection.'));
    };
    document.head.appendChild(el);
  });
  return loading;
}

export interface CheckoutArgs {
  keyId: string;
  orderId: string;
  amountPaise: number;
  /** Shown on the Checkout sheet so the devotee recognises what they are paying for. */
  description: string;
  prefill?: { name?: string; contact?: string; email?: string };
}

export type CheckoutOutcome =
  /** The devotee completed payment. The webhook decides whether it stands. */
  | { status: 'submitted'; paymentId: string }
  /** They closed the sheet. The booking is untouched and they may try again. */
  | { status: 'dismissed' }
  /** Razorpay rejected the payment and told us why. */
  | { status: 'failed'; reason: string };

export async function payWithRazorpay(args: CheckoutArgs): Promise<CheckoutOutcome> {
  const Razorpay = await loadCheckout();

  return new Promise<CheckoutOutcome>((resolve) => {
    /*
     * `settle` guards against Razorpay firing more than one of these. `ondismiss`
     * runs on a successful payment too in some flows, and resolving twice would
     * turn a paid booking into a dismissed one.
     */
    let done = false;
    const settle = (o: CheckoutOutcome) => { if (!done) { done = true; resolve(o); } };

    const rzp = new Razorpay({
      key: args.keyId,
      order_id: args.orderId,
      amount: args.amountPaise,
      currency: 'INR',
      name: 'TheMaithil',
      description: args.description,
      ...(args.prefill ? { prefill: args.prefill } : {}),
      // Indian phones are the whole market; UPI first is what people expect.
      theme: { color: '#C2410C' },
      handler: (res: { razorpay_payment_id?: string }) =>
        settle({ status: 'submitted', paymentId: res.razorpay_payment_id ?? '' }),
      modal: { ondismiss: () => settle({ status: 'dismissed' }) },
    });

    /*
     * A declined card or a failed UPI collect is a normal outcome, not an
     * exception. Razorpay reports it here rather than through `handler`, and the
     * devotee needs the provider's own reason - "insufficient funds" is actionable
     * in a way that "payment failed" is not.
     */
    const withEvents = rzp as RazorpayInstance & {
      on?: (event: string, cb: (r: { error?: { description?: string } }) => void) => void;
    };
    withEvents.on?.('payment.failed', (r) =>
      settle({ status: 'failed', reason: r.error?.description ?? 'The payment did not go through.' }));

    rzp.open();
  });
}

/**
 * Paying for a booking, from anywhere it can be paid for.
 *
 * This logic existed twice and the two copies disagreed. `/book`'s version branched
 * on `keyId` — null means the fake gateway, which only exists outside production —
 * and opened real Checkout when a key was present. The account page's "Pay now",
 * the path a devotee takes when they abandon checkout and come back, called
 * `simulate-token-capture` UNCONDITIONALLY. That endpoint refuses to run when
 * `NODE_ENV=production`, so in production the resume-payment path returned 403 to
 * exactly the customers most worth recovering. It was written as "mirrors /book's
 * pay() exactly" and never did.
 *
 * One routine now, so the branch cannot be forgotten at a third call site.
 */
export type PayOutcome =
  /** Money captured and the webhook has landed. `codes` only ever set in dev. */
  | { status: 'confirmed'; codes: { startOtp?: string; completeOtp?: string } }
  /** They closed the sheet. The booking is untouched and they may press pay again. */
  | { status: 'dismissed' }
  /** The provider declined and told us why, in words worth showing. */
  | { status: 'failed'; reason: string }
  /** Paid, but the webhook has not reached us yet. Never tell them to pay again. */
  | { status: 'pending' };

interface PayArgs {
  bookingId: string;
  /** Shown on the Checkout sheet so the devotee recognises what they are paying for. */
  description: string;
  /**
   * The booking's current state, when the caller knows it.
   *
   * `draft` means create-then-submit was interrupted — `/book` issues those as two
   * requests and the second can be lost to a closed tab. `payment-intent` requires
   * `pending_accept` and rejects a draft outright, so submitting first is simply
   * what the booking flow would have done a moment later.
   */
  state?: string | undefined;
  prefillName?: string | null | undefined;
}

export async function payForBooking(
  args: PayArgs,
  /** Injected so this module keeps no dependency on where `api` lives. */
  request: <T>(path: string, init?: RequestInit & { auth?: boolean }) => Promise<T>,
): Promise<PayOutcome> {
  if (args.state === 'draft') {
    await request(`/v1/bookings/${args.bookingId}/submit`, { method: 'POST' });
  }

  const intent = await request<{ orderId: string; amountPaise: number; keyId: string | null }>(
    `/v1/bookings/${args.bookingId}/payment-intent`, { method: 'POST' },
  );

  /*
   * No key means there is no Checkout to open. Keeping the local shortcut on THIS
   * branch is what stops it ever running when real payments are configured.
   */
  if (!intent.keyId) {
    const codes = await request<{ startOtp?: string; completeOtp?: string }>(
      `/v1/dev/bookings/${args.bookingId}/simulate-token-capture`, { method: 'POST' },
    );
    return { status: 'confirmed', codes };
  }

  const outcome = await payWithRazorpay({
    keyId: intent.keyId,
    orderId: intent.orderId,
    amountPaise: intent.amountPaise,
    description: args.description,
    ...(args.prefillName ? { prefill: { name: args.prefillName } } : {}),
  });

  if (outcome.status === 'dismissed') return { status: 'dismissed' };
  if (outcome.status === 'failed') return { status: 'failed', reason: outcome.reason };

  const state = await awaitConfirmation(args.bookingId, request);
  if (state === null) return { status: 'pending' };

  // Confirmed. No codes: only their hashes are stored, and the real ones went to
  // the devotee's phone.
  return { status: 'confirmed', codes: {} };
}

/**
 * Waits for the webhook to confirm the booking.
 *
 * Razorpay's browser handler is not proof of anything — it runs on the devotee's
 * phone, and the money is only real once the signed webhook reaches our API. So
 * after Checkout closes we ask the server what state the booking is actually in,
 * rather than believing the browser.
 *
 * Polling, because the webhook is a separate round trip from Razorpay to us: it
 * usually lands within a second or two, but not always, and a devotee watching a
 * spinner needs it to end either way.
 */
async function awaitConfirmation(
  bookingId: string,
  request: <T>(path: string, init?: RequestInit & { auth?: boolean }) => Promise<T>,
): Promise<string | null> {
  for (let i = 0; i < 12; i++) {
    const b = await request<{ state: string }>(`/v1/bookings/${bookingId}`);
    if (b.state !== 'pending_accept') return b.state;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}
