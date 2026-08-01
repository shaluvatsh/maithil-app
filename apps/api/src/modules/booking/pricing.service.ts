import { eq, and, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { panditRituals, surgeRules, rituals } from '../../db/schema/index';
import type { CatalogService } from '../catalog/catalog.service';
import {
  computePrice, paise, ZERO, DomainError, ErrorCode,
  type PriceBreakdown, type PaymentMode, type SamagriOption, type IsoDate,
} from '@themaithil/contracts';

export class PricingService {
  constructor(
    private readonly db: Db,
    private readonly catalog: CatalogService,
  ) {}

  /**
   * Surge lookup. A ritual-specific rule beats a city-wide one for the same date.
   *
   * The original design kept a single surge_multiplier column on panchang_days,
   * which applies one multiplier to every ritual on a date - so a Griha Prabesh
   * muhurat would surge Sraddha too. See ADR/review section 2.9.
   */
  async surgeBpsFor(args: { cityId: string; date: IsoDate; ritualId: string }): Promise<number> {
    const rows = await this.db.select({
      multiplierBps: surgeRules.multiplierBps,
      ritualId: surgeRules.ritualId,
    })
      .from(surgeRules)
      .where(and(
        eq(surgeRules.cityId, args.cityId),
        eq(surgeRules.date, args.date),
        or(eq(surgeRules.ritualId, args.ritualId), isNull(surgeRules.ritualId)),
      ))
      // ritual-specific first
      .orderBy(sql`${surgeRules.ritualId} NULLS LAST`);

    return rows[0]?.multiplierBps ?? 10_000;
  }

  async quote(args: {
    panditId: string;
    ritualId: string;
    cityId: string;
    date: IsoDate;
    samagriOption: SamagriOption;
    paymentMode: PaymentMode;
    travelFeePaise?: number;
    promoDiscountPaise?: number;
  }): Promise<PriceBreakdown> {
    const offered = await this.db.select({ pricePaise: panditRituals.pricePaise })
      .from(panditRituals)
      .where(and(
        eq(panditRituals.panditId, args.panditId),
        eq(panditRituals.ritualId, args.ritualId),
        eq(panditRituals.active, true),
      )).limit(1);

    if (!offered[0]) {
      throw new DomainError(
        ErrorCode.NOT_FOUND, 'this purohit does not offer that ritual',
        { panditId: args.panditId, ritualId: args.ritualId },
      );
    }

    const bomTotal = args.samagriOption === 'pandit_brings'
      ? await this.catalog.bomTotalPaise(args.ritualId)
      : 0;

    const surgeBps = await this.surgeBpsFor({
      cityId: args.cityId, date: args.date, ritualId: args.ritualId,
    });

    return computePrice({
      dakshinaBasePaise: paise(Number(offered[0].pricePaise)),
      bomTotalPaise: paise(bomTotal),
      travelFeePaise: paise(args.travelFeePaise ?? 0),
      surgeBps,
      samagriOption: args.samagriOption,
      paymentMode: args.paymentMode,
      promoDiscountPaise: args.promoDiscountPaise ? paise(args.promoDiscountPaise) : ZERO,
    });
  }
}
