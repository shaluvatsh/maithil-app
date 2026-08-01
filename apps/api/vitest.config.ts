import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each integration case boots its own Postgres-in-wasm instance; forks keep the
    // wasm heaps isolated and reclaimed between files.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
