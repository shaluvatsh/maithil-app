import '../../common/load-env';
import { ulid } from 'ulid';
import { eq, and } from 'drizzle-orm';
import { createDb } from '../client';
import { PanchangService } from '../../modules/panchang/panchang.service';
import {
  cities, users, panditProfiles, addresses, rituals, ritualCityPrices,
  panditRituals, slotDefs, availability,
} from '../schema/index';

/**
 * Demo supply, for local development only.
 *
 * `db:seed` gives you the Kolkata catalogue but no purohits, so there is nothing to
 * book. This adds three verified purohits, prices them across the catalogue, and
 * materialises 30 days of open slots so the booking flow can actually be exercised.
 *
 * Never run this against production - it creates users with predictable phone numbers.
 */
const IST = '+05:30';
const PUROHITS = [
  { phone: '+919830000101', name: 'Sri Bipradas Bhattacharya', years: 28,
    lat: 22.5726, lng: 88.3639, langs: ['bn', 'hi'], trads: ['smarta'] },
  { phone: '+919830000102', name: 'Sri Nabakumar Chakraborty', years: 15,
    lat: 22.4989, lng: 88.3714, langs: ['bn'], trads: ['smarta', 'shakta'] },
  { phone: '+919830000103', name: 'Sri Haradhan Ganguly', years: 41,
    lat: 22.6203, lng: 88.4009, langs: ['bn', 'hi', 'en'], trads: ['shakta'] },
];

const addDays = (n: number) => {
  const d = new Date(Date.now() + 5.5 * 3600_000);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('refusing to seed demo purohits in production');
  }
  const db = createDb(process.env.DATABASE_URL!);

  const city = (await db.select().from(cities).where(eq(cities.slug, 'kolkata')).limit(1))[0];
  if (!city) throw new Error('run `pnpm db:seed` first - no Kolkata city row');

  const defs = await db.select().from(slotDefs)
    .where(eq(slotDefs.cityId, city.id)).orderBy(slotDefs.idx);
  const catalogue = await db.select({
    id: rituals.id, slug: rituals.slug, defaultPaise: ritualCityPrices.defaultPaise,
  }).from(rituals)
    .innerJoin(ritualCityPrices, and(
      eq(ritualCityPrices.ritualId, rituals.id), eq(ritualCityPrices.cityId, city.id),
    ));

  // A devotee you can log in as immediately.
  const devoteePhone = '+919830012345';
  let devotee = (await db.select().from(users).where(eq(users.phone, devoteePhone)).limit(1))[0];
  if (!devotee) {
    devotee = (await db.insert(users).values({
      id: ulid(), phone: devoteePhone, name: 'Debarati Sen', role: 'devotee',
      locale: 'bn', panjikaSchool: 'gupta_press', cityId: city.id,
      referralCode: ulid().slice(-8).toUpperCase(),
    }).returning())[0]!;
    await db.insert(addresses).values({
      id: ulid(), userId: devotee.id, label: 'Home',
      line1: '12 Hindusthan Park', line2: 'Gariahat', cityId: city.id,
      pincode: '700029', lat: 22.5148, lng: 88.3639,
    });
  }

  let created = 0, repaired = 0;
  for (const p of PUROHITS) {
    // Idempotent and self-repairing: an earlier run that died halfway leaves a user
    // row with no profile, prices or slots. Skipping on "user exists" would make that
    // state permanent, so each piece is checked and filled independently.
    let u = (await db.select().from(users).where(eq(users.phone, p.phone)).limit(1))[0];
    const isNew = !u;

    if (!u) {
      u = (await db.insert(users).values({
        id: ulid(), phone: p.phone, name: p.name, role: 'pandit',
        locale: 'bn', cityId: city.id, referralCode: ulid().slice(-8).toUpperCase(),
      }).returning())[0]!;
    }

    const hasProfile = (await db.select().from(panditProfiles)
      .where(eq(panditProfiles.userId, u.id)).limit(1))[0];
    if (!hasProfile) {
      await db.insert(panditProfiles).values({
        userId: u.id,
        bio: `${p.years} বছরের অভিজ্ঞতা`,
        experienceYears: p.years,
        languages: p.langs,
        traditions: p.trads,
        baseLat: p.lat, baseLng: p.lng, serviceRadiusKm: 15,
        // Verified so bookings pass the KYC guard. Real onboarding goes through the
        // admin review queue - see ADR 0010.
        kycStatus: 'verified',
        kycVerifiedAt: new Date().toISOString(),
        cashJobsEnabled: true,
      });
    }

    // Price every ritual at the city default, nudged by experience.
    const priced = await db.select({ ritualId: panditRituals.ritualId })
      .from(panditRituals).where(eq(panditRituals.panditId, u.id));
    const pricedIds = new Set(priced.map((r) => r.ritualId));
    const nudge = 1 + (p.years - 25) / 200;
    for (const r of catalogue) {
      if (pricedIds.has(r.id)) continue;
      await db.insert(panditRituals).values({
        panditId: u.id, ritualId: r.id, active: true,
        pricePaise: Math.round(Number(r.defaultPaise) * nudge / 100) * 100,
      }).onConflictDoNothing();
    }

    // 30 days of open slots.
    const rows = [];
    for (let d = 0; d < 30; d++) {
      const date = addDays(d);
      for (const def of defs) {
        rows.push({
          id: ulid(), panditId: u.id, date, slotIdx: def.idx,
          status: 'open' as const, source: 'default' as const,
          startsAt: new Date(`${date}T${def.startTime}${IST}`).toISOString(),
          endsAt: new Date(`${date}T${def.endTime}${IST}`).toISOString(),
        });
      }
    }
    let slotsAdded = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const res = await db.insert(availability).values(rows.slice(i, i + 500))
        .onConflictDoNothing().returning({ id: availability.id });
      slotsAdded += res.length;
    }

    if (isNew) created++;
    else if (!hasProfile || pricedIds.size < catalogue.length || slotsAdded > 0) repaired++;
  }

  // Panchang, computed rather than fetched - see ADR 0003. Only the Bisuddha
  // Siddhanta (drik) school is computable; Gupta Press is entered by hand.
  const panchang = new PanchangService(db);
  const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
  const pc = await panchang.materialise({ citySlug: 'kolkata', from: today as never, days: 120 });
  await panchang.reconcileSchools('kolkata');

  console.log(`
demo data ready
  devotee   ${devoteePhone}   (log in with OTP 123456 while OTP_DEV_BYPASS=true)
  purohits  ${PUROHITS.map((p) => p.phone).join(', ')}
  ${created} created, ${repaired} repaired - all priced across ${catalogue.length} rituals, 30 days of slots
  panchang  ${pc.days} days, ${pc.intervals} tithi/nakshatra intervals (bisuddha siddhanta)
`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
