import '../../common/load-env';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

/**
 * Loads pincode centroids from a CSV.
 *
 * Deliberately an import rather than a checked-in constant. These are real-world
 * coordinates that dispatch a human being to a house: they have to come from a
 * dataset with a name and a date, not from anybody's memory. A plausible-looking
 * coordinate is worse than no coordinate at all — the coarse fallback (the city
 * centroid) is visibly coarse and the scheduler can widen its margin against it,
 * whereas an invented point looks precise and quietly sends a purohit to the wrong
 * part of the city.
 *
 * Usage:
 *   pnpm --filter @themaithil/api db:seed:pincodes <file.csv> [source-label]
 *
 * Expected columns (header row required, order free, extra columns ignored):
 *   pincode,lat,lng
 *
 * Suitable public sources include the India Post PIN code directory published on
 * data.gov.in. Whichever is used, pass its name as the source label so a bad
 * import can be identified and replaced later:
 *   ... data/pincodes.csv india-post-2024
 */
async function main() {
  const [file, source = 'unspecified'] = process.argv.slice(2);
  if (!file) {
    console.error(
      'usage: db:seed:pincodes <file.csv> [source-label]\n'
      + '  CSV needs a header row with pincode, lat and lng columns.',
    );
    process.exit(1);
  }

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  const text = readFileSync(file, 'utf8').trim();
  const [header, ...lines] = text.split(/\r?\n/);
  const cols = header!.split(',').map((c) => c.trim().toLowerCase());
  const at = (name: string) => {
    const i = cols.indexOf(name);
    if (i === -1) throw new Error(`CSV has no "${name}" column (found: ${cols.join(', ')})`);
    return i;
  };
  const [pinAt, latAt, lngAt] = [at('pincode'), at('lat'), at('lng')];

  /**
   * Rows are validated here AND by CHECK constraints in migration 0017. A bulk
   * import is exactly where a malformed row slips in unnoticed, and a pincode that
   * is silently wrong is indistinguishable from one that is right until a purohit
   * is standing in the wrong street.
   */
  const rows: Array<{ pincode: string; lat: number; lng: number }> = [];
  let skipped = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const f = line.split(',');
    const pincode = (f[pinAt] ?? '').trim();
    const lat = Number((f[latAt] ?? '').trim());
    const lng = Number((f[lngAt] ?? '').trim());
    const ok = /^[1-9][0-9]{5}$/.test(pincode)
      && Number.isFinite(lat) && lat >= -90 && lat <= 90
      && Number.isFinite(lng) && lng >= -180 && lng <= 180;
    if (!ok) { skipped++; continue; }
    rows.push({ pincode, lat, lng });
  }

  if (rows.length === 0) {
    console.error(`no valid rows found (${skipped} skipped). Nothing written.`);
    process.exit(1);
  }

  const sql = postgres(url, { max: 1, prepare: false });
  let written = 0;
  // Chunked: a national dataset is ~19,000 rows and one statement that size is
  // needlessly hard on the server.
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500).map((r) => ({ ...r, source }));
    const res = await sql`
      INSERT INTO pincode_centroids ${sql(chunk, 'pincode', 'lat', 'lng', 'source')}
      ON CONFLICT (pincode) DO UPDATE
        SET lat = EXCLUDED.lat, lng = EXCLUDED.lng, source = EXCLUDED.source
      RETURNING pincode`;
    written += res.length;
  }
  await sql.end();

  console.log(
    `loaded ${written} pincode centroids from "${source}"`
    + (skipped ? ` (${skipped} malformed rows skipped)` : ''),
  );
}

main().catch((e) => {
  console.error('\npincode import failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
