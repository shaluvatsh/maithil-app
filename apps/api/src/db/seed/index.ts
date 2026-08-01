import { ulid } from 'ulid';
import { createDb } from '../client';
import {
  cities, rituals, ritualTranslations, ritualCityPrices, boms, bomItems,
  bomItemTranslations, slotDefs, panchangTerms, notificationTemplates,
} from '../schema/index';
import {
  KOLKATA_RITUALS, BASE_BOM, BOM_ADDITIONS, KOLKATA_SLOT_DEFS,
  type BomItemSeed,
} from './rituals.kolkata';
import { TITHI_TERMS, NAKSHATRA_TERMS } from './panchang-terms';

const LOCALES = ['bn', 'hi', 'en'] as const;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const db = createDb(url);

  console.log('seeding Kolkata...');

  const cityId = ulid();
  await db.insert(cities).values({
    id: cityId,
    slug: 'kolkata',
    name: 'Kolkata',
    tz: 'Asia/Kolkata',
    // The larger share of Kolkata households follow Gupta Press. Default, never a lock.
    defaultPanjikaSchool: 'gupta_press',
  }).onConflictDoNothing();

  for (const s of KOLKATA_SLOT_DEFS) {
    await db.insert(slotDefs).values({
      id: ulid(), cityId, idx: s.idx, startTime: s.start, endTime: s.end,
    }).onConflictDoNothing();
  }

  for (const [i, r] of KOLKATA_RITUALS.entries()) {
    const ritualId = ulid();
    await db.insert(rituals).values({
      id: ritualId,
      slug: r.slug,
      durationMin: r.durationMin,
      defaultSlotSpan: r.slotSpan,
      isMuhuratSensitive: r.muhuratSensitive,
      sortOrder: i,
    });

    for (const locale of LOCALES) {
      await db.insert(ritualTranslations).values({
        ritualId,
        locale,
        name: r.names[locale],
        shortDescription: locale === 'bn' ? r.short.bn : r.short.en,
        description: locale === 'bn' ? r.short.bn : r.short.en,
      });
    }

    await db.insert(ritualCityPrices).values({
      ritualId, cityId,
      bandMinPaise: r.bandMin, bandMaxPaise: r.bandMax, defaultPaise: r.bandDefault,
    });

    const bomId = ulid();
    await db.insert(boms).values({ id: bomId, ritualId, cityId, version: 1, status: 'active' });

    const items: BomItemSeed[] = [...BASE_BOM, ...(BOM_ADDITIONS[r.slug] ?? [])];
    for (const [j, item] of items.entries()) {
      const itemId = ulid();
      await db.insert(bomItems).values({
        id: itemId, bomId, qty: item.qty, unit: item.unit,
        grade: item.grade ?? null, catalogPricePaise: item.price,
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
    ['payout.completed', '₹{{amount}} আপনার অ্যাকাউন্টে পাঠানো হয়েছে।'],
  ];
  for (const [key, body] of templates) {
    await db.insert(notificationTemplates).values({
      id: ulid(), key: key!, locale: 'bn', channel: 'whatsapp', body: body!,
    }).onConflictDoNothing();
  }

  console.log(`seeded ${KOLKATA_RITUALS.length} rituals, ${KOLKATA_SLOT_DEFS.length} slots, ` +
              `${TITHI_TERMS.length + NAKSHATRA_TERMS.length} panchang terms`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
