import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = (name) => join(here, '..', '..', 'packages', name, 'src', 'index.ts');

/**
 * Workspace packages are resolved to their SOURCE, not their build output.
 *
 * `@themaithil/region` publishes `dist/index.js` through its `exports` map, so Next
 * loaded whatever was last compiled. Add a function to `src/index.ts`, start the dev
 * server without running a build first, and the page dies with:
 *
 *   TypeError: (0 , _themaithil_region__WEBPACK_IMPORTED_MODULE_3__.computableSchool)
 *   is not a function
 *
 * — a runtime error that typecheck cannot see (it reads `src`) and the test suite
 * cannot see (turbo rebuilds before `test`, so the guard in
 * packages/region/src/__tests__/dist-surface.test.ts is structurally unable to fire).
 * This has now happened twice: first with `categoryFor` breaking `db:seed`, now with
 * `computableSchool` breaking the home page.
 *
 * Pointing the alias at `src` removes the failure mode instead of adding another
 * check for it: there is no second copy of the code, so there is nothing to go
 * stale. `transpilePackages` already compiles these, so nothing else changes.
 *
 * @type {import('next').NextConfig}
 */
export default {
  reactStrictMode: true,
  /**
   * A self-contained server for the container image.
   *
   * Without this there is no way to ship this app: a Next server normally needs the
   * whole `node_modules` tree beside it, and in a pnpm workspace that tree is a
   * forest of symlinks into `.pnpm` that does not survive being copied between
   * Docker stages. `standalone` makes Next trace what the server actually imports
   * and emit a real `node_modules` next to `server.js`, so the runtime stage copies
   * three directories and runs.
   *
   * It lands in `<distDir>/standalone`, which means `.next-build/standalone` in
   * production — see `distDir` below for why that is not `.next`.
   */
  output: 'standalone',
  /**
   * The repo root, so tracing follows the workspace packages this app aliases to
   * SOURCE (see the webpack block). Left to infer it, Next picks `apps/web` and
   * silently omits everything above it, producing an image that builds cleanly and
   * then cannot start.
   */
  outputFileTracingRoot: join(here, '..', '..'),
  /**
   * The production build gets its own directory, away from the dev server's.
   *
   * `next build` and `next dev` both defaulted to `.next`, so running the build
   * while a dev server was up rewrote the chunks underneath it and every request
   * then died with `Cannot find module './352.js'` — a missing webpack chunk the
   * running server still had a reference to. The only cure was killing the server,
   * deleting `.next` and starting again, and the verification gate (`pnpm build`)
   * triggers it every single time.
   *
   * `NODE_ENV` is set by Next itself: `production` for `build` and `start`, so both
   * agree on `.next-build`, and `development` for `dev`, which keeps `.next`.
   */
  distDir: process.env.NODE_ENV === 'production' ? '.next-build' : '.next',
  transpilePackages: ['@themaithil/contracts', '@themaithil/region'],
  webpack: (config) => {
    /*
     * `@themaithil/contracts` writes its internal imports as `./errors.js`, the
     * NodeNext style where the extension names the EMITTED file. Resolving the
     * package to its source (below) then asks webpack for a `.js` that only exists
     * as `.ts`, and the build dies with "Can't resolve './errors.js'".
     *
     * It went unnoticed because every import of that package from the web app was
     * type-only, and types are erased before webpack ever looks. The first value
     * import — `computePrice`, so the checkout estimate stops being a second,
     * drifting copy of the pricing rules — is what surfaced it.
     *
     * `@themaithil/region` omits extensions entirely, which is why its value
     * imports have always worked. This makes both behave the same.
     */
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
    };
    config.resolve.alias = {
      ...config.resolve.alias,
      '@themaithil/region': pkg('region'),
      '@themaithil/contracts': pkg('contracts'),
    };
    return config;
  },
};
