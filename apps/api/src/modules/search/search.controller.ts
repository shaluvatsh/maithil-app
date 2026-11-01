import { Controller, Get, Query, Inject } from '@nestjs/common';
import { SearchService } from './search.service';
import { AvailabilityService } from '../availability/availability.service';
import { BookableTimesService, STEP_MINUTES } from '../availability/bookable-times.service';
import { DB } from '../../common/tokens';
import type { Db } from '../../db/client';
import { rituals } from '../../db/schema/index';
import { eq } from 'drizzle-orm';
import { DomainError, ErrorCode } from '@themaithil/contracts';
import { Public } from '../auth/guards';
import { getRegion, DEFAULT_LOCALE } from '@themaithil/region';
import { z } from 'zod';

/**
 * `slotIdx` is bounded by the CITY, not by a constant.
 *
 * This was `.max(3)` — Kolkata's four-slot day. The southern cities run five
 * (`SOUTH_SLOTS`), so a devotee in Bengaluru, Chennai or Hyderabad searching the
 * 18:00–20:30 slot was rejected by validation before the request ever reached the
 * service, making that slot unbookable through search. The bound has to be resolved
 * after `citySlug` is known, so it lives in a refinement rather than on the field.
 */
const SearchQuery = z.object({
  ritualId: z.string(),
  citySlug: z.string().default(process.env.LAUNCH_CITY_SLUG ?? 'kolkata'),
  date: z.string().optional(),
  slotIdx: z.coerce.number().int().min(0).optional(),
  /**
   * THE REQUESTED WINDOW, AND THE REASON THIS SCHEMA EXISTS TO BE READ CAREFULLY.
   *
   * `SearchArgs` has declared these since ADR 0013, `rankPandits` branches on them
   * first, and its comment says they "supersede `date`+`slotIdx`". The booking flow
   * duly stopped sending `slotIdx` and started sending `startsAt`/`endsAt`.
   *
   * They were never added HERE. A Zod object strips unknown keys rather than
   * rejecting them, so both silently fell off the parsed query, `searchPandits`
   * received neither, and `rankPandits` fell through BOTH availability branches to
   * the empty-`sql` default — no availability filter at all.
   *
   * What that looked like, measured against the dev database: with one of four
   * purohits booked across 00:30–02:30, `/v1/availability/times` correctly reported
   * `purohitCount: 3` for that window while `/v1/search/pandits` returned all FOUR
   * for the same window, the booked one included. Asked for a window at midnight
   * IST, when nobody has working hours at all, it still returned all four.
   *
   * So "4 pandits are free at this time" on the booking screen did not mean that.
   * It meant "4 verified purohits exist in this city". The devotee then chose
   * options, an address and a payment mode, pressed Review and book, and
   * `createBooking` — which DOES pass these through to `matchPandit` — refused with
   * "no purohit is free at that time". A dead end at the last step, contradicting
   * what the page had said two steps earlier.
   *
   * Validated as datetimes rather than passed through: they are interpolated into
   * `::timestamptz` casts, and a malformed one should be a 422 naming the field,
   * not a Postgres error from inside a CTE.
   */
  startsAt: z.string().datetime({ offset: true }).optional(),
  endsAt: z.string().datetime({ offset: true }).optional(),
  /** How many contiguous slots the ritual needs. Only meaningful with `slotIdx`. */
  slotSpan: z.coerce.number().int().min(1).optional(),
  lat: z.coerce.number().optional(),
  lng: z.coerce.number().optional(),
  maxPricePaise: z.coerce.number().int().optional(),
  languages: z.union([z.string(), z.array(z.string())]).optional(),
  sort: z.enum(['relevance', 'price_asc', 'rating_desc', 'distance']).default('relevance'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
}).superRefine((q, ctx) => {
  /*
   * Both or neither. `rankPandits` tests `startsAt && endsAt` together, so one
   * without the other does not half-filter — it silently falls through to the
   * slot branch, or to no filter at all. That is the same class of quiet
   * wrong-branch failure that made these two worth a comment above.
   */
  if ((q.startsAt === undefined) !== (q.endsAt === undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [q.startsAt === undefined ? 'startsAt' : 'endsAt'],
      message: 'startsAt and endsAt must be given together',
    });
  }
  if (q.startsAt && q.endsAt && Date.parse(q.endsAt) <= Date.parse(q.startsAt)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['endsAt'],
      message: 'endsAt must be after startsAt',
    });
  }
  if (q.slotIdx === undefined) return;
  const slotsInDay = getRegion(q.citySlug).slots.length;
  if (q.slotIdx > slotsInDay - 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['slotIdx'],
      message: `${q.citySlug} has ${slotsInDay} slots a day`,
    });
  }
});

const AvailabilityQuery = z.object({
  panditId: z.string(),
  from: z.string(),
  to: z.string(),
});

/** The devotee's time picker: which start times this ritual can be booked at. */
const TimesQuery = z.object({
  ritualId: z.string(),
  citySlug: z.string(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
});

@Controller('v1')
export class SearchController {
  constructor(
    @Inject(SearchService) private readonly search: SearchService,
    @Inject(AvailabilityService) private readonly availability: AvailabilityService,
    @Inject(BookableTimesService) private readonly times: BookableTimesService,
    @Inject(DB) private readonly db: Db,
  ) {}

  @Public()
  @Get('search/pandits')
  async pandits(@Query() raw: unknown) {
    const q = SearchQuery.parse(raw);
    const languages = q.languages
      ? (Array.isArray(q.languages) ? q.languages : [q.languages])
      : undefined;
    const results = await this.search.searchPandits({ ...q, languages });
    /*
     * The product's default language, not the launch city's.
     *
     * This was the literal 'bn', which told a Chennai client that its results were
     * Bengali — and would have kept saying so after the interface stopped opening
     * in Bengali at all (ADR 0017). One owner, in packages/region.
     */
    return { results, nextCursor: null, locale: DEFAULT_LOCALE };
  }

  @Public()
  @Get('availability')
  async slots(@Query() raw: unknown) {
    const q = AvailabilityQuery.parse(raw);
    return this.availability.forRange(q as never);
  }

  /**
   * Start times for the devotee's picker, replacing the four fixed slots.
   *
   * Public: choosing a time is browsing, and sending someone to a login wall
   * before they have seen whether their date works is where bookings are lost.
   */
  @Public()
  @Get('availability/times')
  async bookableTimes(@Query() raw: unknown) {
    const q = TimesQuery.parse(raw);
    const [ritual] = await this.db.select({ durationMin: rituals.durationMin })
      .from(rituals).where(eq(rituals.id, q.ritualId)).limit(1);
    if (!ritual) throw new DomainError(ErrorCode.NOT_FOUND, 'unknown ritual');
    return {
      stepMinutes: STEP_MINUTES,
      times: await this.times.forDate({ ...q, durationMin: ritual.durationMin }),
    };
  }
}
