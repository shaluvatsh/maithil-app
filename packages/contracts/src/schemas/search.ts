import { z } from 'zod';
import { Ulid, IsoDate } from '../ids.js';
import { Locale } from '../enums.js';

export const SearchPanditsQuery = z.object({
  ritualId: Ulid,
  citySlug: z.string().default('kolkata'),
  date: IsoDate.optional(),
  slotIdx: z.number().int().min(0).max(3).optional(),
  languages: z.array(z.string()).optional(),
  traditions: z.array(z.string()).optional(),
  maxPricePaise: z.number().int().optional(),
  /** Devotee's venue, for radius filtering. Haversine in SQL - no Maps API here. */
  lat: z.number().optional(),
  lng: z.number().optional(),
  sort: z.enum(['relevance', 'price_asc', 'rating_desc', 'distance']).default('relevance'),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(50).default(20),
});

export const PanditCard = z.object({
  id: Ulid,
  name: z.string(),
  photoUrl: z.string().nullable(),
  badges: z.array(z.string()),
  /**
   * A 30-second recording of them chanting, and what they are reciting. Devotees
   * judge shuddha uchcharan, and no competitor lets them hear it before booking.
   */
  chantingSampleUrl: z.string().nullable(),
  chantingSampleLabel: z.string().nullable(),
  experienceYears: z.number().int(),
  languages: z.array(z.string()),
  traditions: z.array(z.string()),
  /** Bayesian-smoothed so two 5-star reviews do not outrank forty 4.7s. */
  rating: z.number().nullable(),
  ratingCount: z.number().int(),
  pricePaise: z.number().int(),
  distanceKm: z.number().nullable(),
  isNewPandit: z.boolean(),      // cold-start boost is visible, not hidden
  nextAvailable: z.object({ date: IsoDate, slotIdx: z.number().int() }).nullable(),
});

export const SearchPanditsResponse = z.object({
  results: z.array(PanditCard),
  nextCursor: z.string().nullable(),
  locale: Locale,
});

export type PanditCard = z.infer<typeof PanditCard>;
