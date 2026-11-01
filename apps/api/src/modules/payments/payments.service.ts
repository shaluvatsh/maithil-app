import { ulid } from 'ulid';
import { eq, and } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { paymentIntents, webhookEvents, bookings } from '../../db/schema/index';
import type { PaymentGateway } from './razorpay.client';
import type { BookingService } from '../booking/booking.service';
import { DomainError, ErrorCode, type PriceBreakdown } from '@themaithil/contracts';

/**
 * Payments.
 *
 * Two rules govern everything here:
 *
 * 1. THE WEBHOOK IS THE SOURCE OF TRUTH, not the browser callback. A client can lie,
 *    close the tab, or lose the network. A booking only becomes `confirmed` when
 *    Razorpay tells us server-to-server that the payment captured.
 *
 * 2. EXACTLY-ONCE PROCESSING. Razorpay retries webhooks. `webhook_events` has a
 *    unique index on (provider, provider_event_id) and the insert is the claim - if
 *    it conflicts, we have already handled this event and return without doing it
 *    again.
 */
export class PaymentsService {
  constructor(
    private readonly db: Db,
    private readonly gateway: PaymentGateway,
    private readonly bookings: BookingService,
    /** Whether this deployment can charge anybody (`PAYMENTS_ENABLED`). */
    private readonly paymentsEnabled = true,
  ) {}

