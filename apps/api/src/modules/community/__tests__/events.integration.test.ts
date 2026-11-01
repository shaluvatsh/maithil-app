import { describe, it, expect, beforeEach } from 'vitest';
import { ulid } from 'ulid';
import { sql } from 'drizzle-orm';
import { makeHarness, type Harness } from '../../../test/harness';
import { EventsService } from '../events.service';
import { MemoryKv } from '../../../common/kv';
import { ErrorCode } from '@themaithil/contracts';

/**
 * Events, against real Postgres. ADR 0015.
 *
 * The tests that matter here are the ones about CAPACITY and the LIABILITY TIER,
 * because both are enforced in SQL and both fail silently if the enforcement is
 * lost — an oversold hall and a devotee selling places at a puja are not exceptions
 * that surface anywhere, they are just wrong.
 */
interface Ctx {
  h: Harness;
  svc: EventsService;
  /** Overbooking off, so capacity arithmetic is testable on its own. */
  strict: EventsService;
  pandit: string;
  devotee: string;
  ops: string;
  extras: string[];
}

async function setup(): Promise<Ctx> {
  const h = await makeHarness();
  const opts = { holdTtlSeconds: 600, freeOverbookBps: 12000, pageSize: 20 };
  const svc = new EventsService(h.db, new MemoryKv(), opts);
  const strict = new EventsService(h.db, new MemoryKv(), { ...opts, freeOverbookBps: 10000 });

  const ops = ulid();
  await h.db.execute(sql`
    INSERT INTO users (id, phone, role, city_id, name)
    VALUES (${ops}, '+919830000700', 'ops', ${h.ids.cityId}, 'Ops')`);

  // Five more devotees, for the capacity and waitlist cases.
  const extras: string[] = [];
  for (let i = 0; i < 5; i++) {
    const id = ulid();
    extras.push(id);
    await h.db.execute(sql`
      INSERT INTO users (id, phone, role, city_id, name)
      VALUES (${id}, ${`+9198300007${10 + i}`}, 'devotee', ${h.ids.cityId}, ${`Devotee ${i}`})`);
  }

  return { h, svc, strict, pandit: h.ids.panditId, devotee: h.ids.devoteeId, ops, extras };
}

const START = '2026-11-14T01:30:00.000Z';
const END = '2026-11-14T04:00:00.000Z';

const draft = (c: Ctx, over: Record<string, unknown> = {}) => c.svc.create({
  hostId: c.pandit,
  kind: 'kirtan',
  title: 'Evening kirtan at the Bagbazar hall',
  description: 'Two hours of kirtan, everyone welcome, prasad after.',
  locale: 'bn',
  citySlug: 'kolkata',
  venueName: 'Bagbazar hall',
  venueLine1: '1 Bagbazar Street',
  startAt: START,
  endAt: END,
  registrationMode: 'rsvp',
  ...over,
} as never);

/** A published event with one session of `capacity` seats. */
async function publishedSession(c: Ctx, capacity: number | null, over: Record<string, unknown> = {}) {
  const ev = await draft(c, {
    sessions: [{ startAt: START, endAt: END, capacity, pricePaise: 0 }],
    ...over,
  });
  await c.svc.publish(ev.id, c.pandit);
  const rows = await c.h.db.execute(sql`
    SELECT id FROM event_sessions WHERE event_id = ${ev.id}`);
  const list = ((rows as unknown as { rows?: unknown[] }).rows ?? rows) as Array<{ id: string }>;
  return { eventId: ev.id, sessionId: list[0]!.id };
}

const seatsTaken = async (c: Ctx, sessionId: string) => {
  const rows = await c.h.db.execute(sql`
    SELECT seats_taken FROM event_sessions WHERE id = ${sessionId}`);
  const list = ((rows as unknown as { rows?: unknown[] }).rows ?? rows) as Array<{ seats_taken: number }>;
  return list[0]!.seats_taken;
};

let c: Ctx;
beforeEach(async () => { c = await setup(); });

