import { build } from 'esbuild';
import { rmSync, cpSync } from 'node:fs';

/**
 * Production build.
 *
 * tsc alone is not enough here: with `moduleResolution: bundler` it emits
 * extensionless relative imports, which Node's ESM loader refuses to resolve. The
 * container would build green and then crash on start with ERR_MODULE_NOT_FOUND.
 *
 * esbuild inlines our own modules so there is nothing left to resolve. Third-party
 * packages stay external and load normally from node_modules.
 *
 * Type checking still happens - `pnpm build` runs `tsc --noEmit` first.
 */
rmSync('dist', { recursive: true, force: true });

await build({
  entryPoints: [
    'src/main.ts',
    'src/db/migrate.ts',
    'src/db/seed/index.ts',
    'src/db/seed/dev.ts',
  ],
  outdir: 'dist',
  outbase: 'src',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
  // NestJS reads decorator metadata at runtime; keeping names intact keeps the DI
  // container and the class-based providers working after bundling.
  keepNames: true,
});

// .sql files are data, not modules, so esbuild does not carry them across.
cpSync('src/db/migrations', 'dist/db/migrations', { recursive: true });
console.log('bundled → dist/');
