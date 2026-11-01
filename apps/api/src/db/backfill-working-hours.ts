import '../common/load-env';
import { sql } from 'drizzle-orm';
import { createDb } from './client';

/**
 * Gives every existing purohit working hours, derived from the slot model they are
 * on today.
 *
 * `pandit_working_hours` (migration 0018) is the continuous-time replacement for
 * "which of the four slots do you work", but it starts empty — so until this runs,
 * a purohit who is fully available under the slot model looks unavailable at every
 * hour under the new one, and the devotee's time picker would offer nothing.
 *
 * The translation is the honest one: a purohit's day runs from the START of their
 * city's first slot to the END of its last. Kolkata's four slots span 06:00–19:30
 * with 30-minute gaps between them; those gaps were never rest, they were a fixed
 * guess at travel. Travel is now estimated per pair of bookings (ADR 0013), so the
 * gaps are not carried across — carrying them would bake the guess back in and
 * block 09:00–09:30 for a purohit whose next job is in the same lane.
 *
 * Nothing is invented beyond that: no purohit is given hours outside the ones the
 * platform already offered on their behalf. Night work in particular is NOT
 * granted — the catalogue's midnight rites need hours a purohit has to opt into
 * themselves, and defaulting everyone into 02:00 availability would enrol them in
 * work they never agreed to.
 *
 * Idempotent: re-running replaces a purohit's rows with the same values. It does
 * NOT overwrite hours a purohit has since set for themselves — those rows differ
 * from the city default and are left alone.
 *
 *   pnpm --filter @themaithil/api db:backfill:working-hours
 */
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const db = createDb(url);

  /*
   * One window per purohit per weekday: their city's first slot start to its last
   * slot end. Written only where the purohit has no hours at all, so a purohit who
   * has already declared their own — including night hours — keeps them.
   */
  const res = await db.execute(sql`
    WITH city_day AS (
      SELECT city_id,
             MIN(start_time) AS opens,
             MAX(end_time)   AS closes
        FROM slot_defs
       WHERE active
       GROUP BY city_id
    ),
    target AS (
      SELECT p.user_id, cd.opens, cd.closes
        FROM pandit_profiles p
        JOIN users u   ON u.id = p.user_id
        JOIN city_day cd ON cd.city_id = u.city_id
       WHERE NOT EXISTS (
         SELECT 1 FROM pandit_working_hours w WHERE w.pandit_id = p.user_id
       )
    )
    INSERT INTO pandit_working_hours (pandit_id, weekday, starts_at, ends_at)
    SELECT t.user_id, d.weekday, t.opens, t.closes
      FROM target t
      CROSS JOIN generate_series(0, 6) AS d(weekday)
    ON CONFLICT (pandit_id, weekday, starts_at) DO NOTHING
    RETURNING pandit_id`);

  const written = ((res as unknown as { rows?: unknown[] }).rows ?? res as unknown[]).length;
  const total = await db.execute(sql`
    SELECT count(DISTINCT pandit_id)::int AS n FROM pandit_working_hours`);
  const covered = (((total as unknown as { rows?: Array<{ n: number }> }).rows
    ?? total as unknown as Array<{ n: number }>)[0]?.n) ?? 0;

  console.log(
    written === 0
      ? `no purohits needed backfilling; ${covered} already have working hours`
      : `backfilled ${written} weekday rows; ${covered} purohits now have working hours`,
  );
  await db.$client.end();
}

main().catch((e) => {
  console.error('\nworking-hours backfill failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
