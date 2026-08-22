import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import { makeHarness, type Harness } from '../../../test/harness';
import { notificationTemplates, notifications } from '../../../db/schema/index';
import { NotificationService, render } from '../notifications.service';
import { ConsoleChannel, type Channel } from '../channels';
import { NotificationConsumer } from '../notifications.consumer';

let h: Harness;
let console_: ConsoleChannel;
let notify: NotificationService;

const seedTemplate = async (key: string, body: string, locale: 'bn' | 'en' = 'bn') =>
  h.db.insert(notificationTemplates).values({
    id: ulid(), key, locale, channel: 'whatsapp',
    providerTemplateName: 'approved_tpl', body,
  });

beforeEach(async () => {
  h = await makeHarness();
  console_ = new ConsoleChannel();
  notify = new NotificationService(h.db, console_);
}, 60_000);
afterEach(async () => { await h?.pg.close(); });

describe('templates', () => {
  it('substitutes variables', () => {
    expect(render('আপনার {{ritual}} বুকিং {{date}}', { ritual: 'পূজা', date: 'কাল' }))
      .toBe('আপনার পূজা বুকিং কাল');
  });

  it('leaves an unknown placeholder visible rather than printing "undefined"', () => {
    expect(render('hi {{missing}}', {})).toBe('hi {{missing}}');
  });
});

describe('notification service', () => {
  it('renders in the recipient locale and records the send', async () => {
    await seedTemplate('booking.confirmed.devotee', 'আপনার {{ritual}} নিশ্চিত হয়েছে।');
    const res = await notify.send({
      userId: h.ids.devoteeId, templateKey: 'booking.confirmed.devotee',
      variables: { ritual: 'সত্যনারায়ণ পূজা' },
    });
    expect(res.status).toBe('sent');
    expect(console_.sent[0]!.body).toBe('আপনার সত্যনারায়ণ পূজা নিশ্চিত হয়েছে।');

    const rows = await h.db.select().from(notifications);
    expect(rows[0]!.status).toBe('sent');
    expect(rows[0]!.providerRef).toBeTruthy();
  });

  it('falls back to Bengali when the locale has no template', async () => {
    await seedTemplate('otp', 'কোড {{otp}}', 'bn');
    const res = await notify.send({
      userId: h.ids.devoteeId, templateKey: 'otp',
      variables: { otp: '123456' }, locale: 'en',
    });
    expect(res.status).toBe('sent');
  });

  it('falls back to the second channel when the first fails, and says which sent', async () => {
    await seedTemplate('otp', 'কোড {{otp}}');
    const broken: Channel = {
      name: 'whatsapp',
      send: async () => { throw new Error('BSP template not approved'); },
    };
    // Note: spreading a class instance drops its prototype methods, so the fallback
    // is built explicitly rather than as { ...consoleChannel, name: 'sms' }.
    const smsSent: string[] = [];
    const sms: Channel = {
      name: 'sms',
      send: async ({ body }) => { smsSent.push(body); return { providerRef: 'sms_1' }; },
    };
    const withFallback = new NotificationService(h.db, broken, sms);

    const res = await withFallback.send({
      userId: h.ids.devoteeId, templateKey: 'otp', variables: { otp: '123456' },
    });
    expect(res.status).toBe('sent');
    expect(res.channel).toBe('sms');
    expect(smsSent).toHaveLength(1);
  });

  it('records the reason when every channel fails', async () => {
    await seedTemplate('otp', 'কোড {{otp}}');
    const broken: Channel = {
      name: 'whatsapp',
      send: async () => { throw new Error('BSP down'); },
    };
    const res = await new NotificationService(h.db, broken).send({
      userId: h.ids.devoteeId, templateKey: 'otp', variables: { otp: '1' },
    });
    expect(res.status).toBe('failed');
    const rows = await h.db.select().from(notifications);
    expect(rows[0]!.failedReason).toMatch(/BSP down/);
  });

  it('does not send when the template is missing entirely', async () => {
    const res = await notify.send({
      userId: h.ids.devoteeId, templateKey: 'nope', variables: {},
    });
    expect(res.status).toBe('failed');
    expect(console_.sent).toHaveLength(0);
  });
});

describe('outbox consumer', () => {
  it('sends once even when the relay redelivers the same event', async () => {
    await seedTemplate('booking.confirmed.devotee', 'নিশ্চিত: {{ritual}}');
    const consumer = new NotificationConsumer(h.db, h.outbox, notify);

    // Create a real booking so the consumer has context to load.
    const d = await h.bookings.createDraft({
      panditId: h.ids.panditId, ritualId: h.ids.ritualId, addressId: h.ids.addressId,
      date: new Date(Date.now() + 10 * 86400_000).toISOString().slice(0, 10),
      slotIdx: 1, samagriOption: 'pandit_brings', paymentMode: 'cash',
      attendeeCount: 10, devoteeId: h.ids.devoteeId, citySlug: 'kolkata',
    } as never);

    const event = {
      id: 'EVT-1', eventType: 'booking.confirmed', aggregateId: d.id, payload: {},
    };
    await consumer.publish(event);
    await consumer.publish(event);
    await consumer.publish(event);

    expect(console_.sent).toHaveLength(1);
  });

  it('ignores events it has no message for', async () => {
    const consumer = new NotificationConsumer(h.db, h.outbox, notify);
    await consumer.publish({
      id: 'EVT-2', eventType: 'booking.rematch_requested', aggregateId: 'x', payload: {},
    });
    expect(console_.sent).toHaveLength(0);
  });

  it('never lets a notification failure escape into the relay', async () => {
    const exploding = new NotificationService(h.db, {
      name: 'whatsapp', send: async () => { throw new Error('boom'); },
    } as Channel);
    const consumer = new NotificationConsumer(h.db, h.outbox, exploding);
    await expect(consumer.publish({
      id: 'EVT-3', eventType: 'booking.confirmed', aggregateId: 'missing-booking', payload: {},
    })).resolves.toBeUndefined();
  });
});