describe('capacity is an invariant, not a check', () => {
  it('refuses to oversell even when the service is bypassed entirely', async () => {
    const { sessionId } = await publishedSession(c, 2);
    // Straight at the table, as a bad code path or a psql session would.
    await expect(c.h.db.execute(sql`
      UPDATE event_sessions SET seats_taken = 3 WHERE id = ${sessionId}`))
      .rejects.toThrow(/seats_within_capacity/);
  });

  it('never lets the counter go negative', async () => {
    const { sessionId } = await publishedSession(c, 5);
    await expect(c.h.db.execute(sql`
      UPDATE event_sessions SET seats_taken = -1 WHERE id = ${sessionId}`))
      .rejects.toThrow(/seats_non_negative/);
  });

  /**
   * The race the `FOR UPDATE` exists for.
   *
   * Without the lock both callers read the same `seats_taken`, both decide there is
   * room, and both write — a hall with more people in it than seats and no error
   * anywhere. With it, one wins the seat and the other is waitlisted.
   */
  it('serialises two people reaching for the last seat', async () => {
    const { sessionId } = await c.strict === undefined
      ? await publishedSession(c, 1)
      : await publishedSession(c, 1);

    const [a, b] = await Promise.all([
      c.strict.register({ sessionId, userId: c.extras[0]!, seats: 1 }),
      c.strict.register({ sessionId, userId: c.extras[1]!, seats: 1 }),
    ]);

    const states = [a.state, b.state].sort();
    expect(states).toEqual(['confirmed', 'waitlisted']);
    expect(await seatsTaken(c, sessionId)).toBe(1);
  });

  it('counts seats, not registrations', async () => {
    const { sessionId } = await publishedSession(c, 10);
    await c.svc.register({ sessionId, userId: c.extras[0]!, seats: 4 });
    await c.svc.register({ sessionId, userId: c.extras[1]!, seats: 3 });
    expect(await seatsTaken(c, sessionId)).toBe(7);
  });

  it('treats an uncapped session as uncapped', async () => {
    const { sessionId } = await publishedSession(c, null);
    for (const u of c.extras) {
      const r = await c.svc.register({ sessionId, userId: u, seats: 10 });
      expect(r.state).toBe('confirmed');
    }
    expect(await seatsTaken(c, sessionId)).toBe(50);
  });

  it('refuses a second place for the same person', async () => {
    const { sessionId } = await publishedSession(c, 10);
    await c.svc.register({ sessionId, userId: c.devotee, seats: 1 });
    await expect(c.svc.register({ sessionId, userId: c.devotee, seats: 1 }))
      .rejects.toMatchObject({ code: ErrorCode.IDEMPOTENCY_CONFLICT });
  });
});

