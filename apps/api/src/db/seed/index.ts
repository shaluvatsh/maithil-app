import '../../common/load-env';
import { sep } from 'node:path';
import { ulid } from 'ulid';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '../client';
import {
  cities, rituals, ritualTranslations, ritualCityPrices, boms, bomItems,
  bomItemTranslations, slotDefs, panchangTerms, notificationTemplates,
  membershipPlans, communitySpaces,
} from '../schema/index';
import {
  KOLKATA_RITUALS, samagriKitFor, BOM_ADDITIONS,
  type BomItemSeed,
} from './rituals.kolkata';
import { TITHI_TERMS, NAKSHATRA_TERMS } from './panchang-terms';
import { allRegions, categoryFor } from '@themaithil/region';
import {
  citySpaceSlug, ritualSpaceSlug, DEFAULT_SPACE_SLUG, type Locale,
} from '@themaithil/contracts';

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
      days: r.days ?? 1,
      sortOrder: i,
    }).onConflictDoUpdate({
      target: rituals.slug,
      set: {
        durationMin: r.durationMin,
        defaultSlotSpan: r.slotSpan,
        isMuhuratSensitive: r.muhuratSensitive,
        category: categoryFor(r.slug),
        deliveryMode: r.deliveryMode ?? 'at_home',
        days: r.days ?? 1,
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

    /*
     * Skip when the kit is EMPTY, not when the service is remote.
     *
     * This used to skip every virtual ritual outright, reasoning that nobody
     * carries samagri down a video call. True — but it conflated "there is no
     * samagri" with "we do not supply the samagri". A video consultation is the
     * first: it needs nothing. An online aarti is the second: the devotee still
     * lights a lamp and offers a flower at their own end, and with no BOM they were
     * never told what to have ready. Nothing is billed either way, because a
     * virtual booking sends `samagriOption: 'none'` and that prices samagri at zero
     * — the list exists to inform the family, not to charge them.
     */
    const kit: BomItemSeed[] = [
      ...samagriKitFor(r.slug, r.deliveryMode),
      ...(BOM_ADDITIONS[r.slug] ?? []),
    ];
    if (kit.length === 0) continue;

    // A BOM already exists on re-run; reuse it rather than stacking duplicates.
    const existingBom = (await db.select({ id: boms.id }).from(boms)
      .where(eq(boms.ritualId, ritualId)).limit(1))[0];
    const bomId = existingBom?.id ?? ulid();
    if (!existingBom) {
      await db.insert(boms).values({ id: bomId, ritualId, cityId, version: 1, status: 'active' });
    }

    // The kit is chosen by the ritual's scale, not shared by all of them. A tarpan
    // took the same 13 items as a wedding, so its materials cost twice its dakshina.
    const items = kit;
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
    /*
     * The login code. Nothing sent one, so outside development every sign-in ended
     * at a screen asking for six digits that had been delivered nowhere.
     *
     * The digits lead, because on a phone the notification preview is often all
     * anyone reads, and the warning is there because a code arriving unrequested is
     * the shape every OTP scam takes.
     */
    /*
     * Verification outcomes. Nothing told the purohit any of these — the decision was
     * written to the database and no message left the building.
     */
    ['pandit.kyc.verified',
      'অভিনন্দন! আপনার TheMaithil প্রোফাইল যাচাই হয়েছে। '
      + 'এখন থেকে ভক্তরা আপনাকে দেখতে ও বুক করতে পারবেন।'],
    ['pandit.kyc.changes_requested',
      'আপনার একটি নথি আবার দরকার: {{reason}}। '
      + 'অ্যাপে গিয়ে সেটি আপলোড করুন — বাকি নথি আবার পাঠাতে হবে না।'],
    ['pandit.kyc.rejected',
      'দুঃখিত, এই মুহূর্তে আপনার প্রোফাইল অনুমোদন করা যায়নি। কারণ: {{reason}}।'],
    /*
     * Only ONE template for the assistant.
     *
     * Its replies do not need one: they go out inside the 24-hour window the person
     * opened by messaging us, where WhatsApp permits free-form text. The passthrough
     * `{{text}}` template that used to sit here would have needed BSP approval to say
     * something a person was already waiting to read — and a template whose whole body
     * is a variable is one some BSPs refuse outright.
     *
     * This one does need approving, because it goes to someone with no account, so
     * there is no window and nothing they are waiting for.
     */
    ['assistant.unknown_number',
      'নমস্কার! এই নম্বরটি TheMaithil-এ নিবন্ধিত নয়। '
      + 'পূজা বুক করতে themaithil.in-এ গিয়ে সাইন আপ করুন।'],
    ['auth.otp',
      'TheMaithil লগইন কোড: {{otp}}। {{minutes}} মিনিটের জন্য বৈধ। '
      + 'কেউ চাইলে এই কোড শেয়ার করবেন না।'],
    /*
     * The anniversary nudge.
     *
     * `GET /v1/me/anniversaries` has computed "you did this last year and the tithi
     * is coming round" since it was written, and nothing ever sent it — so the most
     * predictable demand in the business depended on a family opening the site,
     * unprompted, in the right fortnight. This is the message `AnniversaryJob` sends.
     *
     * Deliberately says what they did and nothing about a price. It is a reminder
     * from the people who performed their puja last year, not an offer.
     */
    ['booking.anniversary',
      'গত বছর আপনার বাড়িতে {{ritual}} হয়েছিল। এবারের তিথি এগিয়ে আসছে — '
      + 'themaithil.in-এ দেখে নিন কোন দিন পড়ছে।'],
    /*
     * The join link for a remote puja.
     *
     * The catalogue has sold `online-aarti` and `virtual-consultation` since it was
     * seeded with no video anywhere in the system. A link the devotee is never told
     * about is the same as no link, so this message IS the delivery.
     */
    ['booking.join_link.devotee',
      'আপনার অনলাইন পূজার লিঙ্ক এসে গেছে: {{link}} — নির্ধারিত সময়ে এখানে যোগ দিন।'],
    /*
     * Asking the purohit for the link, at the moment the money lands.
     *
     * A remote puja is delivered entirely over video, so this link IS the delivery —
     * and nothing asked for it. The purohit had a field on a dashboard they may
     * never open, while the devotee had a paid booking and no way to join it.
     */
    ['booking.join_link.needed.pandit',
      '{{ritual}} বুক হয়েছে — {{date}}, {{slot}}। এটি অনলাইনে হবে, তাই অ্যাপে গিয়ে '
      + 'আপনার ভিডিও লিঙ্কটি দিন। লিঙ্ক ছাড়া ভক্ত যোগ দিতে পারবেন না।'],
    /** And again, if the day is close and it still has not arrived. */
    ['booking.join_link.chase.pandit',
      'মনে করিয়ে দিচ্ছি: {{ritual}}-এর ভিডিও লিঙ্ক এখনও পাইনি, আর সময় এগিয়ে আসছে। '
      + 'অ্যাপে গিয়ে লিঙ্কটি দিন — নাহলে ভক্ত যোগ দিতে পারবেন না।'],
    /*
     * The start code for a later day of a multi-day puja.
     *
     * Sent on the morning it is needed rather than with the rest at booking: a
     * family handed eight digits for four days at once reads out the wrong one.
     */
    ['booking.series.day.devotee',
      '{{ritual}} — আজ {{total}} দিনের মধ্যে {{day}}তম দিন। শুরু করার কোড: {{otp}}। '
      + 'পুরোহিতকে এই কোডটি বলুন।'],
    /** The recording, once it is up. For a puja nobody attended, this is the proof. */
    ['booking.recording.devotee',
      'আপনার পূজার রেকর্ডিং তৈরি: {{link}} — যত খুশি দেখুন, পরিবারকেও পাঠান।'],
  ];
  for (const [key, body] of templates) {
    await db.insert(notificationTemplates).values({
      id: ulid(), key: key!, locale: 'bn', channel: 'whatsapp', body: body!,
    }).onConflictDoNothing();
  }

  /*
   * The login code is the one message we send before we know anything about the
   * person — there is no account yet, so there is no stored locale to read. Every
   * other template can be Bengali-first (ADR 0009) because by then we know who we
   * are writing to; this one reaches a stranger, and a Hindi or English speaker
   * being handed a Bengali sign-in code is a needless way to lose them.
   */
  const authOtp: Array<[Locale, string]> = [
    ['hi', 'TheMaithil लॉगिन कोड: {{otp}}। {{minutes}} मिनट तक वैध। '
         + 'यह कोड किसी के साथ साझा न करें।'],
    ['en', 'Your TheMaithil login code is {{otp}}. It expires in {{minutes}} minutes. '
         + 'Do not share it with anyone.'],
  ];
  for (const [locale, body] of authOtp) {
    await db.insert(notificationTemplates).values({
      id: ulid(), key: 'auth.otp', locale, channel: 'whatsapp', body,
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

  /*
   * COMMUNITY SPACES.
   *
   * Every space here is DERIVED — one per active region and one per ritual in the
   * catalogue. There is no list of spaces anywhere in the codebase, because a list
   * would be a second copy of the city roster and the ritual catalogue that nobody
   * remembers to update, and a launch city with no space is a city where the
   * community tab is empty with no error to explain it.
   *
   * Two axes, deliberately, because they answer different questions. A RITUAL space
   * is national: "who feeds the child first at annaprashan" has the same answer in
   * Pune and in Guwahati, and splitting it by city would fragment the one body of
   * knowledge this surface exists to accumulate. A CITY space is where the local
   * question goes — which ghat, which hall, which purohit is near Salt Lake — and
   * that genuinely is noise everywhere else. Scope is what keeps the two apart.
   */
  let spaces = 0;

  // The national board. The one space named by a constant rather than derived,
  // because "anywhere in India" is not a member of the city list.
  await db.insert(communitySpaces).values({
    id: ulid(),
    slug: DEFAULT_SPACE_SLUG,
    kind: 'general',
    scope: 'national',
    locales: [],
  }).onConflictDoNothing();
  spaces++;

  for (const region of activeCities) {
    const resolved = cityIdBySlug.get(region.slug);
    if (!resolved) continue;
    await db.insert(communitySpaces).values({
      id: ulid(),
      slug: citySpaceSlug(region.slug),
      kind: 'city',
      scope: 'city',
      cityId: resolved,
      // The city's own languages, from the region config. Never a fixed list: a
      // Chennai space that offered Bengali would be as wrong as a Tamil-only one
      // in Kolkata, and both are what a hardcoded array produces.
      locales: [...region.locales],
    }).onConflictDoNothing();
    spaces++;
  }

  for (const r of KOLKATA_RITUALS) {
    const ritualRow = (await db.select({ id: rituals.id }).from(rituals)
      .where(eq(rituals.slug, r.slug)).limit(1))[0];
    if (!ritualRow) continue;
    await db.insert(communitySpaces).values({
      id: ulid(),
      slug: ritualSpaceSlug(r.slug),
      kind: 'ritual',
      scope: 'national',
      ritualId: ritualRow.id,
      // Empty means "whatever the reader's region speaks" rather than a guess made
      // at seed time. A ritual space serves every city, so it cannot name languages.
      locales: [],
    }).onConflictDoNothing();
    spaces++;
  }

  return {
    rituals: KOLKATA_RITUALS.length,
    cities: activeCities.length,
    terms: TITHI_TERMS.length + NAKSHATRA_TERMS.length,
    spaces,
  };
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set - run `pnpm db:migrate` first for details');
  const res = await seedDatabase(createDb(url));
  console.log(
    `seeded ${res.rituals} rituals priced in ${res.cities} cities, `
    + `${res.terms} panchang terms, ${res.spaces} community spaces`,
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
