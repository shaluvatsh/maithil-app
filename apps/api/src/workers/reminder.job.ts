import { sql } from 'drizzle-orm';
import { Logger } from '@nestjs/common';
import type { Db } from '../db/client';
import type { NotificationService } from '../modules/notifications/notifications.service';
import { getRegion, slotLabel } from '@themaithil/region';

/**
 * The day-before reminder.
 *
 * `booking.reminder.t1` has been seeded in three languages since the first
 * migration and NOTHING HAS EVER EMITTED IT. The template sat in the database,
 * fully translated, describing a message no devotee has ever received.
 *
 * It matters more here than the phrase "reminder" suggests. A puja is not a
 * restaurant booking: somebody has to be home, the space has to be prepared, and in
 * cash mode the family has to have the balance ready in notes. A devotee who has
 * forgotten any of those discovers it when a purohit is at the door — and the
 * purohit, who travelled, is the one who absorbs it.
 *
 * SENT TO THE DEVOTEE ONLY. The purohit's own job list is a daily-use screen and
 * they were told at confirmation; a second message to the person whose livelihood
 * this is would be noise. The devotee booked once, possibly weeks ago, and is the
 * one who has to act on it.
 */

/**
 * How far ahead "tomorrow" reaches.
 *
 * A window rather than a calendar day, because the job runs hourly and a calendar
 * comparison would send the whole of tomorrow's list at whatever minute the clock
 * rolled over — including 3am. A rolling 24-to-36-hour band means each booking is
 * reminded roughly a day ahead, at an hour someone is awake, whichever hour the job
 * happens to run.
 */
const REMIND_FROM_HOURS = 24;
const REMIND_TO_HOURS = 36;

interface Due {
  bookingId: string;
  devoteeId: string;
  panditName: string;
  ritualName: string;
  locale: string;
  citySlug: string;
  slotIdx: number;
}

export class ReminderJob {
  private readonly log = new Logger('reminder');

  constructor(
    private readonly db: Db,
    private readonly notify: NotificationService,
  ) {}

  async run(): Promise<number> {
    const due = await this.findDue();
    if (due.length === 0) return 0;

    let sent = 0;
    for (const row of due) {
      /*
       * One failure must not stop the rest. These are independent messages to
       * different people, and a provider rejecting one number is not a reason the
       * other forty families should hear nothing.
       */
      try {
        const res = await this.notify.send({
          userId: row.devoteeId,
          templateKey: 'booking.reminder.t1',
          variables: {
            ritual: row.ritualName,
            pandit: row.panditName,
            // The city's own slot label, never a hardcoded window — the southern
            // cities run five slots on different boundaries.
            slot: slotLabel(getRegion(row.citySlug), row.slotIdx),
            /*
             * Not interpolated by the template — carried so the send is
             * attributable to a BOOKING, which is what `findDue` deduplicates on.
             * `redact` passes non-secret variables through untouched, so this
             * lands in `notifications.payload` and is queryable from there.
             */
            bookingId: row.bookingId,
          },
          locale: row.locale as never,
        });
        if (res.status === 'sent') sent++;
      } catch (e) {
        this.log.warn(`reminder failed for booking ${row.bookingId}: ${(e as Error).message}`);
      }
    }
    if (sent > 0) this.log.log(`reminded ${sent} devotee(s) about tomorrow`);
    return sent;
  }

  /**
   * Confirmed bookings starting in the reminder window, not already reminded.
   *
   * The "already reminded" test is a NOT EXISTS against `notifications` scoped to
   * THIS BOOKING, not merely to the user and a time window. A devotee with two
   * ceremonies on the same day must be reminded about each; deduplicating on the
   * user alone would silently drop the second.
   *
   * The booking id travels in `payload`, which is where `send` stores the template
   * variables — there is no `meta` column on this table, and inventing one for a
   * value the existing column already carries would be a migration for nothing.
   *
   * `confirmed` only. A `pending_accept` booking is unpaid and may yet expire, and
   * reminding someone about a ceremony that has not been secured would be worse
   * than silence.
   */
  private async findDue(): Promise<Due[]> {
    const rows = await this.db.execute(sql`
      SELECT b.id                              AS "bookingId",
             b.devotee_id                      AS "devoteeId",
             /*
              * NEVER NULL. A null here renders the literal placeholder into a
              * message a devotee reads - render substitutes what it is given and
              * leaves the placeholder when given nothing. Caught by a test whose
              * fixture happened to have an unnamed purohit, which is the
              * pathological case rather than the normal one: ADR 0012 assigns a
              * verified purohit at draft creation and the seed names them. This is
              * the guard, not the expectation.
              */
             COALESCE(NULLIF(p.name, ''), 'your purohit') AS "panditName",
             COALESCE(t.name, en.name, r.slug) AS "ritualName",
             u.locale                          AS "locale",
             c.slug                            AS "citySlug",
             b.slot_idx                        AS "slotIdx"
        FROM bookings b
        JOIN rituals r ON r.id = b.ritual_id
        JOIN users   u ON u.id = b.devotee_id
        JOIN users   p ON p.id = b.pandit_id
        JOIN cities  c ON c.id = b.city_id
        LEFT JOIN ritual_translations t  ON t.ritual_id = r.id AND t.locale = u.locale
        LEFT JOIN ritual_translations en ON en.ritual_id = r.id AND en.locale = 'en'
       WHERE b.state = 'confirmed'
         AND b.slot_start_at > now() + (${REMIND_FROM_HOURS} || ' hours')::interval
         AND b.slot_start_at <= now() + (${REMIND_TO_HOURS} || ' hours')::interval
         AND NOT EXISTS (
           SELECT 1 FROM notifications n
            WHERE n.template_key = 'booking.reminder.t1'
              AND n.payload->>'bookingId' = b.id
         )
    `);
    return ((rows as unknown as { rows?: unknown[] }).rows ?? rows) as Due[];
  }
}
