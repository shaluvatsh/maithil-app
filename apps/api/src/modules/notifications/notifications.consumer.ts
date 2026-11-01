import { eq } from 'drizzle-orm';
import { Logger } from '@nestjs/common';
import type { Db } from '../../db/client';
import { bookings, rituals, ritualTranslations, users, cities } from '../../db/schema/index';
import type { OutboxService } from '../../domain/outbox';
import type { NotificationService } from './notifications.service';
import type { EventPublisher } from '../../workers/outbox-relay';
import { formatINR, paise, type Locale, type PriceBreakdown } from '@themaithil/contracts';
import { getRegion } from '@themaithil/region';

/**
 * Turns booking events into messages.
 *
 * Plugged in as an outbox EventPublisher, so it receives every domain event exactly
 * where the relay hands them over. Delivery is at-least-once, so the FIRST thing it
 * does is claim the event via processed_events - without that, a relay retry sends
 * the devotee their OTP twice.
 */
const CONSUMER = 'notifications';

/**
 * The reviewer's own words, or a fallback that still tells the purohit where to look.
 *
 * Never left blank: a message saying only "we need something from you" sends someone
 * back to a screen with no idea which document to replace.
 */
function reasonOf(payload: unknown): string {
  const notes = (payload as { notes?: unknown } | null)?.notes;
  return typeof notes === 'string' && notes.trim().length > 0
    ? notes.trim()
    : 'open the app to see which document we need';
}

export class NotificationConsumer implements EventPublisher {
  private readonly log = new Logger('notify.consumer');

  constructor(
    private readonly db: Db,
    private readonly outbox: OutboxService,
    private readonly notify: NotificationService,
  ) {}

  async publish(event: { id: string; eventType: string; aggregateId: string; payload: unknown }) {
    const mine = await this.outbox.claimForConsumer(this.db, CONSUMER, event.id);
    if (!mine) return;   // already handled; at-least-once delivery means this happens

    const handler = this.handlers[event.eventType];
    if (!handler) return;

    try {
      await handler(event.aggregateId, event.payload);
    } catch (e) {
      this.log.error(
        `failed to notify for ${event.eventType} ${event.aggregateId}`,
        e instanceof Error ? e.stack : String(e),
      );
      // Un-claim before swallowing. The claim above ran BEFORE the send, so a
      // failure here previously left the event marked "processed" with nothing
      // actually delivered - a silent, permanent drop, on the one consumer whose
      // job is to tell a human something happened. Releasing the claim lets the
      // relay's next delivery of this event (at-least-once) retry the send; the
      // claim's own INSERT ... ON CONFLICT still dedupes two relay instances
      // racing on the SAME delivery attempt.
      await this.outbox.unclaimForConsumer(this.db, CONSUMER, event.id);
      // Swallow: a notification failure must never block the relay or the booking.
      // The row in `notifications` records the failure for ops to chase.
    }
  }

  private readonly handlers: Record<
    string, (aggregateId: string, payload: unknown) => Promise<void>
  > = {
    'booking.submitted': async (id) => {
      const b = await this.context(id);
      if (!b) return;
      await this.notify.send({
        userId: b.panditId, templateKey: 'booking.confirmed.pandit',
        variables: {
          ritual: b.ritualName(b.panditLocale), date: b.date, slot: b.slotLabel,
          area: b.area(b.panditLocale), amount: b.panditAmount,
        },
      });
    },
    'booking.confirmed': async (id) => {
      const b = await this.context(id);
      if (!b) return;
      await this.notify.send({
        userId: b.devoteeId, templateKey: 'booking.confirmed.devotee',
        variables: {
          ritual: b.ritualName(b.devoteeLocale), pandit: b.panditName,
          date: b.date, slot: b.slotLabel,
        },
      });

      /*
       * A remote booking is not fulfilled until the purohit hands over a link, and
       * nothing asked them for one.
       *
       * The devotee has paid in full for a ceremony delivered entirely over video;
       * the join link IS the delivery. Leaving it to the purohit to notice a field
       * on a dashboard they may not open makes the whole product depend on someone
       * remembering — the same shape as every other "built but never wired" hole in
       * this codebase. So they are asked, on WhatsApp, the moment the money lands.
       */
      if (b.deliveryMode === 'virtual') {
        await this.notify.send({
          userId: b.panditId, templateKey: 'booking.join_link.needed.pandit',
          variables: {
            ritual: b.ritualName(b.panditLocale), date: b.date, slot: b.slotLabel,
          },
        });
      }
    },
    /**
     * A substitution the devotee did not ask for. They must hear it from us, on
     * WhatsApp, immediately — not discover a different name at their door.
     *
     * The new purohit is notified with the same template a fresh booking uses,
     * because from their side that is exactly what it is.
     */
    'booking.pandit_substituted': async (id) => {
      const b = await this.context(id);
      if (!b) return;
      await this.notify.send({
        userId: b.devoteeId, templateKey: 'booking.pandit_changed.devotee',
        variables: {
          ritual: b.ritualName(b.devoteeLocale), pandit: b.panditName,
          date: b.date, slot: b.slotLabel,
        },
      });
      await this.notify.send({
        userId: b.panditId, templateKey: 'booking.confirmed.pandit',
        variables: {
          ritual: b.ritualName(b.panditLocale), date: b.date, slot: b.slotLabel,
          area: b.area(b.panditLocale), amount: b.panditAmount,
        },
      });
    },
    /** Nobody could take it. This is the message that has to be honest. */
    'booking.cancelled': async (id) => {
      const b = await this.context(id);
      if (!b) return;
      await this.notify.send({
        userId: b.devoteeId, templateKey: 'booking.cancelled.devotee',
        variables: {
          ritual: b.ritualName(b.devoteeLocale), date: b.date, slot: b.slotLabel,
        },
      });
    },
    /*
     * The verification outcome.
     *
     * Nothing told the purohit any of these. The decision was written to the database
     * and no message left the building, so an approved purohit found out by opening
     * an app they had no reason to reopen, and a rejected one might never find out at
     * all — on the one screen only they can act on.
     *
     * Keyed off the purohit id rather than a booking, so these use `notifyPandit`
     * instead of the booking `context()` above.
     */
    'pandit.kyc.verified': async (panditId) => {
      await this.notify.send({
        userId: panditId, templateKey: 'pandit.kyc.verified', variables: {},
      });
    },
    'pandit.kyc.rejected': async (panditId, payload) => {
      await this.notify.send({
        userId: panditId, templateKey: 'pandit.kyc.rejected',
        variables: { reason: reasonOf(payload) },
      });
    },
    /*
     * "Send that one again" — the common outcome, and the one that most needs to
     * reach them, because the application stops until they act.
     */
    'pandit.kyc.changes_requested': async (panditId, payload) => {
      await this.notify.send({
        userId: panditId, templateKey: 'pandit.kyc.changes_requested',
        variables: { reason: reasonOf(payload) },
      });
    },
    'booking.completed': async (id, payload) => {
      const b = await this.context(id);
      if (!b) return;
      await this.notify.send({
        userId: b.panditId, templateKey: 'payout.completed',
        variables: { amount: b.panditAmount },
      });

      /*
       * The recording, for a puja nobody was in the room for.
       *
       * Only present on a remote booking, where it is the whole proof of
       * performance — an at-home family watched the ceremony happen and does not
       * need a video of it. Sent second and separately so a missing recording never
       * costs the purohit their payout message.
       */
      const recordingUrl = (payload as { recordingUrl?: unknown } | null)?.recordingUrl;
      if (typeof recordingUrl === 'string' && recordingUrl.length > 0) {
        await this.notify.send({
          userId: b.devoteeId, templateKey: 'booking.recording.devotee',
          variables: { link: recordingUrl },
        });
      }
    },
  };