describe('free sessions are overbooked, on purpose', () => {
  it('seats beyond capacity up to the configured factor', async () => {
    // 1.2x of 5 is 6, so the sixth seat is confirmed and the seventh waits.
    const { sessionId } = await publishedSession(c, 5);
    for (let i = 0; i < 5; i++) {
      expect((await c.svc.register({ sessionId, userId: c.extras[i]!, seats: 1 })).state)
        .toBe('confirmed');
    }
    expect((await c.svc.register({ sessionId, userId: c.devotee, seats: 1 })).state)
      .toBe('confirmed');
    expect((await c.svc.register({ sessionId, userId: c.pandit, seats: 1 })).state)
      .toBe('waitlisted');
  });

  /**
   * The conflict this design resolves.
   *
   * The CHECK first read `seats_taken <= capacity`, which forbids exactly what
   * overbooking requires — so the sixth seat on a five-seat session failed at the
   * constraint rather than being confirmed. The ceiling therefore has to be visible
   * to SQL, which means it has to be a column.
   */
  it('checks against the stored ceiling, not the advertised capacity', async () => {
    const { sessionId } = await publishedSession(c, 5);
    // 1.2x of 5 is 6, so six is allowed at the database and seven is not.
    await c.h.db.execute(sql`
      UPDATE event_sessions SET seats_taken = 6 WHERE id = ${sessionId}`);
    await expect(c.h.db.execute(sql`
      UPDATE event_sessions SET seats_taken = 7 WHERE id = ${sessionId}`))
      .rejects.toThrow(/seats_within_capacity/);
  });

  it('pins the factor on the session, so changing the knob cannot move it', async () => {
    const { sessionId } = await publishedSession(c, 5);
    // A service configured with no overbooking at all still sees this session's own
    // 1.2x, because the ceiling belongs to the session rather than to the process.
    for (let i = 0; i < 5; i++) {
      await c.strict.register({ sessionId, userId: c.extras[i]!, seats: 1 });
    }
    expect((await c.strict.register({ sessionId, userId: c.devotee, seats: 1 })).state)
      .toBe('confirmed');
  });

  it('never overbooks a paid session', async () => {
    const ev = await draft(c, {
      registrationMode: 'seva_slots',
      sessions: [{ startAt: START, endAt: END, capacity: 5, pricePaise: 25000 }],
    });
    const rows = await c.h.db.execute(sql`
      SELECT oversell_bps FROM event_sessions WHERE event_id = ${ev.id}`);
    const list = ((rows as unknown as { rows?: unknown[] }).rows ?? rows) as Array<{
      oversell_bps: number;
    }>;
    // A seat somebody paid for has to exist; the no-show economics stop applying the
    // moment money changes hands.
    expect(list[0]!.oversell_bps).toBe(10000);
  });

  it('is a knob, so a deployment can turn it off', async () => {
    const { sessionId } = await publishedSession(c, 1);
    await c.strict.register({ sessionId, userId: c.extras[0]!, seats: 1 });
    expect((await c.strict.register({ sessionId, userId: c.extras[1]!, seats: 1 })).state)
      .toBe('waitlisted');
  });
});

