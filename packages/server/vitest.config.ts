import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Handler tests start a throwaway Postgres container. That is deliberately not
    // the development database: AGENTS.md non-negotiable 3 forbids destructive
    // commands against a database not confirmed disposable, and a dev database
    // accumulates real usage data between sessions - it is not fixtures.
    testTimeout: 60_000,
    hookTimeout: 180_000,
    // One container per file, and files that share one must not race on the same
    // channel row. Pure-function suites (the permission matrix) are unaffected.
    fileParallelism: false,
  },
});
