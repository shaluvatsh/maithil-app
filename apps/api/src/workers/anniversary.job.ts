import { sql } from 'drizzle-orm';
import { Logger } from '@nestjs/common';
import type { Db } from '../db/client';
import { anniversaryNudges } from '../db/schema/index';
import type { NotificationService } from '../modules/notifications/notifications.service';

/**
 * "You did this last year, and it is coming round again."
 *
 * `GET /v1/me/anniversaries` has always computed this — matched on the RITUAL and
 * its tithi rather than on the Gregorian date, which is the right model, because a
 * Lakshmi Puja does not fall on the same calendar day twice. It renders in a card
 * on the home page and nothing ever sent it anywhere.
 *
 * That made the most predictable demand in the business depend on a family opening
 * the site, unprompted, in the right fortnight, to discover we had noticed. Home
 * puja is a few-times-a-year purchase; this message is most of what retention can
 * be.
 *
 * WHAT THIS IS NOT. It is not a marketing blast. One message, per household, per
 * ritual, per year, and only for a puja they actually completed — enforced by the
 * primary key on `anniversary_nudges` rather than by this code remembering to
 * check, because a retry after a partial failure is exactly when a reminder turns
 * into three reminders.
 */

/**
 * Roughly a year, with a month either side for the tithi drifting against the
 * Gregorian calendar. The same 305 the read model uses for its `dueNow` flag, so
 * the card and the message can never disagree about what is due.
 */
const DUE_AFTER_DAYS = 305;

/**
 * And an upper bound, which the read model does not need.
 *
 * The card is something you scroll past; a WhatsApp message is something that
 * arrives. A household whose last puja with us was three years ago has moved on,
 * and reminding them annually forever is how a useful nudge becomes the reason
 * somebody blocks the sender.
 */
const STOP_AFTER_DAYS = 730;

interface Due {
  devoteeId: string;
  ritualId: string;
  ritualName: string;
  locale: string;
  lastBookedOn: string;
}

export class AnniversaryJob {
  private readonly log = new Logger('anniversary');

  constructor(
    private readonly db: Db,
    private readonly notify: NotificationService,
  ) {}

  /** IST, matching every other "today" in this codebase. */
  private static todayIst(): string {
    return new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
  }

  async run(): Promise<number> {
    const today = AnniversaryJob.todayIst();
    const year = Number(today.slice(0, 4));
    const at = (days: number) =>
      new Date(Date.parse(`${today}T00:00:00+05:30`) - days * 86_400_000)
        .toISOString().slice(0, 10);

    const due = await this.findDue(at(DUE_AFTER_DAYS), at(STOP_AFTER_DAYS));
    if (due.length === 0) return 0;

    let sent = 0;
    for (const row of due) {
      /*
       * Claim BEFORE sending, and let the primary key be the claim.
       *
       * The obvious order — send, then record — drops a duplicate on every
       * household whenever the process dies mid-batch or the BSP is slow enough to
       * outlive the tick. Claiming first means the worst case is a nudge that was
       * claimed and not delivered, which is a message nobody gets rather than a
       * message somebody gets twice. For an unsolicited reminder that is the right
       * way round, and the failure is visible in `notifications` either way.
       */
      const claimed = await this.db.insert(anniversaryNudges).values({
        devoteeId: row.devoteeId,
        ritualId: row.ritualId,
        year,
      }).onConflictDoNothing().returning({ year: anniversaryNudges.year });
      if (claimed.length === 0) continue;      // already nudged this household this year

      const res = await this.notify.send({
        userId: row.devoteeId,
        templateKey: 'booking.anniversary',
        variables: { ritual: row.ritualName },
        locale: row.locale as never,
      });
      if (res.status === 'sent') sent++;
      else {
        this.log.warn(
          `could not deliver the ${row.ritualName} reminder to ${row.devoteeId}`,
        );
      }
    }
    return sent;
  }

  /**
   * Every household with a completed puja whose anniversary is now due.
   *
   * One grouped query for the whole platform rather than the read model's
   * per-devotee version — the alternative is a query per user per day, which is
   * the "query inside a loop" the project's standing constraint calls out, on a
   * job that runs daily forever.
   *
   * `left join` on the translation and a coalesce down to the slug, the same
   * fallback chain `base()` uses: a missing translation must degrade to a readable
   * name, never to an empty message.
   */
  private async findDue(dueBefore: string, stopBefore: string): Promise<Due[]> {
    const rows = await this.db.execute(sql`
      SELECT b.devotee_id                                   AS "devoteeId",
             b.ritual_id                                    AS "ritualId",
             COALESCE(t.name, en.name, r.slug)              AS "ritualName",
             u.locale                                       AS "locale",
             MAX(b.date)::text                              AS "lastBookedOn"
        FROM bookings b
        JOIN rituals r ON r.id = b.ritual_id
        JOIN users   u ON u.id = b.devotee_id
        LEFT JOIN ritual_translations t  ON t.ritual_id = r.id AND t.locale = u.locale
        LEFT JOIN ritual_translations en ON en.ritual_id = r.id AND en.locale = 'en'
       WHERE b.state = 'completed'
         AND u.deleted_at IS NULL
       GROUP BY b.devotee_id, b.ritual_id, t.name, en.name, r.slug, u.locale
      HAVING MAX(b.date) <= ${dueBefore}
         AND MAX(b.date) >  ${stopBefore}
    `);
    return ((rows as unknown as { rows?: unknown[] }).rows ?? rows) as Due[];
  }
}
