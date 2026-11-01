import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';

/**
 * Integration tests against a real Postgres engine (PGlite = Postgres 18 on wasm).
 *
 * These assert the DATABASE-level guards, not the application ones. The point is
 * that even a bad migration, an ORM bug or someone in psql cannot corrupt the
 * ledger or double-book a purohit.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrations = join(here, '..', 'migrations');
let db: PGlite;

const exec = async (sql: string) => {
  for (const stmt of sql.split('--> statement-breakpoint')) {
    if (stmt.trim()) await db.exec(stmt);
  }
};

beforeAll(async () => {
  db = await PGlite.create({ extensions: { btree_gist } });
  await db.exec('CREATE EXTENSION IF NOT EXISTS btree_gist;');
  await exec(readFileSync(join(migrations, '0000_init.sql'), 'utf8'));
  await exec(readFileSync(join(migrations, '9999_guards.sql'), 'utf8'));

  await db.exec(`
    INSERT INTO cities (id, slug, name) VALUES ('C1', 'kolkata', 'Kolkata');
    INSERT INTO users (id, phone, role) VALUES
      ('U_DEV', '+919830000001', 'devotee'),
      ('U_PAN', '+919830000002', 'pandit');
    INSERT INTO pandit_profiles (user_id) VALUES ('U_PAN');
    INSERT INTO rituals (id, slug, duration_min) VALUES ('R1', 'satyanarayan-puja', 120);
    INSERT INTO ledger_accounts (id, owner_type, owner_id) VALUES
      ('A_PLAT', 'platform', NULL),
      ('A_ESCR', 'escrow', NULL),
      ('A_PAN', 'pandit', 'U_PAN');
  `);
}, 60_000);

const postTxn = async (txnId: string, legs: Array<[string, 'debit' | 'credit', number]>) => {
  await db.exec('BEGIN');
  await db.query(`INSERT INTO ledger_transactions (id, kind) VALUES ($1, 'test')`, [txnId]);
  for (const [i, [account, direction, amount]] of legs.entries()) {
    await db.query(
      `INSERT INTO ledger_entries (id, txn_id, account_id, direction, amount_paise, type)
       VALUES ($1, $2, $3, $4, $5, 'adjustment')`,
      [`${txnId}_L${i}`, txnId, account, direction, amount],
    );
  }
  await db.exec('COMMIT');
};

describe('database guards', () => {
  it('applies the full schema', async () => {
    const r = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema='public'`,
    );
    expect(r.rows[0]!.count).toBeGreaterThanOrEqual(35);
  });

  // --- LEDGER ---------------------------------------------------------------
  it('accepts a balanced transaction', async () => {
    await postTxn('T_OK', [['A_ESCR', 'debit', 25500], ['A_PLAT', 'credit', 25500]]);
    const r = await db.query(`SELECT * FROM ledger_entries WHERE txn_id = 'T_OK'`);
    expect(r.rows).toHaveLength(2);
  });

  it('REJECTS an unbalanced transaction at COMMIT', async () => {
    await expect(
      postTxn('T_BAD', [['A_ESCR', 'debit', 25500], ['A_PLAT', 'credit', 25400]]),
    ).rejects.toThrow(/unbalanced by 100 paise/);
    await db.exec('ROLLBACK');
  });

  it('allows legs in any order within the transaction (deferred check)', async () => {
    await postTxn('T_ORDER', [
      ['A_PLAT', 'credit', 1000], ['A_PAN', 'credit', 9000], ['A_ESCR', 'debit', 10000],
    ]);
    const r = await db.query(`SELECT count(*)::int AS c FROM ledger_entries WHERE txn_id='T_ORDER'`);
    expect((r.rows[0] as { c: number }).c).toBe(3);
  });

  it('rejects zero and negative amounts', async () => {
    for (const amount of [0, -500]) {
      await expect(
        postTxn(`T_NEG_${amount}`, [['A_ESCR', 'debit', amount], ['A_PLAT', 'credit', amount]]),
      ).rejects.toThrow();
      await db.exec('ROLLBACK');
    }
  });

  it('is APPEND-ONLY: updates and deletes are refused', async () => {
    await expect(
      db.exec(`UPDATE ledger_entries SET amount_paise = 1 WHERE txn_id = 'T_OK'`),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.exec(`DELETE FROM ledger_entries WHERE txn_id = 'T_OK'`),
    ).rejects.toThrow(/append-only/);
  });

  // --- SURGE ----------------------------------------------------------------
  it('caps surge at 1.5x in the database, not just in code', async () => {
    await expect(db.query(
      `INSERT INTO surge_rules (id, city_id, date, multiplier_bps) VALUES ($1,'C1','2026-10-19',$2)`,
      ['S_HIGH', 16000],
    )).rejects.toThrow(/surge_within_bounds/);

    await expect(db.query(
      `INSERT INTO surge_rules (id, city_id, date, multiplier_bps) VALUES ($1,'C1','2026-10-19',$2)`,
      ['S_LOW', 9000],
    )).rejects.toThrow(/surge_within_bounds/);
  });

  it('permits only one city-wide surge rule per date (NULL ritual_id)', async () => {
    await db.query(
      `INSERT INTO surge_rules (id, city_id, date, multiplier_bps) VALUES ('S_A','C1','2026-10-20',12000)`,
    );
    await expect(db.query(
      `INSERT INTO surge_rules (id, city_id, date, multiplier_bps) VALUES ('S_B','C1','2026-10-20',13000)`,
    )).rejects.toThrow();
    // but a ritual-specific rule on the same date is fine - that is the whole point
    await db.query(
      `INSERT INTO surge_rules (id, city_id, date, ritual_id, multiplier_bps)
       VALUES ('S_C','C1','2026-10-20','R1',15000)`,
    );
  });

  // --- PANCHANG -------------------------------------------------------------
  it('refuses overlapping tithis for the same city AND school', async () => {
    await db.query(
      `INSERT INTO panchang_intervals (id, city_id, school, kind, value_key, starts_at, ends_at)
       VALUES ('P1','C1','gupta_press','tithi','shukla_pratipada',
               '2026-10-19T22:14:00+05:30','2026-10-20T19:03:00+05:30')`,
    );
    await expect(db.query(
      `INSERT INTO panchang_intervals (id, city_id, school, kind, value_key, starts_at, ends_at)
       VALUES ('P2','C1','gupta_press','tithi','shukla_dwitiya',
               '2026-10-20T10:00:00+05:30','2026-10-21T08:00:00+05:30')`,
    )).rejects.toThrow(/panchang_intervals_no_overlap/);
  });

  it('ALLOWS the two schools to disagree over the same instant - the core Kolkata case', async () => {
    await db.query(
      `INSERT INTO panchang_intervals (id, city_id, school, kind, value_key, starts_at, ends_at)
       VALUES ('P3','C1','bisuddha_siddhanta','tithi','shukla_dwitiya',
               '2026-10-19T22:14:00+05:30','2026-10-20T19:03:00+05:30')`,
    );
    const r = await db.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM panchang_intervals WHERE kind='tithi'`,
    );
    expect(r.rows[0]!.c).toBe(2);
  });

  // --- BOOKINGS -------------------------------------------------------------
  const booking = (id: string, slotIdx: number, span: number) => db.query(
    `INSERT INTO bookings (id, devotee_id, pandit_id, ritual_id, city_id, date,
                           slot_idx, slot_span, slot_start_at, slot_end_at,
                           panjika_school, price, payment_mode, state)
     VALUES ($1,'U_DEV','U_PAN','R1','C1','2026-10-20',$2,$3,
             '2026-10-20T09:30:00+05:30','2026-10-20T12:30:00+05:30',
             'gupta_press','{}'::jsonb,'cash','draft')`,
    [id, slotIdx, span],
  );

  /*
   * This used to assert that `slot_idx + slot_span <= 4` — and it was testing
   * Kolkata's four-slot day, not a property of bookings. That ceiling refused
   * evening bookings outright in the five-slot southern cities, and it made a
   * ritual running most of a day (a full Chandi Paath, a Mahamrityunjay jaap)
   * bookable only at dawn. Migration A0001 replaced it with a bound on the span
   * alone; the overlap guarantee moved to `bookings_pandit_no_overlap` in 0018,
   * an exclusion constraint over the real interval, which does not care how a
   * city divides its day.
   */
  it('allows a long ritual to start late in the day', async () => {
    // slot 3 + span 2 was refused outright before; it is now an ordinary booking.
    await booking('B_LATE', 3, 2);
    await booking('B_OK', 2, 2);
  });

  it('still refuses a span that is not a real length', async () => {
    await expect(booking('B_ZERO', 0, 0)).rejects.toThrow(/booking_slot_span_valid/);
    // Longer than any city's whole day is a bug, not a long puja.
    await expect(booking('B_HUGE', 0, 9)).rejects.toThrow(/booking_slot_span_valid/);
  });

  it('refuses a completed cash booking with no recorded cash amount', async () => {
    await booking('B_CASH', 0, 1);
    await expect(
      db.exec(`UPDATE bookings SET state='completed' WHERE id='B_CASH'`),
    ).rejects.toThrow(/cash_completion_records_amount/);

    await db.exec(
      `UPDATE bookings SET state='completed', cash_collected_paise=254000 WHERE id='B_CASH'`,
    );
  });

  it('makes double-booking a slot impossible', async () => {
    await db.exec(`
      INSERT INTO availability (id, pandit_id, date, slot_idx, status, starts_at, ends_at)
      VALUES ('AV1','U_PAN','2026-10-20',1,'open',
              '2026-10-20T09:30:00+05:30','2026-10-20T12:30:00+05:30')`);
    await expect(db.exec(`
      INSERT INTO availability (id, pandit_id, date, slot_idx, status, starts_at, ends_at)
      VALUES ('AV2','U_PAN','2026-10-20',1,'open',
              '2026-10-20T09:30:00+05:30','2026-10-20T12:30:00+05:30')`),
    ).rejects.toThrow();
  });

  // --- OUTBOX / IDEMPOTENCY -------------------------------------------------
  it('dedupes consumers on (consumer, event_id)', async () => {
    await db.exec(
      `INSERT INTO processed_events (consumer, event_id) VALUES ('notifications','E1')`);
    await expect(db.exec(
      `INSERT INTO processed_events (consumer, event_id) VALUES ('notifications','E1')`),
    ).rejects.toThrow();
    // a different consumer may process the same event
    await db.exec(
      `INSERT INTO processed_events (consumer, event_id) VALUES ('kit_orders','E1')`);
  });

  it('keeps the outbox relay index partial to unpublished rows', async () => {
    const r = await db.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'outbox_unpublished'`,
    );
    expect(r.rows[0]!.indexdef).toMatch(/WHERE \(published_at IS NULL\)/);
  });

  it('rejects out-of-range review stars', async () => {
    await expect(db.exec(
      `INSERT INTO reviews (id, booking_id, author, pandit_stars)
       VALUES ('RV1','B_OK','devotee',7)`),
    ).rejects.toThrow(/review_stars_range/);
  });
});
