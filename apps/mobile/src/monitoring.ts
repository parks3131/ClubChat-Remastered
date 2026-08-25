/**
 * Where a crash on the phone goes.
 *
 * **The client half of `packages/server/src/monitoring.ts`, and deliberately the same shape** -
 * one `capture(error, where, context)` that cannot throw, plus an init called once at startup.
 * A reader who has met the server's Monitor has met this one, which is the same argument
 * `MediaStore`/`FakeMediaStore` and `Mailer`/`LoggingMailer` already make in this codebase.
 *
 * > **`PRD/17` listed error monitoring as release-blocking and it was closed 2026-08-03 for the
 * > server only.** The row said so plainly - "the mobile client is not covered; a JS crash on the
 * > phone still reaches nobody" - and that stayed true through every defect this project found on
 * > a device. Most of them were found because somebody was holding the phone and said so.
 *
 * Three properties, each a way this could have been built wrong:
 *
 *  1. **Reporting never changes behaviour.** `capture` cannot throw and never rejects. A reporter
 *     that can fail is a second failure bolted onto the first, firing exactly when the app is
 *     already unhappy.
 *  2. **Absent configuration is a supported state.** With no DSN this still reports, to the
 *     console, so the call sites are exercised on every development launch instead of running for
 *     the first time in production. A no-op stub would mean the first real execution is also the
 *     first execution.
 *  3. **The local record is written first.** The console line happens before the network attempt,
 *     because the local one cannot fail and the remote one can.
 *
 * **Not a React component and not a hook**, so it can be called from the sync engine, the send
 * outbox and a `catch` in a plain module - which is where the interesting failures are.
 */

import * as Sentry from '@sentry/react-native';
import { config } from './config.ts';

/** A stable name for the call site, so reports group by cause rather than by message. */
export type Where = string;

export type Monitor = {
  capture(error: unknown, where: Where, context?: Record<string, unknown>): void;
};

const enabled = config.sentryDsn.length > 0;

/**
 * Start reporting. Called once, as early as the app has a chance to run code.
 *
 * Safe to call when no DSN is set: it simply does not initialise the SDK, and `capture` falls
 * back to the console. Safe to call twice, because the guard below is the same one `capture`
 * reads.
 */
export function initMonitoring(): void {
  Sentry.init({
    /*
     * **Always called, and `enabled` carries the on/off rather than an early return.**
     *
     * Returning early left `Sentry.wrap` in the root layout holding a client that was never
     * initialised, which warns `App Start Span could not be finished` on every single launch. A
     * warning that fires every time is a warning people learn to scroll past, and this one would
     * have been sitting above the real ones.
     *
     * It is also the honest reading of this module's second property: with no DSN the SDK still
     * starts and simply sends nothing, so the code path in development is the production path
     * with the transport switched off - rather than a different path that has never run.
     */
    enabled,
    dsn: config.sentryDsn,
    /*
     * Which build this came from, so a crash on the founder's dev phone is distinguishable from a
     * crash in front of a real club. Both land in one project; only this tells them apart.
     */
    environment: config.sentryEnvironment,
    /*
     * How much is timed, from `config.ts` rather than from a constant here.
     *
     * > **This said `tracesSampleRate: 0` with a comment calling performance a separate decision.
     * > The separate decision was never made**, on either half of the system, so nothing anywhere
     * > has ever recorded how long anything took in front of a real member.
     *
     * A tenth, the same number the three server roles use, because both halves report into one
     * Sentry organisation and therefore one quota. Errors are unaffected: a crash is always sent.
     *
     * **What this will and will not produce today, stated plainly rather than discovered later.**
     * The SDK's automatic instrumentation attaches HTTP spans to a root span, and the root spans
     * on a phone come from navigation - which needs `Sentry.reactNavigationIntegration()`
     * registered against expo-router's navigation container in `app/_layout.tsx`. That is not
     * wired, so a raised rate will mostly find nothing to sample yet. The rate is configuration
     * first so that wiring it is one change rather than two, and so the value can be turned down
     * for the build after this one without touching code.
     */
    tracesSampleRate: config.sentryTracesSampleRate,
    /*
     * Which hosts a `sentry-trace` header is attached to, and it is a short list on purpose.
     *
     * The SDK's default on a native build is a regular expression that matches everything, so a
     * trace header goes on every outgoing request, to anybody. This app also fetches signed media
     * from `cdn.clubchatapp.com`, and there is no reason for a third party to receive a header
     * describing our tracing. Pinning it to the API has the
     * second effect of making the server half of a trace joinable at all: the api's sampler
     * inherits an incoming decision rather than re-rolling it, so the phone's span and the
     * server's span end up in one trace instead of two halves of a story.
     */
    tracePropagationTargets: [config.apiUrl],
    /*
     * **Off, and this is a privacy decision rather than a default left alone.** Session Replay
     * records the screen, and this app shows private one-to-one conversations. `PRD/16` allows no
     * analytics or third-party data sharing at all, and a replay of a DM is the most personal
     * thing the product holds.
     */
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    /*
     * Do not attach the message the user was typing, or anything else the SDK guesses might be
     * useful. Only what a `capture` call passes explicitly.
     */
    sendDefaultPii: false,
  });
}

/**
 * Record something that went wrong.
 *
 * `where` is a stable string naming the call site - `sync.channel`, `outbox.flush` - so reports
 * group by cause. Never pass message bodies or anything a member typed: this leaves the device.
 */
export function capture(error: unknown, where: Where, context?: Record<string, unknown>): void {
  /*
   * Logged every time, configured or not, and BEFORE the send is attempted. In development this
   * is the whole feature - it lands in the Metro log where somebody can see it - and in
   * production it is the copy that cannot fail.
   *
   * > **`warn` and never `error`, and this is behavioural rather than stylistic.** React Native's
   * > LogBox turns a `console.error` into a **full-screen overlay** in development, so reporting a
   * > handled failure would cover the app with a red screen the member has to dismiss. That breaks
   * > this module's first property - reporting never changes behaviour - and it breaks it in the
   * > worst place, because `capture` is called from paths that are already degraded and already
   * > recovering: a failed reconcile, a cache falling back to memory. Those are handled, and the
   * > app is meant to carry on.
   * >
   * > Found by shipping it: the smoke test that proved the pipeline works also put a Console Error
   * > overlay on the founder's phone at launch. Severity here belongs to Sentry, which gets a real
   * > `captureException` below; the console copy exists so a developer can see it, and a warning
   * > is visible in Metro without seizing the screen.
   */
  // eslint-disable-next-line no-console
  console.warn(`[monitor] ${where}`, error, context ?? {});

  if (!enabled) return;

  try {
    Sentry.withScope((scope) => {
      scope.setTag('where', where);
      if (context !== undefined) scope.setContext('detail', context);
      Sentry.captureException(error);
    });
  } catch {
    /*
     * The reporter failing must never become the incident. Swallowed deliberately, and it is one
     * of the few places in this codebase where that is right: the error has already been written
     * to the console above, so nothing is lost by giving up on the remote copy.
     */
  }
}

/** The port, for a caller that would rather hold an object than import a function. */
export const monitor: Monitor = { capture };
