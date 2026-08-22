import { ulid } from 'ulid';
import { Logger } from '@nestjs/common';
import { eq, and, lt, isNotNull } from 'drizzle-orm';
import type { Db, Executor } from '../../db/client';
import {
  bookings, bookingEvents, users, rituals, slotDefs, cities, panditProfiles, addresses,
} from '../../db/schema/index';
import { LedgerService } from '../../domain/ledger';
import { OutboxService } from '../../domain/outbox';
import { SlotService, holdKey, HOLD_TTL_SECONDS } from '../../domain/slots';
import { planSettlement, planTokenCapture } from '../../domain/settlement';
import { AvailabilityService, slotInstant, today, addDays } from '../availability/availability.service';
import type { PricingService } from './pricing.service';
import type { BookingOtpService } from '../auth/otp.service';
import type { KvStore } from '../../common/kv';
import type { CatalogService } from '../catalog/catalog.service';
import {
  findTransition, isTerminal, computeRefund, paise,
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
  ritualId: string; citySlug: string; date?: string; slotIdx?: number; slotSpan?: number;
  exclude?: string[];
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
    private readonly devOtp = false,
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
  async createDraft(args: CreateBookingBody & { devoteeId: string; citySlug: string }) {
    const horizonEnd = addDays(today(), this.horizonDays);
    if (args.date < today() || args.date > horizonEnd) {
      throw new DomainError(
        ErrorCode.OUT_OF_HORIZON,
        `bookings open up to ${this.horizonDays} days ahead`,
        { requested: args.date, horizonEnd },
      );
    }

    const [addressRows, cityId, ritualRows, devoteeRows] = await Promise.all([
      // `addressId` names a row in another table entirely, supplied by the client
      // and never checked against the caller - so any devotee could book a
      // ceremony to ANY other household's saved address, just by knowing or
      // guessing its ulid.
      this.db.select({ userId: addresses.userId })
        .from(addresses).where(eq(addresses.id, args.addressId)).limit(1),
      this.catalog.cityIdBySlug(args.citySlug),
      this.db.select().from(rituals).where(eq(rituals.id, args.ritualId)).limit(1),
      this.db.select({ panjikaSchool: users.panjikaSchool })
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

    /**
     * No purohit named means the platform assigns one — the default flow.
     *
     * Matching happens HERE rather than in the browser so the choice cannot be
     * tampered with, and so the same ranking serves the web app, the future
     * mobile apps and re-match after a decline.
     */
    const panditId = args.panditId ?? (await this.search.matchPandit({
      ritualId: args.ritualId,
      citySlug: args.citySlug,
      date: args.date,
      slotIdx: args.slotIdx,
      slotSpan,
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

    if (args.slotIdx + slotSpan > 4) {
      throw new DomainError(
        ErrorCode.SLOT_UNAVAILABLE,
        'this ritual needs more time than remains in the day from that slot',
        { slotIdx: args.slotIdx, slotSpan },
      );
    }

    const first = defs.find((d) => d.idx === args.slotIdx);
    const last = defs.find((d) => d.idx === args.slotIdx + slotSpan - 1);
    if (!first || !last) throw new DomainError(ErrorCode.NOT_FOUND, 'unknown slot');

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
        const key = holdKey(panditId, args.date, args.slotIdx + i);
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

      const id = ulid();
      await this.db.insert(bookings).values({
        id,
        devoteeId: args.devoteeId,
        panditId: panditId,
        ritualId: args.ritualId,
        cityId,
        addressId: args.addressId,
        date: args.date,
        slotIdx: args.slotIdx,
        slotSpan,
        slotStartAt: slotInstant(args.date, first.startTime).toISOString(),
        slotEndAt: slotInstant(args.date, last.endTime).toISOString(),
        state: 'draft',
        // Snapshotted: changing the preference later must never rewrite history.
        panjikaSchool: devoteeRows[0]?.panjikaSchool ?? cityRows[0]?.school ?? 'gupta_press',
        attendeeCount: args.attendeeCount,
        sankalp: args.sankalp ?? null,
        samagriOption: args.samagriOption,
        bomSnapshot,
        price,
        paymentMode: args.paymentMode,
      });

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
      const state = await this.transition(tx, {
        bookingId, from: b.state, trigger: 'submit',
        actorId: devoteeId, actorRole: 'devotee',
        patch: { acceptDeadlineAt: deadline, acceptedAt: now },
        eventPayload: { panditId: b.panditId, acceptDeadlineAt: deadline, autoAccepted: true },
      });
      return { id: bookingId, state, acceptDeadlineAt: deadline, acceptedAt: now };
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
   * Called by the payment webhook once the token is captured. This is where money
   * first enters the system and where the slot is irrevocably taken - so the slot
   * lock, the ledger write and the state change are one transaction.
   */
  async confirmOnTokenCapture(args: {
    bookingId: string; paymentIntentId: string; travelMinutes?: number;
  }) {
    // Resolved BEFORE the transaction opens. Querying the pool from inside a
    // transaction takes a second connection and deadlocks the moment the pool has
    // one - which is exactly what a single-connection test database has.
    const pre = await this.load(this.db, args.bookingId);
    const citySlug = await this.catalog.citySlugById(pre.cityId);

    return this.db.transaction(async (tx) => {
      const b = await this.load(tx, args.bookingId);
      if (b.state === 'confirmed') return { id: b.id, state: b.state };   // webhook replay
      if (!b.acceptedAt) {
        throw new DomainError(
          ErrorCode.INVALID_TRANSITION, 'purohit has not accepted this booking yet',
        );
      }

      await this.slots.lockAndBook(tx, {
        panditId: b.panditId, date: b.date as IsoDate,
        slotIdx: b.slotIdx, slotSpan: b.slotSpan, bookingId: b.id,
      });

      await this.availability.applyTravelBuffer(tx, {
        panditId: b.panditId, date: b.date as IsoDate,
        slotIdx: b.slotIdx, slotSpan: b.slotSpan,
        travelMinutes: args.travelMinutes ?? 0,
        citySlug,
      });

      const price = b.price as PriceBreakdown;
      await this.ledger.post(tx, {
        kind: 'token_capture',
        bookingId: b.id,
        idempotencyKey: `token:${args.paymentIntentId}`,
        legs: planTokenCapture({
          bookingId: b.id, devoteeId: b.devoteeId, amount: paise(price.tokenPaise),
        }),
      });

      const startOtp = this.otp.generate(this.devOtp);
      const completeOtp = this.otp.generate(this.devOtp);

      const state = await this.transition(tx, {
        bookingId: b.id, from: b.state, trigger: 'token_captured',
        actorRole: 'system',
        patch: {
          confirmedAt: new Date().toISOString(),
          startOtpHash: this.otp.hash(b.id, 'start', startOtp),
          completeOtpHash: this.otp.hash(b.id, 'complete', completeOtp),
        },
        eventPayload: { paymentIntentId: args.paymentIntentId },
      });

      // OTPs go to the DEVOTEE over WhatsApp. Returned here only so the dev
      // environment can complete a booking without a BSP wired up.
      return { id: b.id, state, ...(this.devOtp ? { startOtp, completeOtp } : {}) };
    });
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
          offlineCaptureAt: args.capturedAt,
          completionLat: args.location ? String(args.location.lat) : null,
          completionLng: args.location ? String(args.location.lng) : null,
          otpAttempts: 0,
        },
        eventPayload: {
          tdsPaise: plan.tdsPaise,
          cashDuePaise: plan.cashDuePaise,
          panditNetPaise: plan.panditNetPaise,
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
      ritualId: b.ritualId,
      citySlug,
      date: b.date,
      slotIdx: b.slotIdx,
      slotSpan: b.slotSpan,
      exclude: [...tried],
    });
    return replacement?.id ?? null;
  }

  private async rematch(
    tx: Executor, b: typeof bookings.$inferSelect, replacement: { id: string },
  ): Promise<string> {
    // Free the old calendar, take the new one. lockAndBook throws if the
    // replacement was taken between the match and here, which rolls the whole
    // cancellation back rather than leaving the booking with no purohit.
    if (b.confirmedAt) {
      await this.slots.release(tx, b.id);
      await this.availability.releaseBuffers(tx, {
        panditId: b.panditId, date: b.date as IsoDate,
      });
      await this.slots.lockAndBook(tx, {
        panditId: replacement.id,
        date: b.date,
        slotIdx: b.slotIdx,
        slotSpan: b.slotSpan,
        bookingId: b.id,
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

  async cancel(args: {
    bookingId: string; actorId: string; actorRole: 'devotee' | 'pandit' | 'admin'; reason: string;
  }) {
    // Resolved BEFORE the transaction opens — see findReplacement.
    const pre = await this.load(this.db, args.bookingId);
    const candidateId = args.actorRole === 'pandit' && !isTerminal(pre.state)
      ? await this.findReplacement(pre)
      : null;

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
        const replacement = await this.rematch(tx, b, { id: candidateId });
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
   * CLAUDE.md's standing constraint calls out, on a job that runs every minute.
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
