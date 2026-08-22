import '../common/load-env';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

/**
 * Migration runner.
 *
 * Applies every .sql file in ./migrations in filename order, inside a transaction,
 * recording each in `_migrations`. Re-running is a no-op.
 *
 * Deliberately ~50 lines and dependency-free: migrations are the one thing you need
 * to be able to reason about at 2am, and drizzle-kit's own runner does not apply the
 * hand-written 9999_guards.sql where the ledger trigger and exclusion constraints live.
 */
const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, 'migrations');

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set.\n\n' +
      '  1. cp .env.example .env      (from the repo root)\n' +
      '  2. edit .env so DATABASE_URL points at your Postgres\n\n' +
      'Homebrew Postgres has no password by default, so it usually looks like:\n' +
      `  postgres://${process.env.USER ?? 'you'}@localhost:5432/themaithil`,
    );
  }

  const sql = postgres(url, { max: 1, prepare: false });

  await sql`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;

  const applied = new Set(
    (await sql<{ name: string }[]>`SELECT name FROM _migrations`).map((r) => r.name),
  );

  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  let ran = 0;

  for (const file of files) {
    if (applied.has(file)) continue;
    const body = readFileSync(join(dir, file), 'utf8');

    await sql.begin(async (tx) => {
      // drizzle-kit separates statements with this marker; hand-written files
      // are applied whole.
      for (const stmt of body.split('--> statement-breakpoint')) {
        if (stmt.trim()) await tx.unsafe(stmt);
      }
      await tx`INSERT INTO _migrations (name) VALUES (${file})`;
    });

    console.log(`  applied ${file}`);
    ran++;
  }

  console.log(ran === 0 ? 'database already up to date' : `${ran} migration(s) applied`);
  await sql.end();
}

main().catch((e) => {
  console.error('\nmigration failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
