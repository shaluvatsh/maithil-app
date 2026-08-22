import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * No @vitejs/plugin-react here: it targets a newer Vite than vitest 2 ships, and
 * these are DOM assertions rather than a dev server - esbuild's automatic JSX
 * transform is all that is needed.
 */
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  /**
   * Workspace packages resolve to source here too, matching next.config.mjs.
   *
   * Without this, vitest imports `@themaithil/region` from `dist`, so running
   * `vitest` directly in this package tests whatever was last compiled rather than
   * what is written. Turbo rebuilds before `pnpm test`, which hid the problem right
   * up until someone ran the binary by hand and got a failure they could not
   * explain from the diff.
   */
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./', import.meta.url)),
      '@themaithil/region': fileURLToPath(new URL('../../packages/region/src/index.ts', import.meta.url)),
      '@themaithil/contracts': fileURLToPath(new URL('../../packages/contracts/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./__tests__/setup.tsx'],
    include: ['__tests__/**/*.test.{ts,tsx}'],
  },
});
