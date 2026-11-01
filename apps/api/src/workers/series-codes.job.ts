import { sql } from 'drizzle-orm';
import { Logger } from '@nestjs/common';
import type { Db } from '../db/client';
import type { NotificationService } from '../modules/notifications/notifications.service';

/**
 * Delivers a multi-day booking's start code on the morning of each later day.
 *
 * Every day of a series gets its own pair of codes at confirmation, because
 * completion is what settles money and a single shared code would let day one's
 * code settle day four — paying the purohit for Dashami before Saptami has
 * happened, which is the whole point of settling per day.
 *
 * That leaves a delivery problem. Handing a family eight digits for four days at
 * once is how the wrong code gets read out at the door, so only day one's codes go
 * out at confirmation and the rest are sent on their own morning, by this.
 *
 * WHAT THIS DOES NOT SEND. The completion code. That one is delivered at the same
 * moment as the start code today, and for a single-day puja that is fine — the
 * family has both in hand for a ceremony a few hours long. Splitting them is a
 * separate change to the single-day flow and does not belong in a sweep whose job
 * is to catch up a series.
 */

/** Only the codes a purohit will actually need today. */
interface DueDay {
  bookingId: string;
  devoteeId: string;
  ritualName: string;
  locale: string;
  dayNumber: number;
  totalDays: number;
}

export class SeriesCodesJob {
  private readonly log = new Logger('series-codes');

  constructor(
    private readonly db: Db,
    private readonly notify: NotificationService,
    /**
     * Regenerating a code is impossible — only the hash is stored — so this cannot
     * re-send the real one. It re-issues instead, which is why it takes the same
     * OTP service `confirmOnTokenCapture` used.
     */
    private readonly otp: {
      generate(dev?: boolean): string;
      hash(bookingId: string, kind: 'start' | 'complete', otp: string): string;
    },
    private readonly devOtp = false,
  ) {}

  async run(): Promise<number> {
    const due = await this.findDue();
    if (due.length === 0) return 0;

    let sent = 0;
    for (const day of due) {
      /*
       * A FRESH code, not the one issued at confirmation.
       *
       * Only the hash was stored — deliberately, so a copy of the database is not a
       * list of valid codes — so there is nothing to look up and re-send. Issuing a
       * new one and replacing the hash is the only honest option, and it is also
       * the safer one: the code is live for the day it is needed rather than for
       * however long the series has been booked.
       */
      const startOtp = this.otp.generate(this.devOtp);
      await this.db.execute(sql`
        UPDATE bookings
           SET start_otp_hash = ${this.otp.hash(day.bookingId, 'start', startOtp)},
               otp_attempts = 0,
               series_codes_sent_at = now()
         WHERE id = ${day.bookingId}
      `);

      const res = await this.notify.send({
        userId: day.devoteeId,
        templateKey: 'booking.series.day.devotee',
        variables: {
          otp: startOtp,
          ritual: day.ritualName,
          day: String(day.dayNumber),
          total: String(day.totalDays),
        },
        locale: day.locale as never,
      });
      if (res.status === 'sent') sent++;
      else this.log.warn(`could not deliver day ${day.dayNumber} code for ${day.bookingId}`);
    }
    return sent;
  }

  /**
   * Confirmed days of a multi-day booking that start today and have not had their
   * code sent yet.
   *
   * `series_codes_sent_at` is the dedup rather than a `notifications` lookup,
   * because this job REPLACES the stored hash: running it twice would invalidate a
   * code the devotee already has in hand, which is worse than not sending at all.
   * A column that is set in the same statement as the hash cannot drift from it.
   */
  private async findDue(): Promise<DueDay[]> {
    const rows = await this.db.execute(sql`
      WITH series AS (
        SELECT b.id,
               b.devotee_id,
               b.ritual_id,
               b.slot_start_at,
               COALESCE(b.parent_booking_id, b.id) AS head_id
          FROM bookings b
         WHERE b.state = 'confirmed'
           AND b.series_codes_sent_at IS NULL
      )
      SELECT s.id                                  AS "bookingId",
             s.devotee_id                          AS "devoteeId",
             COALESCE(t.name, en.name, r.slug)     AS "ritualName",
             u.locale                              AS "locale",
             (SELECT count(*)::int FROM bookings d
               WHERE COALESCE(d.parent_booking_id, d.id) = s.head_id
                 AND d.slot_start_at <= s.slot_start_at)      AS "dayNumber",
             (SELECT count(*)::int FROM bookings d
               WHERE COALESCE(d.parent_booking_id, d.id) = s.head_id) AS "totalDays"
        FROM series s
        JOIN rituals r ON r.id = s.ritual_id
        JOIN users   u ON u.id = s.devotee_id
        LEFT JOIN ritual_translations t  ON t.ritual_id = r.id AND t.locale = u.locale
        LEFT JOIN ritual_translations en ON en.ritual_id = r.id AND en.locale = 'en'
       WHERE s.id <> s.head_id
         AND s.slot_start_at >= now()
         AND s.slot_start_at <  now() + interval '18 hours'
    `);
    return ((rows as unknown as { rows?: unknown[] }).rows ?? rows) as DueDay[];
  }
}
