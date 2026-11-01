import { ulid } from 'ulid';
import { Logger } from '@nestjs/common';
import { eq, and, or, lt, isNotNull, sql } from 'drizzle-orm';
import type { Db, Executor } from '../../db/client';
import {
  bookings, bookingEvents, users, rituals, slotDefs, cities, panditProfiles, addresses,
} from '../../db/schema/index';
import { LedgerService } from '../../domain/ledger';
import { OutboxService } from '../../domain/outbox';
import { SlotService, holdKey, HOLD_TTL_SECONDS } from '../../domain/slots';
import { assertFeasible, lockPurohit } from '../../domain/feasibility';
import { planSettlement, planTokenCapture } from '../../domain/settlement';
import { AvailabilityService, slotInstant, today, addDays } from '../availability/availability.service';
import { getRegion } from '@themaithil/region';
import type { PricingService } from './pricing.service';
import type { BookingOtpService } from '../auth/otp.service';
import type { KvStore } from '../../common/kv';
import type { NotificationService } from '../notifications/notifications.service';
import type { CatalogService } from '../catalog/catalog.service';
import {
  findTransition, isTerminal, computeRefund, paise, formatINR,
  DomainError, ErrorCode,
  type BookingState, type BookingTrigger, type PriceBreakdown,
  type CreateBookingBody, type IsoDate,
} from '@themaithil/contracts';

const ACCEPT_WINDOW_MS = 2 * 3600_000;

/** Hand a booking around more than this and a human should be looking at it. */
const MAX_SUBSTITUTIONS = 3;

/**
 * Structural, not a class import: booking depends on the ABILITY to match, not on
 * SearchService. Importing the class would tie the booking engine to the search
 * module's dependency graph and make it awkward to fake in tests.
 */
type MatchPandit = (args: {
  /** The booking this allocation is for, so the decision can be recorded. ADR 0012. */
  bookingId?: string | undefined;
  ritualId: string; citySlug: string; date?: string | undefined;
  slotIdx?: number | undefined; slotSpan?: number | undefined;
  exclude?: string[] | undefined;
  /** Time-based availability (ADR 0013); supersedes date+slotIdx where present. */
  startsAt?: string | undefined; endsAt?: string | undefined;
  lat?: number | undefined; lng?: number | undefined;
  geoPrecision?: string | undefined;
  devoteeLocale?: string | undefined;
}) => Promise<{ id: string } | null>;

export class BookingService {
  private readonly log = new Logger('booking');

  constructor(
    private readonly db: Db,
    private readonly pricing: PricingService,
    private readonly catalog: CatalogService,
    private readonly availability: AvailabilityService,
    private readonly slots: SlotService,
    private readonly ledger: LedgerService,
    private readonly outbox: OutboxService,
    private readonly otp: BookingOtpService,
    private readonly kv: KvStore,
    private readonly horizonDays: number,
    /** Assigns the purohit when the devotee has not named one. See ADR 0012. */
    private readonly search: { matchPandit: MatchPandit },
    /**
     * The start and completion codes exist in memory for the length of one method
     * and are never stored in plaintext — only their hashes are. If they are not
     * sent from here they are gone, and the puja cannot be started or settled.
     */
    private readonly notify: NotificationService,
    /** Signs the purohit's photo URL. Optional: no storage means no photo, not no booking. */
    private readonly store?: { presignDownload(a: { key: string }): Promise<string> },
    private readonly devOtp = false,
    /**
     * Whether this deployment can charge anybody (`PAYMENTS_ENABLED`).
     *
     * Defaults TRUE so every existing construction keeps today's behaviour. Read in
     * exactly two places: `submit`, which confirms straight away when there is
     * nothing to charge, and `confirmOnTokenCapture`, which refuses an unpaid
     * confirmation while payments are on.
     */
    private readonly paymentsEnabled = true,
  ) {}

  // -------------------------------------------------------------------------
  // Transition core. EVERY state change goes through here: it validates against
  // the declarative table in contracts, writes the audit row and the outbox event
  // in the SAME transaction as the update. See ADR 0005.
  // -------------------------------------------------------------------------
  /**
   * Locks the row and re-checks `from` against what is actually there, rather than
   * trusting the caller's pre-transaction read.
   *
   * The UPDATE below was a compare-and-set (`WHERE state = from`) with nobody
   * checking how many rows it touched. Two concurrent transitions both read the
   * same `from` under READ COMMITTED; the second blocks on the row lock, wakes once
   * the first commits, and re-runs the CAS against a row whose state has already
   * moved - so it matches zero rows and updates nothing. But the audit insert and
   * the outbox emit below were unconditional, so the second caller got a 200, an
   * audit row and a domain event for a transition that never happened to the row.
   * `FOR UPDATE` here makes the second transaction wait and then see the real
   * state, so it fails loudly with INVALID_TRANSITION instead of lying.
   */
  private async transition(tx: Executor, args: {
    bookingId: string;
    from: BookingState;
    trigger: BookingTrigger;
    actorId?: string | null;
    actorRole?: string | null;
    patch?: Partial<typeof bookings.$inferInsert>;
    eventPayload?: Record<string, unknown>;
  }): Promise<BookingState> {
    const [locked] = await tx.select({ state: bookings.state })
      .from(bookings).where(eq(bookings.id, args.bookingId)).for('update');
    if (!locked) throw new DomainError(ErrorCode.NOT_FOUND, 'booking not found');
    if (locked.state !== args.from) {
      throw new DomainError(
        ErrorCode.INVALID_TRANSITION,
        `cannot ${args.trigger} a booking that is ${locked.state}`,
        { from: locked.state, trigger: args.trigger },
      );
    }

    const t = findTransition(locked.state, args.trigger);
    if (!t) {
      throw new DomainError(
        ErrorCode.INVALID_TRANSITION,
        `cannot ${args.trigger} a booking that is ${locked.state}`,
        { from: locked.state, trigger: args.trigger },
      );
    }

    const updated = await tx.update(bookings)
      .set({ ...args.patch, state: t.to, updatedAt: new Date().toISOString() })
      .where(and(eq(bookings.id, args.bookingId), eq(bookings.state, args.from)))
      .returning({ id: bookings.id });
    if (updated.length === 0) {
      // Unreachable given the lock above - kept as a paging alert, not a control flow path.
      throw new DomainError(
        ErrorCode.INVALID_TRANSITION,
        'booking state changed underneath this transition',
        { bookingId: args.bookingId, from: args.from, trigger: args.trigger },
      );
    }

    await tx.insert(bookingEvents).values({
      id: ulid(),
      bookingId: args.bookingId,
      fromState: args.from,
      toState: t.to,
      trigger: args.trigger,
      actorId: args.actorId ?? null,
      actorRole: args.actorRole ?? null,
      meta: args.eventPayload ?? {},
    });

    for (const eventType of t.emits) {
      await this.outbox.emit(tx, {
        aggregateType: 'booking',
        aggregateId: args.bookingId,
        eventType,
        payload: { bookingId: args.bookingId, from: args.from, to: t.to, ...args.eventPayload },
      });
    }
    return t.to;
  }

  /**
   * Where a booking happens, with the honesty of its coordinate attached.
   *
   * `geoPrecision` travels with the point because the travel estimate is only as
   * good as its endpoints: two `city`-precision addresses are the SAME point, so
   * the distance between them is zero and a buffer derived from it is a fiction
   * rather than merely a rough guess. `estimateTravel` widens its floor rather
   * than trusting it. See GeocodeService.
   */
  private async venueOf(addressId: string) {
    const [row] = await this.db.select({
      lat: addresses.lat, lng: addresses.lng, precision: addresses.geoPrecision,
    }).from(addresses).where(eq(addresses.id, addressId)).limit(1);
    if (!row) throw new DomainError(ErrorCode.NOT_FOUND, 'booking address not found');
    return row;
  }

  private async load(exec: Executor, id: string) {
    const rows = await exec.select().from(bookings).where(eq(bookings.id, id)).limit(1);
    if (!rows[0]) throw new DomainError(ErrorCode.NOT_FOUND, 'booking not found');
    return rows[0];
  }

