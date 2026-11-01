import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import { makeHarness, daysFromNow, type Harness } from '../../../test/harness';
import { bookings, rituals, panditRituals, ritualTranslations } from '../../../db/schema/index';
import { NotificationConsumer } from '../../notifications/notifications.consumer';
import { DomainError, ErrorCode } from '@themaithil/contracts';

let h: Harness;
const DATE = daysFromNow(10);

/** A second ritual, sold the way `online-aarti` is: remotely. */
let virtualRitualId: string;

const draft = (over: Record<string, unknown> = {}) => h.bookings.createDraft({
  panditId: h.ids.panditId,
  ritualId: h.ids.ritualId,
  addressId: h.ids.addressId,
  date: DATE,
  slotIdx: 1,
  samagriOption: 'pandit_brings',
  paymentMode: 'cash',
  attendeeCount: 20,
  devoteeId: h.ids.devoteeId,
  ...over,
} as never);

const toConfirmed = async (over: Record<string, unknown> = {}) => {
  const d = await draft(over);
  await h.bookings.submit(d.id, h.ids.devoteeId);
  const c = await h.bookings.confirmOnTokenCapture({
    bookingId: d.id, paymentIntentId: `pi_${d.id}`,
  });
  return { ...d, ...c };
};

beforeEach(async () => {
  h = await makeHarness();

  virtualRitualId = ulid();
  await h.db.insert(rituals).values({
    id: virtualRitualId, slug: 'online-aarti',
    durationMin: 45, defaultSlotSpan: 1, deliveryMode: 'virtual',
  });
  await h.db.insert(ritualTranslations).values({
    ritualId: virtualRitualId, locale: 'bn', name: 'অনলাইন আরতি',
    shortDescription: 'ভিডিওতে আরতি', description: 'ভিডিওতে আরতি',
  });
  await h.db.insert(panditRituals).values({
    panditId: h.ids.panditId, ritualId: virtualRitualId, pricePaise: 49900, active: true,
  });
});
afterEach(async () => { await h.pg.close(); });

/**
 * The catalogue has sold `online-aarti` ("Live aarti by video, joined from
 * anywhere") since it was seeded, and there was no video anywhere in the system —
 * no meeting link, no recording, on the booking row or any other. A devotee could
 * pay and neither side had a way to reach the other.
 */
describe('a remote booking can actually be delivered', () => {
  it('carries the purohit’s join link to the devotee', async () => {
    const b = await toConfirmed({ ritualId: virtualRitualId, slotIdx: 2 });

    await h.bookings.setJoinUrl({
      bookingId: b.id,
      panditId: h.ids.panditId,
      joinUrl: 'https://meet.google.com/abc-defg-hij',
    });

    const [row] = await h.db.select({ joinUrl: bookings.joinUrl })
      .from(bookings).where(eq(bookings.id, b.id));
    expect(row?.joinUrl).toBe('https://meet.google.com/abc-defg-hij');
  });

  it('tells the devotee about it, because a link nobody is told about is no link', async () => {
    const b = await toConfirmed({ ritualId: virtualRitualId, slotIdx: 2 });
    const before = h.notifications.channel.sent.length;

    await h.bookings.setJoinUrl({
      bookingId: b.id, panditId: h.ids.panditId,
      joinUrl: 'https://meet.google.com/abc-defg-hij',
    });

    const fresh = h.notifications.channel.sent.slice(before);
    expect(fresh.some((m) => m.templateKey === 'booking.join_link.devotee')).toBe(true);
  });

  it('refuses a join link on a puja the purohit is travelling to', async () => {
    // The default harness ritual is `at_home`. A "join by video" control on a
    // ceremony happening in the family's own front room is a contradiction, so this
    // is refused rather than quietly stored.
    const b = await toConfirmed();

    await expect(h.bookings.setJoinUrl({
      bookingId: b.id, panditId: h.ids.panditId, joinUrl: 'https://meet.google.com/x',
    })).rejects.toMatchObject({ code: ErrorCode.INVALID_TRANSITION });
  });

  it('refuses a join link from a purohit who does not hold the job', async () => {
    const b = await toConfirmed({ ritualId: virtualRitualId, slotIdx: 2 });

    await expect(h.bookings.setJoinUrl({
      bookingId: b.id, panditId: h.ids.devoteeId, joinUrl: 'https://meet.google.com/x',
    })).rejects.toBeInstanceOf(DomainError);
  });

  it('stores the recording at completion and puts it on the event', async () => {
    const b = await toConfirmed({ ritualId: virtualRitualId, slotIdx: 2 });
    await h.bookings.start({
      bookingId: b.id, panditId: h.ids.panditId, otp: b.startOtp!,
    });
    await h.bookings.complete({
      bookingId: b.id, panditId: h.ids.panditId, otp: b.completeOtp!,
      capturedAt: new Date().toISOString(),
      cashCollectedPaise: (b.price as { balancePaise: number }).balancePaise,
      recordingUrl: 'https://drive.example.com/aarti-recording',
    });

    const [row] = await h.db.select({ recordingUrl: bookings.recordingUrl })
      .from(bookings).where(eq(bookings.id, b.id));
    expect(row?.recordingUrl).toBe('https://drive.example.com/aarti-recording');
  });
});

