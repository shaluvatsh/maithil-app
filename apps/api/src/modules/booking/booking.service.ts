import { ulid } from 'ulid';
import { eq, and } from 'drizzle-orm';
import type { Db, Executor } from '../../db/client';
import {
  bookings, bookingEvents, users, rituals, slotDefs, cities, panditProfiles,
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

export class BookingService {
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
    private readonly devOtp = false,
  ) {}

  // -------------------------------------------------------------------------
  // Transition core. EVERY state change goes through here: it validates against
  // the declarative table in contracts, writes the audit row and the outbox event
  // in the SAME transaction as the update. See ADR 0005.
  // -------------------------------------------------------------------------
  private async transition(tx: Executor, args: {
    bookingId: string;
    from: BookingState;
    trigger: BookingTrigger;
    actorId?: string | null;
    actorRole?: string | null;
    patch?: Partial<typeof bookings.$inferInsert>;
    eventPayload?: Record<string, unknown>;
  }): Promise<BookingState> {
    const t = findTransition(args.from, args.trigger);
    if (!t) {
      throw new DomainError(
        ErrorCode.INVALID_TRANSITION,
        `cannot ${args.trigger} a booking that is ${args.from}`,
        { from: args.from, trigger: args.trigger },
      );
    }

    await tx.update(bookings)
      .set({ ...args.patch, state: t.to, updatedAt: new Date().toISOString() })
      .where(and(eq(bookings.id, args.bookingId), eq(bookings.state, args.from)));

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
  async createDraft(args: CreateBookingBody & { devoteeId: string; citySlug: string }) {
    const cityId = await this.catalog.cityIdBySlug(args.citySlug);

    const horizonEnd = addDays(today(), this.horizonDays);
    if (args.date < today() || args.date > horizonEnd) {
      throw new DomainError(
        ErrorCode.OUT_OF_HORIZON,
        `bookings open up to ${this.horizonDays} days ahead`,
        { requested: args.date, horizonEnd },
      );
    }

    const ritual = await this.db.select().from(rituals)
      .where(eq(rituals.id, args.ritualId)).limit(1);
    if (!ritual[0]) throw new DomainError(ErrorCode.NOT_FOUND, 'unknown ritual');

    const pandit = await this.db.select().from(panditProfiles)
      .where(eq(panditProfiles.userId, args.panditId)).limit(1);
    if (!pandit[0]) throw new DomainError(ErrorCode.NOT_FOUND, 'unknown purohit');
    if (pandit[0].kycStatus !== 'verified') {
      throw new DomainError(ErrorCode.KYC_INCOMPLETE, 'this purohit is not yet verified');
    }
    if (args.paymentMode === 'cash' && !pandit[0].cashJobsEnabled) {
      throw new DomainError(
        ErrorCode.CASH_JOBS_PAUSED,
        'this purohit is not accepting cash bookings right now',
      );
    }

    const slotSpan = args.slotSpan ?? ritual[0].defaultSlotSpan;
    if (args.slotIdx + slotSpan > 4) {
      throw new DomainError(
        ErrorCode.SLOT_UNAVAILABLE,
        'this ritual needs more time than remains in the day from that slot',
        { slotIdx: args.slotIdx, slotSpan },
      );
    }

    const defs = await this.db.select().from(slotDefs)
      .where(eq(slotDefs.cityId, cityId)).orderBy(slotDefs.idx);
    const first = defs.find((d) => d.idx === args.slotIdx);
    const last = defs.find((d) => d.idx === args.slotIdx + slotSpan - 1);
    if (!first || !last) throw new DomainError(ErrorCode.NOT_FOUND, 'unknown slot');

    // Soft hold. UX only - correctness comes from the FOR UPDATE at confirm time,
    // so a Redis outage degrades checkout rather than double-booking a purohit.
    const held: string[] = [];
    for (let i = 0; i < slotSpan; i++) {
      const key = holdKey(args.panditId, args.date, args.slotIdx + i);
      const ok = await this.kv.setIfAbsent(key, args.devoteeId, HOLD_TTL_SECONDS);
      if (!ok) {
        await Promise.all(held.map((k) => this.kv.del(k)));
        throw new DomainError(
          ErrorCode.SLOT_UNAVAILABLE,
          'someone else is checking out for this slot; try another',
        );
      }
      held.push(key);
    }

    const price = await this.pricing.quote({
      panditId: args.panditId,
      ritualId: args.ritualId,
      cityId,
      date: args.date,
      samagriOption: args.samagriOption,
      paymentMode: args.paymentMode,
    });

    const devotee = await this.db.select({ panjikaSchool: users.panjikaSchool })
      .from(users).where(eq(users.id, args.devoteeId)).limit(1);
    const city = await this.db.select({ school: cities.defaultPanjikaSchool })
      .from(cities).where(eq(cities.id, cityId)).limit(1);

    const id = ulid();
    await this.db.insert(bookings).values({
      id,
      devoteeId: args.devoteeId,
      panditId: args.panditId,
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
      panjikaSchool: devotee[0]?.panjikaSchool ?? city[0]?.school ?? 'gupta_press',
      attendeeCount: args.attendeeCount,
      sankalp: args.sankalp ?? null,
      samagriOption: args.samagriOption,
      bomSnapshot: await this.catalog.bomFor(args.ritualId, 'bn'),
      price,
      paymentMode: args.paymentMode,
    });

    return {
      id,
      price,
      slotSpan,
      holdExpiresAt: new Date(Date.now() + HOLD_TTL_SECONDS * 1000).toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // draft -> pending_accept -> confirmed
  // -------------------------------------------------------------------------
  async submit(bookingId: string, devoteeId: string) {
    return this.db.transaction(async (tx) => {
      const b = await this.load(tx, bookingId);
      if (b.devoteeId !== devoteeId) {
        throw new DomainError(ErrorCode.FORBIDDEN, 'not your booking');
      }
      const deadline = new Date(Date.now() + ACCEPT_WINDOW_MS).toISOString();
      const state = await this.transition(tx, {
        bookingId, from: b.state, trigger: 'submit',
        actorId: devoteeId, actorRole: 'devotee',
        patch: { acceptDeadlineAt: deadline },
        eventPayload: { panditId: b.panditId, acceptDeadlineAt: deadline },
      });
      return { id: bookingId, state, acceptDeadlineAt: deadline };
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
  async cancel(args: {
    bookingId: string; actorId: string; actorRole: 'devotee' | 'pandit' | 'admin'; reason: string;
  }) {
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
      return { id: b.id, state, refund };
    });
  }

  /** Job: expire bookings the purohit never answered, and offer to the next match. */
  async expireStaleAccepts(): Promise<number> {
    const stale = await this.db.select({ id: bookings.id, state: bookings.state })
      .from(bookings)
      .where(and(
        eq(bookings.state, 'pending_accept'),
        // acceptDeadlineAt in the past
        // (kept simple - the job runs every minute)
      ));

    let expired = 0;
    for (const row of stale) {
      const b = await this.load(this.db, row.id);
      if (!b.acceptDeadlineAt || new Date(b.acceptDeadlineAt) > new Date()) continue;
      await this.db.transaction(async (tx) => {
        await this.transition(tx, {
          bookingId: b.id, from: 'pending_accept', trigger: 'accept_window_expired',
          actorRole: 'system',
        });
      });
      expired++;
    }
    return expired;
  }
}
