import '../common/load-env';
import { eq, and, sql } from 'drizzle-orm';
import { createDb } from './client';
import { addresses, cities } from './schema/index';
import { GeocodeService } from '../modules/booking/geocode.service';

/**
 * Repairs addresses that were saved before geocoding existed.
 *
 * `POST /v1/me/addresses` used to fall through to `(0, 0)` — the Atlantic — for
 * every address it created, and later to the city centroid. Both are still on
 * disk, and migration 0017 stamped every existing row `geo_precision = 'city'`
 * because a SQL default cannot know any better. For a row at `(0, 0)` that label
 * is simply false: `city` promises the city's centroid, and the Atlantic is not it.
 *
 * A wrong coordinate is worse than a coarse one. Coarse is visible and the
 * scheduler can widen its margin against it (ADR 0013); a point 6,000 km out looks
 * exactly as authoritative as a good one and quietly poisons every travel estimate
 * and every proximity score computed from it.
 *
 * Only `(0, 0)` is touched. Rows that already hold a real coordinate are left
 * alone, including their conservative `city` label: understating precision costs a
 * little unnecessary buffer, whereas overstating it sends a purohit to the wrong
 * street. When in doubt this stays on the safe side.
 *
 * Idempotent — a second run finds nothing to do.
 *
 *   pnpm --filter @themaithil/api db:repair:addresses
 */
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  const db = createDb(url);
  const geo = new GeocodeService(db);

  const broken = await db.select({
    id: addresses.id,
    pincode: addresses.pincode,
    citySlug: cities.slug,
  })
    .from(addresses)
    .innerJoin(cities, eq(cities.id, addresses.cityId))
    .where(and(eq(addresses.lat, 0), eq(addresses.lng, 0)));

  if (broken.length === 0) {
    console.log('no addresses need repair');
    await db.$client.end();
    return;
  }

  let fixed = 0;
  for (const row of broken) {
    const point = await geo.resolve({ citySlug: row.citySlug, pincode: row.pincode });
    await db.update(addresses)
      .set({ lat: point.lat, lng: point.lng, geoPrecision: point.precision })
      .where(eq(addresses.id, row.id));
    fixed++;
    console.log(`  ${row.id} → ${point.precision} (${point.lat}, ${point.lng})`);
  }

  const remaining = await db.select({ n: sql<number>`count(*)::int` })
    .from(addresses).where(and(eq(addresses.lat, 0), eq(addresses.lng, 0)));

  console.log(`repaired ${fixed} address(es); ${remaining[0]?.n ?? 0} still at (0, 0)`);
  await db.$client.end();
}

main().catch((e) => {
  console.error('\naddress repair failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
