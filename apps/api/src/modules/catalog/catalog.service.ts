import { eq, and, sql, inArray } from 'drizzle-orm';
import type { Db } from '../../db/client';
import {
  rituals, ritualTranslations, ritualCityPrices, boms, bomItems,
  bomItemTranslations, cities,
} from '../../db/schema/index';
import { RITUAL_CATEGORIES } from '@themaithil/region';
import {
  DomainError, ErrorCode, type Locale,
  type RitualSummary, type RitualDetail,
} from '@themaithil/contracts';

export class CatalogService {
  constructor(private readonly db: Db) {}

  async cityIdBySlug(slug: string): Promise<string> {
    const rows = await this.db.select({ id: cities.id }).from(cities)
      .where(eq(cities.slug, slug)).limit(1);
    if (!rows[0]) throw new DomainError(ErrorCode.NOT_FOUND, `unknown city: ${slug}`);
    return rows[0].id;
  }

  /** Reverse lookup, so services holding a booking can resolve its region config. */
  async citySlugById(cityId: string): Promise<string> {
    const rows = await this.db.select({ slug: cities.slug }).from(cities)
      .where(eq(cities.id, cityId)).limit(1);
    if (!rows[0]) throw new DomainError(ErrorCode.NOT_FOUND, `unknown city id: ${cityId}`);
    return rows[0].slug;
  }

