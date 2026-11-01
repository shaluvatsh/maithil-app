import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import { makeHarness, daysFromNow, type Harness } from '../../../test/harness';
import {
  bookings, cities, users, addresses, panditProfiles, panditRituals, slotDefs, rituals,
} from '../../../db/schema/index';
import { ErrorCode } from '@themaithil/contracts';

let h: Harness;
const DATE = daysFromNow(10);

/** A second city, with its own purohit, address and slot grid. */
let patna: { cityId: string; panditId: string; devoteeId: string; addressId: string };

beforeEach(async () => {
  h = await makeHarness();

  const cityId = ulid();
  const panditId = ulid();
  const devoteeId = ulid();
  const addressId = ulid();

  await h.db.insert(cities).values({
    id: cityId, slug: 'patna', name: 'Patna', defaultPanjikaSchool: 'mithila',
  });
  // Patna's own grid, deliberately on different boundaries from Kolkata's — the
  // point of a region is that the day is not the same shape everywhere.
  for (const [idx, start, end] of [
    [0, '05:30', '08:30'], [1, '09:00', '12:00'],
    [2, '12:30', '15:30'], [3, '16:00', '19:00'],
  ] as const) {
    await h.db.insert(slotDefs).values({ id: ulid(), cityId, idx, startTime: start, endTime: end });
  }

  await h.db.insert(users).values([
    { id: devoteeId, phone: '+919830000011', role: 'devotee', cityId, panjikaSchool: 'mithila' },
    { id: panditId, phone: '+919830000012', role: 'pandit', cityId },
  ]);
  await h.db.insert(panditProfiles).values({
    userId: panditId, kycStatus: 'verified', cashJobsEnabled: true,
    baseLat: 25.5941, baseLng: 85.1376,
  });
  await h.db.insert(addresses).values({
    id: addressId, userId: devoteeId, line1: '4 Boring Road', cityId,
    pincode: '800001', lat: 25.6, lng: 85.13,
  });
  await h.db.insert(panditRituals).values({
    panditId, ritualId: h.ids.ritualId, pricePaise: 150000, active: true,
  });
  await h.availability.materialise({ panditId, cityId });

  patna = { cityId, panditId, devoteeId, addressId };
});
afterEach(async () => { await h.pg.close(); });

/**
 * Every booking used to be created against `LAUNCH_CITY_SLUG`, a process-wide
 * constant handed in by the controller — so a Patna devotee got a Kolkata `city_id`,
 * Kolkata's slot times, Kolkata's panjika and a match against Kolkata's purohits.
 * The catalogue is priced in all fourteen cities and the panchang is materialised
 * for all fourteen, so reads were multi-city while every write collapsed onto one.
 */
describe('a booking belongs to the city its address is in', () => {
  it('files a Patna booking in Patna, not the launch city', async () => {
    const d = await h.bookings.createDraft({
      ritualId: h.ids.ritualId,
      addressId: patna.addressId,
      date: DATE,
      slotIdx: 1,
      samagriOption: 'pandit_brings',
      paymentMode: 'cash',
      attendeeCount: 10,
      devoteeId: patna.devoteeId,
    } as never);

    const [row] = await h.db.select({ cityId: bookings.cityId })
      .from(bookings).where(eq(bookings.id, d.id));
    expect(row?.cityId).toBe(patna.cityId);
    expect(row?.cityId).not.toBe(h.ids.cityId);
  });

  it('matches a purohit from that city, not from the launch city', async () => {
    // The whole point. `matchPandit` joins candidates on `users.city_id`, so before
    // this a Patna booking could only ever be offered to Kolkata's purohits.
    const d = await h.bookings.createDraft({
      ritualId: h.ids.ritualId,
      addressId: patna.addressId,
      date: DATE,
      slotIdx: 1,
      samagriOption: 'pandit_brings',
      paymentMode: 'cash',
      attendeeCount: 10,
      devoteeId: patna.devoteeId,
    } as never);

    expect(d.pandit.id).toBe(patna.panditId);
  });

  it("uses that city's slot times, not the launch city's", async () => {
    // Patna's slot 1 is 09:00–12:00; Kolkata's is 09:30–12:30. Reading the grid
    // from the wrong city puts the purohit at the door half an hour out.
    const d = await h.bookings.createDraft({
      ritualId: h.ids.ritualId,
      addressId: patna.addressId,
      date: DATE,
      slotIdx: 1,
      samagriOption: 'pandit_brings',
      paymentMode: 'cash',
      attendeeCount: 10,
      devoteeId: patna.devoteeId,
    } as never);

    const [row] = await h.db.select({ startsAt: bookings.slotStartAt })
      .from(bookings).where(eq(bookings.id, d.id));
    const hhmm = new Date(row!.startsAt).toLocaleTimeString('en-GB', {
      hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata',
    });
    expect(hhmm).toBe('09:00');
  });

  it('still keeps a Kolkata booking in Kolkata', async () => {
    const d = await h.bookings.createDraft({
      ritualId: h.ids.ritualId,
      addressId: h.ids.addressId,
      date: DATE,
      slotIdx: 1,
      samagriOption: 'pandit_brings',
      paymentMode: 'cash',
      attendeeCount: 10,
      devoteeId: h.ids.devoteeId,
    } as never);

    const [row] = await h.db.select({ cityId: bookings.cityId })
      .from(bookings).where(eq(bookings.id, d.id));
    expect(row?.cityId).toBe(h.ids.cityId);
    expect(d.pandit.id).toBe(h.ids.panditId);
  });

  it('refuses rather than guessing when there is no city to derive', async () => {
    // A remote booking has no address, so the devotee's own city answers. An
    // account with neither is not something to file under a default.
    const orphanId = ulid();
    await h.db.insert(users).values({
      id: orphanId, phone: '+919830000013', role: 'devotee', cityId: null,
    });

    await expect(h.bookings.createDraft({
      ritualId: h.ids.ritualId,
      date: DATE,
      slotIdx: 1,
      samagriOption: 'none',
      paymentMode: 'digital_full',
      attendeeCount: 1,
      devoteeId: orphanId,
    } as never)).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });
});