describe('giving up a place promotes the next person immediately', () => {
  it('promotes oldest-first and keeps the counter right', async () => {
    const { sessionId } = await publishedSession(c, 1);
    await c.strict.register({ sessionId, userId: c.extras[0]!, seats: 1 });
    await c.strict.register({ sessionId, userId: c.extras[1]!, seats: 1 });
    await c.strict.register({ sessionId, userId: c.extras[2]!, seats: 1 });

    const res = await c.strict.cancelRegistration({ sessionId, userId: c.extras[0]! });
    // The seat exists the instant it is released; a waitlisted devotee finding out
    // tomorrow has already made other plans.
    expect(res.promoted).toBe(c.extras[1]);
    expect(await seatsTaken(c, sessionId)).toBe(1);
  });

  it('does not promote anyone when a waitlisted person leaves', async () => {
    const { sessionId } = await publishedSession(c, 1);
    await c.strict.register({ sessionId, userId: c.extras[0]!, seats: 1 });
    await c.strict.register({ sessionId, userId: c.extras[1]!, seats: 1 });

    const res = await c.strict.cancelRegistration({ sessionId, userId: c.extras[1]! });
    expect(res.promoted).toBeNull();
    expect(await seatsTaken(c, sessionId)).toBe(1);
  });

  it('refuses when there is nothing to give up', async () => {
    const { sessionId } = await publishedSession(c, 5);
    await expect(c.svc.cancelRegistration({ sessionId, userId: c.devotee }))
      .rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  it('lets someone come back after cancelling', async () => {
    const { sessionId } = await publishedSession(c, 5);
    await c.svc.register({ sessionId, userId: c.devotee, seats: 1 });
    await c.svc.cancelRegistration({ sessionId, userId: c.devotee });
    expect((await c.svc.register({ sessionId, userId: c.devotee, seats: 1 })).state)
      .toBe('confirmed');
    expect(await seatsTaken(c, sessionId)).toBe(1);
  });
});

describe('the liability tier', () => {
  it('lets a devotee list an event', async () => {
    const ev = await c.svc.create({
      hostId: c.devotee, kind: 'kirtan',
      title: 'Kirtan at our para pandal',
      description: 'Neighbourhood kirtan, everybody is welcome to come along.',
      locale: 'bn', citySlug: 'kolkata',
      venueName: 'Para pandal', venueLine1: '4 Hindusthan Park',
      startAt: START, endAt: END, registrationMode: 'rsvp',
    } as never);
    expect(ev.hostKind).toBe('devotee');
  });

  it('refuses to let a devotee sell places', async () => {
    await expect(c.svc.create({
      hostId: c.devotee, kind: 'puja',
      title: 'Durga Puja anjali, reserved seating',
      description: 'A paid event listed by somebody with no verification at all.',
      locale: 'bn', citySlug: 'kolkata',
      venueName: 'A hall', venueLine1: '1 Nowhere Lane',
      startAt: START, endAt: END, registrationMode: 'ticketed',
    } as never)).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
  });

  it('refuses it at the database too, when the service is bypassed', async () => {
    await expect(c.h.db.execute(sql`
      INSERT INTO events (id, host_id, host_kind, kind, title, description, locale,
                          city_id, venue_name, venue_line1, lat, lng,
                          start_at, end_at, registration_mode, state)
      VALUES (${ulid()}, ${c.devotee}, 'devotee', 'puja', 't', 'd', 'bn',
              ${c.h.ids.cityId}, 'v', 'l', 22.5, 88.3,
              ${START}, ${END}, 'ticketed', 'draft')`))
      .rejects.toThrow(/cannot take money/);
  });

  it('will not publish a paid event while the money path is unwired', async () => {
    const ev = await draft(c, {
      registrationMode: 'seva_slots',
      sessions: [{ startAt: START, endAt: END, capacity: 20, pricePaise: 25000 }],
    });
    await expect(c.svc.publish(ev.id, c.pandit))
      .rejects.toMatchObject({ code: ErrorCode.INVALID_TRANSITION });
  });

  it('will not confirm a paid seat without a payment, at the database', async () => {
    const ev = await draft(c, {
      registrationMode: 'seva_slots',
      sessions: [{ startAt: START, endAt: END, capacity: 20, pricePaise: 25000 }],
    });
    const rows = await c.h.db.execute(sql`
      SELECT id FROM event_sessions WHERE event_id = ${ev.id}`);
    const sid = (((rows as unknown as { rows?: unknown[] }).rows ?? rows) as Array<{ id: string }>)[0]!.id;

    await expect(c.h.db.execute(sql`
      INSERT INTO event_registrations (id, session_id, user_id, seats, state)
      VALUES (${ulid()}, ${sid}, ${c.devotee}, 1, 'confirmed')`))
      .rejects.toThrow(/paid seat cannot be confirmed/);
  });

  it('sends a hosted event to review, and a listing straight out', async () => {
    const listing = await draft(c, { registrationMode: 'rsvp' });
    expect((await c.svc.publish(listing.id, c.pandit)).state).toBe('published');

    const hosted = await draft(c, {
      registrationMode: 'seva_slots',
      sessions: [{ startAt: START, endAt: END, capacity: 20, pricePaise: 0 }],
    });
    // Free seva slots still go to review: we are standing behind it either way.
    expect((await c.svc.publish(hosted.id, c.pandit)).state).toBe('pending_review');
  });
});

describe('sessions belong inside their event', () => {
  it('refuses a session that starts before the event does', async () => {
    const ev = await draft(c);
    await expect(c.h.db.execute(sql`
      INSERT INTO event_sessions (id, event_id, start_at, end_at)
      VALUES (${ulid()}, ${ev.id}, '2026-11-13T01:00:00Z', ${END})`))
      .rejects.toThrow(/outside its event window/);
  });

  it('creates one spanning session when none is given', async () => {
    const ev = await draft(c);
    const rows = await c.h.db.execute(sql`
      SELECT start_at, end_at FROM event_sessions WHERE event_id = ${ev.id}`);
    const list = ((rows as unknown as { rows?: unknown[] }).rows ?? rows) as Array<{
      start_at: string; end_at: string;
    }>;
    // An event with no sessions is unregisterable, which would be a silent dead end.
    expect(list).toHaveLength(1);
    expect(Date.parse(list[0]!.start_at)).toBe(Date.parse(START));
  });
});

describe('discovery', () => {
  it('shows only published events, soonest first', async () => {
    const later = await publishedSession(c, 10);
    const soonerEv = await draft(c, {
      startAt: '2026-11-10T01:30:00.000Z', endAt: '2026-11-10T03:00:00.000Z',
      sessions: [{
        startAt: '2026-11-10T01:30:00.000Z', endAt: '2026-11-10T03:00:00.000Z',
        capacity: 10, pricePaise: 0,
      }],
    });
    await c.svc.publish(soonerEv.id, c.pandit);
    await draft(c); // left as a draft

    const res = await c.svc.discover({ from: '2026-11-01T00:00:00.000Z' } as never);
    expect(res.items.map((i) => i.id)).toEqual([soonerEv.id, later.eventId]);
  });

  it('pages by cursor without overlap', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const start = `2026-11-1${i}T01:30:00.000Z`;
      const end = `2026-11-1${i}T03:00:00.000Z`;
      const ev = await draft(c, {
        startAt: start, endAt: end,
        sessions: [{ startAt: start, endAt: end, capacity: 5, pricePaise: 0 }],
      });
      await c.svc.publish(ev.id, c.pandit);
      ids.push(ev.id);
    }

    const first = await c.svc.discover({ from: '2026-11-01T00:00:00.000Z', limit: 2 } as never);
    const second = await c.svc.discover({
      from: '2026-11-01T00:00:00.000Z', limit: 2, cursor: first.nextCursor!,
    } as never);

    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(2);
    expect(new Set([...first.items, ...second.items].map((i) => i.id)).size).toBe(4);
    expect(second.nextCursor).toBeNull();
  });

  /**
   * The honesty rule. Every event in Kolkata without a pincode shares the city
   * centroid, so a distance computed from it is exactly zero — and "0.0 km away"
   * is a number a reader would act on.
   */
  it('reports no distance for a city-precision event rather than zero', async () => {
    const { eventId } = await publishedSession(c, 10);
    const res = await c.svc.discover({
      from: '2026-11-01T00:00:00.000Z', lat: 22.5726, lng: 88.3639, radiusKm: 25,
    } as never);
    const found = res.items.find((i) => i.id === eventId);
    expect(found).toBeTruthy();
    expect(found!.distanceKm).toBeNull();
  });

  it('measures a distance once the venue has a pincode', async () => {
    await c.h.db.execute(sql`
      INSERT INTO pincode_centroids (pincode, lat, lng, source)
      VALUES ('700005', 22.5990, 88.3639, 'test')`);
    const ev = await draft(c, {
      pincode: '700005',
      sessions: [{ startAt: START, endAt: END, capacity: 10, pricePaise: 0 }],
    });
    await c.svc.publish(ev.id, c.pandit);

    const res = await c.svc.discover({
      from: '2026-11-01T00:00:00.000Z', lat: 22.5726, lng: 88.3639, radiusKm: 25,
    } as never);
    const found = res.items.find((i) => i.id === ev.id)!;
    expect(found.distanceKm).toBeGreaterThan(0);
    expect(found.distanceKm).toBeLessThan(5);
  });

  it('excludes a venue outside the radius', async () => {
    await c.h.db.execute(sql`
      INSERT INTO pincode_centroids (pincode, lat, lng, source)
      VALUES ('700005', 22.5990, 88.3639, 'test')`);
    const ev = await draft(c, {
      pincode: '700005',
      sessions: [{ startAt: START, endAt: END, capacity: 10, pricePaise: 0 }],
    });
    await c.svc.publish(ev.id, c.pandit);

    // Chennai, looking for something within 5 km.
    const res = await c.svc.discover({
      from: '2026-11-01T00:00:00.000Z', lat: 13.0827, lng: 80.2707, radiusKm: 5,
    } as never);
    expect(res.items.map((i) => i.id)).not.toContain(ev.id);
  });

  it('reports seats left, and nothing when a session is uncapped', async () => {
    const capped = await publishedSession(c, 10);
    await c.svc.register({ sessionId: capped.sessionId, userId: c.devotee, seats: 3 });
    const open = await publishedSession(c, null);

    const res = await c.svc.discover({ from: '2026-11-01T00:00:00.000Z' } as never);
    const a = res.items.find((i) => i.id === capped.eventId)!;
    const b = res.items.find((i) => i.id === open.eventId)!;
    expect(a.seatsLeft).toBe(7);
    // "12 left" beside an uncapped session is arithmetic nobody can act on.
    expect(b.seatsLeft).toBeNull();
  });

  it('returns only the scripts the page needs', async () => {
    await publishedSession(c, 5);
    const ta = await draft(c, {
      locale: 'ta', sessions: [{ startAt: START, endAt: END, capacity: 5, pricePaise: 0 }],
    });
    await c.svc.publish(ta.id, c.pandit);

    const res = await c.svc.discover({ from: '2026-11-01T00:00:00.000Z' } as never);
    expect(res.scripts).toEqual(['bengali', 'tamil']);
  });
});