  /**
   * Booking-scoped context for a notification, resolved per BOOKING rather than
   * from a module-level constant.
   *
   * This used one `getRegion(LAUNCH_CITY_SLUG)` computed once at import time and
   * one `ritualTranslations` join with no locale predicate - so every message,
   * for every city, carried Kolkata's slot times and whichever translation row
   * Postgres happened to return first, regardless of the recipient's own
   * `users.locale`. The panchang job's docstring already tells this exact story
   * ("thirteen of fourteen cities had no panchang... nothing errored") about a
   * different file; this was the same bug in the one place that reaches a human
   * on their phone.
   */
  private async context(bookingId: string) {
    const rows = await this.db.select({
      devoteeId: bookings.devoteeId,
      panditId: bookings.panditId,
      date: bookings.date,
      slotIdx: bookings.slotIdx,
      price: bookings.price,
      ritualId: bookings.ritualId,
      ritualSlug: rituals.slug,
      deliveryMode: rituals.deliveryMode,
      citySlug: cities.slug,
    })
      .from(bookings)
      .innerJoin(rituals, eq(rituals.id, bookings.ritualId))
      .innerJoin(cities, eq(cities.id, bookings.cityId))
      .where(eq(bookings.id, bookingId)).limit(1);
    const b = rows[0];
    if (!b) return null;

    const [pandit, devotee, translations] = await Promise.all([
      this.db.select({ name: users.name, locale: users.locale })
        .from(users).where(eq(users.id, b.panditId)).limit(1),
      this.db.select({ locale: users.locale })
        .from(users).where(eq(users.id, b.devoteeId)).limit(1),
      this.db.select({ locale: ritualTranslations.locale, name: ritualTranslations.name })
        .from(ritualTranslations).where(eq(ritualTranslations.ritualId, b.ritualId)),
    ]);

    const byLocale = new Map(translations.map((t) => [t.locale, t.name]));
    // Preferred locale, then English, then the slug - never an arbitrary row.
    const ritualName = (locale: Locale) =>
      byLocale.get(locale) ?? byLocale.get('en') ?? b.ritualSlug;

    const region = getRegion(b.citySlug);
    const slotLabel = (() => {
      const s = region.slots[b.slotIdx];
      return s ? `${s.start}–${s.end}` : '';
    })();
    const area = (locale: Locale) => (locale === 'en' ? region.name.en : region.name.native);

    const p = b.price as PriceBreakdown;
    return {
      devoteeId: b.devoteeId,
      panditId: b.panditId,
      /** 'virtual' means the purohit owes the devotee a link before the day. */
      deliveryMode: b.deliveryMode,
      date: b.date,
      slotLabel,
      ritualName,
      area,
      panditLocale: (pandit[0]?.locale ?? 'bn') as Locale,
      devoteeLocale: (devotee[0]?.locale ?? 'bn') as Locale,
      panditName: pandit[0]?.name ?? 'পুরোহিত',
      panditAmount: formatINR(paise(p.dakshinaPaise + p.samagriPaise + p.travelPaise)),
    };
  }
}
