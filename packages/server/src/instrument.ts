/**
 * The Sentry SDK, started before anything it needs to watch is loaded.
 *
 * **This module exists for its import order and nothing else.** It must be the FIRST import of
 * every entrypoint, above `pino`, above `fastify`, above the database client. Move it down the
 * list and nothing breaks loudly: errors still report, requests still produce a transaction, and
 * the traces quietly stop containing the one thing worth having in them.
 *
 * Why the order decides that. `@sentry/node` 10 is OpenTelemetry underneath, and OpenTelemetry
 * instruments a library by wrapping it as it is loaded. A module that was already loaded when the
 * SDK started is never wrapped, and this is an ESM codebase, so every `import` in an entrypoint is
 * resolved before a single line of that entrypoint's own body runs. `initMonitoring(config, 'api',
 * logger)` sits about ninety lines into `api/main.ts` - which is far too late for `pg`, and was
 * always going to be.
 *
 * Measured rather than reasoned about, on `node:24-trixie-slim`, the image this actually ships in:
 *
 * | where the SDK starts | what one traced request contains |
 * |---|---|
 * | after the imports (the shape before this file) | `http.server` transaction, two `fastify` spans |
 * | from here, imported first | the same, plus `db pg.connect` and `db SELECT ...` |
 *
 * So the difference is "that request took 400ms" against "that request took 400ms and here is the
 * query that spent it", which is the entire reason to pay for tracing.
 *
 * **It cannot decide whether the process boots.** `loadConfig` throws a readable error listing
 * every bad variable, and that error belongs to the entrypoint, which calls it a few lines later
 * and lets it kill the process. If this file let the same failure escape, the first thing anybody
 * saw of a missing `DATABASE_URL` would be a stack trace out of a file whose job is telemetry.
 * Swallowed here, reported there. `scripts/check-node-parse.mjs` imports every module in this
 * package with no environment at all, and this is also what lets it.
 *
 * There is no `--import` flag anywhere, deliberately. Sentry's ESM guidance reaches for
 * `node --import ./instrument.mjs`, which would mean the start command in `fly/api.toml`, the
 * three `dev:` scripts and the Dockerfile's `CMD` all having to agree about a flag - four places
 * to forget it, and forgetting it is silent. A first import is one line in the file that needs it.
 */

import { loadConfig } from './config.ts';
import { startSentry } from './monitoring.ts';

try {
  startSentry(loadConfig());
} catch {
  /*
   * Deliberately silent, and this is the one place in this package where a bare catch is right.
   *
   * The only failure that reaches here is `loadConfig` refusing the environment, and the
   * entrypoint that imported this file calls `loadConfig` again immediately and throws the same
   * error with the same message, at a place where the reader expects it. Reporting it twice would
   * put a telemetry file's stack trace above the readable one.
   */
}
