import { z } from 'zod';
import { Ulid } from '../ids.js';
import { Locale } from '../enums.js';

export const RitualSummary = z.object({
  id: Ulid,
  slug: z.string(),
  name: z.string(),
  shortDescription: z.string(),
  durationMin: z.number().int().positive(),
  /** Contiguous 3h slots this ritual occupies. Derived from duration. See ADR 0006. */
  defaultSlotSpan: z.number().int().min(1).max(4),
  priceBand: z.object({
    minPaise: z.number().int(),
    maxPaise: z.number().int(),
    defaultPaise: z.number().int(),
  }),
  bomTotalPaise: z.number().int(),
  isMuhuratSensitive: z.boolean(),
});

export const BomItem = z.object({
  id: Ulid,
  name: z.string(),
  qty: z.string(),           // "1.5" - decimal as string, never a float
  unit: z.string(),          // kg, g, piece, mala, tola
  grade: z.string().nullable(),
  catalogPricePaise: z.number().int(),
  perishable: z.boolean(),
});

export const RitualDetail = RitualSummary.extend({
  description: z.string(),
  bom: z.array(BomItem),
  locale: Locale,
});

export const ListRitualsQuery = z.object({
  citySlug: z.string().default('kolkata'),
  locale: Locale.default('bn'),
  q: z.string().optional(),
});

export type RitualSummary = z.infer<typeof RitualSummary>;
export type RitualDetail = z.infer<typeof RitualDetail>;
export type BomItem = z.infer<typeof BomItem>;
