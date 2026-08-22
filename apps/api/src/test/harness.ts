import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ulid } from 'ulid';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../db/schema/index';
import type { Db } from '../db/client';
import { loadConfig, type Config } from '../common/config';
import { MemoryKv } from '../common/kv';
import { LedgerService } from '../domain/ledger';
import { OutboxService } from '../domain/outbox';
import { SlotService } from '../domain/slots';
import { BookingOtpService } from '../modules/auth/otp.service';
import { CatalogService } from '../modules/catalog/catalog.service';
import { AvailabilityService } from '../modules/availability/availability.service';
import { PricingService } from '../modules/booking/pricing.service';
import { SearchService } from '../modules/search/search.service';
import { BookingService } from '../modules/booking/booking.service';
import { IdempotencyService } from '../common/idempotency';
import { KOLKATA_SLOT_DEFS } from '../db/seed/rituals.kolkata';

const here = dirname(fileURLToPath(import.meta.url));
const migrations = join(here, '..', 'db', 'migrations');

export const TEST_CONFIG: Config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'pglite://memory',
  JWT_ACCESS_SECRET: 'test-secret-that-is-long-enough-32ch',
  JWT_REFRESH_SECRET: 'test-refresh-secret-long-enough-32c',
  OTP_DEV_BYPASS: 'true',
  BOOKING_HORIZON_DAYS: '120',
} as unknown as NodeJS.ProcessEnv);

export interface Harness {
  db: Db;
  pg: PGlite;
  kv: MemoryKv;
  bookings: BookingService;
  catalog: CatalogService;
  availability: AvailabilityService;
  ledger: LedgerService;
  outbox: OutboxService;
  idempotency: IdempotencyService;
  ids: { cityId: string; ritualId: string; devoteeId: string; panditId: string; addressId: string };
}

/**
 * A full stack over Postgres-in-wasm. Real SQL, real constraints, real transactions
 * and real deferred triggers - so these tests exercise the same guards production
 * relies on, without Docker.
 */
export async function makeHarness(opts: { dakshinaPaise?: number } = {}): Promise<Harness> {
  const pg = await PGlite.create({ extensions: { btree_gist } });
  await pg.exec('CREATE EXTENSION IF NOT EXISTS btree_gist;');
  // Every migration, in filename order - the same set and order the production
  // runner applies. Naming two files explicitly meant new migrations silently never
  // ran in tests, so the schema under test drifted from the real one.
  for (const file of readdirSync(migrations).filter((f) => f.endsWith('.sql')).sort()) {
    for (const stmt of readFileSync(join(migrations, file), 'utf8').split('--> statement-breakpoint')) {
      if (stmt.trim()) await pg.exec(stmt);
    }
  }

  // PGlite and postgres-js are both PgDatabase underneath; the cast keeps the
  // production type precise while letting tests run without a server.
  const db = drizzle(pg, { schema }) as unknown as Db;

  const cityId = ulid(), ritualId = ulid(), devoteeId = ulid();
  const panditId = ulid(), addressId = ulid();

  await db.insert(schema.cities).values({
    id: cityId, slug: 'kolkata', name: 'Kolkata', defaultPanjikaSchool: 'gupta_press',
  });
  for (const s of KOLKATA_SLOT_DEFS) {
    await db.insert(schema.slotDefs).values({
      id: ulid(), cityId, idx: s.idx, startTime: s.start, endTime: s.end,
    });
  }
  await db.insert(schema.users).values([
    { id: devoteeId, phone: '+919830000001', role: 'devotee', cityId, panjikaSchool: 'gupta_press' },
    { id: panditId, phone: '+919830000002', role: 'pandit', cityId },
  ]);
  await db.insert(schema.panditProfiles).values({
    userId: panditId, kycStatus: 'verified', cashJobsEnabled: true,
    baseLat: 22.5726, baseLng: 88.3639,
  });
  await db.insert(schema.addresses).values({
    id: addressId, userId: devoteeId, line1: '12 Hindusthan Park', cityId,
    pincode: '700029', lat: 22.5148, lng: 88.3639,
  });

  // Satyanarayan Puja: 2 hours, one slot.
  await db.insert(schema.rituals).values({
    id: ritualId, slug: 'satyanarayan-puja', durationMin: 120, defaultSlotSpan: 1,
  });
  await db.insert(schema.ritualTranslations).values({
    ritualId, locale: 'bn', name: 'সত্যনারায়ণ পূজা',
    shortDescription: 'সিন্নি সহ পূজা', description: 'সিন্নি সহ পূজা',
  });
  await db.insert(schema.ritualCityPrices).values({
    ritualId, cityId, bandMinPaise: 110000, bandMaxPaise: 250000, defaultPaise: 150000,
  });
  await db.insert(schema.panditRituals).values({
    panditId, ritualId, pricePaise: opts.dakshinaPaise ?? 150000, active: true,
  });

  const bomId = ulid();
  await db.insert(schema.boms).values({ id: bomId, ritualId, cityId, version: 1, status: 'active' });
  const itemId = ulid();
  await db.insert(schema.bomItems).values({
    id: itemId, bomId, qty: '1', unit: 'set', linePricePaise: 80000, perishable: false,
  });
  await db.insert(schema.bomItemTranslations).values({
    bomItemId: itemId, locale: 'bn', name: 'পূজার উপকরণ',
  });

  const kv = new MemoryKv();
  const catalog = new CatalogService(db);
  const availability = new AvailabilityService(db, TEST_CONFIG.BOOKING_HORIZON_DAYS);
  const slots = new SlotService();
  const ledger = new LedgerService(db);
  const outbox = new OutboxService();
  const pricing = new PricingService(db, catalog);
  const otp = new BookingOtpService(TEST_CONFIG.JWT_ACCESS_SECRET);
  const search = new SearchService(db);
  const bookings = new BookingService(
    db, pricing, catalog, availability, slots, ledger, outbox, otp, kv,
    TEST_CONFIG.BOOKING_HORIZON_DAYS,
    { matchPandit: (a) => search.matchPandit(a as never) },
    true,
  );

  await availability.materialise({ panditId, cityId });

  return {
    db, pg, kv, bookings, catalog, availability, ledger, outbox,
    idempotency: new IdempotencyService(db),
    ids: { cityId, ritualId, devoteeId, panditId, addressId },
  };
}

export const daysFromNow = (n: number): string => {
  const d = new Date(Date.now() + 5.5 * 3600_000);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