describe('cancelling an event', () => {
  it('releases every seat and cancels every registration', async () => {
    const { eventId, sessionId } = await publishedSession(c, 10);
    await c.svc.register({ sessionId, userId: c.devotee, seats: 2 });
    await c.svc.register({ sessionId, userId: c.extras[0]!, seats: 1 });

    await c.svc.cancel(eventId, c.pandit, 'the hall flooded');

    expect(await seatsTaken(c, sessionId)).toBe(0);
    const rows = await c.h.db.execute(sql`
      SELECT DISTINCT state FROM event_registrations WHERE session_id = ${sessionId}`);
    const states = ((rows as unknown as { rows?: unknown[] }).rows ?? rows) as Array<{ state: string }>;
    // Leaving seats_taken behind is how a reinstated event comes back already full.
    expect(states.map((s) => s.state)).toEqual(['cancelled']);
  });

  it('takes it out of discovery', async () => {
    const { eventId } = await publishedSession(c, 10);
    await c.svc.cancel(eventId, c.pandit, 'the hall flooded');
    const res = await c.svc.discover({ from: '2026-11-01T00:00:00.000Z' } as never);
    expect(res.items.map((i) => i.id)).not.toContain(eventId);
  });

  it('refuses someone else’s event', async () => {
    const { eventId } = await publishedSession(c, 10);
    await expect(c.svc.cancel(eventId, c.devotee, 'not mine to cancel'))
      .rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
  });

  it('refuses a place on a cancelled session', async () => {
    const { eventId, sessionId } = await publishedSession(c, 10);
    await c.svc.cancel(eventId, c.pandit, 'the hall flooded');
    await expect(c.svc.register({ sessionId, userId: c.devotee, seats: 1 }))
      .rejects.toMatchObject({ code: ErrorCode.INVALID_TRANSITION });
  });
});

describe('a listing is not a registration', () => {
  it('refuses a reservation on an event with nothing to reserve', async () => {
    const { sessionId } = await publishedSession(c, null, { registrationMode: 'none' });
    await expect(c.svc.register({ sessionId, userId: c.devotee, seats: 1 }))
      .rejects.toMatchObject({ code: ErrorCode.INVALID_TRANSITION });
  });

  it('refuses a place on an unpublished event', async () => {
    const ev = await draft(c, {
      sessions: [{ startAt: START, endAt: END, capacity: 5, pricePaise: 0 }],
    });
    const rows = await c.h.db.execute(sql`
      SELECT id FROM event_sessions WHERE event_id = ${ev.id}`);
    const sid = (((rows as unknown as { rows?: unknown[] }).rows ?? rows) as Array<{ id: string }>)[0]!.id;
    await expect(c.svc.register({ sessionId: sid, userId: c.devotee, seats: 1 }))
      .rejects.toMatchObject({ code: ErrorCode.INVALID_TRANSITION });
  });
});
