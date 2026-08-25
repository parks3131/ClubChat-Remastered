/**
 * A build-time string, read as a sampling rate.
 *
 * Its own module rather than four lines inside `config.ts`, for the reason `tab-bar-routes.ts` is
 * its own module: `config.ts` imports `react-native`, so nothing that imports it can be tested,
 * and the one interesting property here is exactly the kind that is silent when it is wrong.
 *
 * **`Number('')` is `0`.** An `EXPO_PUBLIC_*` variable is inlined into the bundle at build time,
 * and a profile in `eas.json` that declares the key with no value inlines the empty string. Read
 * naively that means "trace nothing", which is indistinguishable from a deliberate decision and
 * would leave the app silent while every config file said a tenth.
 */

/**
 * The rate this build should sample at, or `fallback` when the value is missing or nonsense.
 *
 * **Nonsense falls back rather than throwing, and that is deliberately different from the
 * server.** `packages/server/src/config.ts` refuses to boot on a rate it cannot parse, because a
 * server that will not start is a loud deploy failure somebody fixes in a minute. The same rule
 * on a phone would be a black screen in a member's hand over a telemetry value, which is a far
 * worse outcome than the wrong number of traces.
 */
export function traceSampleRate(raw: string | undefined, fallback: number): number {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === '') return fallback;
  const value = Number(trimmed);
  // `Number.isFinite` rather than `!Number.isNaN`, so `Infinity` is refused too.
  if (!Number.isFinite(value) || value < 0 || value > 1) return fallback;
  return value;
}