/**
 * `booking_slot_span_valid` read `slot_idx + slot_span <= 4` — Kolkata's four-slot
 * day, written into the schema as though it were a property of bookings. It capped
 * how long a ritual could be AND already refused evening bookings in the five-slot
 * southern cities. Migration 0026 replaced it with a bound on the span alone; the
 * real overlap guarantee is the interval exclusion constraint from 0018.
 */
describe('a ritual that runs most of the day', () => {
  /** Chandi Paath: five hours, two of Kolkata's three-hour slots. */
  let longRitualId: string;

  beforeEach(async () => {
    longRitualId = ulid();
    await h.db.insert(rituals).values({
      id: longRitualId, slug: 'chandi-paath', durationMin: 300, defaultSlotSpan: 2,
    });
    await h.db.insert(panditRituals).values({
      panditId: h.ids.panditId, ritualId: longRitualId, pricePaise: 1100000, active: true,
    });
  });

  const bookAt = (slotIdx: number) => h.bookings.createDraft({
    ritualId: longRitualId,
    addressId: h.ids.addressId,
    date: DATE,
    slotIdx,
    samagriOption: 'pandit_brings',
    paymentMode: 'cash',
    attendeeCount: 40,
    devoteeId: h.ids.devoteeId,
  } as never);

  it('can start late in the day, not only at dawn', async () => {
    // slot 2 + span 2 = 4, which the old constraint allowed only from slot 0.
    const d = await bookAt(2);

    const [row] = await h.db.select({ span: bookings.slotSpan, idx: bookings.slotIdx })
      .from(bookings).where(eq(bookings.id, d.id));
    expect(row?.span).toBe(2);
    expect(row?.idx).toBe(2);
  });

  it('books the whole duration, not just the first slot', async () => {
    const d = await bookAt(0);

    const [row] = await h.db.select({
      startsAt: bookings.slotStartAt, endsAt: bookings.slotEndAt,
    }).from(bookings).where(eq(bookings.id, d.id));
    const mins = (new Date(row!.endsAt).getTime() - new Date(row!.startsAt).getTime()) / 60_000;
    // Kolkata slots 0 and 1 span 06:00-12:30 inclusive of the gap between them.
    expect(mins).toBeGreaterThanOrEqual(300);
  });

  it('still refuses to overlap another booking for the same purohit', async () => {
    // The ceiling came off; the guarantee did not. That now rests on the interval
    // exclusion constraint rather than on arithmetic over a slot grid.
    const first = await bookAt(0);
    await h.bookings.submit(first.id, h.ids.devoteeId);
    await h.bookings.confirmOnTokenCapture({
      bookingId: first.id, paymentIntentId: `pi_${first.id}`,
    });

    await expect(bookAt(1)).rejects.toThrow();
  });
});
