import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ulid } from 'ulid';
import { sql } from 'drizzle-orm';
import { makeHarness, notifier, seedTemplates, type Harness } from '../../test/harness';
import { ReminderJob } from '../reminder.job';

let h: Harness;
let job: ReminderJob;
let notify: ReturnType<typeof notifier>;

beforeEach(async () => {
  h = await makeHarness();
  await seedTemplates(h.db);
  notify = notifier(h.db);
  job = new ReminderJob(h.db, notify);
}, 60_000);
afterEach(async () => { await h?.pg.close(); });

/** A confirmed booking starting `hours` from now. */
const booking = async (hours: number, over: Record<string, unknown> = {}) => {
  const id = ulid();
  const start = new Date(Date.now() + hours * 3600_000).toISOString();
  const end = new Date(Date.now() + (hours + 2) * 3600_000).toISOString();
  await h.db.execute(sql`
    INSERT INTO bookings (id, devotee_id, pandit_id, ritual_id, city_id, address_id,
                          date, slot_idx, slot_start_at, slot_end_at, state,
                          samagri_option, payment_mode, panjika_school, price)
    VALUES (${id}, ${h.ids.devoteeId}, ${h.ids.panditId}, ${h.ids.ritualId},
            ${h.ids.cityId}, ${h.ids.addressId},
            ${start.slice(0, 10)}, 0, ${start}::timestamptz, ${end}::timestamptz,
            ${(over.state as string) ?? 'confirmed'},
            'pandit_brings', 'cash', 'gupta_press',
            '{"totalPaise":100000,"tokenPaise":10000}'::jsonb)`);
  return id;
};

/**
 * THE DAY-BEFORE REMINDER, which had a seeded template in three languages and no
 * emitter at all — a fully translated message no devotee has ever received.
 *
 * It matters more than "reminder" suggests. A puja needs somebody home, the space
 * prepared, and in cash mode the balance ready in notes. A devotee who has forgotten
 * finds out when a purohit is at their door, and the purohit — who travelled — is
 * the one who absorbs it.
 */
describe('the day-before reminder', () => {
  it('reminds a devotee about a booking starting tomorrow', async () => {
    await booking(30);
    expect(await job.run()).toBe(1);

    const sent = notify.channel.sent.filter((m) => m.templateKey === 'booking.reminder.t1');
    expect(sent).toHaveLength(1);
  });

  it('says nothing about a booking that is still days away', async () => {
    await booking(96);
    expect(await job.run()).toBe(0);
  });

  it('says nothing about one starting within the hour', async () => {
    await booking(2);
    expect(await job.run()).toBe(0);
  });

  /**
   * A `pending_accept` booking is unpaid and may yet expire. Reminding someone
   * about a ceremony that has not been secured is worse than silence.
   */
  it('ignores a booking that was never confirmed', async () => {
    await booking(30, { state: 'pending_accept' });
    expect(await job.run()).toBe(0);
  });

  it('ignores one that was cancelled', async () => {
    await booking(30, { state: 'cancelled_devotee' });
    expect(await job.run()).toBe(0);
  });

  /**
   * The job runs hourly and the window is twelve hours wide, so without this every
   * booking would be reminded about twelve times.
   */
  it('reminds once, however often it runs', async () => {
    await booking(30);
    expect(await job.run()).toBe(1);
    expect(await job.run()).toBe(0);
    expect(await job.run()).toBe(0);
  });

  /**
   * Deduplicated on the BOOKING, not on the devotee. Two ceremonies on one day is
   * the case that a per-user check would silently halve.
   */
  it('reminds about both of two bookings on the same day', async () => {
    await booking(28);
    await booking(32);
    expect(await job.run()).toBe(2);
  });

  /**
   * THE BUG THIS CAUGHT. The first run of this suite sent "{{pandit}} is coming" —
   * `render` substitutes what it is given and leaves the placeholder when given
   * nothing, and `users.name` is nullable. A devotee would have received the raw
   * template. The query now guarantees a value rather than hoping for one.
   */
  it('never sends an unsubstituted placeholder', async () => {
    await booking(30);
    await job.run();

    const sent = notify.channel.sent.filter((m) => m.templateKey === 'booking.reminder.t1');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).not.toMatch(/\{\{/);
  });

  it('does nothing, quietly, when there is nothing to remind about', async () => {
    expect(await job.run()).toBe(0);
    expect(notify.channel.sent).toHaveLength(0);
  });
});
