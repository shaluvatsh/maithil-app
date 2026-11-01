import { z } from 'zod';
import { Ulid, IsoDate } from '../ids.js';
import { BookingState, PaymentMode, SamagriOption, PanjikaSchool } from '../enums.js';

export const PriceBreakdownSchema = z.object({
  dakshinaPaise: z.number().int(),
  samagriPaise: z.number().int(),
  travelPaise: z.number().int(),
  platformFeePaise: z.number().int(),
  discountPaise: z.number().int(),
  totalPaise: z.number().int(),
  tokenPaise: z.number().int(),
  balancePaise: z.number().int(),
  feeShortfallPaise: z.number().int(),
  surgeBps: z.number().int(),
  commissionBps: z.number().int(),
});

export const CreateBookingBody = z.object({
  /**
   * Omit to have the platform assign one — the default flow. The devotee is not
   * asked to choose between purohits they have no basis to compare.
   *
   * Supplied only by the "book this specific purohit" flow, reached from a
   * purohit's profile or from a past booking.
   */
  panditId: Ulid.optional(),
  ritualId: Ulid,
  addressId: Ulid,
  date: IsoDate,
  /*
   * `.max(3)` here was Kolkata's four-slot day - a static bound this schema has
   * no way to make city-aware, since it is compiled once with no request
   * context. The southern cities run five slots (`SOUTH_SLOTS`), so a real
   * booking into their evening slot 422'd here before the request ever reached
   * `booking.service.ts`'s own check, which IS city-aware (see `defs.length`
   * there). This bound is now deliberately loose - a sanity ceiling against
   * garbage input, not the business rule. The business rule lives in one place.
   */
  slotIdx: z.number().int().min(0).max(9).optional(),
  /** Contiguous slots. Defaults to the ritual's defaultSlotSpan. ADR 0006. */
  slotSpan: z.number().int().min(1).max(9).optional(),
  /**
   * The instant the ritual begins, ISO-8601.
   *
   * Supersedes `slotIdx` (ADR 0013). A slot index cannot express a muhurat that
   * starts at 11:15, the 04:00 Brahma muhurta, or the midnight Kali Puja the
   * catalogue already sells — all of which are simply a time. The end is derived
   * from the ritual's own duration rather than sent, so a client cannot ask for a
   * window that disagrees with the service it booked.
   *
   * `slotIdx` stays accepted while the purohit calendar is still slot-shaped;
   * exactly one of the two is required.
   */
  startsAt: z.string().datetime({ offset: true }).optional(),
  samagriOption: SamagriOption.default('pandit_brings'),
  paymentMode: PaymentMode,
  attendeeCount: z.number().int().positive().max(500).default(10),
  promoCode: z.string().optional(),
}).refine(
  (b) => b.startsAt !== undefined || b.slotIdx !== undefined,
  { message: 'either startsAt or slotIdx is required', path: ['startsAt'] },
);

export const BookingResponse = z.object({
  id: Ulid,
  state: BookingState,
  ritualId: Ulid,
  panditId: Ulid,
  devoteeId: Ulid,
  date: IsoDate,
  slotIdx: z.number().int(),
  slotSpan: z.number().int(),
  /** Absolute instants. Every deadline in the product is relative to these. */
  slotStartAt: z.string().datetime(),
  slotEndAt: z.string().datetime(),
  panjikaSchool: PanjikaSchool,
  samagriOption: SamagriOption,
  paymentMode: PaymentMode,
  price: PriceBreakdownSchema,
  holdExpiresAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});

export const ConfirmBookingBody = z.object({
  /** Required. Retries are expected - the client may be on a flaky mobile network. */
  idempotencyKey: z.string().min(16).max(128),
});

/**
 * Beginning the puja.
 *
 * This used to be a bare `{ otp }` read straight off the request body with no
 * schema at all — the only mutating booking endpoint that never went through Zod.
 *
 * Does not carry a sankalp (family name/gotra) any more. The product used to have
 * the purohit collect and store it here; that was dropped because it is personal
 * information the app has no need to hold — the purohit still asks the family
 * directly when they arrive, it is just never typed into this app.
 */
export const StartBookingBody = z.object({
  otp: z.string().regex(/^\d{6}$/),
});

export const CompleteBookingBody = z.object({
  otp: z.string().regex(/^\d{6}$/),
  /** Required in cash mode. Must equal balancePaise or we raise a dispute. */
  cashCollectedPaise: z.number().int().nonnegative().optional(),
  /** Required, and required to be recent - offline capture is intent, not completion. */
  capturedAt: z.string().datetime(),
  location: z.object({ lat: z.number(), lng: z.number() }).optional(),
  /**
   * Proof of performance, for a ritual nobody was in the room for.
   *
   * Optional, and only ever meaningful on a `virtual` booking: an at-home puja was
   * attended by the family, so a recording of it would be a strange thing to
   * demand. On a remote one it is what the devotee actually bought.
   */
  recordingUrl: z.string().url().max(2000).optional(),
  idempotencyKey: z.string().min(16).max(128),
});

/**
 * The purohit's own meeting link for a remote booking.
 *
 * Not a link the platform mints. Standing up video infrastructure to deliver a ₹499
 * aarti is the wrong order of work, and this persona already runs remote pujas on
 * WhatsApp video and Meet — a room they can operate beats a room we can build.
 */
export const JoinLinkBody = z.object({
  joinUrl: z.string().url().max(2000),
});

export const CancelBookingBody = z.object({
  reason: z.string().min(3).max(500),
  idempotencyKey: z.string().min(16).max(128),
});

/**
 * Moving a confirmed booking to a new date/slot without cancelling it - the
 * membership benefit ("free rescheduling up to 24 hours before") that had no
 * endpoint behind it. `slotSpan` is not accepted: the ritual's duration does not
 * change because the date did, so the service keeps the original span rather
 * than trusting a client-supplied one that could shrink or grow it.
 */
export const RescheduleBookingBody = z.object({
  date: IsoDate,
  slotIdx: z.number().int().min(0).max(9),
  idempotencyKey: z.string().min(16).max(128),
});

export type CreateBookingBody = z.infer<typeof CreateBookingBody>;
export type BookingResponse = z.infer<typeof BookingResponse>;
export type StartBookingBody = z.infer<typeof StartBookingBody>;
export type CompleteBookingBody = z.infer<typeof CompleteBookingBody>;
export type RescheduleBookingBody = z.infer<typeof RescheduleBookingBody>;
export type JoinLinkBody = z.infer<typeof JoinLinkBody>;

/**
 * A purohit declining a job they were auto-assigned (ADR 0011).
 *
 * The reason is REQUIRED, and `decline_reason_given` is a declared guard on the
 * transition for the same reason: a decline with no reason cannot be told apart from
 * a mis-tap, and it is the only signal ops has for distinguishing "my child is ill"
 * from "I do not want cash jobs" — one of which is a roster problem and the other a
 * product one.
 */
export const DeclineBookingBody = z.object({
  reason: z.string().trim().min(3, 'please say briefly why you cannot take this job').max(500),
});
export type DeclineBookingBody = z.infer<typeof DeclineBookingBody>;