  /** Creates the order the client hands to Razorpay Checkout. */
  async createTokenIntent(args: { bookingId: string; userId: string }) {
    /*
     * Refused outright when there is no gateway.
     *
     * In cash-only mode a booking is already `confirmed` by the time the devotee
     * could reach a pay button, so the state check below would reject this anyway —
     * but with a message about the booking rather than about the deployment. A
     * client that still has a Pay button from a cached page deserves to be told
     * which of the two is actually true.
     */
    if (!this.paymentsEnabled) {
      throw new DomainError(
        ErrorCode.FORBIDDEN,
        'online payment is not available; this booking is settled in cash',
      );
    }
    const rows = await this.db.select().from(bookings)
      .where(eq(bookings.id, args.bookingId)).limit(1);
    const booking = rows[0];
    if (!booking) throw new DomainError(ErrorCode.NOT_FOUND, 'booking not found');
    if (booking.devoteeId !== args.userId) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'not your booking');
    }
    if (booking.state !== 'pending_accept') {
      throw new DomainError(
        ErrorCode.INVALID_TRANSITION,
        'this booking is not awaiting payment',
        { state: booking.state },
      );
    }

    const price = booking.price as PriceBreakdown;

    // One intent per booking+kind. Re-requesting returns the existing order rather
    // than creating a second one the devotee could also pay.
    const existing = await this.db.select().from(paymentIntents)
      .where(and(
        eq(paymentIntents.bookingId, booking.id),
        eq(paymentIntents.kind, 'token'),
      )).limit(1);
    if (existing[0] && existing[0].status !== 'failed') {
      return {
        paymentIntentId: existing[0].id,
        orderId: existing[0].aggregatorOrderId,
        amountPaise: Number(existing[0].amountPaise),
        keyId: this.gateway.checkoutKeyId(),
      };
    }

    const idempotencyKey = `token:${booking.id}`;
    const order = await this.gateway.createOrder({
      amountPaise: price.tokenPaise,
      receipt: booking.id,
      notes: { bookingId: booking.id, kind: 'token' },
      idempotencyKey,
    });

    const id = ulid();
    await this.db.insert(paymentIntents).values({
      id,
      bookingId: booking.id,
      userId: booking.devoteeId,
      kind: 'token',
      aggregator: 'razorpay',
      aggregatorOrderId: order.id,
      amountPaise: price.tokenPaise,
      status: 'created',
      idempotencyKey,
    });

    /*
     * `keyId` is what the browser needs to open Checkout, and it comes from the
     * gateway that created this very order — so the money cannot land in a
     * different merchant account than the one the order lives in. Null means there
     * is no Checkout to open (the fake gateway, outside production).
     */
    return {
      paymentIntentId: id,
      orderId: order.id,
      amountPaise: price.tokenPaise,
      keyId: this.gateway.checkoutKeyId(),
    };
  }

  /**
   * Webhook entry point. Verifies the signature over the RAW body, claims the event,
   * then dispatches. Anything unrecognised is recorded and acknowledged - replying
   * non-2xx to an event we simply do not handle makes Razorpay retry it forever.
   */
  async handleWebhook(args: { rawBody: string; signature: string }) {
    if (!this.gateway.verifyWebhookSignature(args.rawBody, args.signature)) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'invalid webhook signature');
    }

    const payload = JSON.parse(args.rawBody) as {
      event: string;
      payload?: {
        payment?: { entity?: { id?: string; order_id?: string; method?: string; amount?: number } };
        refund?: { entity?: { id?: string; payment_id?: string } };
      };
    };

    const paymentEntity = payload.payload?.payment?.entity;
    const eventId =
      paymentEntity?.id ??
      payload.payload?.refund?.entity?.id ??
      `${payload.event}:${args.rawBody.length}`;
    const providerEventId = `${payload.event}:${eventId}`;

    const claimed = await this.db.insert(webhookEvents).values({
      id: ulid(),
      provider: 'razorpay',
      providerEventId,
      payload: payload as object,
    }).onConflictDoNothing().returning({ id: webhookEvents.id });

    if (claimed.length === 0) {
      return { status: 'duplicate' as const, event: payload.event };
    }
    const rowId = claimed[0]!.id;

    try {
      const handled = await this.dispatch(payload.event, paymentEntity);
      await this.db.update(webhookEvents)
        .set({ processedAt: new Date().toISOString() })
        .where(eq(webhookEvents.id, rowId));
      return { status: handled ? ('processed' as const) : ('ignored' as const), event: payload.event };
    } catch (e) {
      // Leave processed_at null and record why: the row is the audit trail, and an
      // operator can replay it from the admin console once the cause is fixed.
      await this.db.update(webhookEvents)
        .set({
          attempts: (await this.attempts(rowId)) + 1,
          lastError: e instanceof Error ? e.message : String(e),
        })
        .where(eq(webhookEvents.id, rowId));
      /*
       * Recorded, not rethrown. This class's own contract (see the docstring above)
       * is 200 once the event is claimed - this used to `throw e` here, which the
       * global exception filter turns into a real non-2xx (409 for the slot-conflict
       * case below, but really anything dispatch() can throw), directly contradicting
       * that contract and making Razorpay retry an event that will fail identically
       * every time forever. `webhook_events.last_error` is the actual recovery path:
       * an operator replays it once the cause is fixed. See the strict concurrency
       * review, finding #3.
       */
      return { status: 'failed' as const, event: payload.event };
    }
  }

  private async attempts(id: string): Promise<number> {
    const r = await this.db.select({ attempts: webhookEvents.attempts })
      .from(webhookEvents).where(eq(webhookEvents.id, id)).limit(1);
    return r[0]?.attempts ?? 0;
  }

  private async dispatch(
    event: string,
    payment?: { id?: string; order_id?: string; method?: string; amount?: number },
  ): Promise<boolean> {
    if (!payment?.order_id) return false;

    const rows = await this.db.select().from(paymentIntents)
      .where(eq(paymentIntents.aggregatorOrderId, payment.order_id)).limit(1);
    const intent = rows[0];
    if (!intent) return false;   // an order we did not create; nothing to do

    if (event === 'payment.captured') {
      // The order amount was fixed when WE created it; Razorpay echoes it back on
      // capture and nothing here previously compared the two. A mismatch means
      // either a Razorpay-side bug or a tampered payload that got past signature
      // verification some other way - either way, booking a devotee in on a number
      // nobody quoted them is worse than refusing the webhook and paging ops.
      if (payment.amount !== undefined && payment.amount !== Number(intent.amountPaise)) {
        throw new DomainError(
          ErrorCode.PAYMENT_AMOUNT_MISMATCH,
          `captured amount ${payment.amount} does not match the order amount ${intent.amountPaise}`,
          { intentId: intent.id, orderId: payment.order_id },
        );
      }

      await this.db.update(paymentIntents).set({
        status: 'captured',
        aggregatorPaymentId: payment.id ?? null,
        method: payment.method ?? null,
        capturedAt: new Date().toISOString(),
      }).where(eq(paymentIntents.id, intent.id));

      if (intent.kind === 'token' && intent.bookingId) {
        try {
          // Idempotent by design: a replayed capture finds the booking already
          // confirmed and returns without touching the slot or the ledger.
          await this.bookings.confirmOnTokenCapture({
            bookingId: intent.bookingId,
            paymentIntentId: intent.id,
          });
        } catch (e) {
          /*
           * SLOT_UNAVAILABLE here means a concurrent booking won the purohit's
           * slot between this devotee's draft and this capture - the one real
           * double-booking race the platform accepts (see the Redis hold's own
           * comment in slots.ts). It is deterministic, not transient: retrying
           * confirmOnTokenCapture will fail identically forever, and by the time
           * this webhook fires the money is already captured on Razorpay's side.
           * Leaving it there with nothing but a log line is a devotee charged for
           * a booking that will never happen. Refund immediately instead - this
           * IS the resolution, not a fallback pending a human. See the strict
           * concurrency review, finding #2.
           */
          if (e instanceof DomainError && e.code === ErrorCode.SLOT_UNAVAILABLE && payment.id) {
            await this.gateway.refund({
              paymentId: payment.id,
              amountPaise: Number(intent.amountPaise),
              idempotencyKey: `auto-refund:${intent.id}`,
            });
            await this.db.update(paymentIntents).set({ status: 'refunded' })
              .where(eq(paymentIntents.id, intent.id));
            return true;
          }
          throw e;
        }
      }
      return true;
    }

    if (event === 'payment.failed') {
      await this.db.update(paymentIntents).set({ status: 'failed' })
        .where(eq(paymentIntents.id, intent.id));
      return true;
    }

    return false;
  }

  /** Issues a refund against the original payment. Called by the refund consumer. */
  async refundBooking(args: { bookingId: string; amountPaise: number }) {
    const rows = await this.db.select().from(paymentIntents)
      .where(and(
        eq(paymentIntents.bookingId, args.bookingId),
        eq(paymentIntents.status, 'captured'),
      )).limit(1);
    const intent = rows[0];
    if (!intent?.aggregatorPaymentId) {
      throw new DomainError(
        ErrorCode.PAYMENT_NOT_CAPTURED,
        'nothing was captured for this booking, so there is nothing to refund',
      );
    }
    const refund = await this.gateway.refund({
      paymentId: intent.aggregatorPaymentId,
      amountPaise: args.amountPaise,
      idempotencyKey: `refund:${args.bookingId}`,
    });
    await this.db.update(paymentIntents).set({ status: 'refunded' })
      .where(eq(paymentIntents.id, intent.id));
    return refund;
  }
}
