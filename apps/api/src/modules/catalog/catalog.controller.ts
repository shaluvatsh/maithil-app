import { Controller, Get, Param, Query, Inject } from '@nestjs/common';
import { CatalogService } from './catalog.service';
import { OffersService } from './offers.service';
import { StatsService } from './stats.service';
import { Public } from '../auth/guards';
import { Cacheable, CACHE } from '../../common/cache';
import { ListRitualsQuery } from '@themaithil/contracts';

@Controller('v1')
export class CatalogController {
  constructor(
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(OffersService) private readonly offers: OffersService,
    @Inject(StatsService) private readonly stats: StatsService,
  ) {}

  /**
   * Counted, not claimed. The hero used to assert an average rating over zero
   * reviews and fifty thousand families served before launch.
   */
  @Public()
  @Cacheable(CACHE.stats)
  @Get('stats')
  summary() {
    return this.stats.summary();
  }

  /**
   * The current membership offer, or null.
   *
   * Null is a real answer here and the client must render nothing for it. The
   * previous card was eight hardcoded numbers that no database row backed, so it
   * advertised a saving nobody could realise — see offers.service.ts.
   */
  @Public()
  @Cacheable(CACHE.catalogue)
  @Get('offers/current')
  currentOffer(@Query() query: unknown) {
    const q = ListRitualsQuery.parse(query);
    return this.offers.current(q.citySlug, q.locale);
  }

  /** Public: ritual pages are the SEO surface and the top of the funnel. */
  @Public()
  @Cacheable(CACHE.catalogue)
  @Get('rituals')
  list(@Query() query: unknown) {
    const q = ListRitualsQuery.parse(query);
    return this.catalog.listRituals({
      citySlug: q.citySlug, locale: q.locale, category: q.category,
    });
  }

  /** Browse taxonomy with live counts for this city. */
  @Public()
  @Cacheable(CACHE.catalogue)
  @Get('categories')
  categories(@Query() query: unknown) {
    const q = ListRitualsQuery.parse(query);
    return this.catalog.categories(q.citySlug);
  }

  @Public()
  @Cacheable(CACHE.catalogue)
  @Get('rituals/:slug')
  detail(@Param('slug') slug: string, @Query() query: unknown) {
    const q = ListRitualsQuery.parse(query);
    return this.catalog.getRitual({ slug, citySlug: q.citySlug, locale: q.locale });
  }
}
