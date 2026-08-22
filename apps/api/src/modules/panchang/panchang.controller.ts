import { Controller, Get, Post, Query, Body, Inject } from '@nestjs/common';
import { z } from 'zod';
import { PanchangService } from './panchang.service';
import { Public, Roles } from '../auth/guards';
import { Cacheable, CACHE } from '../../common/cache';
import { PanjikaSchool } from '@themaithil/contracts';
import { getRegion, computableSchool } from '@themaithil/region';

const Query_ = z.object({
  citySlug: z.string().default(process.env.LAUNCH_CITY_SLUG ?? 'kolkata'),
  from: z.string(),
  to: z.string(),
  /**
   * Every school the platform knows, not the two Bengal ones.
   *
   * This enum rejected `drik_generic` — the almanac twelve of the fourteen cities
   * actually follow — so a request for a Mumbai or Ahmedabad panchang failed
   * validation before it reached the query. And the default was `gupta_press`,
   * which is hand-entered and has never been entered, so a caller that omitted the
   * parameter reliably got nothing back.
   */
  school: PanjikaSchool.optional(),
  view: z.enum(['devotee', 'pandit']).default('devotee'),
  locale: z.enum(['bn', 'hi', 'en']).default('bn'),
});

@Controller('v1')
export class PanchangController {
  constructor(@Inject(PanchangService) private readonly panchang: PanchangService) {}

  /** Public: the panchang tab is a reason to open the app on a day you are not booking. */
  @Public()
  @Cacheable(CACHE.almanac)
  @Get('panchang')
  async get(@Query() raw: unknown) {
    const q = Query_.parse(raw);
    // No school asked for means "whichever one this city publishes", not a
    // hardcoded guess that happens to be right in one city out of fourteen.
    const school = q.school ?? computableSchool(getRegion(q.citySlug));
    const args = { ...q, school };
    return q.view === 'pandit'
      ? this.panchang.forPandit(args as never)
      : this.panchang.forDevotee(args as never);
  }

  /**
   * Which almanacs actually have data for this city.
   *
   * Kolkata's configured default is Gupta Press, which under ADR 0003 is entered by
   * hand and has never been entered — only Bisuddha Siddhanta is computed. Both the
   * home page and `/panchang` asked for the configured default, got an empty array,
   * and rendered nothing. So the panchang was invisible in the launch city, and the
   * failure was silent: an empty list is indistinguishable from a quiet day.
   *
   * The client cannot be expected to guess which school is published, so it asks.
   */
  @Public()
  @Cacheable(CACHE.almanac)
  @Get('panchang/schools')
  schools(@Query() raw: unknown) {
    const q = z.object({
      citySlug: z.string().default(process.env.LAUNCH_CITY_SLUG ?? 'kolkata'),
    }).parse(raw);
    return this.panchang.schools(q.citySlug);
  }

  /** Admin-triggered rebuild. The same call the nightly job makes. */
  @Roles('admin', 'ops')
  @Post('admin/panchang/materialise')
  materialise(@Body() body: { citySlug?: string; from?: string; days?: number }) {
    const from = body.from ?? new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
    return this.panchang.materialise({
      citySlug: body.citySlug ?? process.env.LAUNCH_CITY_SLUG ?? 'kolkata',
      from: from as never,
      days: body.days ?? 120,
    });
  }
}
