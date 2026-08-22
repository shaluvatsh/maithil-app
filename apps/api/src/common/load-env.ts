import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Loads the nearest .env by walking up from this file to the repo root.
 *
 * No dependency, and no reliance on cwd - `pnpm db:migrate` from the repo root and
 * `tsx src/db/migrate.ts` from apps/api both have to find the same file. Real
 * environment variables always win, so this is a no-op in production.
 *
 * Import it for its side effect, FIRST, before anything that reads process.env.
 */
function parse(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

export function loadEnvFile(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      for (const [k, v] of Object.entries(parse(readFileSync(candidate, 'utf8')))) {
        if (process.env[k] === undefined) process.env[k] = v;
      }
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

loadEnvFile();
