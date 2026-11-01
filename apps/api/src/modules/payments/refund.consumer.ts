import { Logger } from '@nestjs/common';
import type { Db } from '../../db/client';
import type { OutboxService } from '../../domain/outbox';
import type { PaymentsService } from './payments.service';
import type { EventPublisher } from '../../workers/outbox-relay';
import { DomainError, ErrorCode } from '@themaithil/contracts';

/**
 * Sends cancelled devotees their money back.
 *
 * `booking.refund_due` has been in the state machine since the first commit and
 * `PaymentsService.refundBooking` carries the docstring "Called by the refund
 * consumer" — but no such consumer existed. Cancelling wrote a `devotee_credit`
 * entry to the ledger and stopped there.
 *
 * So the books said the devotee was owed money and nothing ever moved it. The
 * cancellation message even told them "we are refunding the full amount". For a
 * devotee who cancelled a wedding puja, that is a promise the product made, recorded
 * against itself, and had no code path to keep.
 *
 * The ledger entry is still the source of truth for what is owed; this only performs
 * the transfer the ledger already committed to.
 */
const CONSUMER = 'refunds';

export class RefundConsumer implements EventPublisher {
  private readonly log = new Logger('refunds');

  constructor(
    private readonly db: Db,
    private readonly outbox: OutboxService,
    private readonly payments: PaymentsService,
  ) {}

  async publish(event: { id: string; eventType: string; aggregateId: string; payload: unknown }) {
    if (event.eventType !== 'booking.refund_due') return;

    /*
     * Claim first. Delivery is at-least-once, and a second delivery that reached the
     * gateway again would refund a devotee twice — the gateway's own idempotency key
     * is the backstop, this is the cheap guard in front of it.
     */
    const mine = await this.outbox.claimForConsumer(this.db, CONSUMER, event.id);
    if (!mine) return;

    const amountPaise = Number(
      (event.payload as { refundPaise?: number } | null)?.refundPaise ?? 0,
    );
    // A cancellation inside the no-refund window emits the event with nothing owed.
    // That is a normal outcome, not a refund of zero to attempt.
    if (!Number.isFinite(amountPaise) || amountPaise <= 0) return;

    try {
      await this.payments.refundBooking({ bookingId: event.aggregateId, amountPaise });
      this.log.log(`refunded ${amountPaise}p for booking ${event.aggregateId}`);
    } catch (e) {
      /*
       * A cash booking has no captured payment, so there is nothing for the gateway
       * to reverse — the devotee never paid us. That is a settled outcome, not a
       * failure to retry, and releasing the claim would make it retry forever.
       */
      if (e instanceof DomainError && e.code === ErrorCode.PAYMENT_NOT_CAPTURED) {
        this.log.log(`no captured payment for ${event.aggregateId}; nothing to refund`);
        return;
      }
      // Anything else is worth another attempt on the next delivery. Release the
      // claim so the relay can retry, and never let it stall the relay itself.
      await this.outbox.unclaimForConsumer(this.db, CONSUMER, event.id);
      this.log.error(
        `refund failed for booking ${event.aggregateId}`,
        e instanceof Error ? e.stack : String(e),
      );
    }
  }
}
