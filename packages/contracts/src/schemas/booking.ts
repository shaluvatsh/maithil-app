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
  slotIdx: z.number().int().min(0).max(3),
  /** Contiguous slots. Defaults to the ritual's defaultSlotSpan. ADR 0006. */
  slotSpan: z.number().int().min(1).max(4).optional(),
  samagriOption: SamagriOption.default('pandit_brings'),
  paymentMode: PaymentMode,
  attendeeCount: z.number().int().positive().max(500).default(10),
  /** Captured at booking for the sankalp. */
  sankalp: z.object({
    name: z.string().min(1),
    gotra: z.string().optional(),
  }).optional(),
  promoCode: z.string().optional(),
});

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

export const CompleteBookingBody = z.object({
  otp: z.string().regex(/^\d{6}$/),
  /** Required in cash mode. Must equal balancePaise or we raise a dispute. */
  cashCollectedPaise: z.number().int().nonnegative().optional(),
  /** Required, and required to be recent - offline capture is intent, not completion. */
  capturedAt: z.string().datetime(),
  location: z.object({ lat: z.number(), lng: z.number() }).optional(),
  idempotencyKey: z.string().min(16).max(128),
});

export const CancelBookingBody = z.object({
  reason: z.string().min(3).max(500),
  idempotencyKey: z.string().min(16).max(128),
});

export type CreateBookingBody = z.infer<typeof CreateBookingBody>;
export type BookingResponse = z.infer<typeof BookingResponse>;
export type CompleteBookingBody = z.infer<typeof CompleteBookingBody>;
