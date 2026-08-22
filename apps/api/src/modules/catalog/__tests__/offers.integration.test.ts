import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ulid } from 'ulid';
import { eq } from 'drizzle-orm';
import { makeHarness, type Harness } from '../../../test/harness';
import {
  membershipPlans, membershipCityPrices, cities, rituals, ritualTranslations,
  ritualCityPrices,
} from '../../../db/schema/index';
import { OffersService } from '../offers.service';

let h: Harness;
let offers: OffersService;

const plan = (over: Partial<typeof membershipPlans.$inferInsert> = {}) => ({
  id: ulid(), slug: 'family-year', name: 'Family Membership',
  tagline: 'A year of member pricing', pricePaise: 149_900,
  durationDays: 365, discountBps: 1200,
  benefits: ['12% off dakshina'], offerEndsOn: null, active: true, ...over,
});

beforeEach(async () => {
  h = await makeHarness();
  offers = new OffersService(h.db);
}, 60_000);
afterEach(async () => { await h?.pg.close(); });

/**
 * The home page advertised a membership with a price, a discount, a saving and a
 * countdown, all eight numbers written as string literals into a React component.
 * Nobody could buy it and the countdown counted towards no date. An advertised
 * saving that cannot be realised is a misleading advertisement regardless of
 * intent, so the rule here is simple: no row, no offer.
 */
describe('the current offer', () => {
  it('is null when no plan exists, rather than a default', async () => {
    expect(await offers.current('kolkata')).toBeNull();
  });

  it('is null for a city we do not serve', async () => {
    await h.db.insert(membershipPlans).values(plan());
    expect(await offers.current('atlantis')).toBeNull();
  });

  it('is null for an inactive plan', async () => {
    await h.db.insert(membershipPlans).values(plan({ active: false }));
    expect(await offers.current('kolkata')).toBeNull();
  });

  /** Filtered in SQL, so a stale row cannot reach the page past a forgotten check. */
  it('is null once the offer has expired', async () => {
    await h.db.insert(membershipPlans).values(plan({ offerEndsOn: '2020-01-01' }));
    expect(await offers.current('kolkata')).toBeNull();
  });

  it('returns the plan, priced, when one is live', async () => {
    await h.db.insert(membershipPlans).values(plan());
    const res = (await offers.current('kolkata'))!;

    expect(res.name).toBe('Family Membership');
    expect(res.pricePaise).toBe(149_900);
    expect(res.discountBps).toBe(1200);
    expect(res.benefits).toEqual(['12% off dakshina']);
  });

  it('prefers the city price over the national one', async () => {
    const p = plan();
    await h.db.insert(membershipPlans).values(p);
    const [city] = await h.db.select({ id: cities.id }).from(cities)
      .where(eq(cities.slug, 'kolkata')).limit(1);
    await h.db.insert(membershipCityPrices).values({
      planId: p.id, cityId: city!.id, pricePaise: 99_900,
    });

    expect((await offers.current('kolkata'))!.pricePaise).toBe(99_900);
  });

  it('counts the days left from the offer end date', async () => {
    const in30 = new Date(Date.now() + 30 * 86_400_000 + 5.5 * 3600_000)
      .toISOString().slice(0, 10);
    await h.db.insert(membershipPlans).values(plan({ offerEndsOn: in30 }));

    const res = (await offers.current('kolkata'))!;
    expect(res.daysLeft).toBeGreaterThanOrEqual(29);
    expect(res.daysLeft).toBeLessThanOrEqual(30);
  });

  it('has no countdown when the offer does not end', async () => {
    await h.db.insert(membershipPlans).values(plan());
    expect((await offers.current('kolkata'))!.daysLeft).toBeNull();
  });
});

/**
 * The bundle is summed from `ritual_city_prices` — the same table the booking flow
 * charges from — so the advertised list price cannot drift from what a devotee is
 * actually asked to pay.
 */
