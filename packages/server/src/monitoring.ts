/**
 * Where an error goes when nobody is looking at a terminal.
 *
 * > **`SPEC/TECH/15` asked for this "in the error path from the first commit" and it was never
 * > built.** Until now a 500, a failed effect and a dropped socket were logged by pino and
 * > reached nobody: `PRD/17` lists it under "blocking a real release" as "a crash or failed load
 * > in real use is **invisible**", and that was exactly true.
 *
 * Three properties this module exists to hold, each of which is a way it could have been built
 * wrong:
 *
 *  1. **Reporting never changes behaviour.** `capture` cannot throw and never rejects. A monitor
 *     that can fail is a second failure mode bolted onto the first one, and it would fire at
 *     precisely the moment the system is already unhappy.
 *  2. **Absent configuration is a supported state, not a degraded one.** With no `SENTRY_DSN`
 *     this still reports - to the process logger, where a developer can see it - so the call
 *     sites are exercised on every dev run and in CI rather than only in production. A no-op
 *     stub would mean the first time these paths ran for real would be the first time they ran
 *     at all.
 *  3. **The report says which build it came from.** A stack trace against unknown source is a
 *     puzzle; `release` ties it to a commit.
 *
 * Deliberately NOT a Fastify plugin: the worker and the gateway have no Fastify, and the whole
 * point is that all three processes report the same way.
 */

import * as Sentry from '@sentry/node';
import type { Config } from './config.ts';

/** Anything that can carry a report onward. Pino satisfies it; so does `console`. */
export type ReportLogger = {
  error: (payload: Record<string, unknown>, message?: string) => void;
};

export type Monitor = {
  /**
   * Record something that went wrong.
   *
   * `where` is a stable string naming the call site - `worker.drain`, `api.request` - so that
   * reports group by cause rather than by whichever message the error happened to carry.
   */
  capture(error: unknown, where: string, context?: Record<string, unknown>): void;
  /** Give in-flight reports a chance to leave before the process does. */
  flush(timeoutMs?: number): Promise<void>;
};

/**
 * Start reporting for this process.
 *
 * Called once per entrypoint, before anything that could fail. `service` distinguishes the three
 * roles in one Sentry project rather than needing three.
 */
export function initMonitoring(
  config: Config,
  service: 'api' | 'gateway' | 'worker',
  logger: ReportLogger,
): Monitor {
  const enabled = config.SENTRY_DSN !== undefined && config.SENTRY_DSN.length > 0;

  if (enabled) {
    Sentry.init({
      dsn: config.SENTRY_DSN!,
      environment: config.SENTRY_ENVIRONMENT,
      /*
       * The commit this build came from. Without it a stack trace points at line numbers in a
       * source nobody can identify afterwards, which is most of the value of having the trace.
       */
      ...(config.SENTRY_RELEASE === undefined ? {} : { release: config.SENTRY_RELEASE }),
      /*
       * Errors only. Performance tracing is a separate decision with its own quota cost, and
       * belongs with the performance audit rather than smuggled in here.
       */
      tracesSampleRate: 0,
      initialScope: { tags: { service } },
    });
  }

  return {
    capture(error, where, context) {
      /*
       * Logged EVERY time, whether or not Sentry is configured, and before the send is attempted.
       * The local log is the one that cannot fail; the remote one is the one that can.
       */
      logger.error(
        { err: error, where, service, ...(context ?? {}) },
        `captured error at ${where}`,
      );

      if (!enabled) return;

      try {
        Sentry.withScope((scope) => {
          scope.setTag('where', where);
          if (context !== undefined) scope.setContext('detail', context);
          Sentry.captureException(error);
        });
      } catch {
        /*
         * The reporter failing must never become the incident. Swallowed deliberately and it is
         * the one place in this codebase where that is right: the error itself has already been
         * written to the log above, so nothing is lost by giving up on the remote copy.
         */
      }
    },

    async flush(timeoutMs = 2000) {
      if (!enabled) return;
      try {
        await Sentry.flush(timeoutMs);
      } catch {
        // Same reasoning as `capture`. Shutdown must not hang or fail on the reporter.
      }
    },
  };
}

/**
 * A monitor that reports nowhere, for tests.
 *
 * Tests assert behaviour, not telemetry, and a suite that initialised the real SDK would either
 * need a DSN or spend its time on a disabled client. Exported rather than reconstructed per test
 * so there is one definition of "no monitoring".
 */
export function silentMonitor(): Monitor {
  return { capture() {}, async flush() {} };
}
