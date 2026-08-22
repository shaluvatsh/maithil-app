import { Controller, Get, Query, Inject } from '@nestjs/common';
import { SearchService } from './search.service';
import { AvailabilityService } from '../availability/availability.service';
import { Public } from '../auth/guards';
import { z } from 'zod';

const SearchQuery = z.object({
  ritualId: z.string(),
  citySlug: z.string().default(process.env.LAUNCH_CITY_SLUG ?? 'kolkata'),
  date: z.string().optional(),
  slotIdx: z.coerce.number().int().min(0).max(3).optional(),
  lat: z.coerce.number().optional(),
  lng: z.coerce.number().optional(),
  maxPricePaise: z.coerce.number().int().optional(),
  languages: z.union([z.string(), z.array(z.string())]).optional(),
  sort: z.enum(['relevance', 'price_asc', 'rating_desc', 'distance']).default('relevance'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const AvailabilityQuery = z.object({
  panditId: z.string(),
  from: z.string(),
  to: z.string(),
});

@Controller('v1')
export class SearchController {
  constructor(
    @Inject(SearchService) private readonly search: SearchService,
    @Inject(AvailabilityService) private readonly availability: AvailabilityService,
  ) {}

  @Public()
  @Get('search/pandits')
  async pandits(@Query() raw: unknown) {
    const q = SearchQuery.parse(raw);
    const languages = q.languages
      ? (Array.isArray(q.languages) ? q.languages : [q.languages])
      : undefined;
    const results = await this.search.searchPandits({ ...q, languages });
    return { results, nextCursor: null, locale: 'bn' as const };
  }

  @Public()
  @Get('availability')
  async slots(@Query() raw: unknown) {
    const q = AvailabilityQuery.parse(raw);
    return this.availability.forRange(q as never);
  }
}