  // -------------------------------------------------------------------------
  // draft
  // -------------------------------------------------------------------------
  /**
   * `createDraft` used to be roughly ten sequential DB round trips, most of which
   * had no dependency on each other and were only sequential because each call sat
   * on its own `await` line. Restructured into three waves, each internally
   * parallel, along the ACTUAL dependency chain:
   *
   *   1. address ownership, city lookup, ritual, devotee's panjika — none of these
   *      need each other's result.
   *   2. purohit matching — genuinely sequential: it needs the ritual's slot span
   *      from wave 1, and everything after needs to know WHO was matched.
   *   3. purohit profile, slot definitions, city's panjika fallback, and the BOM
   *      snapshot — four independent lookups that only need panditId/cityId/
   *      ritualId, all resolved by the end of wave 2.
   *
   * The slot-hold loop and the price quote are likewise independent of each other
   * (the quote does not need the Redis hold to succeed) and now run concurrently.
   */
  /**
   * WHICH CITY A BOOKING IS IN — derived, never supplied.
   *
   * The controller used to pass `LAUNCH_CITY_SLUG`, a process-wide constant, so
   * EVERY booking was created against Kolkata no matter which city the devotee had
   * picked: Kolkata's `city_id`, Kolkata's slot times, Kolkata's panjika, and a
   * `matchPandit` that searched Kolkata's purohits. The catalogue is priced in all
   * fourteen cities and the panchang is materialised for all fourteen, so reads were
   * multi-city while every write collapsed onto one. Onboarding a purohit in Mumbai
   * would not have helped: no Mumbai booking could ever reach them.
   *
   * The ADDRESS is the answer, not a slug from the client and not a picker. The
   * ceremony happens where the family lives; that row already carries `city_id`, it
   * was chosen deliberately when the address was saved, and — unlike a query
   * parameter — a devotee cannot point it at a city to dodge that city's pricing or
   * supply. A remote booking has no address, so it falls back to the devotee's own
   * city, which is the only city it can meaningfully be in.
   */
  private async cityOf(args: {
    addressId?: string | undefined; devoteeId: string;
  }): Promise<{ cityId: string; citySlug: string }> {
    const cityId = args.addressId
      ? (await this.db.select({ cityId: addresses.cityId })
        .from(addresses).where(eq(addresses.id, args.addressId)).limit(1))[0]?.cityId
      : (await this.db.select({ cityId: users.cityId })
        .from(users).where(eq(users.id, args.devoteeId)).limit(1))[0]?.cityId;

    if (!cityId) {
      throw new DomainError(
        ErrorCode.NOT_FOUND,
        'we could not tell which city this booking is in — choose an address first',
      );
    }
    return { cityId, citySlug: await this.catalog.citySlugById(cityId) };
  }

