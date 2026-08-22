import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every controller must be registered.
 *
 * `VerificationController` was written, complete and correct, and never added to
 * `app.module.ts`. Nest simply did not mount it, so every route on it returned 404
 * — the admin approval queue rendered as "empty" and the Approve button did
 * nothing, with no error anywhere to explain why.
 *
 * Nothing caught this. It typechecks, it builds, and the unit tests never boot
 * Nest. The only signal was the absence of a line in the startup log, which is the
 * kind of thing nobody notices. So: a file that declares a controller must appear
 * in the module.
 */
const src = join(__dirname, '..');

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' ? [] : walk(path);
    return e.isFile() && e.name.endsWith('.ts') ? [path] : [];
  });
}

describe('every controller is wired into the application', () => {
  it('registers each @Controller class in app.module', () => {
    const appModule = readFileSync(join(src, 'app.module.ts'), 'utf8');
    const registered = appModule
      .slice(appModule.indexOf('controllers: ['), appModule.indexOf('providers: ['));

    const declared = walk(src).flatMap((file) => {
      const body = readFileSync(file, 'utf8');
      if (!body.includes('@Controller(')) return [];
      return [...body.matchAll(/export class (\w*Controller)\b/g)].map((m) => m[1]!);
    });

    expect(declared.length, 'no controllers found — the scan is broken').toBeGreaterThan(5);

    const missing = declared.filter((name) => !registered.includes(name));
    expect(
      missing,
      `declared but never registered, so every route on them 404s: ${missing.join(', ')}`,
    ).toEqual([]);
  });
});
