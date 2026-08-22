import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each integration case boots its own Postgres-in-wasm instance, and a PGlite
    // heap is hundreds of megabytes that the WASM allocator never returns to the OS.
    //
    // `singleFork: true` therefore did the opposite of what the old comment here
    // claimed: it ran all thirteen files in ONE process, so the heaps accumulated
    // until the worker was killed mid-run. Vitest reported "Worker exited
    // unexpectedly", marked the seven auth integration tests as *pending* rather than
    // failed, and still exited non-zero — a suite that looks green per-test while
    // silently skipping a file.
    //
    // One fork per file means the heap is reclaimed by process exit. Capping the
    // forks bounds peak memory, which is what the single fork was reaching for.
    pool: 'forks',
    poolOptions: { forks: { singleFork: false, minForks: 1, maxForks: 2 } },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