  async createDraft(args: CreateBookingBody & { devoteeId: string }) {
    const horizonEnd = addDays(today(), this.horizonDays);
    if (args.date < today() || args.date > horizonEnd) {
      throw new DomainError(
        ErrorCode.OUT_OF_HORIZON,
        `bookings open up to ${this.horizonDays} days ahead`,
        { requested: args.date, horizonEnd },
      );
    }

    /*
     * Resolved first, because everything after it depends on the answer: the slot
     * grid, the region's timezone, the panjika fallback and the pool `matchPandit`
     * ranks over are all properties of the city, and getting it from a constant was
     * what made this a single-city product.
     */
    const { cityId, citySlug } = await this.cityOf(args);

    const [addressRows, ritualRows, devoteeRows] = await Promise.all([
      // `addressId` names a row in another table entirely, supplied by the client
      // and never checked against the caller - so any devotee could book a
      // ceremony to ANY other household's saved address, just by knowing or
      // guessing its ulid.
      /*
       * Coordinates come back with the ownership check, not in a second query.
       * They were fetched and dropped: this selected `userId` alone, so proximity
       * — a quarter of the allocation score — was computed against NULL for every
       * candidate and every purohit scored an identical 0.5. The UI meanwhile told
       * the devotee they had been matched "nearest to you".
       */
      this.db.select({
        userId: addresses.userId,
        lat: addresses.lat,
        lng: addresses.lng,
        geoPrecision: addresses.geoPrecision,
      }).from(addresses).where(eq(addresses.id, args.addressId)).limit(1),
      this.db.select().from(rituals).where(eq(rituals.id, args.ritualId)).limit(1),
      this.db.select({ panjikaSchool: users.panjikaSchool, locale: users.locale })
        .from(users).where(eq(users.id, args.devoteeId)).limit(1),
    ]);

    if (!addressRows[0] || addressRows[0].userId !== args.devoteeId) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'not your address');
    }
    const ritual = ritualRows[0];
    if (!ritual) throw new DomainError(ErrorCode.NOT_FOUND, 'unknown ritual');

    // Resolved before matching, not after: matchPandit needs the real span to
    // confirm a purohit is free for the WHOLE ritual, not just its first slot.
    const slotSpan = args.slotSpan ?? ritual.defaultSlotSpan;

    /*
     * The series ids, generated BEFORE matching rather than at insert time.
     *
     * The allocation has to be recorded against the booking it produced (ADR 0012),
     * and matching runs first — so without the id up front there is nothing to key
     * the decision on. Day one is the head of the series and the id the decision is
     * filed under; the later days inherit the same purohit and need no second
     * decision.
     */
    const days = Math.max(1, ritual.days ?? 1);
    const ids = Array.from({ length: days }, () => ulid());
    const parentId = ids[0]!;

    /**
     * No purohit named means the platform assigns one — the default flow.
     *
     * Matching happens HERE rather than in the browser so the choice cannot be
     * tampered with, and so the same ranking serves the web app, the future
     * mobile apps and re-match after a decline.
     */
    const panditId = args.panditId ?? (await this.search.matchPandit({
      bookingId: parentId,
      ritualId: args.ritualId,
      citySlug: citySlug,
      date: args.date,
      slotIdx: args.slotIdx,
      slotSpan,
      /*
       * Where the puja actually is, so "nearest to you" means something — but only
       * when we know it. A `city`-precision address is the city's centroid, the
       * same point for every devotee in Kolkata, so ranking by distance from it
       * would not find their nearest purohit: it would hand every booking in the
       * city to whoever lives closest to the middle. Passing the precision lets the
       * ranking fall back to neutral rather than act on a coordinate nobody
       * measured. See GeocodeService.
       */
      lat: addressRows[0].lat,
      lng: addressRows[0].lng,
      geoPrecision: addressRows[0].geoPrecision,
      /** Scored, never filtered — see `searchPandits`. */
      devoteeLocale: devoteeRows[0]?.locale,
      startsAt: args.startsAt,
      endsAt: args.startsAt
        ? new Date(new Date(args.startsAt).getTime() + ritual.durationMin * 60_000).toISOString()
        : undefined,
    }))?.id;

    if (!panditId) {
      throw new DomainError(
        ErrorCode.NOT_FOUND,
        'no purohit is free at that time — try another slot or another day',
      );
    }

    const [panditRows, defs, cityRows, bomSnapshot, assignedRows] = await Promise.all([
      this.db.select().from(panditProfiles).where(eq(panditProfiles.userId, panditId)).limit(1),
      this.db.select().from(slotDefs).where(eq(slotDefs.cityId, cityId)).orderBy(slotDefs.idx),
      this.db.select({ school: cities.defaultPanjikaSchool })
        .from(cities).where(eq(cities.id, cityId)).limit(1),
      this.catalog.bomFor(args.ritualId, 'bn'),
      // Who was assigned, needed only for the response - independent of the
      // insert below, so no reason to wait for it.
      this.db.select({ name: users.name, phone: users.phone })
        .from(users).where(eq(users.id, panditId)).limit(1),
    ]);

    const pandit = panditRows[0];
    if (!pandit) throw new DomainError(ErrorCode.NOT_FOUND, 'unknown purohit');
    if (pandit.kycStatus !== 'verified') {
      throw new DomainError(ErrorCode.KYC_INCOMPLETE, 'this purohit is not yet verified');
    }
    if (args.paymentMode === 'cash' && !pandit.cashJobsEnabled) {
      throw new DomainError(
        ErrorCode.CASH_JOBS_PAUSED,
        'this purohit is not accepting cash bookings right now',
      );
    }

    /*
     * When the booking begins and ends, as instants.
     *
     * Two ways in. `startsAt` is the real one (ADR 0013): the devotee picked a
     * time, the end follows from the ritual's own duration, and nothing has to be
     * expressible as a slot index — which is what lets a muhurat at 11:15, a 04:00
     * Brahma muhurta or a midnight Kali Puja be booked at all.
     *
     * `slotIdx` is the legacy path, kept while the purohit calendar is still
     * slot-shaped. `slotIdx` remains NOT NULL on the row, so a time-based booking
     * still records the slot its start falls in — vestigial, and read only by the
     * slot-era availability views until those retire.
     */
    let startsAt: Date;
    let endsAt: Date;
    let slotIdx: number;

    if (args.startsAt) {
      startsAt = new Date(args.startsAt);
      endsAt = new Date(startsAt.getTime() + ritual.durationMin * 60_000);
      /*
       * The slot this start falls in — and, when it falls in none, the last slot
       * that has already begun rather than the first slot of the day.
       *
       * Kolkata's slots leave gaps (09:00–09:30, 12:30–13:00, 16:00–16:30), which
       * is exactly the kind of time ADR 0013 exists to let a devotee book. The old
       * fallback recorded `0` for every one of them, so a 12:30 pm booking was
       * filed under the 06:00–09:00 morning slot — six and a half hours out, on a
       * column the purohit's calendar, the availability views and both bookings
       * lists all read. `slot_idx` is vestigial, but while it is NOT NULL it should
       * at least not lie about which half of the day this is.
       */
      const containing = defs.findIndex((d) =>
        slotInstant(args.date, d.startTime, citySlug) <= startsAt
        && startsAt < slotInstant(args.date, d.endTime, citySlug));
      if (containing !== -1) {
        slotIdx = defs[containing]!.idx;
      } else {
        const begun = defs.filter(
          (d) => slotInstant(args.date, d.startTime, citySlug) <= startsAt,
        );
        slotIdx = begun.length > 0 ? begun[begun.length - 1]!.idx : (defs[0]?.idx ?? 0);
      }
    } else {
      /*
       * The day's length is the CITY's, not a constant. This read `> 4`, which is
       * Kolkata's four-slot day; the southern cities run five (`SOUTH_SLOTS`), so a
       * booking in their evening slot was rejected here even though availability
       * had published it — `availability.service.ts` derives the same bound from
       * `region.slots.length` and the two disagreed.
       */
      slotIdx = args.slotIdx!;
      if (slotIdx + slotSpan > defs.length) {
        throw new DomainError(
          ErrorCode.SLOT_UNAVAILABLE,
          'this ritual needs more time than remains in the day from that slot',
          { slotIdx, slotSpan, slotsInDay: defs.length },
        );
      }
      const first = defs.find((d) => d.idx === slotIdx);
      const last = defs.find((d) => d.idx === slotIdx + slotSpan - 1);
      if (!first || !last) throw new DomainError(ErrorCode.NOT_FOUND, 'unknown slot');
      startsAt = slotInstant(args.date, first.startTime, citySlug);
      endsAt = slotInstant(args.date, last.endTime, citySlug);
    }

    /*
     * Soft hold. UX only - correctness comes from the FOR UPDATE at confirm time,
     * so a Redis outage degrades checkout rather than double-booking a purohit.
     *
     * `held` is mutated by `holdSlots` AS IT GOES, not returned and assigned after
     * the fact - so it reflects whatever was actually acquired regardless of
     * whether `holdSlots` or `pricing.quote` is the one that ends up rejecting the
     * `Promise.all` below. Returning a fresh array and only wiring it up on
     * success would leak real holds for their full 10-minute TTL on the one path
     * this exists to prevent: pricing failing AFTER the holds already succeeded.
     */
    const held: string[] = [];
    const holdSlots = async (): Promise<void> => {
      for (let i = 0; i < slotSpan; i++) {
        const key = holdKey(panditId, args.date, slotIdx + i);
        const ok = await this.kv.setIfAbsent(key, args.devoteeId, HOLD_TTL_SECONDS);
        if (!ok) {
          throw new DomainError(
            ErrorCode.SLOT_UNAVAILABLE,
            'someone else is checking out for this slot; try another',
          );
        }
        held.push(key);
      }
    };

    try {
      const [, price] = await Promise.all([
        holdSlots(),
        this.pricing.quote({
          panditId: panditId,
          ritualId: args.ritualId,
          cityId,
          date: args.date,
          samagriOption: args.samagriOption,
          paymentMode: args.paymentMode,
        }),
      ]);

      /*
       * ONE ROW PER DAY, linked by `parent_booking_id`.
       *
       * A four-day Durga Puja is not one long booking: it is the same purohit, at
       * the same hour, in the same house, on four consecutive dates — each of which
       * is performed, and each of which can independently be started, completed,
       * or go wrong. `parent_booking_id` has been on this table since the first
       * migration to say exactly that and nothing has ever written it, so the
       * catalogue could only sell the four-hour ghot form.
       *
       * WHY EACH DAY CARRIES ITS OWN PRICE. Settlement runs per booking at
       * completion (`planSettlement`), so a per-day price is what pays the purohit
       * per day AS THE DAY IS PERFORMED. The alternative — the whole sum on day
       * one — pays for Dashami before Saptami has happened, which is money out of
       * escrow against work nobody has done yet and the exact shape of hole the
       * digital_full bug already put in these books once.
       *
       * The quote is for ONE day (the band and `durationMin` are both per day), so
       * the series total is simply this repeated. Rounding is not an issue for the
       * same reason: nothing is divided.
       */

      await this.db.transaction(async (tx) => {
        for (let day = 0; day < days; day++) {
          const date = addDays(args.date as IsoDate, day);
          await tx.insert(bookings).values({
            id: ids[day]!,
            // Day one is the head of the series and points at nobody; every later
            // day points back at it. NULL therefore means "a single-day booking, or
            // the first day of one" — which is almost every row in the table.
            parentBookingId: day === 0 ? null : parentId,
            devoteeId: args.devoteeId,
            panditId: panditId,
            ritualId: args.ritualId,
            cityId,
            addressId: args.addressId,
            date,
            slotIdx,
            slotSpan,
            slotStartAt: new Date(startsAt.getTime() + day * 86_400_000).toISOString(),
            slotEndAt: new Date(endsAt.getTime() + day * 86_400_000).toISOString(),
            state: 'draft',
            panjikaSchool:
              devoteeRows[0]?.panjikaSchool ?? cityRows[0]?.school ?? 'gupta_press',
            attendeeCount: args.attendeeCount,
            samagriOption: args.samagriOption,
            bomSnapshot,
            price,
            paymentMode: args.paymentMode,
          });
        }
      });

      const id = parentId;


      // Who was assigned, returned so the devotee learns who is coming to their
      // home. They do not choose, but they are never told "a pandit" — a stranger
      // entering your house on a named day is not an anonymous transaction.
      return {
        id,
        price,
        slotSpan,
        pandit: {
          id: panditId,
          name: assignedRows[0]?.name ?? 'Your purohit',
          experienceYears: pandit.experienceYears ?? 0,
          /*
           * Their face. This response has always carried a name and an initial was
           * all the screen could render from it — and since ADR 0012 the devotee did
           * not choose this person, so that initial was the whole of what they had
           * before the door opened.
           */
          photoUrl: pandit.photoKey && this.store
            ? await this.store.presignDownload({ key: pandit.photoKey })
            : null,
          // Hearing them recite is the strongest trust signal available, and it
          // matters most here: the devotee did not choose this person.
          chantingSampleUrl: pandit.chantingSampleUrl ?? null,
          chantingSampleLabel: pandit.chantingSampleLabel ?? null,
        },
        holdExpiresAt: new Date(Date.now() + HOLD_TTL_SECONDS * 1000).toISOString(),
      };
    } catch (e) {
      await Promise.all(held.map((k) => this.kv.del(k)));
      throw e;
    }
  }

  // -------------------------------------------------------------------------
  // draft -> pending_accept -> confirmed
  // -------------------------------------------------------------------------
  /**
   * Submitting a booking into a PUBLISHED slot accepts it automatically.
   *
   * The purohit already declared that slot open; requiring a second, explicit
   * acceptance asked them to confirm something they had told us twice. Worse, the
   * two-hour window assumed a responsiveness this persona structurally cannot
   * offer — a purohit performing a four-hour biye cannot answer a phone, so the
   * window would expire and the devotee would lose the slot because the purohit
   * was working. See ADR 0011.
   *
   * The devotee's certainty is the product: "a real slot, held the moment you pay"
   * is only true if nobody else has to say yes first. The purohit keeps a decline
   * path (`decline()`), which re-matches and is counted against their response
   * score — the Urban Company model, not the request-to-book model.
   */
  async submit(bookingId: string, devoteeId: string) {
    return this.db.transaction(async (tx) => {
      const b = await this.load(tx, bookingId);
      if (b.devoteeId !== devoteeId) {
        throw new DomainError(ErrorCode.FORBIDDEN, 'not your booking');
      }
      const now = new Date().toISOString();
      // Retained so a purohit can still decline, and so expiry sweeps have a
      // horizon; it is no longer a gate on the devotee paying.
      const deadline = new Date(Date.now() + ACCEPT_WINDOW_MS).toISOString();

      /*
       * The whole series, not just the day the devotee happened to click.
       *
       * A four-day Durga Puja is four linked drafts and the devotee is submitting
       * one booking, so all four move together. Leaving the later days in `draft`
       * would strand them: `payment-intent` requires `pending_accept`, and
       * `confirmOnTokenCapture` would then find them un-submittable and fail the
       * whole capture after the money had been taken.
       *
       * A single-day booking is a series of one, so there is no branch here.
       */
      const series = await this.seriesOf(tx, bookingId);
      let headState = b.state;

      for (const day of series) {
        const to = await this.transition(tx, {
          bookingId: day.id, from: day.state, trigger: 'submit',
          actorId: devoteeId, actorRole: 'devotee',
          patch: { acceptDeadlineAt: deadline, acceptedAt: now },
          eventPayload: {
            panditId: day.panditId, acceptDeadlineAt: deadline, autoAccepted: true,
          },
        });
        if (day.id === bookingId) headState = to;
      }

      return { id: bookingId, state: headState, acceptDeadlineAt: deadline, acceptedAt: now };
    });
  }

  /**
   * Submit, then confirm immediately when there is nothing to charge.
   *
   * With `PAYMENTS_ENABLED=false` there is no gateway, so `pending_accept` has
   * nothing to wait FOR: the state exists to hold a slot while the devotee pays,
   * and in cash-only mode they pay the purohit on the day. Leaving bookings parked
   * there would mean `expireStaleAccepts` reaped every one of them an hour later.
   *
   * Two calls rather than one combined transaction, deliberately: `submit` and
   * `confirmOnTokenCapture` each own their own transaction, and the second takes a
   * purohit-level advisory lock to run the travel feasibility check. Nesting them
   * would hold that lock across the whole submission, and flattening them would
   * mean a third copy of the confirmation logic.
   *
   * If the confirmation fails — a travel conflict, the slot taken in between — the
   * booking stays in `pending_accept` with the error surfaced, which is the same
   * place a failed payment would have left it.
   */
  async submitAndConfirmUnpaid(bookingId: string, devoteeId: string) {
    const submitted = await this.submit(bookingId, devoteeId);
    if (this.paymentsEnabled) return submitted;
    return this.confirmOnTokenCapture({
      bookingId, paymentIntentId: null, unpaid: true,
    });
  }

  async accept(bookingId: string, panditId: string) {
    return this.db.transaction(async (tx) => {
      const b = await this.load(tx, bookingId);
      if (b.panditId !== panditId) {
        throw new DomainError(ErrorCode.FORBIDDEN, 'this job is not assigned to you');
      }
      if (b.acceptDeadlineAt && new Date(b.acceptDeadlineAt) < new Date()) {
        throw new DomainError(ErrorCode.INVALID_TRANSITION, 'the accept window has closed');
      }
      const state = await this.transition(tx, {
        bookingId, from: b.state, trigger: 'pandit_accept',
        actorId: panditId, actorRole: 'pandit',
        patch: { acceptedAt: new Date().toISOString() },
      });
      return { id: bookingId, state };
    });
  }

  /**
   * Every day of a booking's series, in order, including the day itself.
   *
   * `parent_booking_id` is NULL on day one and points at it from every later day,
   * so "the series" is the head plus its children — and a single-day booking is
   * just a series of one, which is what lets every caller treat both the same way
   * instead of branching on whether a ritual happens to be multi-day.
   */
  private async seriesOf(exec: Executor, bookingId: string) {
    const [b] = await exec.select().from(bookings).where(eq(bookings.id, bookingId)).limit(1);
    if (!b) throw new DomainError(ErrorCode.NOT_FOUND, 'booking not found');

    const headId = b.parentBookingId ?? b.id;
    const rows = await exec.select().from(bookings)
      .where(or(eq(bookings.id, headId), eq(bookings.parentBookingId, headId)))
      .orderBy(bookings.slotStartAt);
    return rows;
  }

  /**
   * Called by the payment webhook once the token is captured. This is where money
   * first enters the system and where the slot is irrevocably taken - so the slot
   * lock, the ledger write and the state change are one transaction.
   */
  async confirmOnTokenCapture(args: {
    bookingId: string;
    /** Null only on the cash-only path, where no money was taken. */
    paymentIntentId: string | null;
    /**
     * CASH-ONLY CONFIRMATION (`PAYMENTS_ENABLED=false`).
     *
     * Everything this method does is still required when no money moves — the
     * purohit lock, the travel feasibility check, the slot bookkeeping, a distinct
     * pair of codes per day and their delivery. Only the ledger capture is not,
     * because there is nothing to capture.
     *
     * So this is a parameter rather than a second method: duplicating the body
     * would mean two copies of the serialisation and feasibility logic, and the
     * copy used by the deployment that is live today would be the one nobody reads.
     */
    unpaid?: boolean;
  }) {
    /*
     * The `payments_disabled` guard on the `confirmed_unpaid` transition, enforced
     * where the state machine says guards are enforced — in the service. Without
     * this the unpaid path would be reachable while payments are ON, which is the
     * one thing this flag must never allow: a booking confirmed for free on a
     * deployment that is charging everyone else.
     */
    if (args.unpaid && this.paymentsEnabled) {
      throw new DomainError(
        ErrorCode.INVALID_TRANSITION,
        'cannot confirm a booking without payment while payments are enabled',
      );
    }
    if (!args.unpaid && !args.paymentIntentId) {
      throw new DomainError(
        ErrorCode.INVALID_TRANSITION, 'a paid confirmation needs a payment intent',
      );
    }
    // Resolved BEFORE the transaction opens. Querying the pool from inside a
    // transaction takes a second connection and deadlocks the moment the pool has
    // one - which is exactly what a single-connection test database has.
    const pre = await this.load(this.db, args.bookingId);
    const citySlug = await this.catalog.citySlugById(pre.cityId);
    /*
     * The venue, resolved outside the transaction like everything else this method
     * needs - a second pooled connection from inside an open one deadlocks the
     * moment the pool has one, which is what a single-connection test database is.
     *
     * Null for a VIRTUAL booking, which has no address at all: a video consultation
     * involves no journey the platform can model, so no travel constraint applies
     * to it. Its time is still protected, by the exclusion constraint.
     */
    const venue = pre.addressId ? await this.venueOf(pre.addressId) : null;

    const result = await this.db.transaction(async (tx) => {
      /*
       * Serialise allocation for this purohit before reading their day. Two
       * concurrent captures would otherwise each see a picture that excludes the
       * other, both find themselves feasible, and the exclusion constraint would
       * catch only a literal overlap - not the pair an hour apart across the city,
       * which is precisely what the travel check exists to prevent. Keyed on the
       * purohit alone; see `lockPurohit` for why not on the date.
       */
      await lockPurohit(tx, pre.panditId);

      const b = await this.load(tx, args.bookingId);
      // Webhook replay. No codes: they were sent the first time, and re-sending
      // would message the devotee twice for one payment.
      if (b.state === 'confirmed') {
        // Widened deliberately: the other branch returns whatever the transition
        // produced, and narrowing this one to the literal would split the union.
        return { id: b.id, state: b.state as BookingState, days: 1, codes: null };
      }
      if (!b.acceptedAt) {
        throw new DomainError(
          ErrorCode.INVALID_TRANSITION, 'purohit has not accepted this booking yet',
        );
      }

      /*
       * Can they actually get here, and on to whatever is next? The slot grid never
       * asked: it treated turnaround as a fixed 30 minutes, and the one piece meant
       * to vary it (`applyTravelBuffer`) has never fired because its only caller
       * passes a hardcoded 25, below every city's gap. Asked against the booking's
       * own timestamps, so this is unchanged when slots go away (ADR 0013).
       */
      /*
       * Every day of the series, not just the one the payment named.
       *
       * A four-day Durga Puja is four linked rows and the devotee paid once for all
       * of them, so all four are confirmed here or none is. Confirming only the day
       * the webhook happened to reference would leave Ashtami through Dashami in
       * `draft` — unheld, unallocated, and quietly available to the next devotee who
       * asked for that purohit.
       *
       * A single-day booking is a series of one, so this is the same code path for
       * both rather than a branch on whether the ritual is multi-day.
       */
      const series = await this.seriesOf(tx, args.bookingId);

      if (venue) {
        for (const day of series) {
          await assertFeasible(tx, {
            panditId: day.panditId,
            startsAt: new Date(day.slotStartAt),
            endsAt: new Date(day.slotEndAt),
            venue,
            citySlug,
          });
        }
      }

      /*
       * Bookkeeping for the slot-era views, not the correctness guarantee.
       *
       * `lockAndBook` used to be the guarantee: FOR UPDATE over discrete slot rows,
       * refusing if any was taken. It cannot express a booking that starts at 10:30
       * — there is no slot index for it — and it would refuse two bookings that
       * merely share a slot without overlapping in time. The guarantee now sits on
       * the interval itself: the exclusion constraint on `bookings` prevents an
       * overlap outright, and `assertFeasible` above prevents a journey the purohit
       * could not make. `applyTravelBuffer` retires with it — it never once fired
       * (its caller passed a hardcoded 25, below every city's gap), and blocking a
       * whole neighbouring slot is exactly the fixed guess the estimate replaces.
       */
      for (const day of series) {
        await this.slots.markOccupied(tx, {
          panditId: day.panditId,
          startsAt: new Date(day.slotStartAt),
          endsAt: new Date(day.slotEndAt),
          bookingId: day.id,
        });
      }

      /*
       * ONE capture for the series, summed across its days.
       *
       * Each day carries its own price so that `planSettlement` can pay the purohit
       * per day AS IT IS PERFORMED — but the devotee paid once, for the whole thing,
       * so the money entering escrow is one transaction against one payment intent.
       * Posting a capture per day would put N ledger transactions against a single
       * `paymentIntentId` and break the idempotency key that makes a replayed
       * webhook harmless.
       */
      const price = b.price as PriceBreakdown;
      /*
       * No capture when no money moved. `planTokenCapture` is where money ENTERS
       * the system and nowhere else, so posting a zero-value or fabricated capture
       * here would put a payment in the ledger that no devotee ever made — the
       * exact dishonesty the cash-only mode exists to avoid. The settlement side
       * already copes: its cash branch releases commission only
       * `if (price.tokenPaise > 0)`, which is zero in this mode.
       */
      if (!args.unpaid) {
        const seriesToken = series.reduce(
          (sum, day) => sum + (day.price as PriceBreakdown).tokenPaise, 0,
        );
        await this.ledger.post(tx, {
          kind: 'token_capture',
          bookingId: b.id,
          idempotencyKey: `token:${args.paymentIntentId}`,
          legs: planTokenCapture({
            bookingId: b.id, devoteeId: b.devoteeId, amount: paise(seriesToken),
          }),
        });
      }

      /*
       * A DISTINCT PAIR OF CODES PER DAY.
       *
       * Not one pair for the series, however much tidier that would be to deliver.
       * Completion is what settles money, so a single completion code would let day
       * one's code settle day four — paying the purohit for Dashami on Saptami
       * morning, which is the precise thing per-day settlement exists to prevent.
       * The codes are hashed per booking id already (`otp.hash(b.id, ...)`), so a
       * pair per day costs nothing structurally.
       *
       * Only day one's codes are delivered now; the rest go out on their own
       * morning, from `SeriesCodesJob`. Sending a family eight digits for four days
       * at once is how the wrong code gets read out at the door.
       */
      // Annotated, not inferred: the replay guard above narrows `b.state` to
      // exclude 'confirmed', which is exactly the value the transition produces.
      let headState: BookingState = b.state;
      const dayCodes: Array<{ bookingId: string; startOtp: string; completeOtp: string }> = [];

      for (const day of series) {
        const startOtp = this.otp.generate(this.devOtp);
        const completeOtp = this.otp.generate(this.devOtp);
        const to = await this.transition(tx, {
          bookingId: day.id, from: day.state,
          // A trigger of its own, so `booking_events` carries a permanent per-row
          // record of which bookings were confirmed without money. See the
          // transition table in contracts for why this is not a relaxed guard.
          trigger: args.unpaid ? 'confirmed_unpaid' : 'token_captured',
          actorRole: 'system',
          patch: {
            confirmedAt: new Date().toISOString(),
            startOtpHash: this.otp.hash(day.id, 'start', startOtp),
            completeOtpHash: this.otp.hash(day.id, 'complete', completeOtp),
          },
          eventPayload: args.unpaid
            ? { reason: 'payments_disabled', collectedInCash: price.totalPaise }
            : { paymentIntentId: args.paymentIntentId },
        });
        if (day.id === b.id) headState = to;
        dayCodes.push({ bookingId: day.id, startOtp, completeOtp });
      }

      // OTPs go to the DEVOTEE over WhatsApp. Returned here only so the dev
      // environment can complete a booking without a BSP wired up.
      const first = dayCodes[0]!;
      return {
        id: b.id, state: headState,
        days: series.length,
        codes: {
          devoteeId: b.devoteeId,
          cashDue: formatINR(paise(price.balancePaise)),
          startOtp: first.startOtp,
          completeOtp: first.completeOtp,
        },
      };
    });

    /*
     * Sent AFTER the transaction commits, and this is the only chance to send them.
     *
     * The comment above has always said these go to the devotee over WhatsApp.
     * Nothing sent them. Only the hashes are stored, so a code that is not delivered
     * here does not exist anywhere afterwards — the devotee has no way to start the
     * puja and the purohit no way to settle it, on a booking that has already been
     * paid for.
     *
     * Outside the transaction because a BSP round trip inside one holds a database
     * connection open across the network, and because a messaging failure must not
     * roll back a payment we have already captured. The failure is recorded in
     * `notifications` instead.
     */
    const codes = result.codes;
    /*
     * A replayed webhook. The codes were delivered the first time and only their
     * hashes survive, so there is nothing to re-send and nothing to hand back —
     * re-sending would message the devotee twice for one payment.
     *
     * Shaped like the success return rather than narrower, so a caller reading
     * `startOtp` does not have to prove which branch it came from first.
     */
    if (!codes) {
      return {
        id: result.id,
        state: result.state,
        days: result.days,
        startOtp: undefined as string | undefined,
        completeOtp: undefined as string | undefined,
      };
    }

    await Promise.all([
      this.notify.send({
        userId: codes.devoteeId, templateKey: 'booking.otp.start',
        variables: { otp: codes.startOtp },
      }),
      this.notify.send({
        userId: codes.devoteeId, templateKey: 'booking.otp.complete',
        variables: { otp: codes.completeOtp, amount: codes.cashDue },
      }),
    ]);

    return {
      id: result.id,
      state: result.state,
      /** How many days were confirmed — 1 for everything but a festival series. */
      days: result.days,
      startOtp: this.devOtp ? codes.startOtp : undefined,
      completeOtp: this.devOtp ? codes.completeOtp : undefined,
    };
  }

  // -------------------------------------------------------------------------
  // in_progress -> completed
  // -------------------------------------------------------------------------
  /**
   * OTP verification happens OUTSIDE the transaction, deliberately.
   *
   * The obvious implementation increments the failed-attempt counter inside the
   * transaction and then throws - which rolls the increment back, so the counter
   * never advances and a 6-digit code can be brute-forced without limit. The
   * counter has to be committed on its own.
   */
  private async verifyBookingOtp(
    booking: typeof bookings.$inferSelect,
    kind: 'start' | 'complete',
    otp: string,
  ): Promise<void> {
    if (booking.otpAttempts >= 5) {
      throw new DomainError(ErrorCode.OTP_RATE_LIMITED, 'too many attempts; ask for a new code');
    }
    const hash = kind === 'start' ? booking.startOtpHash : booking.completeOtpHash;
    if (!hash || !this.otp.matches(booking.id, kind, otp, hash)) {
      await this.db.update(bookings)
        .set({ otpAttempts: booking.otpAttempts + 1 })
        .where(eq(bookings.id, booking.id));
      throw new DomainError(ErrorCode.OTP_INVALID, 'incorrect code');
    }
  }

  /**
   * Beginning the puja.
   *
   * No longer carries a sankalp (family name/gotra) to record — the product used
   * to collect and store that here, keyed off this exact moment ("the purohit is
   * standing in the family's front room already asking"), but it is personal
   * information the app has no real need to hold. The purohit still asks the
   * family directly; the app just does not mediate or remember the answer.
   */
  async start(args: { bookingId: string; panditId: string; otp: string }) {
    const pre = await this.load(this.db, args.bookingId);
    if (pre.panditId !== args.panditId) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'this job is not assigned to you');
    }
    await this.verifyBookingOtp(pre, 'start', args.otp);

    return this.db.transaction(async (tx) => {
      const b = await this.load(tx, args.bookingId);
      const state = await this.transition(tx, {
        bookingId: b.id, from: b.state, trigger: 'start_otp_verified',
        actorId: args.panditId, actorRole: 'pandit',
        patch: { startedAt: new Date().toISOString(), otpAttempts: 0 },
      });
      return { id: b.id, state };
    });
  }

  /**
   * The purohit's meeting link for a remote booking.
   *
   * The catalogue has sold `online-aarti` and `virtual-consultation` since it was
   * seeded and there was no video anywhere in the system — a devotee could pay for
   * a live aarti and neither side had a way to reach the other. This is that way.
   *
   * Refused on an at-home booking rather than quietly stored: a join link on a puja
   * the purohit is travelling to is a contradiction, and silently accepting it
   * would put a "join by video" control on a devotee's booking for a ceremony
   * happening in their own front room.
   */
  async setJoinUrl(args: { bookingId: string; panditId: string; joinUrl: string }) {
    const [row] = await this.db.select({
      panditId: bookings.panditId,
      state: bookings.state,
      deliveryMode: rituals.deliveryMode,
    })
      .from(bookings)
      .innerJoin(rituals, eq(rituals.id, bookings.ritualId))
      .where(eq(bookings.id, args.bookingId)).limit(1);

    if (!row) throw new DomainError(ErrorCode.NOT_FOUND, 'booking not found');
    if (row.panditId !== args.panditId) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'this job is not assigned to you');
    }
    if (row.deliveryMode !== 'virtual') {
      throw new DomainError(
        ErrorCode.INVALID_TRANSITION,
        'this puja happens at the devotee\'s home, so there is nothing to join',
      );
    }
    if (isTerminal(row.state) || row.state === 'completed') {
      throw new DomainError(
        ErrorCode.INVALID_TRANSITION, 'this booking is already closed',
      );
    }

    await this.db.update(bookings)
      .set({ joinUrl: args.joinUrl, updatedAt: new Date().toISOString() })
      .where(eq(bookings.id, args.bookingId));

    /*
     * Told, not left to be discovered. A link the devotee never learns about is the
     * same as no link — and for a remote booking this message IS the delivery.
     */
    const [devotee] = await this.db.select({ devoteeId: bookings.devoteeId })
      .from(bookings).where(eq(bookings.id, args.bookingId)).limit(1);
    if (devotee) {
      await this.notify.send({
        userId: devotee.devoteeId,
        templateKey: 'booking.join_link.devotee',
        variables: { link: args.joinUrl },
      });
    }

    return { id: args.bookingId, joinUrl: args.joinUrl };
  }

  /**
   * Completion. Verifies the OTP server-side, settles, and emits.
   *
   * Note what is NOT here: an offline path that completes without server-side OTP
   * validation. The original design had the app cache a completion payload and sync
   * within 30 minutes, which either leaks the OTP hash to the device or accepts an
   * unverified completion - and in cash mode completion moves money. Offline capture
   * records INTENT (offlineCaptureAt, GPS, cash amount); the booking only reaches
   * `completed` when the server has seen a valid OTP.
   */
  async complete(args: {
    bookingId: string;
    panditId: string;
    otp: string;
    cashCollectedPaise?: number;
    capturedAt: string;
    location?: { lat: number; lng: number };
    recordingUrl?: string | undefined;
  }) {
    const pre = await this.load(this.db, args.bookingId);
    if (pre.panditId !== args.panditId) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'this job is not assigned to you');
    }
    if (pre.state === 'completed') {
      return { id: pre.id, state: pre.state, settlement: null };   // retry of a synced capture
    }
    await this.verifyBookingOtp(pre, 'complete', args.otp);

    return this.db.transaction(async (tx) => {
      const b = await this.load(tx, args.bookingId);

      const price = b.price as PriceBreakdown;
      if (b.paymentMode === 'cash' && args.cashCollectedPaise === undefined) {
        throw new DomainError(
          ErrorCode.CASH_AMOUNT_MISMATCH, 'record the cash amount you collected',
        );
      }

      // Throws CASH_AMOUNT_MISMATCH on a discrepancy, which rolls the whole
      // transaction back: the booking stays in_progress and ops raise a dispute.
      const plan = planSettlement({
        bookingId: b.id,
        panditId: b.panditId,
        devoteeId: b.devoteeId,
        paymentMode: b.paymentMode,
        price,
        ...(args.cashCollectedPaise !== undefined
          ? { cashCollectedPaise: paise(args.cashCollectedPaise) } : {}),
        tdsApplicable: true,
      });

      await this.ledger.post(tx, {
        kind: 'settlement',
        bookingId: b.id,
        idempotencyKey: `settlement:${b.id}`,
        legs: plan.legs,
      });

      const state = await this.transition(tx, {
        bookingId: b.id, from: b.state, trigger: 'complete_otp_verified',
        actorId: args.panditId, actorRole: 'pandit',
        patch: {
          completedAt: new Date().toISOString(),
          cashCollectedPaise: args.cashCollectedPaise ?? null,
          // Proof of performance for a booking nobody attended. Null on an at-home
          // puja, which needs none.
          ...(args.recordingUrl ? { recordingUrl: args.recordingUrl } : {}),
          offlineCaptureAt: args.capturedAt,
          completionLat: args.location ? String(args.location.lat) : null,
          completionLng: args.location ? String(args.location.lng) : null,
          otpAttempts: 0,
        },
        eventPayload: {
          tdsPaise: plan.tdsPaise,
          cashDuePaise: plan.cashDuePaise,
          panditNetPaise: plan.panditNetPaise,
          /*
           * Carried on the event rather than messaged from here, so telling the
           * devotee their recording is ready goes through the outbox like every
           * other notification — and gets the consumer's retry with it. Sending
           * inline would put a BSP round trip inside this transaction.
           */
          ...(args.recordingUrl ? { recordingUrl: args.recordingUrl } : {}),
        },
      });

      return { id: b.id, state, settlement: plan };
    });
  }

  // -------------------------------------------------------------------------
  // cancellation
  // -------------------------------------------------------------------------
  /**
   * A purohit dropping out must not end the booking.
   *
   * Cancelling used to be terminal for everyone: the devotee was refunded and left
   * with no purohit on the day of their ceremony, which is the single worst thing
   * this product can do to a family. A refund is not a remedy for a missing
   * Annaprashan.
   *
   * So a purohit-side cancellation first tries to hand the job to the next-best
   * match. The devotee keeps their slot, their price and their booking; only the
   * name changes, and they are told. Only when nobody is left does it fall through
   * to the terminal cancel-and-refund below.
   *
   * The AGREED PRICE IS NOT RECOMPUTED. The devotee accepted a number; a
   * substitution they did not ask for must never change it. A replacement whose own
   * rate is higher is free to decline, and we walk further down the list.
   */
  /**
   * Finds the replacement OUTSIDE any transaction.
   *
   * `matchPandit` runs its ranking against the pool. Called from inside an open
   * transaction it takes a second connection and deadlocks the moment the pool has
   * only one — which is exactly what a single-connection test database is, and what
   * `confirmOnTokenCapture` already carries a warning about. Resolve first, act
   * second.
   */
  private async findReplacement(b: typeof bookings.$inferSelect): Promise<string | null> {
    const priorEvents = await this.db.select({ meta: bookingEvents.meta })
      .from(bookingEvents).where(eq(bookingEvents.bookingId, b.id));

    // Everyone who has already held this booking, so we walk down the ranking
    // rather than round in circles.
    const tried = new Set<string>([b.panditId]);
    for (const e of priorEvents) {
      const m = e.meta as { panditId?: string; previousPanditId?: string } | null;
      if (m?.panditId) tried.add(m.panditId);
      if (m?.previousPanditId) tried.add(m.previousPanditId);
    }

    // Churning a booking through the whole roster helps nobody; past this, a human
    // should look at it.
    if (tried.size > MAX_SUBSTITUTIONS) return null;

    const citySlug = await this.catalog.citySlugById(b.cityId);
    const replacement = await this.search.matchPandit({
      // A re-match is a second decision for the same booking, deliberately not an
      // amendment of the first: the roster and everyone's load have moved since.
      bookingId: b.id,
      ritualId: b.ritualId,
      citySlug,
      date: b.date,
      slotIdx: b.slotIdx,
      slotSpan: b.slotSpan,
      /*
       * THE WINDOW THE BOOKING ACTUALLY HOLDS — the other half of ADR 0013, missed
       * here when `createBooking` was migrated.
       *
       * Without these `rankPandits` falls to its `date`+`slotIdx` branch, which asks
       * the `availability` slot grid whether the replacement is free. For a booking
       * whose window does not align to a slot — Kolkata's slots leave gaps, so a
       * 12:30 start files under `slot_idx` 0, the 06:00–09:00 slot — that asks about
       * the wrong three hours entirely. A replacement could be "free" in a slot they
       * are not needed for and busy at the time they are.
       *
       * This path runs when a purohit releases a CONFIRMED booking, so it is the one
       * the devotee is relying on most: they have paid, someone has dropped out, and
       * nobody is watching. `lockAndBook` would still refuse a genuine clash, but a
       * refusal here means no replacement was found at all.
       */
      startsAt: b.slotStartAt,
      endsAt: b.slotEndAt,
      exclude: [...tried],
    });
    return replacement?.id ?? null;
  }

  private async rematch(
    tx: Executor, b: typeof bookings.$inferSelect, replacement: { id: string },
    citySlug: string,
  ): Promise<string> {
    // Free the old calendar, take the new one. lockAndBook throws if the
    // replacement was taken between the match and here, which rolls the whole
    // cancellation back rather than leaving the booking with no purohit.
    if (b.confirmedAt) {
      await this.slots.release(tx, b.id);
      await this.availability.releaseBuffers(tx, {
        panditId: b.panditId, date: b.date as IsoDate,
      });
      // `citySlug` is a parameter, not resolved here: `citySlugById` reads on
      // `this.db`, a second connection from inside this open transaction -
      // exactly the deadlock `findReplacement`'s own comment warns about,
      // reproduced here until this test suite actually exercised the path.
      // See `cancel()`, which resolves it before the transaction opens.
      await this.slots.lockAndBook(tx, {
        panditId: replacement.id,
        date: b.date,
        slotIdx: b.slotIdx,
        slotSpan: b.slotSpan,
        bookingId: b.id,
        slotsInDay: getRegion(citySlug).slots.length,
      });
    }

    await tx.update(bookings)
      .set({ panditId: replacement.id, updatedAt: new Date().toISOString() })
      .where(eq(bookings.id, b.id));

    await tx.insert(bookingEvents).values({
      id: ulid(),
      bookingId: b.id,
      fromState: b.state,
      toState: b.state,          // the booking does not move; only the purohit does
      trigger: 'pandit_substituted',
      actorRole: 'platform',
      meta: { previousPanditId: b.panditId, panditId: replacement.id },
    });

    await this.outbox.emit(tx, {
      aggregateType: 'booking',
      aggregateId: b.id,
      eventType: 'booking.pandit_substituted',
      payload: {
        bookingId: b.id,
        previousPanditId: b.panditId,
        panditId: replacement.id,
        date: b.date,
        slotIdx: b.slotIdx,
      },
    });

    return replacement.id;
  }

  // -------------------------------------------------------------------------
  // reschedule — date/slot change, no state change
  // -------------------------------------------------------------------------
  /**
   * Moves a CONFIRMED booking to a new date/slot with the same purohit, without
   * cancelling it. "Free rescheduling up to 24 hours before" has been on the
   * membership plan since it was seeded (`db/seed/index.ts`); nothing behind it
   * could actually move a date, so the only way to change plans was to cancel —
   * forfeiting up to the full amount inside 24 hours — and rebook from scratch
   * at whatever price and purohit were available fresh.
   *
   * Same reasoning as `rematch`: the AGREED PRICE IS NOT RECOMPUTED. The devotee
   * accepted a number for this ritual; a date change they asked for must not
   * move it, any more than a purohit substitution the platform initiated does.
   */
  async reschedule(args: {
    bookingId: string; devoteeId: string; date: IsoDate; slotIdx: number;
  }) {
    const horizonEnd = addDays(today(), this.horizonDays);
    if (args.date < today() || args.date > horizonEnd) {
      throw new DomainError(
        ErrorCode.OUT_OF_HORIZON,
        `bookings open up to ${this.horizonDays} days ahead`,
        { requested: args.date, horizonEnd },
      );
    }

    /*
     * Resolved OUTSIDE the transaction, on `this.db` rather than `tx` - same
     * reasoning as `findReplacement`'s own comment: a second connection
     * requested from inside an open transaction deadlocks the moment the pool
     * has only one, which is exactly what a single-connection test database
     * is. `cityId` and `slotSpan` are immutable on an existing booking, so
     * resolving them here and re-verifying everything else against the FOR
     * UPDATE lock below is safe, not stale.
     */
    const pre = await this.load(this.db, args.bookingId);
    const citySlug = await this.catalog.citySlugById(pre.cityId);
    const defs = await this.db.select().from(slotDefs)
      .where(and(eq(slotDefs.cityId, pre.cityId), eq(slotDefs.active, true)))
      .orderBy(slotDefs.idx);

    // The ritual's duration does not change because the date did — the span
    // stays what it always was, applied to the new start.
    const first = defs.find((d) => d.idx === args.slotIdx);
    const last = defs.find((d) => d.idx === args.slotIdx + pre.slotSpan - 1);
    if (!first || !last) throw new DomainError(ErrorCode.NOT_FOUND, 'unknown slot');

    return this.db.transaction(async (tx) => {
      // Locked, not `load()`'s plain select: two reschedule calls racing on the
      // same booking must not both read "confirmed" and both proceed.
      const [locked] = await tx.select().from(bookings)
        .where(eq(bookings.id, args.bookingId)).for('update');
      if (!locked) throw new DomainError(ErrorCode.NOT_FOUND, 'booking not found');
      const b = locked;

      if (b.devoteeId !== args.devoteeId) {
        throw new DomainError(ErrorCode.FORBIDDEN, 'not your booking');
      }
      /*
       * Only a confirmed booking has a real slot locked and a purohit committed
       * to it. `draft`/`pending_accept` have nothing scheduled yet worth moving
       * (change the search instead), and `in_progress` onward are all past the
       * point where a date means anything.
       */
      if (b.state !== 'confirmed') {
        throw new DomainError(
          ErrorCode.INVALID_TRANSITION,
          'only a confirmed booking can be rescheduled',
          { state: b.state },
        );
      }

      const hoursUntilSlot = (new Date(b.slotStartAt).getTime() - Date.now()) / 3_600_000;
      if (hoursUntilSlot < 24) {
        throw new DomainError(
          ErrorCode.RESCHEDULE_WINDOW_CLOSED,
          'this booking starts in under 24 hours and can no longer be rescheduled online — message your purohit directly',
          { hoursUntilSlot },
        );
      }

      const previousDate = b.date;
      const previousSlotIdx = b.slotIdx;

      /*
       * Free the old calendar, take the new one. `lockAndBook` throws if the new
       * slot was taken between the devotee choosing it and here — which rolls
       * this whole reschedule back rather than leaving the booking half-moved
       * (still showing the old date to the devotee while holding no slot at all).
       */
      await this.slots.release(tx, b.id);
      await this.availability.releaseBuffers(tx, {
        panditId: b.panditId, date: previousDate as IsoDate,
      });
      await this.slots.lockAndBook(tx, {
        panditId: b.panditId, date: args.date, slotIdx: args.slotIdx, slotSpan: b.slotSpan,
        bookingId: b.id, slotsInDay: getRegion(citySlug).slots.length,
      });

      await tx.update(bookings).set({
        date: args.date,
        slotIdx: args.slotIdx,
        slotStartAt: slotInstant(args.date, first.startTime, citySlug).toISOString(),
        slotEndAt: slotInstant(args.date, last.endTime, citySlug).toISOString(),
        updatedAt: new Date().toISOString(),
      }).where(eq(bookings.id, b.id));

      await tx.insert(bookingEvents).values({
        id: ulid(),
        bookingId: b.id,
        fromState: b.state,
        toState: b.state,          // the booking does not move state; only the date does
        trigger: 'rescheduled',
        actorId: args.devoteeId,
        actorRole: 'devotee',
        meta: {
          previousDate, previousSlotIdx, date: args.date, slotIdx: args.slotIdx,
        },
      });

      await this.outbox.emit(tx, {
        aggregateType: 'booking',
        aggregateId: b.id,
        eventType: 'booking.rescheduled',
        payload: {
          bookingId: b.id, previousDate, previousSlotIdx, date: args.date, slotIdx: args.slotIdx,
        },
      });

      return { id: b.id, state: b.state, date: args.date, slotIdx: args.slotIdx };
    });
  }

  /**
   * A purohit declining a job they were auto-assigned.
   *
   * ADR 0011 removed the accept step: publishing a slot IS the acceptance, because a
   * purohit mid-ceremony cannot answer a phone and a two-hour accept window would
   * lose the devotee their slot for the crime of the purohit working. The ADR was
   * explicit that a decline path must remain — "the Urban Company model, not the
   * request-to-book model" — and `booking.service` has said so in a comment since,
   * pointing at a `decline()` that was never written.
   *
   * Without it a purohit who genuinely cannot attend had exactly one route: the full
   * cancel flow, which charges them a cancellation penalty for a job they never
   * agreed to individually. That is a bad trade for the platform too — it makes the
   * honest early "I can't" cost more than going quiet, which is precisely the
   * behaviour that ends with nobody at the door.
   *
   * THREE THINGS HAPPEN HERE, in this order and for this reason:
   *
   * 1. RE-MATCH FIRST. The devotee's booking surviving is worth more than the audit
   *    trail being tidy, so a replacement is sought before anything is torn down. If
   *    one is found the booking never leaves `pending_accept` and the devotee is
   *    simply told who is coming instead.
   * 2. Only if nobody can take it does the booking move to `expired` under the
   *    `pandit_decline` trigger, so `booking_events` records WHY it died rather than
   *    leaving it indistinguishable from an accept window timing out.
   * 3. The decline is counted against the purohit either way — including when the
   *    re-match succeeds. They still declined; the platform merely absorbed it.
   */
  async decline(args: { bookingId: string; panditId: string; reason: string }) {
    const reason = args.reason?.trim() ?? '';
    /*
     * `decline_reason_given` is a declared guard on this transition, and it earns
     * its place: a decline with no reason is indistinguishable from a purohit
     * tapping the wrong button, and the reason is the only signal ops has for
     * telling "my child is ill" apart from "I do not want cash jobs".
     */
    if (reason.length < 3) {
      // `decline_reason_given` is a declared guard on this transition, so a missing
      // reason is a guard failure rather than a malformed request. The controller's
      // zod schema rejects it first with a friendlier 422; this is the backstop for
      // any other caller.
      throw new DomainError(
        ErrorCode.INVALID_TRANSITION, 'please say briefly why you cannot take this job',
      );
    }

    // Resolved before the transaction, for the deadlock reason `cancel` documents.
    const pre = await this.load(this.db, args.bookingId);
    if (pre.panditId !== args.panditId) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'this job is not assigned to you');
    }
    /*
     * `pending_accept` only, because that is the single state the state machine
     * declares `pandit_decline` for. A confirmed booking has been paid for and
     * walking away from it is a cancellation with a refund attached, not a decline
     * — `cancel` already handles that, penalty and all.
     */
    if (pre.state !== 'pending_accept') {
      throw new DomainError(
        ErrorCode.INVALID_TRANSITION,
        pre.state === 'confirmed'
          ? 'this booking is already paid for — cancelling it refunds the devotee'
          : 'this job can no longer be declined',
      );
    }

    const candidateId = await this.findReplacement(pre);
    const citySlug = candidateId ? await this.catalog.citySlugById(pre.cityId) : null;

    const outcome = await this.db.transaction(async (tx) => {
      const b = await this.load(tx, args.bookingId);
      if (b.state !== 'pending_accept') {
        throw new DomainError(ErrorCode.INVALID_TRANSITION, 'this job can no longer be declined');
      }

      if (candidateId) {
        const replacement = await this.rematch(tx, b, { id: candidateId }, citySlug!);
        if (replacement) {
          /*
           * The booking lives, so there is no state change to record — but the
           * decline itself still has to be in the spine, or a purohit who declines
           * everything looks spotless because the platform kept rescuing them.
           */
          /*
           * Written straight to the spine rather than through `transition`, because
           * the booking must NOT move: `pandit_decline` is declared as
           * pending_accept → expired, and the whole point of this branch is that it
           * survived. `rematch` writes its own `pandit_substituted` row the same way
           * and for the same reason — the purohit changed, the booking did not.
           */
          await tx.insert(bookingEvents).values({
            id: ulid(),
            bookingId: b.id,
            fromState: b.state,
            toState: b.state,
            trigger: 'pandit_decline',
            actorId: args.panditId,
            actorRole: 'pandit',
            meta: { reason, previousPanditId: args.panditId, panditId: replacement },
          });
          return { id: b.id, state: 'pending_accept' as const, rematched: true, panditId: replacement };
        }
      }

      const to = await this.transition(tx, {
        bookingId: b.id, from: b.state, trigger: 'pandit_decline',
        actorId: args.panditId, actorRole: 'pandit',
        eventPayload: { reason, previousPanditId: args.panditId, panditId: null },
      });
      return { id: b.id, state: to, rematched: false, panditId: null };
    });

    /*
     * Scored AFTER the transaction commits, deliberately.
     *
     * The rate is a reputational statistic, not a booking invariant: a failure to
     * recompute it must not roll back a decline the purohit has already been told
     * went through, and it is self-correcting on the next one because it is
     * recomputed from the events rather than nudged.
     */
    try { await this.recordDecline(args.panditId); }
    catch (e) { this.log.warn(`acceptance rate not updated: ${(e as Error).message}`); }

    return outcome;
  }

  /**
   * The purohit's acceptance rate, recomputed from what actually happened.
   *
   * `pandit_profiles.acceptance_rate` has been read by the ranking since the first
   * commit — it is 15% of the match score — and NOTHING HAS EVER WRITTEN IT. Every
   * purohit scored the `COALESCE(..., 0.8)` default, so the term contributed an
   * identical constant to every candidate and did nothing at all.
   *
   * RECOMPUTED, NOT DECREMENTED. An incremental nudge drifts: a failed write, a
   * replayed call or a manual correction leaves a number nobody can reconstruct.
   * Counting the events gives the same answer every time, and this runs only when
   * someone declines, which is rare.
   *
   * The denominator is jobs OFFERED — confirmed plus declined — rather than every
   * booking ever touched, so a purohit is measured on what they did with work they
   * were actually given.
   */
  private async recordDecline(panditId: string): Promise<void> {
    await this.db.execute(sql`
      WITH offered AS (
        SELECT
          (SELECT count(*) FROM booking_events e
             JOIN bookings b ON b.id = e.booking_id
            WHERE e.trigger = 'pandit_decline' AND b.pandit_id = ${panditId}) AS declined,
          (SELECT count(*) FROM bookings
            WHERE pandit_id = ${panditId}
              AND state IN ('confirmed','in_progress','completed','reviewed')) AS kept
      )
      UPDATE pandit_profiles SET acceptance_rate = (
        SELECT CASE WHEN (kept + declined) = 0 THEN NULL
                    ELSE round(kept::numeric / (kept + declined), 4)
               END FROM offered
      )
      WHERE user_id = ${panditId}
    `);
  }

  async cancel(args: {
    bookingId: string; actorId: string; actorRole: 'devotee' | 'pandit' | 'admin'; reason: string;
  }) {
    // Resolved BEFORE the transaction opens — see findReplacement. `citySlug`
    // is only needed if rematch() will actually run, and only rematch() needs
    // it, so it is resolved here rather than inside `tx` (same deadlock this
    // whole pattern exists to avoid).
    const pre = await this.load(this.db, args.bookingId);
    const candidateId = args.actorRole === 'pandit' && !isTerminal(pre.state)
      ? await this.findReplacement(pre)
      : null;
    const citySlug = candidateId ? await this.catalog.citySlugById(pre.cityId) : null;

    return this.db.transaction(async (tx) => {
      const b = await this.load(tx, args.bookingId);
      if (isTerminal(b.state)) {
        throw new DomainError(ErrorCode.INVALID_TRANSITION, 'this booking is already closed');
      }

      const cancelledBy = args.actorRole === 'admin' ? 'platform' : args.actorRole;
      if (cancelledBy === 'devotee' && b.devoteeId !== args.actorId) {
        throw new DomainError(ErrorCode.FORBIDDEN, 'not your booking');
      }
      if (cancelledBy === 'pandit' && b.panditId !== args.actorId) {
        throw new DomainError(ErrorCode.FORBIDDEN, 'this job is not assigned to you');
      }

      // Try to save the booking before ending it.
      if (cancelledBy === 'pandit' && candidateId) {
        const replacement = await this.rematch(tx, b, { id: candidateId }, citySlug!);
        if (replacement) {
          return {
            id: b.id,
            state: b.state,
            rematched: true,
            panditId: replacement,
            refund: { refundPaise: paise(0), reason: 'rematched_no_refund_needed' },
          };
        }
      }

      const price = b.price as PriceBreakdown;
      const hoursUntilSlot =
        (new Date(b.slotStartAt).getTime() - Date.now()) / 3_600_000;
      const amountPaid = b.confirmedAt ? paise(price.tokenPaise) : paise(0);
      const refund = computeRefund({
        breakdown: { tokenPaise: paise(price.tokenPaise), totalPaise: paise(price.totalPaise) },
        amountPaidPaise: amountPaid,
        hoursUntilSlot,
        cancelledBy,
      });

      if (b.confirmedAt) {
        await this.slots.release(tx, b.id);
        await this.availability.releaseBuffers(tx, {
          panditId: b.panditId, date: b.date as IsoDate,
        });
      }

      if (refund.refundPaise > 0) {
        await this.ledger.post(tx, {
          kind: 'refund',
          bookingId: b.id,
          idempotencyKey: `refund:${b.id}`,
          legs: [
            { account: { type: 'escrow', ownerId: null },
              direction: 'debit', amount: refund.refundPaise, type: 'refund' },
            { account: { type: 'devotee_credit', ownerId: b.devoteeId },
              direction: 'credit', amount: refund.refundPaise, type: 'refund' },
          ],
        });
      }

      const state = await this.transition(tx, {
        bookingId: b.id, from: b.state,
        trigger: cancelledBy === 'pandit' ? 'cancel_pandit' : 'cancel_devotee',
        actorId: args.actorId, actorRole: args.actorRole,
        patch: { cancelledAt: new Date().toISOString(), cancelReason: args.reason },
        eventPayload: {
          refundPaise: refund.refundPaise, refundReason: refund.reason, hoursUntilSlot,
        },
      });
      return { id: b.id, state, refund, rematched: false };
    });
  }

  /** Job: expire bookings the purohit never answered, and offer to the next match. */
  /**
   * Job: expire bookings the purohit never answered, and offer to the next match.
   *
   * The actual predicate - `acceptDeadlineAt` in the past - was commented out
   * ("kept simple") and replaced with a per-row re-fetch and a JS date check. That
   * meant every `pending_accept` booking in the whole table was selected and loaded
   * individually, every time this runs, forever - the exact "query inside a loop"
   * CONTRIBUTING.md's standing constraint calls out, on a job that runs every minute.
   * Filtering in SQL is not an optimisation here; it is the predicate the comment
   * already said should exist.
   */
  async expireStaleAccepts(): Promise<number> {
    const nowIso = new Date().toISOString();
    const stale = await this.db.select({ id: bookings.id })
      .from(bookings)
      .where(and(
        eq(bookings.state, 'pending_accept'),
        isNotNull(bookings.acceptDeadlineAt),
        lt(bookings.acceptDeadlineAt, nowIso),
      ));

    let expired = 0;
    for (const row of stale) {
      try {
        await this.db.transaction(async (tx) => {
          await this.transition(tx, {
            bookingId: row.id, from: 'pending_accept', trigger: 'accept_window_expired',
            actorRole: 'system',
          });
        });
        expired++;
      } catch (e) {
        // The booking moved between the SELECT above and this transition (paid,
        // cancelled) - an ordinary race for a sweep job, not a reason to abort the
        // rest of the batch.
        this.log.warn(`could not expire booking ${row.id}: ${e instanceof Error ? e.message : e}`);
      }
    }
    return expired;
  }
}
