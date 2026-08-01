import { z } from 'zod';
import { IsoDate, Ulid } from '../ids.js';
import { SlotStatus } from '../enums.js';

export const SlotView = z.object({
  slotIdx: z.number().int(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  status: SlotStatus,
  /** Panchang annotations, computed by real interval intersection - not a weekday map. */
  containsAbhijit: z.boolean(),
  overlapsRahuKaal: z.boolean(),
  bookingId: Ulid.nullable(),
});

export const DayAvailability = z.object({
  date: IsoDate,
  slots: z.array(SlotView),
});

export const SetAvailabilityBody = z.object({
  changes: z.array(z.object({
    date: IsoDate,
    slotIdx: z.number().int().min(0).max(3),
    status: z.enum(['open', 'closed']),
  })).min(1).max(400),
});

export type SlotView = z.infer<typeof SlotView>;
export type DayAvailability = z.infer<typeof DayAvailability>;
