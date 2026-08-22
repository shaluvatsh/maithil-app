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
  transpilePackages: ['@themaithil/contracts', '@themaithil/region'],
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      '@themaithil/region': pkg('region'),
      '@themaithil/contracts': pkg('contracts'),
    };
    return config;
  },
};