describe('the festival bundle', () => {
  /**
   * The harness seeds one ritual, in Bengali only. The bundle needs at least two
   * priced festival pujas to be a bundle at all, and it needs English names to
   * quote — so the test builds the situation it is asserting about rather than
   * relying on whatever the fixture happens to contain.
   */
  beforeEach(async () => {
    await h.db.insert(membershipPlans).values(plan());

    const [city] = await h.db.select({ id: cities.id }).from(cities)
      .where(eq(cities.slug, 'kolkata')).limit(1);

    const extra = [
      { slug: 'durga-puja-ghot', name: 'Durga Puja Ghot', price: 250_000 },
      { slug: 'kali-puja', name: 'Kali Puja', price: 180_000 },
    ];
    for (const r of extra) {
      const id = ulid();
      await h.db.insert(rituals).values({
        id, slug: r.slug, durationMin: 180, defaultSlotSpan: 1,
        category: 'festival-pujas', deliveryMode: 'at_home',
      });
      await h.db.insert(ritualTranslations).values({
        ritualId: id, locale: 'en', name: r.name,
        shortDescription: r.name, description: r.name,
      });
      await h.db.insert(ritualCityPrices).values({
        ritualId: id, cityId: city!.id,
        bandMinPaise: r.price, bandMaxPaise: r.price * 2, defaultPaise: r.price,
      });
    }
  });

  it('prices from the catalogue rather than from copy', async () => {
    const res = (await offers.current('kolkata'))!;
    expect(res.bundle).not.toBeNull();

    const summed = res.bundle!.rituals.reduce((s, r) => s + r.pricePaise, 0);
    expect(res.bundle!.listPaise, 'the list price is not the sum of its parts')
      .toBe(summed);
  });

  it('applies the plan discount, and the saving is the difference', async () => {
    const { bundle } = (await offers.current('kolkata'))!;
    expect(bundle!.memberPaise).toBeLessThan(bundle!.listPaise);
    expect(bundle!.savingPaise).toBe(bundle!.listPaise - bundle!.memberPaise);

    // Within a rupee of 12%, allowing for the rounding up to whole rupees.
    const applied = bundle!.savingPaise / bundle!.listPaise;
    expect(applied).toBeGreaterThan(0.115);
    expect(applied).toBeLessThanOrEqual(0.12);
  });

  /** Rounded up, so the advertised member price is never below what is charged. */
  it('never advertises a price the checkout will exceed', async () => {
    const { bundle } = (await offers.current('kolkata'))!;
    const exact = bundle!.listPaise * (1 - 1200 / 10_000);
    expect(bundle!.memberPaise).toBeGreaterThanOrEqual(exact);
  });

  it('states the saving net of the membership itself', async () => {
    const res = (await offers.current('kolkata'))!;
    expect(res.netSavingPaise).toBe(res.bundle!.savingPaise - res.pricePaise);
  });

  it('names every ritual it priced, so the claim can be checked', async () => {
    const { bundle } = (await offers.current('kolkata'))!;
    expect(bundle!.rituals.length).toBeGreaterThanOrEqual(2);
    for (const r of bundle!.rituals) {
      expect(r.name).toBeTruthy();
      // Resolved through ritual_translations, not echoed back as the slug.
      if (r.slug !== 'satyanarayan-puja') expect(r.name).not.toBe(r.slug);
      expect(r.pricePaise).toBeGreaterThan(0);
    }
  });
});


/**
 * `active` means "show this offer". It does not mean "money can change hands for
 * it", and today those differ: the membership has a price and a discount, but
 * nothing charges for it and nothing applies the discount at booking time. A Join
 * button wired to an unpurchasable plan takes ₹1,499 for a benefit the pricing
 * engine never grants.
 */
describe('a plan is not purchasable until it is', () => {
  it('defaults to not purchasable, so the button cannot appear by accident', async () => {
    await h.db.insert(membershipPlans).values(plan());
    expect((await offers.current('kolkata'))!.purchasable).toBe(false);
  });

  it('reports it once it is switched on deliberately', async () => {
    await h.db.insert(membershipPlans).values(plan({ purchasable: true }));
    expect((await offers.current('kolkata'))!.purchasable).toBe(true);
  });

  it('is independent of whether the offer is shown at all', async () => {
    await h.db.insert(membershipPlans).values(plan({ active: false, purchasable: true }));
    // Still hidden: purchasable does not resurrect an inactive plan.
    expect(await offers.current('kolkata')).toBeNull();
  });
});