  /**
   * Localised ritual list with the BOM total precomputed.
   *
   * Bengali is the primary locale and is required at seed time; hi/en fall back to
   * it rather than showing an empty string. See ADR 0009.
   */
  async listRituals(args: {
    citySlug: string; locale: Locale; category?: string | undefined;
  }): Promise<RitualSummary[]> {
    const cityId = await this.cityIdBySlug(args.citySlug);

    const bomTotals = this.db.$with('bom_totals').as(
      this.db.select({
        ritualId: boms.ritualId,
        total: sql<number>`COALESCE(SUM(${bomItems.linePricePaise}), 0)::bigint`
          .as('total'),
      })
      .from(boms)
      .leftJoin(bomItems, eq(bomItems.bomId, boms.id))
      .where(eq(boms.status, 'active'))
      .groupBy(boms.ritualId),
    );

    const rows = await this.db.with(bomTotals)
      .select({
        id: rituals.id,
        slug: rituals.slug,
        durationMin: rituals.durationMin,
        defaultSlotSpan: rituals.defaultSlotSpan,
        isMuhuratSensitive: rituals.isMuhuratSensitive,
        category: rituals.category,
        deliveryMode: rituals.deliveryMode,
        name: sql<string>`COALESCE(${ritualTranslations.name}, fallback.name)`,
        shortDescription:
          sql<string>`COALESCE(${ritualTranslations.shortDescription}, fallback.short_description)`,
        bandMin: ritualCityPrices.bandMinPaise,
        bandMax: ritualCityPrices.bandMaxPaise,
        bandDefault: ritualCityPrices.defaultPaise,
        bomTotal: sql<number>`COALESCE(bom_totals.total, 0)::bigint`,
      })
      .from(rituals)
      .innerJoin(ritualCityPrices, and(
        eq(ritualCityPrices.ritualId, rituals.id),
        eq(ritualCityPrices.cityId, cityId),
      ))
      .leftJoin(ritualTranslations, and(
        eq(ritualTranslations.ritualId, rituals.id),
        eq(ritualTranslations.locale, args.locale),
      ))
      .leftJoin(
        sql`ritual_translations AS fallback`,
        sql`fallback.ritual_id = ${rituals.id} AND fallback.locale = 'bn'`,
      )
      .leftJoin(bomTotals, eq(bomTotals.ritualId, rituals.id))
      .where(args.category
        ? and(eq(rituals.active, true), eq(rituals.category, args.category))
        : eq(rituals.active, true))
      .orderBy(rituals.sortOrder);

    return rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      shortDescription: r.shortDescription,
      durationMin: r.durationMin,
      defaultSlotSpan: r.defaultSlotSpan,
      isMuhuratSensitive: r.isMuhuratSensitive,
      category: r.category,
      deliveryMode: r.deliveryMode,
      priceBand: {
        minPaise: Number(r.bandMin),
        maxPaise: Number(r.bandMax),
        defaultPaise: Number(r.bandDefault),
      },
      bomTotalPaise: Number(r.bomTotal),
    }));
  }

  /**
   * Categories with live counts, so a tile never promises a section that turns out
   * to be empty — and an empty category is visible to us rather than to a devotee.
   */
  async categories(citySlug: string) {
    const cityId = await this.cityIdBySlug(citySlug);
    const rows = await this.db
      .select({ category: rituals.category, count: sql<number>`count(*)::int` })
      .from(rituals)
      .innerJoin(ritualCityPrices, and(
        eq(ritualCityPrices.ritualId, rituals.id),
        eq(ritualCityPrices.cityId, cityId),
      ))
      .where(eq(rituals.active, true))
      .groupBy(rituals.category);

    const counts = new Map(rows.map((r) => [r.category, Number(r.count)]));
    return [...RITUAL_CATEGORIES]
      .sort((a, b) => a.order - b.order)
      .map((c) => ({
        id: c.id, en: c.en, blurb: c.blurb, emoji: c.emoji, tint: c.tint,
        count: counts.get(c.id) ?? 0,
      }))
      .filter((c) => c.count > 0);
  }

  async getRitual(args: {
    slug: string; citySlug: string; locale: Locale;
  }): Promise<RitualDetail> {
    const list = await this.listRituals({ citySlug: args.citySlug, locale: args.locale });
    const summary = list.find((r) => r.slug === args.slug);
    if (!summary) throw new DomainError(ErrorCode.NOT_FOUND, `unknown ritual: ${args.slug}`);

    const bom = await this.bomFor(summary.id, args.locale);
    return { ...summary, description: summary.shortDescription, bom, locale: args.locale };
  }

  /** The BOM as the devotee sees it, localised. Also the input to samagri pricing. */
  async bomFor(ritualId: string, locale: Locale) {
    const bomRow = await this.db.select({ id: boms.id }).from(boms)
      .where(and(eq(boms.ritualId, ritualId), eq(boms.status, 'active')))
      .orderBy(sql`${boms.version} DESC`).limit(1);
    if (!bomRow[0]) return [];

    const rows = await this.db.select({
      id: bomItems.id,
      qty: bomItems.qty,
      unit: bomItems.unit,
      grade: bomItems.grade,
      linePricePaise: bomItems.linePricePaise,
      perishable: bomItems.perishable,
      name: sql<string>`COALESCE(${bomItemTranslations.name}, fb.name)`,
    })
      .from(bomItems)
      .leftJoin(bomItemTranslations, and(
        eq(bomItemTranslations.bomItemId, bomItems.id),
        eq(bomItemTranslations.locale, locale),
      ))
      .leftJoin(
        sql`bom_item_translations AS fb`,
        sql`fb.bom_item_id = ${bomItems.id} AND fb.locale = 'bn'`,
      )
      .where(eq(bomItems.bomId, bomRow[0].id))
      .orderBy(bomItems.sortOrder);

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      qty: r.qty,
      unit: r.unit,
      grade: r.grade,
      linePricePaise: Number(r.linePricePaise),
      perishable: r.perishable,
    }));
  }

  /** Sum of BOM lines at catalogue rates. Feeds computePrice(). */
  async bomTotalPaise(ritualId: string): Promise<number> {
    const rows = await this.db.select({
      total: sql<string>`COALESCE(SUM(${bomItems.linePricePaise}), 0)`,
    })
      .from(boms)
      .leftJoin(bomItems, eq(bomItems.bomId, boms.id))
      .where(and(eq(boms.ritualId, ritualId), eq(boms.status, 'active')));
    return Math.round(Number(rows[0]?.total ?? 0));
  }
}
