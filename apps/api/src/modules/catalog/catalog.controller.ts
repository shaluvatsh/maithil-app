import { Controller, Get, Param, Query } from '@nestjs/common';
import { CatalogService } from './catalog.service';
import { Public } from '../auth/guards';
import { ListRitualsQuery } from '@themaithil/contracts';

@Controller('v1')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  /** Public: ritual pages are the SEO surface and the top of the funnel. */
  @Public()
  @Get('rituals')
  list(@Query() query: unknown) {
    const q = ListRitualsQuery.parse(query);
    return this.catalog.listRituals({ citySlug: q.citySlug, locale: q.locale });
  }

  @Public()
  @Get('rituals/:slug')
  detail(@Param('slug') slug: string, @Query() query: unknown) {
    const q = ListRitualsQuery.parse(query);
    return this.catalog.getRitual({ slug, citySlug: q.citySlug, locale: q.locale });
  }
}
