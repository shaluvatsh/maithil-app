import { sql } from 'drizzle-orm';
import { Logger } from '@nestjs/common';
import type { Db } from '../db/client';
import type { NotificationService } from '../modules/notifications/notifications.service';

/**
 * Chases a remote booking that still has no way to join it.
 *
 * A `virtual` ritual is delivered entirely over video, so the purohit's meeting link
 * IS the delivery — a devotee who has paid in full and has no link has bought
 * nothing. The purohit is asked for one the moment the payment lands
 * (`NotificationConsumer`, `booking.confirmed`), but a single message sent days
 * beforehand is not a guarantee: it can be missed, ignored, or arrive while they are
 * performing somewhere else.
 *
 * So this runs hourly and asks again for anything starting soon that is still empty.
 * It is the difference between a link the purohit remembered and a link the platform
 * made sure of.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not generate a link, and it does not
 * cancel the booking. Standing up video infrastructure to deliver a ₹499 aarti is
 * the wrong order of work, and cancelling a ceremony a family is expecting — hours
 * before it — because of a missing URL would be a far worse outcome than a nudge
 * that eventually reaches a human. Escalation past this point is an ops decision,
 * and the unanswered rows are visible in `notifications` for exactly that.
 */

/** Start asking again once the ceremony is this close. */
const CHASE_WITHIN_HOURS = 24;

/**
 * And stop once it has begun. A link for a puja whose time has passed helps nobody,
 * and continuing to message a purohit about it is how a useful nudge becomes noise.
 */
interface Pending {
  bookingId: string;
  panditId: string;
  ritualName: string;
  locale: string;
  slotStartAt: string;
}

export class JoinLinkChaseJob {
  private readonly log = new Logger('join-link');

  constructor(
    private readonly db: Db,
    private readonly notify: NotificationService,
  ) {}

  async run(): Promise<number> {
    const pending = await this.findPending();
    if (pending.length === 0) return 0;

    let asked = 0;
    for (const row of pending) {
      const res = await this.notify.send({
        userId: row.panditId,
        templateKey: 'booking.join_link.chase.pandit',
        variables: { ritual: row.ritualName },
        locale: row.locale as never,
      });
      if (res.status === 'sent') asked++;
    }
    if (asked > 0) {
      this.log.warn(`${asked} remote booking(s) start within ${CHASE_WITHIN_HOURS}h with no join link`);
    }
    return asked;
  }

  /**
   * Confirmed remote bookings starting soon with no link, that we have not already
   * chased in the last hour.
   *
   * The "already chased" test is a NOT EXISTS against `notifications` rather than a
   * column on the booking: the message is the thing being deduplicated, the table
   * already records every send with its template key, and a booking that genuinely
   * needs chasing twice over two days should be chased twice.
   */
  private async findPending(): Promise<Pending[]> {
    const rows = await this.db.execute(sql`
      SELECT b.id                                  AS "bookingId",
             b.pandit_id                           AS "panditId",
             COALESCE(t.name, en.name, r.slug)     AS "ritualName",
             u.locale                              AS "locale",
             b.slot_start_at                       AS "slotStartAt"
        FROM bookings b
        JOIN rituals r ON r.id = b.ritual_id
        JOIN users   u ON u.id = b.pandit_id
        LEFT JOIN ritual_translations t  ON t.ritual_id = r.id AND t.locale = u.locale
        LEFT JOIN ritual_translations en ON en.ritual_id = r.id AND en.locale = 'en'
       WHERE r.delivery_mode = 'virtual'
         AND b.state = 'confirmed'
         AND b.join_url IS NULL
         AND b.slot_start_at > now()
         AND b.slot_start_at <= now() + (${CHASE_WITHIN_HOURS} || ' hours')::interval
         AND NOT EXISTS (
           SELECT 1 FROM notifications n
            WHERE n.user_id = b.pandit_id
              AND n.template_key = 'booking.join_link.chase.pandit'
              AND n.created_at > now() - interval '1 hour'
         )
    `);
    return ((rows as unknown as { rows?: unknown[] }).rows ?? rows) as Pending[];
  }
}
