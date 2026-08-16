import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // One throwaway Postgres for the whole run, with the migrations replayed into a template
    // once and each file taking a copy. That is deliberately not the development database:
    // AGENTS.md non-negotiable 3 forbids destructive commands against a database not confirmed
    // disposable, and a dev database accumulates real usage data between sessions - it is not
    // fixtures. See src/test/global-setup.ts for why it is one container and not one per file.
    globalSetup: ['./src/test/global-setup.ts'],
    testTimeout: 60_000,
    // Was 180s, for a file that had to start and migrate its own container before its first
    // test. A file's setup is now a CREATE DATABASE against a server that is already up.
    hookTimeout: 60_000,
    // Kept off, and no longer for the reason it was set. It was "one container per file, and
    // files that share one must not race on the same channel row" - and no two files share a
    // database now, so that argument has gone. What is left is that turning it on is a change
    // with its own failure modes (a dozen workers against one postmaster, and the timing tests)
    // and it belongs in its own pass rather than riding along with the container fix.
    fileParallelism: false,
  },
});
