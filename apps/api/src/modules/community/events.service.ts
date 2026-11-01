import { ulid } from 'ulid';
import { eq, and, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import type { KvStore } from '../../common/kv';
import {
  events, eventSessions, eventRegistrations, cities, users, panditProfiles, rituals,
} from '../../db/schema/index';
import {
  DomainError, ErrorCode, isHostedMode,
  encodeEventCursor, decodeEventCursor,
  type CreateEvent, type DiscoverEvents, type EventCard,
} from '@themaithil/contracts';
import { getRegion, scriptsForLocales } from '@themaithil/region';

/**
 * EVENTS (C2). ADR 0015.
 *
 * Three things here are load-bearing and everything else is plumbing:
 *
 * 1. CAPACITY. `seats_taken` on the session is the truth, `SELECT … FOR UPDATE`
 *    serialises the readers of it, and `seats_within_capacity` is the seatbelt that
 *    makes a forgotten lock fail loudly rather than oversell a hall. Counting
 *    registration rows would be a race, and festival load is exactly when it loses.
 *
 * 2. GEO. A btree on (lat, lng) cannot serve a radius query, so the query brackets
 *    the radius with a bounding box the index CAN serve, then orders by haversine
 *    inside it. The box's degree deltas are derived from latitude — Guwahati and
 *    Chennai are thirteen degrees apart and one fixed delta over-scans one while
 *    under-scanning the other.
 *
 * 3. THE LIABILITY TIER. Anyone may LIST; only a verified host may take money. The
 *    database enforces it too, and this service refuses earlier with a readable
 *    message. Ticketed events are refused outright until the money path exists —
 *    see `publish`.
 */

const EARTH_KM = 6371;
/** Degrees of latitude per kilometre. Constant; longitude's shrinks with latitude. */
const DEG_PER_KM = 1 / 111.32;
const BPS = 10_000;

export interface EventOptions {
  /** `COMMUNITY_HOLD_TTL_SECONDS`. */
  holdTtlSeconds: number;
  /** `COMMUNITY_FREE_EVENT_OVERBOOK_BPS`. Never applied to a paid session. */
  freeOverbookBps: number;
  /** `COMMUNITY_FEED_PAGE_SIZE`. */
  pageSize: number;
}

interface EventRow {
  id: string; kind: EventCard['kind']; title: string; description: string;
  locale: EventCard['locale']; city_slug: string; venue_name: string;
  start_at: string; end_at: string; panjika_school: string | null;
  registration_mode: EventCard['registrationMode'];
  host_kind: EventCard['hostKind']; host_name: string | null;
  kyc_status: string | null; geo_precision: string;
  distance_km: number | null; seats_left: number | null; session_count: number;
}

export class EventsService {
  constructor(
    private readonly db: Db,
    private readonly kv: KvStore,
    private readonly opts: EventOptions,
  ) {}

  // --- hosting --------------------------------------------------------------

  /**
   * Create an event as a draft. Nothing is visible until `publish`.
   *
   * The host kind is derived from the account, never accepted from the request: it
   * decides whether this event may ever take money, and a client that could assert
   * `org` would have talked its way past the whole two-tier model.
   */
  async create(args: CreateEvent & { hostId: string }) {
    const region = getRegion(args.citySlug);
    const city = (await this.db.select({ id: cities.id }).from(cities)
      .where(and(eq(cities.slug, args.citySlug), eq(cities.active, true))).limit(1))[0];
    if (!city) throw new DomainError(ErrorCode.NOT_FOUND, `unknown city: ${args.citySlug}`);

    const host = (await this.db.select({
      role: users.role, name: users.name, kyc: panditProfiles.kycStatus,
    }).from(users)
      .leftJoin(panditProfiles, eq(panditProfiles.userId, users.id))
      .where(eq(users.id, args.hostId)).limit(1))[0];
    if (!host) throw new DomainError(ErrorCode.NOT_FOUND, 'no such account');

    const hostKind = host.role === 'pandit' ? 'pandit' as const
      : host.role === 'admin' || host.role === 'ops' ? 'platform' as const
      : 'devotee' as const;

    if (isHostedMode(args.registrationMode) && hostKind === 'devotee') {
      throw new DomainError(
        ErrorCode.FORBIDDEN,
        'a devotee may list an event but not sell places at one',
        { registrationMode: args.registrationMode },
      );
    }

    if (Date.parse(args.endAt) <= Date.parse(args.startAt)) {
      throw new DomainError(ErrorCode.OUT_OF_HORIZON, 'an event must end after it starts');
    }

    /*
     * Where the event is, as precisely as we can HONESTLY say.
     *
     * A pincode centroid is a couple of kilometres across, which is enough to tell
     * Gariahat from Salt Lake and therefore enough for a distance label to mean
     * something. Without one we fall back to the city centroid and record `city`, so
     * discovery knows to show "in Kolkata" rather than a number it cannot stand
     * behind. Nothing here is invented — the same tiering `addresses` uses.
     */
    const point = await this.resolvePoint(args.pincode, region);

    const ritualId = args.ritualSlug
      ? (await this.db.select({ id: rituals.id }).from(rituals)
          .where(eq(rituals.slug, args.ritualSlug)).limit(1))[0]?.id ?? null
      : null;

    const eventId = ulid();
    await this.db.transaction(async (tx) => {
      await tx.insert(events).values({
        id: eventId,
        hostId: args.hostId,
        hostKind,
        kind: args.kind,
        ritualId,
        title: args.title,
        description: args.description,
        locale: args.locale,
        cityId: city.id,
        venueName: args.venueName,
        venueLine1: args.venueLine1,
        pincode: args.pincode ?? null,
        lat: point.lat,
        lng: point.lng,
        geoPrecision: point.precision,
        startAt: args.startAt,
        endAt: args.endAt,
        panjikaSchool: (args.panjikaSchool ?? null) as never,
        registrationMode: args.registrationMode,
        state: 'draft',
        externalUrl: args.externalUrl ?? null,
      });

      /*
       * One session spanning the event when none is given.
       *
       * A single-evening kirtan should not make a host describe a session, and the
       * registration path needs something to attach a seat to — an event with no
       * sessions is unregisterable, which would be a silent dead end.
       */
      const sessions = args.sessions?.length
        ? args.sessions
        : [{ startAt: args.startAt, endAt: args.endAt, capacity: null, pricePaise: 0 }];

      for (const s of sessions) {
        const price = s.pricePaise ?? 0;
        await tx.insert(eventSessions).values({
          id: ulid(),
          eventId,
          startAt: s.startAt,
          endAt: s.endAt,
          capacity: s.capacity ?? null,
          pricePaise: price,
          /*
           * Only a FREE session is overbooked. A seat somebody paid for has to
           * exist, so a paid session is pinned at 1x — the no-show economics that
           * justify overbooking do not apply once money has changed hands.
           */
          oversellBps: price > 0 ? BPS : this.opts.freeOverbookBps,
        });
      }
    });

    return { id: eventId, state: 'draft' as const, hostKind };
  }

  /**
   * Make it visible.
   *
   * A LISTING publishes immediately and is moderated after the fact, like a post. A
   * HOSTED event is reviewed first, always — we are taking money and standing behind
   * it, so it goes to `pending_review` and an operator verifies it.
   *
   * A ticketed event is refused outright. The tables, the ledger entry types and the
   * capacity guards are all in place, but the payment path is not wired, and the
   * honest failure is a clear refusal rather than a seat someone believes they paid
   * for. The database agrees: `assert_paid_seat_has_payment` will not confirm a paid
   * seat without a payment intent.
   */
  async publish(eventId: string, actorId: string) {
    const ev = (await this.db.select().from(events)
      .where(eq(events.id, eventId)).limit(1))[0];
    if (!ev) throw new DomainError(ErrorCode.NOT_FOUND, 'no such event');
    if (ev.hostId !== actorId) throw new DomainError(ErrorCode.FORBIDDEN, 'not your event');
    if (ev.state !== 'draft') {
      throw new DomainError(ErrorCode.INVALID_TRANSITION, `already ${ev.state}`, {
        state: ev.state,
      });
    }

    if (isHostedMode(ev.registrationMode)) {
      const paid = (await this.db.select({ price: eventSessions.pricePaise })
        .from(eventSessions).where(eq(eventSessions.eventId, eventId)))
        .some((s) => s.price > 0);
      if (paid) {
        throw new DomainError(
          ErrorCode.INVALID_TRANSITION,
          'paid events are not open yet — publish this as an RSVP and charge at the venue',
          { registrationMode: ev.registrationMode },
        );
      }
    }

    const next = isHostedMode(ev.registrationMode) ? 'pending_review' as const : 'published' as const;
    const now = new Date().toISOString();
    await this.db.update(events)
      .set({ state: next, updatedAt: now })
      .where(eq(events.id, eventId));
    return { id: eventId, state: next };
  }

  /** Ops verifies a hosted event and it goes live. Listings never come through here. */
  async verify(eventId: string, actorId: string) {
    const now = new Date().toISOString();
    await this.db.update(events)
      .set({ state: 'published', verifiedBy: actorId, updatedAt: now })
      .where(and(eq(events.id, eventId), eq(events.state, 'pending_review')));
    return { id: eventId, state: 'published' as const };
  }

  async cancel(eventId: string, actorId: string, reason: string) {
    const ev = (await this.db.select({ hostId: events.hostId, state: events.state })
      .from(events).where(eq(events.id, eventId)).limit(1))[0];
    if (!ev) throw new DomainError(ErrorCode.NOT_FOUND, 'no such event');
    if (ev.hostId !== actorId) throw new DomainError(ErrorCode.FORBIDDEN, 'not your event');

    const now = new Date().toISOString();
    await this.db.transaction(async (tx) => {
      await tx.update(events).set({
        state: 'cancelled', cancelledAt: now, cancelReason: reason, updatedAt: now,
      }).where(eq(events.id, eventId));

      /*
       * Cancel every seat and zero the counters in the same transaction.
       *
       * Leaving `seats_taken` behind on a cancelled event is how a reinstated event
       * comes back already full — and the registrations have to move to `cancelled`
       * so the attendee list is honest about what happened.
       */
      await tx.execute(sql`
        UPDATE event_registrations SET state = 'cancelled', cancelled_at = ${now},
                                       updated_at = ${now}
         WHERE session_id IN (SELECT id FROM event_sessions WHERE event_id = ${eventId})
           AND state IN ('held', 'confirmed', 'waitlisted')`);
      await tx.execute(sql`
        UPDATE event_sessions SET seats_taken = 0, cancelled_at = ${now}
         WHERE event_id = ${eventId}`);
    });
    return { id: eventId, state: 'cancelled' as const };
  }

  // --- attending ------------------------------------------------------------

  /**
   * Take a seat, or join the waitlist.
   *
   * THE WHOLE POINT OF THIS METHOD is the `FOR UPDATE` below. Two devotees hitting
   * the last seat at the same instant both read `seats_taken = 199` without it, both
   * decide there is room, and both write 200 — a hall with 201 people in it and no
   * error anywhere. The lock serialises them; the CHECK constraint catches any future
   * path that forgets to take it.
   *
   * A FREE session is overbooked by `freeOverbookBps`, because free RSVPs no-show at
   * 40-60% and a hall that shows full and runs half empty is the failure hosts
   * actually notice. A PAID session is never overbooked: a seat someone bought has
   * to exist.
   */
  async register(args: { sessionId: string; userId: string; seats: number }) {
    return this.db.transaction(async (tx) => {
      const rows = await tx.execute(sql`
        SELECT s.id, s.capacity, s.oversell_bps, s.seats_taken, s.price_paise,
               s.cancelled_at,
               e.id AS event_id, e.state AS event_state, e.registration_mode
          FROM event_sessions s
          JOIN events e ON e.id = s.event_id
         WHERE s.id = ${args.sessionId}
           FOR UPDATE OF s`);
      const session = (((rows as unknown as { rows?: unknown[] }).rows ?? rows) as Array<{
        id: string; capacity: number | null; oversell_bps: number;
        seats_taken: number; price_paise: number;
        cancelled_at: string | null; event_id: string; event_state: string;
        registration_mode: string;
      }>)[0];

      if (!session) throw new DomainError(ErrorCode.NOT_FOUND, 'no such session');
      if (session.cancelled_at) {
        throw new DomainError(ErrorCode.INVALID_TRANSITION, 'that session was cancelled');
      }
      if (session.event_state !== 'published') {
        throw new DomainError(ErrorCode.INVALID_TRANSITION, 'that event is not open', {
          state: session.event_state,
        });
      }
      if (session.registration_mode === 'none') {
        throw new DomainError(
          ErrorCode.INVALID_TRANSITION,
          'this event is a listing — turn up, there is nothing to reserve',
        );
      }
      if (session.price_paise > 0) {
        // Belt and braces with `publish`: a paid session cannot be reached, and if
        // one ever is, it refuses here rather than confirming an unpaid seat.
        throw new DomainError(
          ErrorCode.PAYMENT_NOT_CAPTURED, 'paid events are not open yet',
        );
      }

      const existing = (await tx.select().from(eventRegistrations).where(and(
        eq(eventRegistrations.sessionId, args.sessionId),
        eq(eventRegistrations.userId, args.userId),
      )).limit(1))[0];
      if (existing && existing.state !== 'cancelled') {
        throw new DomainError(ErrorCode.IDEMPOTENCY_CONFLICT, 'you already have a place', {
          state: existing.state,
        });
      }

      /*
       * The effective ceiling, from the SESSION's own factor rather than from
       * configuration. The CHECK constraint evaluates the same expression against
       * the same column, so the two cannot drift — and a factor changed in the
       * environment tomorrow does not move the ceiling of a session people already
       * have places at.
       */
      const ceiling = session.capacity === null
        ? null
        : Math.floor((session.capacity * session.oversell_bps) / BPS);

      const wouldBe = session.seats_taken + args.seats;
      const state = ceiling !== null && wouldBe > ceiling ? 'waitlisted' as const : 'confirmed' as const;

      const id = existing?.id ?? ulid();
      const now = new Date().toISOString();
      const values = {
        id, sessionId: args.sessionId, userId: args.userId, seats: args.seats,
        state, holdExpiresAt: null, cancelledAt: null, updatedAt: now,
      };
      if (existing) {
        await tx.update(eventRegistrations).set(values).where(eq(eventRegistrations.id, existing.id));
      } else {
        await tx.insert(eventRegistrations).values(values);
      }

      if (state === 'confirmed') {
        // The counter moves inside the same transaction as the row that justifies
        // it, under the lock taken above.
        await tx.update(eventSessions)
          .set({ seatsTaken: session.seats_taken + args.seats })
          .where(eq(eventSessions.id, args.sessionId));
      }

      return { id, state, seats: args.seats };
    });
  }

  /**
   * Give up a place, and promote whoever is next.
   *
   * Promotion is here rather than in a sweep job because the seat exists the instant
   * it is released, and a waitlisted devotee finding out tomorrow is a devotee who
   * has made other plans. Oldest-first, which is the only ordering anyone would
   * accept as fair.
   */
  async cancelRegistration(args: { sessionId: string; userId: string }) {
    return this.db.transaction(async (tx) => {
      const locked = await tx.execute(sql`
        SELECT id, capacity, oversell_bps, seats_taken FROM event_sessions
         WHERE id = ${args.sessionId} FOR UPDATE`);
      const session = (((locked as unknown as { rows?: unknown[] }).rows ?? locked) as Array<{
        id: string; capacity: number | null; oversell_bps: number; seats_taken: number;
      }>)[0];
      if (!session) throw new DomainError(ErrorCode.NOT_FOUND, 'no such session');

      const reg = (await tx.select().from(eventRegistrations).where(and(
        eq(eventRegistrations.sessionId, args.sessionId),
        eq(eventRegistrations.userId, args.userId),
      )).limit(1))[0];
      if (!reg || reg.state === 'cancelled') {
        throw new DomainError(ErrorCode.NOT_FOUND, 'you have no place to give up');
      }

      const now = new Date().toISOString();
      await tx.update(eventRegistrations)
        .set({ state: 'cancelled', cancelledAt: now, updatedAt: now })
        .where(eq(eventRegistrations.id, reg.id));

      let freed = session.seats_taken;
      if (reg.state === 'confirmed') freed = Math.max(0, freed - reg.seats);

      const ceiling = session.capacity === null
        ? null
        : Math.floor((session.capacity * session.oversell_bps) / BPS);

      let promoted: string | null = null;
      if (reg.state === 'confirmed') {
        const next = (await tx.select().from(eventRegistrations).where(and(
          eq(eventRegistrations.sessionId, args.sessionId),
          eq(eventRegistrations.state, 'waitlisted'),
        )).orderBy(eventRegistrations.createdAt).limit(1))[0];

        if (next && (ceiling === null || freed + next.seats <= ceiling)) {
          await tx.update(eventRegistrations)
            .set({ state: 'confirmed', updatedAt: now })
            .where(eq(eventRegistrations.id, next.id));
          freed += next.seats;
          promoted = next.userId;
        }
      }

      await tx.update(eventSessions).set({ seatsTaken: freed })
        .where(eq(eventSessions.id, args.sessionId));

      return { cancelled: true, promoted };
    });
  }

  // --- discovery ------------------------------------------------------------

  /**
   * What is on near me, soonest first.
   *
   * ONE statement, and the geo predicate is a bounding box the index can serve
   * before haversine orders inside it. The deltas are computed per request from the
   * requested radius AND the latitude, because a degree of longitude is 111 km at
   * the equator and 96 km in Srinagar — one fixed delta would over-scan the south
   * and under-scan the north.
   *
   * Keyset on `(start_at, id)` ASCENDING: a list of events is soonest-first, unlike
   * a feed of questions. Reusing the community cursor would have sorted by creation
   * and put next month's aarti above tomorrow's.
   */
  async discover(args: DiscoverEvents & { viewerId?: string | undefined }) {
    const limit = args.limit ?? this.opts.pageSize;
    const cursor = decodeEventCursor(args.cursor);
    const from = args.from ?? new Date().toISOString();

    const cityId = args.citySlug
      ? (await this.db.select({ id: cities.id }).from(cities)
          .where(eq(cities.slug, args.citySlug)).limit(1))[0]?.id ?? null
      : null;
    if (args.citySlug && !cityId) {
      throw new DomainError(ErrorCode.NOT_FOUND, `unknown city: ${args.citySlug}`);
    }

    const hasPoint = args.lat !== undefined && args.lng !== undefined;
    const radius = args.radiusKm ?? null;
    const lat = args.lat ?? null;
    const lng = args.lng ?? null;

    // Box half-widths. Longitude's shrinks with latitude by cos(lat); clamped so a
    // request near a pole cannot divide by zero and ask for the whole world.
    const dLat = hasPoint && radius ? radius * DEG_PER_KM : null;
    const dLng = hasPoint && radius
      ? radius * DEG_PER_KM / Math.max(0.01, Math.cos((lat! * Math.PI) / 180))
      : null;

    const localesCsv = args.locales?.length ? args.locales.join(',') : null;

    const distance = sql`
      CASE WHEN ${lat}::float8 IS NULL OR e.geo_precision = 'city' THEN NULL ELSE
        ${EARTH_KM} * 2 * asin(sqrt(
          power(sin(radians(e.lat - ${lat}::float8) / 2), 2)
          + cos(radians(${lat}::float8)) * cos(radians(e.lat))
          * power(sin(radians(e.lng - ${lng}::float8) / 2), 2)))
      END`;

    const rows = await this.db.execute(sql`
      SELECT e.id, e.kind, e.title, e.description, e.locale, e.venue_name,
             e.start_at, e.end_at, e.panjika_school, e.registration_mode,
             e.host_kind, e.geo_precision, c.slug AS city_slug,
             u.name AS host_name, pp.kyc_status,
             ${distance} AS distance_km,
             agg.session_count,
             agg.seats_left
        FROM events e
        JOIN cities c ON c.id = e.city_id
        JOIN users u  ON u.id = e.host_id
        LEFT JOIN pandit_profiles pp ON pp.user_id = e.host_id
        JOIN LATERAL (
          SELECT count(*)::int AS session_count,
                 -- NULL where any session is unlimited: "12 left" alongside an
                 -- uncapped session would be arithmetic nobody can act on.
                 CASE WHEN bool_or(s.capacity IS NULL) THEN NULL
                      ELSE GREATEST(0, sum(s.capacity - s.seats_taken))::int END AS seats_left
            FROM event_sessions s
           WHERE s.event_id = e.id AND s.cancelled_at IS NULL
        ) agg ON TRUE
       WHERE e.state = 'published'
         AND e.start_at >= ${from}::timestamptz
         AND (${cityId}::text IS NULL OR e.city_id = ${cityId})
         AND (${args.kind ?? null}::event_kind IS NULL OR e.kind = ${args.kind ?? null})
         AND (${localesCsv}::text IS NULL
              OR e.locale::text = ANY(string_to_array(${localesCsv}::text, ',')))
         -- The index-usable box. Haversine below trims the corners it leaves in.
         AND (${dLat}::float8 IS NULL
              OR (e.lat BETWEEN ${lat}::float8 - ${dLat}::float8
                            AND ${lat}::float8 + ${dLat}::float8
                  AND e.lng BETWEEN ${lng}::float8 - ${dLng}::float8
                                AND ${lng}::float8 + ${dLng}::float8))
         AND (${cursor?.startAt ?? null}::timestamptz IS NULL
              OR (e.start_at, e.id) > (${cursor?.startAt ?? null}::timestamptz, ${cursor?.id ?? null}))
       ORDER BY e.start_at ASC, e.id ASC
       LIMIT ${limit + 1}`);

    const list = ((rows as unknown as { rows?: unknown[] }).rows ?? rows) as EventRow[];
    const page = list.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor = list.length > limit && last
      ? encodeEventCursor({ startAt: last.start_at, id: last.id })
      : null;

    const items: EventCard[] = page
      // The box keeps the corners; haversine removes them. Doing it here rather than
      // in a HAVING keeps the predicate the index serves as simple as possible.
      .filter((r) => !radius || r.distance_km === null || r.distance_km <= radius)
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        title: r.title,
        description: r.description,
        locale: r.locale,
        citySlug: r.city_slug,
        venueName: r.venue_name,
        startAt: r.start_at,
        endAt: r.end_at,
        panjikaSchool: (r.panjika_school ?? null) as EventCard['panjikaSchool'],
        registrationMode: r.registration_mode,
        hostKind: r.host_kind,
        hostName: r.host_name ?? '',
        hostVerified: r.kyc_status === 'verified',
        distanceKm: r.distance_km === null ? null : Math.round(r.distance_km * 10) / 10,
        seatsLeft: r.seats_left,
        sessionCount: r.session_count,
      }));

    return { items, nextCursor, scripts: scriptsForLocales(items.map((i) => i.locale)) };
  }

  /**
   * One event, with its sessions and the viewer's own place in each.
   *
   * The viewer's registration is a LEFT JOIN on one pinned user id, not a lookup per
   * session — a nine-day paath would otherwise fire ten statements to render one
   * page. `yourState` is the whole reason this endpoint differs from a discovery
   * card: the page has to be able to say "you are on the waiting list" rather than
   * offering a button that will refuse.
   */
  async detail(eventId: string, viewerId?: string) {
    const viewer = viewerId ?? null;

    const rows = await this.db.execute(sql`
      SELECT e.id, e.kind, e.title, e.description, e.locale, e.venue_name,
             e.venue_line1, e.start_at, e.end_at, e.panjika_school,
             e.registration_mode, e.host_kind, e.state, e.external_url,
             e.geo_precision, c.slug AS city_slug, c.name AS city_name,
             u.name AS host_name, pp.kyc_status
        FROM events e
        JOIN cities c ON c.id = e.city_id
        JOIN users u  ON u.id = e.host_id
        LEFT JOIN pandit_profiles pp ON pp.user_id = e.host_id
       WHERE e.id = ${eventId}`);
    const ev = (((rows as unknown as { rows?: unknown[] }).rows ?? rows) as Array<{
      id: string; kind: EventCard['kind']; title: string; description: string;
      locale: EventCard['locale']; venue_name: string; venue_line1: string;
      start_at: string; end_at: string; panjika_school: string | null;
      registration_mode: EventCard['registrationMode']; host_kind: EventCard['hostKind'];
      state: string; external_url: string | null; geo_precision: string;
      city_slug: string; city_name: string; host_name: string | null;
      kyc_status: string | null;
    }>)[0];

    if (!ev) throw new DomainError(ErrorCode.NOT_FOUND, 'no such event');
    /*
     * A draft is visible to nobody, including by direct link. A CANCELLED event
     * stays readable on purpose: somebody who reserved a place and is standing
     * outside a locked hall needs the page to tell them it was called off.
     */
    if (ev.state === 'draft' || ev.state === 'pending_review') {
      throw new DomainError(ErrorCode.NOT_FOUND, 'no such event');
    }

    const sessionRows = await this.db.execute(sql`
      SELECT s.id, s.start_at, s.end_at, s.capacity, s.oversell_bps, s.seats_taken,
             s.price_paise, s.cancelled_at, r.state AS your_state
        FROM event_sessions s
        LEFT JOIN event_registrations r
               ON r.session_id = s.id AND r.user_id = ${viewer}
                  AND r.state <> 'cancelled'
       WHERE s.event_id = ${eventId}
       ORDER BY s.start_at ASC`);
    const sessions = (((sessionRows as unknown as { rows?: unknown[] }).rows ?? sessionRows) as Array<{
      id: string; start_at: string; end_at: string; capacity: number | null;
      oversell_bps: number; seats_taken: number; price_paise: number;
      cancelled_at: string | null; your_state: string | null;
    }>).map((r) => ({
      id: r.id,
      startAt: r.start_at,
      endAt: r.end_at,
      capacity: r.capacity,
      seatsTaken: r.seats_taken,
      pricePaise: r.price_paise,
      cancelledAt: r.cancelled_at,
      /*
       * Counted against the SAME ceiling registration uses, not against `capacity`.
       * Showing "0 places left" while the next person is still confirmed would make
       * the page contradict the button beside it.
       */
      seatsLeft: r.capacity === null
        ? null
        : Math.max(0, Math.floor((r.capacity * r.oversell_bps) / BPS) - r.seats_taken),
      yourState: r.your_state,
    }));

    return {
      id: ev.id,
      kind: ev.kind,
      title: ev.title,
      description: ev.description,
      locale: ev.locale,
      citySlug: ev.city_slug,
      cityName: ev.city_name,
      venueName: ev.venue_name,
      venueLine1: ev.venue_line1,
      startAt: ev.start_at,
      endAt: ev.end_at,
      panjikaSchool: (ev.panjika_school ?? null) as EventCard['panjikaSchool'],
      registrationMode: ev.registration_mode,
      hostKind: ev.host_kind,
      hostName: ev.host_name ?? '',
      hostVerified: ev.kyc_status === 'verified',
      state: ev.state,
      externalUrl: ev.external_url,
      // A detail page is reached from a card or a link, never from a radius query,
      // so there is no point to measure from.
      distanceKm: null,
      seatsLeft: sessions.reduce<number | null>(
        (acc, s) => (acc === null || s.seatsLeft === null ? null : acc + s.seatsLeft), 0,
      ),
      sessionCount: sessions.length,
      sessions,
      scripts: scriptsForLocales([ev.locale]),
    };
  }

  // --- helpers --------------------------------------------------------------

  /**
   * The best point we can honestly claim, and what it is worth.
   *
   * Pincode centroid where we have one, city centroid otherwise — and the precision
   * is recorded either way, because discovery has to know whether a distance label
   * would be a measurement or a fiction.
   */
  private async resolvePoint(pincode: string | undefined, region: { coords: { lat: number; lng: number } }) {
    if (pincode) {
      const rows = await this.db.execute(sql`
        SELECT lat, lng FROM pincode_centroids WHERE pincode = ${pincode} LIMIT 1`);
      const hit = (((rows as unknown as { rows?: unknown[] }).rows ?? rows) as Array<{
        lat: number; lng: number;
      }>)[0];
      if (hit) return { lat: hit.lat, lng: hit.lng, precision: 'pincode' as const };
    }
    return { lat: region.coords.lat, lng: region.coords.lng, precision: 'city' as const };
  }
}
