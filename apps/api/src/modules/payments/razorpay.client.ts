import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Razorpay Route client.
 *
 * Hand-rolled over fetch rather than the SDK: the surface we need is four calls, and
 * a thin client we control is easier to fake in tests and to reason about when money
 * is on the line.
 *
 * Route is the escrow product - funds land in Razorpay's account and are transferred
 * to linked accounts on our instruction. See ADR 0004, and the open question in
 * PRODUCTION.md about maximum hold duration under the RBI T+1 settlement rule.
 */
const API = 'https://api.razorpay.com/v1';

export interface RazorpayOrder {
  id: string; amount: number; currency: string; status: string; receipt?: string;
}
export interface RazorpayRefund { id: string; amount: number; status: string }
export interface RazorpayTransfer { id: string; amount: number; recipient: string; status: string }
export interface RazorpayLinkedAccount { id: string; status: string }

/**
 * A purohit's payout destination, on its way to the provider and no further.
 *
 * This shape exists so the account number has exactly one place it can be: passed in
 * here, forwarded once, and dropped. Nothing in this interface returns it, and the
 * caller stores only the `id` that comes back.
 */
export interface PayoutAccountInput {
  method: 'bank_account' | 'upi';
  holderName: string;
  /** Bank only. Digits, unformatted. Never persisted. */
  accountNumber?: string;
  /** Bank only. */
  ifsc?: string;
  /** UPI only. */
  vpa?: string;
  email: string;
  phone: string;
}

export interface PaymentGateway {
  createOrder(args: {
    amountPaise: number; receipt: string; notes?: Record<string, string>; idempotencyKey: string;
  }): Promise<RazorpayOrder>;
  refund(args: {
    paymentId: string; amountPaise: number; idempotencyKey: string;
  }): Promise<RazorpayRefund>;
  transfer(args: {
    paymentId: string; linkedAccountId: string; amountPaise: number; idempotencyKey: string;
  }): Promise<RazorpayTransfer>;
  /**
   * Registers the purohit as a Route linked account and returns its id.
   *
   * Route requires a linked account before it will hold or transfer anything on
   * someone's behalf, which is why this is a prerequisite for a payout rather than a
   * detail of one.
   */
  createLinkedAccount(args: PayoutAccountInput & {
    idempotencyKey: string;
  }): Promise<RazorpayLinkedAccount>;
  verifyWebhookSignature(rawBody: string, signature: string): boolean;
}

export class RazorpayClient implements PaymentGateway {
  constructor(
    private readonly keyId: string,
    private readonly keySecret: string,
    private readonly webhookSecret: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private auth(): string {
    return `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64')}`;
  }

  private async call<T>(path: string, body: unknown, idempotencyKey: string): Promise<T> {
    const res = await this.fetchImpl(`${API}${path}`, {
      method: 'POST',
      headers: {
        authorization: this.auth(),
        'content-type': 'application/json',
        'x-razorpay-idempotency-key': idempotencyKey,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`razorpay ${path} failed (${res.status}): ${text.slice(0, 300)}`);
    return JSON.parse(text) as T;
  }

  createOrder(args: {
    amountPaise: number; receipt: string; notes?: Record<string, string>; idempotencyKey: string;
  }) {
    return this.call<RazorpayOrder>('/orders', {
      amount: args.amountPaise, currency: 'INR', receipt: args.receipt,
      notes: args.notes ?? {}, payment_capture: 1,
    }, args.idempotencyKey);
  }

  refund(args: { paymentId: string; amountPaise: number; idempotencyKey: string }) {
    return this.call<RazorpayRefund>(`/payments/${args.paymentId}/refund`, {
      amount: args.amountPaise, speed: 'normal',
    }, args.idempotencyKey);
  }

  transfer(args: {
    paymentId: string; linkedAccountId: string; amountPaise: number; idempotencyKey: string;
  }) {
    return this.call<RazorpayTransfer>(`/payments/${args.paymentId}/transfers`, {
      transfers: [{
        account: args.linkedAccountId, amount: args.amountPaise, currency: 'INR',
        // Held until we instruct settlement - this is the escrow behaviour the
        // booking model depends on.
        on_hold: true,
      }],
    }, args.idempotencyKey);
  }

  createLinkedAccount(args: PayoutAccountInput & { idempotencyKey: string }) {
    return this.call<RazorpayLinkedAccount>('/accounts', {
      type: 'route',
      email: args.email,
      phone: args.phone,
      legal_business_name: args.holderName,
      business_type: 'individual',
      contact_name: args.holderName,
      profile: { category: 'services', subcategory: 'other' },
      // Route's own field names. The account number leaves the process here and is
      // not retained by anything on our side.
      ...(args.method === 'bank_account'
        ? {
          settlements: {
            account_number: args.accountNumber,
            ifsc_code: args.ifsc,
            beneficiary_name: args.holderName,
          },
        }
        : { settlements: { vpa: args.vpa, beneficiary_name: args.holderName } }),
    }, args.idempotencyKey);
  }

  /**
   * HMAC-SHA256 over the RAW body. It must be the exact bytes Razorpay sent: a body
   * that has been parsed and re-serialised will not verify, which is why the webhook
   * route keeps the raw buffer.
   */
  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    if (!signature) return false;
    const expected = createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(signature, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

/**
 * Development gateway: behaves like Razorpay without the network, so the whole
 * booking flow works locally before the PA application is approved (P0-0).
 */
export class FakeGateway implements PaymentGateway {
  readonly orders: RazorpayOrder[] = [];
  readonly refunds: RazorpayRefund[] = [];
  readonly transfers: RazorpayTransfer[] = [];
  constructor(private readonly webhookSecret = 'dev-webhook-secret') {}

  async createOrder(args: { amountPaise: number; receipt: string }) {
    const order: RazorpayOrder = {
      id: `order_dev_${Math.random().toString(36).slice(2, 12)}`,
      amount: args.amountPaise, currency: 'INR', status: 'created', receipt: args.receipt,
    };
    this.orders.push(order);
    return order;
  }
  async refund(args: { paymentId: string; amountPaise: number }) {
    const r = { id: `rfnd_dev_${this.refunds.length}`, amount: args.amountPaise, status: 'processed' };
    this.refunds.push(r); return r;
  }
  async transfer(args: { linkedAccountId: string; amountPaise: number }) {
    const t = {
      id: `trf_dev_${this.transfers.length}`, amount: args.amountPaise,
      recipient: args.linkedAccountId, status: 'created',
    };
    this.transfers.push(t); return t;
  }
  readonly linkedAccounts: Array<{ id: string; holderName: string }> = [];
  async createLinkedAccount(args: PayoutAccountInput) {
    const acct = {
      id: `acc_dev_${this.linkedAccounts.length}`, status: 'created',
    };
    // Deliberately does NOT retain the account number, so a test asserting that the
    // number never leaves the request has something real to assert against.
    this.linkedAccounts.push({ id: acct.id, holderName: args.holderName });
    return acct;
  }
  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    return this.sign(rawBody) === signature;
  }
  sign(rawBody: string): string {
    return createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex');
  }
}
