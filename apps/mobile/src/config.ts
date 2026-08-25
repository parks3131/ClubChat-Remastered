/**
 * Client configuration.
 *
 * `EXPO_PUBLIC_*` variables are inlined into the bundle, so only values that are safe to
 * ship in a client may go here. That is the whole list: two URLs, a Sentry DSN, and two values
 * that only describe how much this build reports. Any key that bypasses authorization must never
 * appear in a client bundle (AGENTS.md non-negotiable 5).
 */

import { Platform } from 'react-native';
import { resolveEndpoint } from './endpoint.ts';
import { traceSampleRate } from './trace-rate.ts';

/**
 * `localhost` resolves to the device itself on a physical phone, so a real device needs
 * the host machine's LAN address. Set EXPO_PUBLIC_API_URL when testing off-simulator.
 */
const defaultHost = Platform.OS === 'android' ? '10.0.2.2' : 'localhost';

export const config = {
  /*
   * Resolved through `endpoint.ts` rather than with `??`, because the two shapes differ exactly
   * where it matters. `??` treats "nothing set it" as "use the laptop", which is right on a laptop
   * and is an app that can never reach anything once it is on somebody else's phone. The resolver
   * keeps the convenience for a development build and makes absence fatal for a release one.
   */
  apiUrl: resolveEndpoint({
    variable: 'EXPO_PUBLIC_API_URL',
    raw: process.env['EXPO_PUBLIC_API_URL'],
    protocols: ['http:', 'https:'],
    developmentFallback: `http://${defaultHost}:3000`,
    isDevelopment: __DEV__,
  }),
  wsUrl: resolveEndpoint({
    variable: 'EXPO_PUBLIC_WS_URL',
    raw: process.env['EXPO_PUBLIC_WS_URL'],
    protocols: ['ws:', 'wss:'],
    developmentFallback: `ws://${defaultHost}:3001`,
    isDevelopment: __DEV__,
  }),
  /**
   * Where a crash on the phone goes.
   *
   * **A DSN is safe in a client and is not a secret**, which is worth stating because
   * non-negotiable 5 sits two paragraphs up. It is a write-only ingest address: holding it lets
   * somebody *send* events to the project, never read them. The value that must never ship is
   * the auth token used to upload source maps, and that one lives in the build environment and
   * nowhere near this file.
   *
   * **Absent is a supported state, not a degraded one** - the same property the server's
   * `monitoring.ts` is built around. With no DSN the reporter writes to the console instead, so
   * every `capture` call site runs on every development launch rather than executing for the
   * first time in production, which is when nobody is watching.
   */
  sentryDsn: process.env['EXPO_PUBLIC_SENTRY_DSN'] ?? '',
  /**
   * Which build a crash came from.
   *
   * **Derived from `__DEV__` rather than configured**, deliberately. The server takes
   * `SENTRY_ENVIRONMENT` from its environment because a server is deployed into one; a phone build
   * already knows which it is, and a value somebody has to remember to set is a value that will
   * eventually be wrong in the direction that matters - a release build reporting as development,
   * which is the one case where the label has to be right.
   *
   * Without this, a crash from a dev build and a crash from the App Store arrive in the same
   * project looking identical, and the first question anybody asks - "is this real members, or is
   * it me" - has no answer.
   *
   * Still overridable, for the build that is neither: a TestFlight release is `production` by this
   * rule and may deserve its own name.
   */
  sentryEnvironment:
    process.env['EXPO_PUBLIC_SENTRY_ENVIRONMENT'] ?? (__DEV__ ? 'development' : 'production'),
  /**
   * How much of this build's activity is TIMED, as opposed to reported when it breaks.
   *
   * A tenth, matching the three server roles, so there is one number to reason about across a
   * system whose halves share one Sentry organisation and therefore one quota. Errors are
   * unaffected by it: a crash is always sent.
   *
   * **Unlike the server's, this cannot be turned down without shipping a build**, because an
   * `EXPO_PUBLIC_*` variable is inlined into the JavaScript bundle at build time rather than read
   * at boot. That is a property of the platform rather than a decision: a phone has no
   * environment to restart into. The knob is here so the next build can carry a different number
   * without a code change, which is as close as a client gets.
   *
   * Parsed rather than read, because an empty value would otherwise mean zero. See
   * `trace-rate.ts` - the trap is real and the default is what protects it.
   */
  sentryTracesSampleRate: traceSampleRate(
    process.env['EXPO_PUBLIC_SENTRY_TRACES_SAMPLE_RATE'],
    0.1,
  ),
} as const;
