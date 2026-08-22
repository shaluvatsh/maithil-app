import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guards against a stale build.
 *
 * The API and the web app import `@themaithil/region` by package name, which Node
 * resolves to `dist/index.js` — not to the TypeScript source. So a module that exists
 * in `src` but was never compiled into `dist` produces a runtime error that no
 * typecheck and no source-importing test will ever catch:
 *
 *   SyntaxError: The requested module '@themaithil/region'
 *   does not provide an export named 'categoryFor'
 *
 * That is exactly how `categories.ts` broke `db:seed`: the module was added to
 * `src/index.ts`, every test passed against source, and the shipped `dist` predated it.
 *
 * This test compares the two surfaces directly.
 *
 * KNOW WHAT THIS CANNOT CATCH. `test` declares `dependsOn: ["^build"]`, so turbo
 * rebuilds `dist` before this file ever runs — it can only fail if the build itself
 * drops an export, never if a developer's checkout is merely stale. It did not, and
 * could not, catch `computableSchool` missing from a dev server's `dist`.
 *
 * The actual fix for staleness is upstream and structural: apps/web resolves these
 * packages to `src` (next.config.mjs, vitest.config.mts) and apps/api rebuilds them
 * in a `predev` hook. There is no second copy of the code to go stale. This file
 * guards the shape of the published artifact, which is a different job.
 */
const root = join(__dirname, '..', '..');
const src = join(root, 'src');
const dist = join(root, 'dist');

/** Top-level modules re-exported by src/index.ts, e.g. './categories' -> 'categories'. */
function reexportedModules(): string[] {
  const index = readFileSync(join(src, 'index.ts'), 'utf8');
  return [...index.matchAll(/export \* from '\.\/([^']+)'/g)]
    .map((m) => m[1])
    .filter((m): m is string => m !== undefined);
}

describe('built output matches source', () => {
  it('has been built at all', () => {
    expect(
      existsSync(join(dist, 'index.js')),
      'packages/region/dist is missing. Run `pnpm build` — apps import the built output, not src.',
    ).toBe(true);
  });

  it('compiles every module that index.ts re-exports', () => {
    const missing = reexportedModules().filter((mod) => {
      // A module is either dist/<mod>.js or a directory dist/<mod>/index.js.
      return !existsSync(join(dist, `${mod}.js`)) && !existsSync(join(dist, mod, 'index.js'));
    });

    expect(
      missing,
      `src/index.ts re-exports these, but they are absent from dist: ${missing.join(', ')}.\n` +
        'The build is stale. Anything importing @themaithil/region will fail at runtime.',
    ).toEqual([]);
  });

  it('exports the full public surface from the package entry point', async () => {
    // Import by package name so this resolves the way the API and web app resolve it.
    const built = await import('@themaithil/region');
    const source = await import('../index');

    const missing = Object.keys(source).filter((name) => !(name in built));

    expect(
      missing,
      `these are exported from src but not from the built package: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  /**
   * `bengaluru.ts` survived here after `india.ts` replaced it via the factory. Nothing
   * imported it, so no test ever ran it — but `tsc` compiles all of `src/**`, so when
   * `priceIndexBps` became a required field it broke the build of a package whose
   * behaviour was entirely correct. Dead region files are not free.
   */
  it('has no region file that nothing imports', () => {
    const regions = readdirSync(join(src, 'regions'))
      .filter((f) => f.endsWith('.ts') && f !== 'factory.ts')
      .map((f) => f.replace(/\.ts$/, ''));

    const sources = ['index.ts', ...readdirSync(join(src, 'regions')).map((f) => join('regions', f))]
      .map((f) => readFileSync(join(src, f), 'utf8'))
      .join('\n');

    const orphans = regions.filter(
      (r) => !new RegExp(`from '(\\./|\\./regions/)${r}'`).test(sources),
    );

    expect(
      orphans,
      `src/regions/${orphans.join('.ts, ')}.ts is imported by nothing. ` +
        'Delete it, or wire it into index.ts — it is still typechecked either way.',
    ).toEqual([]);
  });

  it('keeps no orphaned modules in src that index.ts forgot to export', () => {
    const topLevel = readdirSync(src, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.ts') && e.name !== 'index.ts')
      .map((e) => e.name.replace(/\.ts$/, ''));

    const exported = new Set(reexportedModules());
    const orphans = topLevel.filter((m) => !exported.has(m));

    // `types` is re-exported; anything else unexported is almost certainly an oversight.
    expect(orphans, `not reachable from index.ts: ${orphans.join(', ')}`).toEqual([]);
  });
});