/**
 * A remote booking is not fulfilled until the purohit hands over a link, and until
 * now nothing asked them for one — they had a field on a dashboard they might never
 * open, while the devotee had a paid booking and no way to join it.
 */
describe('the purohit is asked for the link, not left to remember it', () => {
  /*
   * The ask rides the outbox like every other notification, so the test has to
   * deliver the event the way the relay would rather than assert on a side effect
   * of `confirmOnTokenCapture` itself.
   */
  const deliverConfirmed = async (bookingId: string) => {
    const consumer = new NotificationConsumer(h.db, h.outbox, h.notifications);
    await consumer.publish({
      id: `evt_${bookingId}`,
      eventType: 'booking.confirmed',
      aggregateId: bookingId,
      payload: {},
    });
  };

  it('asks at confirmation, when the money lands', async () => {
    const b = await toConfirmed({ ritualId: virtualRitualId, slotIdx: 2 });
    const before = h.notifications.channel.sent.length;

    await deliverConfirmed(b.id);

    const fresh = h.notifications.channel.sent.slice(before);
    expect(fresh.some((m) => m.templateKey === 'booking.join_link.needed.pandit')).toBe(true);
  });

  it('does not ask on a puja the purohit is travelling to', async () => {
    // There is nothing to join, and asking would train them to ignore the message
    // on the bookings where it matters.
    const b = await toConfirmed();
    const before = h.notifications.channel.sent.length;

    await deliverConfirmed(b.id);

    const fresh = h.notifications.channel.sent.slice(before);
    expect(fresh.some((m) => m.templateKey === 'booking.join_link.needed.pandit')).toBe(false);
  });
});

/**
 * Kolkata's slot grid leaves gaps — 09:00–09:30, 12:30–13:00, 16:00–16:30 — and
 * ADR 0013 exists precisely so a devotee can book a time the grid has no index for.
 */
describe('a time that falls between two slots', () => {
  it('files under the last slot that has begun, not the first of the day', async () => {
    // 12:30 pm sits in the gap after the 09:30–12:30 forenoon slot. The old
    // fallback recorded 0 — the 06:00–09:00 morning slot, six and a half hours out —
    // on a column the purohit's calendar and both bookings lists read.
    const d = await draft({ slotIdx: undefined, startsAt: `${DATE}T12:30:00+05:30` });

    const [row] = await h.db.select({ slotIdx: bookings.slotIdx, startsAt: bookings.slotStartAt })
      .from(bookings).where(eq(bookings.id, d.id));

    expect(row?.slotIdx).toBe(1);
    expect(new Date(row!.startsAt).toISOString()).toBe(
      new Date(`${DATE}T12:30:00+05:30`).toISOString(),
    );
  });

  it('still records the exact instants the devotee chose', async () => {
    // The slot is bookkeeping; these two are the booking. Every deadline in the
    // product — refund tiers, the reschedule window, feasibility — is measured
    // from them.
    const d = await draft({ slotIdx: undefined, startsAt: `${DATE}T16:15:00+05:30` });

    const [row] = await h.db.select({
      slotIdx: bookings.slotIdx, startsAt: bookings.slotStartAt, endsAt: bookings.slotEndAt,
    }).from(bookings).where(eq(bookings.id, d.id));

    // 16:15 is in the gap after the 13:00–16:00 afternoon slot.
    expect(row?.slotIdx).toBe(2);
    const mins = (new Date(row!.endsAt).getTime() - new Date(row!.startsAt).getTime()) / 60_000;
    expect(mins).toBe(120);   // the harness ritual's own duration, not a slot's
  });
});

/**
 * The sankalp (family name/gotra) capture feature that used to live here — moved
 * off the payment screen, then moved again to the purohit recording it at `start`
 * — was removed outright rather than relocated again. It is personal information
 * about the family and the product no longer has the app hold it at all; the
 * purohit still asks on arrival, the app just never mediates or stores the answer.
 */
describe('starting a puja carries no personal detail about the family', () => {
  it('starts on otp alone, with nothing else accepted or stored', async () => {
    const b = await toConfirmed();
    await h.bookings.start({ bookingId: b.id, panditId: h.ids.panditId, otp: b.startOtp! });

    const [row] = await h.db.select({ sankalp: bookings.sankalp, state: bookings.state })
      .from(bookings).where(eq(bookings.id, b.id));
    expect(row?.state).toBe('in_progress');
    expect(row?.sankalp).toBeNull();
  });
});
