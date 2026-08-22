/**
 * The Worker's tests run in `workerd`, not in Node pretending to be it.
 *
 * That is the whole point of this file. The api mints a signature on Node and this Worker
 * verifies it at the edge, so a test harness that ran the Worker's code under Node would be
 * asserting that one runtime agrees with itself. See ADR-0044.
 *
 * **Two things here are a major version newer than anything you remember, and both fail
 * quietly rather than loudly.** AGENTS.md non-negotiable 1 exists for exactly this.
 *
 * 1. **`@cloudflare/vitest-pool-workers/config` no longer exists in 0.22**, and neither does
 *    `defineWorkersConfig` or `defineWorkersProject`. The pool is a Vite PLUGIN now. Reaching
 *    for the old entry point fails with `Missing "./config" specifier`, which at least is loud.
 *
 * 2. **`isolatedStorage` is gone from the pool options, and passing it is silently ignored.**
 *    `WorkersPoolOptionsSchema` in 0.22 accepts only `main`, `remoteBindings`, `verbose`,
 *    `additionalExports`, `miniflare` and `wrangler`, and the object is parsed with zod's
 *    `$strip`, so an unknown key is dropped rather than rejected. Setting it therefore compiles,
 *    runs, reports nothing, and changes nothing.
 *
 *    This matters because storage is consequently NOT isolated between tests. It was found the
 *    worst way round: an object seeded by one test survived into the next, so "a missing object
 *    is a 404" passed back bytes from the previous test instead. A test that leaks state into
 *    the test asserting absence is the one direction that turns green into a lie.
 *
 *    The harness clears both buckets in `beforeEach` because of this. That is a real obligation
 *    on every test file here, not a tidiness habit, and it is written down rather than assumed
 *    precisely because the config knob that would have removed the obligation looks like it
 *    works.
 */
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // `wrangler.jsonc` is the single source of the bindings, so the tests run against the same
  // R2 bindings, compatibility date and version metadata the deploy uses. Declaring them a
  // second time here is how a suite comes to pass against a shape production does not have.
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
});
