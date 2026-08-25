/**
 * The Worker's tests run in `workerd`, not in Node pretending to be it.
 *
 * Same reasoning as `packages/cdn-worker/vitest.config.ts`, and the same two traps, both of
 * which are a major version newer than anything a model remembers and both of which fail
 * quietly rather than loudly. AGENTS.md non-negotiable 1 exists for exactly this.
 *
 * 1. **`@cloudflare/vitest-pool-workers/config` no longer exists in 0.22**, and neither does
 *    `defineWorkersConfig` or `defineWorkersProject`. The pool is a Vite PLUGIN now. Reaching
 *    for the old entry point fails with `Missing "./config" specifier`, which at least is loud.
 *
 * 2. **`isolatedStorage` is gone from the pool options, and passing it is silently ignored.**
 *    It does not matter for this package - the site Worker has no storage bindings at all - but
 *    it is stated here so the next person to add one does not reach for the knob that looks like
 *    it works. `packages/cdn-worker/vitest.config.ts` carries the full account.
 *
 * **The third trap is this package's own, and it cost the first hour here.** `fetchMock` is gone
 * from `cloudflare:test` in pool 0.22. Every recipe still shows
 * `import { fetchMock } from 'cloudflare:test'` followed by `fetchMock.activate()`, and in this
 * version there is no such export: the `MockAgent` type is still declared in
 * `types/cloudflare-test.d.ts` and nothing exports an instance of it. The join page is the one
 * route here that makes an outbound request, so the whole of its test suite depends on having a
 * replacement. The replacement is `vi.stubGlobal('fetch', ...)`, and it works because the pool
 * runs the `main` Worker in the SAME isolate as the test file - stated in the doc comment on
 * `SELF` in that same declaration file. `test/harness.ts` has the details and the caveat.
 */
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // `wrangler.jsonc` is the single source of the vars and the module rules, so the tests run
  // against the same configuration the deploy uses - including the `Text` rule that turns the
  // two legal markdown files into bundled strings. Declaring any of it a second time here is how
  // a suite comes to pass against a shape production does not have.
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
});
