import '../../common/load-env';
import { sep } from 'node:path';
import { ulid } from 'ulid';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '../client';
import {
  cities, rituals, ritualTranslations, ritualCityPrices, boms, bomItems,
  bomItemTranslations, slotDefs, panchangTerms, notificationTemplates,
  membershipPlans,
} from '../schema/index';
import {
  KOLKATA_RITUALS, samagriKitFor, BOM_ADDITIONS,
  type BomItemSeed,
} from './rituals.kolkata';
import { TITHI_TERMS, NAKSHATRA_TERMS } from './panchang-terms';
import { allRegions, categoryFor } from '@themaithil/region';

const LOCALES = ['bn', 'hi', 'en'] as const;

/**
 * The seed, as a function taking a Db.
 *
 * Extracted so the integration tests run the ACTUAL seed instead of a copy of it —
 * the two bugs that shipped (non-rerunnable rituals, prices for one city only) were
 * both in here, and nothing tested this file.
 */
export async function seedDatabase(db: Db) {

  // Every active region gets a city row and its own slot shape. Bengaluru has five
  // slots opening at brahma muhurta; Kolkata has four. Seeding from config is what
  // makes "add a city" a config change.
  let cityId = '';
  const activeCities = allRegions().filter((r) => r.active);
  const cityIdBySlug = new Map<string, string>();
  for (const region of activeCities) {
    const id = ulid();
    await db.insert(cities).values({
      id,
      slug: region.slug,
      name: region.name.en,
      tz: region.timezone,
      defaultPanjikaSchool:
        (['gupta_press', 'bisuddha_siddhanta', 'mithila'] as const)
          .includes(region.defaultPanjika as never)
          ? (region.defaultPanjika as 'gupta_press' | 'bisuddha_siddhanta' | 'mithila')
          : 'gupta_press',
    }).onConflictDoNothing();

    const row = (await db.select({ id: cities.id }).from(cities)
      .where(eq(cities.slug, region.slug)).limit(1))[0];
    const resolved = row?.id ?? id;
    cityIdBySlug.set(region.slug, resolved);
    if (region.slug === (process.env.LAUNCH_CITY_SLUG ?? 'kolkata')) cityId = resolved;

    for (const s of region.slots) {
      await db.insert(slotDefs).values({
        id: ulid(), cityId: resolved, idx: s.idx, startTime: s.start, endTime: s.end,
      }).onConflictDoNothing();
    }
  }
  if (!cityId) throw new Error('launch city not found among active regions');

  for (const [i, r] of KOLKATA_RITUALS.entries()) {
    /**
     * Upsert, not insert.
     *
     * A plain insert throws on the second run because `slug` is unique, so the seed
     * could never apply a change to an existing catalogue - which is exactly why the
     * new `category` column kept its default and every category looked identical.
     */
    const inserted = await db.insert(rituals).values({
      id: ulid(),
      slug: r.slug,
      durationMin: r.durationMin,
      defaultSlotSpan: r.slotSpan,
      isMuhuratSensitive: r.muhuratSensitive,
      category: categoryFor(r.slug),
      deliveryMode: r.deliveryMode ?? 'at_home',
      sortOrder: i,
    }).onConflictDoUpdate({
      target: rituals.slug,
      set: {
        durationMin: r.durationMin,
        defaultSlotSpan: r.slotSpan,
        isMuhuratSensitive: r.muhuratSensitive,
        category: categoryFor(r.slug),
        deliveryMode: r.deliveryMode ?? 'at_home',
        sortOrder: i,
      },
    }).returning({ id: rituals.id });
    const ritualId = inserted[0]!.id;

    for (const locale of LOCALES) {
      await db.insert(ritualTranslations).values({
        ritualId,
        locale,
        name: r.names[locale],
        shortDescription: locale === 'bn' ? r.short.bn : r.short.en,
        description: locale === 'bn' ? r.short.bn : r.short.en,
      }).onConflictDoUpdate({
        target: [ritualTranslations.ritualId, ritualTranslations.locale],
        set: {
          name: r.names[locale],
          shortDescription: locale === 'bn' ? r.short.bn : r.short.en,
        },
      });
    }

    /**
     * Priced in EVERY active city.
     *
     * `listRituals` inner-joins on the price row, so pricing only the launch city
     * meant every other city returned an empty catalogue. The service list is
     * national and identical; only the price index differs.
     */
    for (const region of activeCities) {
      const scale = region.priceIndexBps / 10000;
      const round = (paise: number) => Math.round((paise * scale) / 100) * 100;
      await db.insert(ritualCityPrices).values({
        ritualId,
        cityId: cityIdBySlug.get(region.slug)!,
        bandMinPaise: round(r.bandMin),
        bandMaxPaise: round(r.bandMax),
        defaultPaise: round(r.bandDefault),
      }).onConflictDoUpdate({
        target: [ritualCityPrices.ritualId, ritualCityPrices.cityId],
        set: {
          bandMinPaise: round(r.bandMin),
          bandMaxPaise: round(r.bandMax),
          defaultPaise: round(r.bandDefault),
        },
      });
    }

    // A remote service has no materials: nobody carries samagri down a video call.
    // Seeding a BOM would put a samagri line on the bill for a puja with no venue.
    if ((r.deliveryMode ?? 'at_home') === 'virtual') continue;

    // A BOM already exists on re-run; reuse it rather than stacking duplicates.
    const existingBom = (await db.select({ id: boms.id }).from(boms)
      .where(eq(boms.ritualId, ritualId)).limit(1))[0];
    const bomId = existingBom?.id ?? ulid();
    if (!existingBom) {
      await db.insert(boms).values({ id: bomId, ritualId, cityId, version: 1, status: 'active' });
    }

    // The kit is chosen by the ritual's scale, not shared by all of them. A tarpan
    // took the same 13 items as a wedding, so its materials cost twice its dakshina.
    const items: BomItemSeed[] = [
      ...samagriKitFor(r.slug, r.deliveryMode),
      ...(BOM_ADDITIONS[r.slug] ?? []),
    ];
    if (existingBom) continue;                 // items already seeded for this ritual
    for (const [j, item] of items.entries()) {
      const itemId = ulid();
      await db.insert(bomItems).values({
        id: itemId, bomId, qty: item.qty, unit: item.unit,
        grade: item.grade ?? null, linePricePaise: item.price,
        perishable: item.perishable ?? false, sortOrder: j,
      });
      for (const locale of LOCALES) {
        await db.insert(bomItemTranslations).values({
          bomItemId: itemId, locale, name: item.names[locale],
        });
      }
    }
  }

  for (const t of [...TITHI_TERMS, ...NAKSHATRA_TERMS]) {
    for (const locale of LOCALES) {
      await db.insert(panchangTerms)
        .values({ valueKey: t.key, locale, label: t[locale] })
        .onConflictDoNothing();
    }
  }

  // Critical WhatsApp templates. Provider names stay null until BSP approval lands
  // (1-2 weeks per batch - this is why it is a week-1 procurement item, see ADR 0008).
  const templates = [
    ['booking.confirmed.devotee', 'আপনার {{ritual}} বুকিং নিশ্চিত হয়েছে। পুরোহিত: {{pandit}}, {{date}} {{slot}}।'],
    ['booking.confirmed.pandit', 'নতুন বুকিং: {{ritual}}, {{date}} {{slot}}, {{area}}। প্রাপ্য: ₹{{amount}}।'],
    ['booking.reminder.t1', 'আগামীকাল {{slot}} সময়ে {{ritual}}। পুরোহিত {{pandit}} আসছেন।'],
    ['booking.otp.start', 'পূজা শুরুর OTP: {{otp}}। পুরোহিতকে জানান।'],
    ['booking.otp.complete', 'সমাপ্তির OTP: {{otp}}। নগদ দেয়: ₹{{amount}}।'],
    // Neither of these existed, so when a purohit dropped out the devotee was told
    // nothing at all — they found out by opening the app, or at the door.
    ['booking.pandit_changed.devotee',
      'আপনার {{ritual}} ({{date}} {{slot}}) এর জন্য নতুন পুরোহিত: {{pandit}}। '
      + 'সময় ও মূল্য অপরিবর্তিত।'],
    ['booking.cancelled.devotee',
      'দুঃখিত — {{date}} {{slot}} এর {{ritual}} বুকিং বাতিল হয়েছে। '
      + 'সম্পূর্ণ টাকা ফেরত দেওয়া হচ্ছে। আমরা শীঘ্রই যোগাযোগ করব।'],
    ['payout.completed', '₹{{amount}} আপনার অ্যাকাউন্টে পাঠানো হয়েছে।'],
  ];
  for (const [key, body] of templates) {
    await db.insert(notificationTemplates).values({
      id: ulid(), key: key!, locale: 'bn', channel: 'whatsapp', body: body!,
    }).onConflictDoNothing();
  }

  /**
   * One membership plan.
   *
   * The home page used to advertise this with eight literal numbers written into
   * JSX — a price, a discount, a saving and a countdown, none of them connected to
   * anything a customer could buy. Priced here so the page can only ever render
   * what the database says, and so the offer disappears when the row does.
   *
   * ₹1,499 for a year against a ~12% discount: a household booking two festival
   * poojas a year is roughly break-even, three is clearly ahead. A plan that
   * cannot pay for itself at realistic usage is churn bought at full price.
   */
  const offerEnds = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
  await db.insert(membershipPlans).values({
    id: ulid(),
    slug: 'family-year',
    name: 'Family Membership',
    tagline: 'A year of priority booking and member pricing',
    pricePaise: 149_900,
    durationDays: 365,
    discountBps: 1200,
    benefits: [
      '12% off the pandit\u2019s dakshina on every booking',
      'Priority allocation during Durga Puja and Diwali',
      'Free rescheduling up to 24 hours before',
      'Samagri kit delivered the evening before, not the morning of',
    ],
    offerEndsOn: offerEnds,
    active: true,
  }).onConflictDoNothing();

  return {
    rituals: KOLKATA_RITUALS.length,
    cities: activeCities.length,
    terms: TITHI_TERMS.length + NAKSHATRA_TERMS.length,
  };
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set - run `pnpm db:migrate` first for details');
  const res = await seedDatabase(createDb(url));
  console.log(
    `seeded ${res.rituals} rituals priced in ${res.cities} cities, ${res.terms} panchang terms`,
  );
  process.exit(0);
}

/**
 * Only run when invoked as a script. Without this guard, importing `seedDatabase`
 * from a test executes the CLI path and calls process.exit, killing the runner.
 */
const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].includes(`db${sep}seed`);
if (invokedDirectly) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
