/**
 * A build-time string, read as the address of a server this app cannot work without.
 *
 * Its own module rather than six lines inside `config.ts`, for the reason `trace-rate.ts` is its
 * own module: `config.ts` imports `react-native`, so nothing that imports it can be loaded under
 * vitest, and the one interesting property here is exactly the kind that is silent when it is
 * wrong.
 *
 * **A `localhost` default is right in development and catastrophic anywhere else.** An
 * `EXPO_PUBLIC_*` variable is not read at boot, it is substituted into the source at bundle time:
 * a build with the variable unset does not carry a fallback, it carries `http://localhost:3000` as
 * a literal, with the `process.env` half already deleted. On a laptop that is the whole
 * convenience of the thing. In a bundle published to phones it is an app that can never reach
 * anything, on a device with nothing listening on port 3000 and no way for anybody holding it to
 * tell that from the network being down.
 *
 * So the default is conditional on the build, and its absence is fatal rather than quiet.
 *
 * **Fatal is the recoverable outcome here, which is the part that reads backwards.** This is the
 * opposite call from `trace-rate.ts`, which refuses to crash a launch over a bad telemetry value,
 * and the difference is what the app can still do afterwards. A wrong sampling rate costs traces;
 * an unreachable API costs everything, so there is no degraded mode to protect. And a throw during
 * bundle evaluation, which is where this runs, is the one failure `expo-updates` can undo by
 * itself: an error thrown before the first frame makes it mark that update failed locally, never
 * launch it again on that device, and fall back to the last one that worked. A bundle that refuses
 * to start therefore recalls itself phone by phone. A bundle that starts and points at localhost
 * has to be recalled by a person, and only reaches the phones that have not taken it yet
 * (ADR-0048).
 */

/** The value the caller was given, or a thrown error naming the variable and the fix. */
export function resolveEndpoint(options: {
  /** The `EXPO_PUBLIC_*` name, so the error says which one to set. */
  variable: string;
  /** What the bundler substituted, which is `undefined` when nothing set it. */
  raw: string | undefined;
  /** Schemes this address is allowed to use, with the colon: `['http:', 'https:']`. */
  protocols: readonly string[];
  /** Where a development build points when nothing set the variable. */
  developmentFallback: string;
  /** `__DEV__`, passed in rather than read, so this module stays loadable off-device. */
  isDevelopment: boolean;
}): string {
  const { variable, raw, protocols, developmentFallback, isDevelopment } = options;

  /*
   * Empty counts as absent. A profile that declares the key with no value inlines `''`, which
   * `?? ` treats as a perfectly good address and every caller then concatenates a path onto. Same
   * trap `trace-rate.ts` documents, one type over.
   */
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === '') {
    if (isDevelopment) return developmentFallback;
    throw new Error(
      `${variable} is not set, and this is not a development build. A release bundle has no ` +
        `development server to fall back on, so it refuses to start rather than ship pointing at ` +
        `${developmentFallback}. Set it in the EAS environment this build or update reads: ` +
        `eas env:set --name ${variable} --value <url> --environment production ` +
        `--visibility plaintext`,
    );
  }

  /*
   * Matched with a regular expression rather than `new URL`, deliberately. React Native's `URL` is
   * a partial implementation rather than the Node one this file's tests run against, and it has
   * historically accepted a scheme-less string without complaint - so a check that passes under
   * vitest could wave the same value through on the device, which is the exact shape of bug this
   * module exists to remove. A scheme, `://`, and something after it is all that needs deciding.
   */
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.+)$/.exec(trimmed);
  if (scheme === null || !protocols.includes(`${scheme[1]?.toLowerCase()}:`)) {
    throw new Error(
      `${variable} is "${trimmed}", which is not ${protocols.join(' or ')} followed by a host. ` +
        `A scheme-less or wrong-scheme address fails at the first request with a message about ` +
        `the network rather than about this value.`,
    );
  }

  /*
   * Trailing slashes removed, because every caller builds `${apiUrl}${path}` with a leading slash
   * on the path, and `monitoring.ts` matches this string against outgoing request URLs to decide
   * what to trace. One typed slash would otherwise produce `//me` and a trace target that matches
   * nothing.
   */
  return trimmed.replace(/\/+$/, '');
}
