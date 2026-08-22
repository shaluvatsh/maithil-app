import { eq, and, inArray, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import {
  membershipPlans, membershipCityPrices, rituals, ritualTranslations,
  ritualCityPrices, cities,
} from '../../db/schema/index';

/**
 * The home page offer, computed rather than written.
 *
 * It used to be eight literals in JSX: "18% OFF", "save up to ₹2,099", "Festival +
 * Membership from ₹11,498", "Bundle from ₹9,399", "145 days left", and a list of
 * three named poojas. None of it was connected to anything. The rituals named were
 * not the ones in the Kolkata catalogue, the "from" price did not match any
 * ritual's price band, the saving was not the difference between the two numbers
 * shown, and the countdown had no end date to count towards.
 *
 * That is worse than a placeholder. A price on a page is a representation, and
 * under the Consumer Protection Act 2019 an advertised saving that cannot be
 * realised is a misleading advertisement regardless of intent.
 *
 * So: the plan comes from a row, the bundle is summed from the same
 * `ritual_city_prices` the booking flow charges from, and the saving is arithmetic
 * on those two numbers. If the numbers cannot be produced, the endpoint returns
 * null and the page renders no offer at all.
 */
export interface FestivalBundle {
  rituals: Array<{ slug: string; name: string; pricePaise: number }>;
  /** What these rituals cost booked one at a time, at catalogue price. */
  listPaise: number;
  /** What a member pays for the same rituals. */
  memberPaise: number;
  savingPaise: number;
}

export class OffersService {
  constructor(private readonly db: Db) {}

  /** The one live plan for a city, or null. Never a default, never a guess. */
  async current(citySlug: string, locale = 'en') {
    const city = (await this.db.select({ id: cities.id }).from(cities)
      .where(eq(cities.slug, citySlug)).limit(1))[0];
    if (!city) return null;

    const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

    const [plan] = await this.db.select().from(membershipPlans)
      .where(and(
        eq(membershipPlans.active, true),
        // An expired offer is not an offer. Filtered in SQL so a stale row can
        // never reach the page through a forgotten client-side check.
        sql`(${membershipPlans.offerEndsOn} IS NULL OR ${membershipPlans.offerEndsOn} >= ${today})`,
      ))
      .orderBy(membershipPlans.pricePaise)
      .limit(1);
    if (!plan) return null;

    // City override wins; the plan's own price is the national fallback.
    const [override] = await this.db.select({ price: membershipCityPrices.pricePaise })
      .from(membershipCityPrices)
      .where(and(
        eq(membershipCityPrices.planId, plan.id),
        eq(membershipCityPrices.cityId, city.id),
      )).limit(1);

    const pricePaise = override?.price ?? plan.pricePaise;
    const bundle = await this.festivalBundle(city.id, plan.discountBps, locale);

    const daysLeft = plan.offerEndsOn
      ? Math.max(0, Math.round(
          (Date.parse(`${plan.offerEndsOn}T00:00:00+05:30`)
            - Date.parse(`${today}T00:00:00+05:30`)) / 86_400_000))
      : null;

    return {
      slug: plan.slug,
      name: plan.name,
      tagline: plan.tagline,
      pricePaise,
      durationDays: plan.durationDays,
      discountBps: plan.discountBps,
      benefits: plan.benefits,
      offerEndsOn: plan.offerEndsOn,
      // The UI must not offer a purchase the platform cannot complete.
      purchasable: plan.purchasable,
      daysLeft,
      bundle,
      /**
       * The honest headline: what a member saves on the bundle, minus what the
       * membership costs. Advertising the gross discount while charging separately
       * for the membership is the trick this field exists to refuse.
       */
      netSavingPaise: bundle ? bundle.savingPaise - pricePaise : null,
    };
  }

  /**
   * The festival rituals this city actually sells, at the prices it actually
   * charges. Returns null rather than an empty bundle — "save ₹0 on 0 poojas" is
   * not a smaller offer, it is a broken one.
   */
  private async festivalBundle(
    cityId: string, discountBps: number, locale: string,
  ): Promise<FestivalBundle | null> {
    const rows = await this.db.select({
      slug: rituals.slug,
      price: ritualCityPrices.defaultPaise,
    })
      .from(rituals)
      .innerJoin(ritualCityPrices, and(
        eq(ritualCityPrices.ritualId, rituals.id),
        eq(ritualCityPrices.cityId, cityId),
      ))
      .where(and(
        eq(rituals.active, true),
        eq(rituals.category, 'festival-pujas'),
        eq(rituals.deliveryMode, 'at_home'),
      ))
      .orderBy(rituals.sortOrder)
      .limit(6);

    if (rows.length < 2) return null;

    const names = await this.names(rows.map((r) => r.slug), locale);
    const items = rows.map((r) => ({
      slug: r.slug,
      name: names.get(r.slug) ?? r.slug,
      pricePaise: Number(r.price),
    }));

    const listPaise = items.reduce((sum, r) => sum + r.pricePaise, 0);
    // Rounded to the rupee, down, so the advertised member price is never lower
    // than what the checkout will actually charge.
    const memberPaise = Math.ceil(listPaise * (1 - discountBps / 10_000) / 100) * 100;

    return { rituals: items, listPaise, memberPaise, savingPaise: listPaise - memberPaise };
  }

  /**
   * Display names live in the translation table, keyed by slug.
   *
   * One query with `inArray`, not one per ritual — six round trips to render one
   * card is the kind of thing that is invisible at six and fatal at sixty.
   */
  private async names(slugs: string[], locale: string): Promise<Map<string, string>> {
    if (slugs.length === 0) return new Map();
    const rows = await this.db.select({
      slug: rituals.slug, name: ritualTranslations.name,
    })
      .from(rituals)
      .leftJoin(ritualTranslations, and(
        eq(ritualTranslations.ritualId, rituals.id),
        eq(ritualTranslations.locale, locale as never),
      ))
      .where(inArray(rituals.slug, slugs));

    return new Map(rows.map((r) => [r.slug, r.name ?? r.slug]));
  }
}
