/**
 * Where an error goes when nobody is looking at a terminal.
 *
 * > **`SPEC/TECH/15` asked for this "in the error path from the first commit" and it was never
 * > built.** Until now a 500, a failed effect and a dropped socket were logged by pino and
 * > reached nobody: `PRD/17` lists it under "blocking a real release" as "a crash or failed load
 * > in real use is **invisible**", and that was exactly true.
 *
 * Four properties this module exists to hold, each of which is a way it could have been built
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
 *  4. **How much is traced is configuration, not a constant.** This module said
 *     `tracesSampleRate: 0` and explained that performance was a separate decision; the separate
 *     decision was never made, so a slow request left no record anywhere for the whole life of
 *     the deployment. The rate now comes from `SENTRY_TRACES_SAMPLE_RATE`, which means it can be
 *     turned down at 3am with a restart instead of a rebuild.
 *
 * **Where the SDK is started from matters, and it is not this file.** `instrument.ts` is the first
 * import of all three entrypoints and calls `startSentry` before `fastify`, `pg` or `ioredis` are
 * loaded. That ordering is the whole difference between a trace that says "the request took 400ms"
 * and one that says which query spent it: the OpenTelemetry instrumentation can only wrap a module
 * it sees being loaded. Proved rather than assumed - starting the SDK after those imports produces
 * an `http.server` transaction with no `db` spans under it at all.
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

/** Is anything being reported anywhere but the local log? Asked in three places, defined once. */
function reportingEnabled(config: Config): boolean {
  return config.SENTRY_DSN !== undefined && config.SENTRY_DSN.length > 0;
}

/**
 * The routes that are never traced, whatever the sample rate says.
 *
 * Fly polls `/ready` on a timer for as long as the app exists, and a monitor watching the deploy
 * polls `/health` and `/__parity` beside it. At any rate above zero they would be the
 * overwhelming majority of everything recorded - and they measure nothing: `/health` answers from
 * memory, `/ready` is one round trip to Postgres, and `/__parity` is an HMAC over a constant.
 * Tracing them spends the whole quota proving the machine is switched on, and buries the handful
 * of traces that are about a member waiting for something.
 *
 * Excluded here rather than by a Sentry inbound filter, because a filter drops the event after it
 * has been sent and counted. This never sends it.
 */
const UNTRACED_PATHS = new Set(['/health', '/ready', '/__parity']);

/*
 * The sampler's types, taken from the option rather than imported from `@sentry/core`.
 *
 * `@sentry/core` is a transitive dependency here, not a declared one - importing a type from it
 * would be reaching through `@sentry/node` into something this package never asked for, and it
 * would break silently on a major bump. Deriving them from the option means they are whatever
 * the installed SDK says they are.
 */
type TracesSampler = NonNullable<Sentry.NodeOptions['tracesSampler']>;
type SamplingContext = Parameters<TracesSampler>[0];

/**
 * The request path a span is about, if it is about one at all.
 *
 * Read from the span's attributes rather than from its name, because the name is not final yet:
 * at sampling time the HTTP instrumentation has started the span but Fastify has not matched a
 * route, so the name is the raw URL and only becomes `GET /clubs/:id` afterwards. The attribute
 * is the raw path either way, which is what a fixed exclusion list wants.
 *
 * Two spellings because the two are set by different OpenTelemetry semantic-convention versions
 * and both appear on the same span today.
 */
function sampledPath(context: SamplingContext): string | undefined {
  const attributes = context.attributes ?? {};
  const value = attributes['url.path'] ?? attributes['http.target'];
  if (typeof value !== 'string') return undefined;
  return value.split('?')[0] ?? value;
}

/**
 * Exactly what `Sentry.init` is given, as a value.
 *
 * Exported so the sampling policy and the release can be asserted without starting a client,
 * which is what `monitoring.test.ts` does. The one thing this shape cannot answer is what the SDK
 * then does to an event on its way out, and that took a real client and a real transport to see -
 * see `test/monitoring-sdk.test.ts` and the Fastify note below.
 */
/*
 * Path segments whose NEXT segment is a credential, and query keys whose value is one.
 *
 * `invites` covers `/invites/:token/preview` and `/invites/:token/redeem`, which are the only two
 * routes today that carry a secret in a URL. Password reset carries its token in a POST body, so
 * it is not here and does not need to be.
 *
 * Kept as a list of PATTERNS rather than a list of routes on purpose. The defect this replaces was
 * a per-route opt-out: the author of `/invites/:token/preview` closed the pino sink with
 * `logLevel: 'warn'` and a docblock explaining exactly why, and the two Sentry sinks stayed open
 * behind it because closing them is a different file. Anything matching the pattern is covered
 * whether or not whoever adds it has read this.
 */
const SECRET_PATH_PARENTS = new Set(['invites']);
const SECRET_QUERY_KEYS = new Set(['token', 'secret', 'key', 'code', 'password', 'signature']);
const REDACTED = '[redacted]';

/**
 * The same URL with any credential in it replaced, or the input unchanged when there is none.
 *
 * Parsed by splitting rather than with `new URL`, because most of what arrives here is not a whole
 * URL: `url.path` is a path, `http.target` is a path and a query, and a breadcrumb can hold
 * anything at all. `new URL` throws on every one of those, and a redactor that throws is a
 * redactor that gets wrapped in a `try` and silently stops redacting.
 */
export function redactUrl(value: string): string {
  const [beforeFragment, ...fragment] = value.split('#');
  const [path = '', ...query] = (beforeFragment ?? '').split('?');

  const segments = path.split('/');
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (SECRET_PATH_PARENTS.has((segments[i] ?? '').toLowerCase())) {
      /*
       * Only when there is something there. `/invites/` with nothing after it is a 404, not a
       * leak, and rewriting it to `/invites/[redacted]` would invent a credential that was never
       * sent.
       */
      if ((segments[i + 1] ?? '') !== '') segments[i + 1] = REDACTED;
    }
  }

  const redactedQuery = query.join('?').split('&').map((pair) => {
    const eq = pair.indexOf('=');
    if (eq === -1) return pair;
    const key = pair.slice(0, eq);
    return SECRET_QUERY_KEYS.has(key.toLowerCase()) ? `${key}=${REDACTED}` : pair;
  });

  const rebuilt = segments.join('/') + (query.length > 0 ? `?${redactedQuery.join('&')}` : '');
  return fragment.length > 0 ? `${rebuilt}#${fragment.join('#')}` : rebuilt;
}

/*
 * Every span attribute the SDK puts a URL in. Named rather than pattern-matched on the key, so a
 * new attribute is a visible addition here instead of something a wildcard quietly did or did not
 * catch.
 */
const URL_ATTRIBUTES = ['url.full', 'url.path', 'url.query', 'http.url', 'http.target'];

function redactAttributes(data: Record<string, unknown> | undefined): void {
  if (data === undefined) return;
  for (const key of URL_ATTRIBUTES) {
    const current = data[key];
    if (typeof current === 'string') data[key] = redactUrl(current);
  }
}

/**
 * An event with every credential-bearing URL in it redacted, in place.
 *
 * Runs on BOTH `beforeSend` and `beforeSendTransaction`, because the two sinks are independent:
 * `request.url` rides on error events regardless of the sample rate, and the span attributes ride
 * on sampled transactions. Closing one and not the other is what the route-level fix did.
 *
 * It redacts and returns the event. It never returns `null`: dropping the report would take the
 * 5xx with it, and losing the error is a worse outcome than the URL that made it interesting.
 */
function redactEvent<T extends { request?: { url?: string }; contexts?: Record<string, unknown>; spans?: unknown[]; breadcrumbs?: unknown[] }>(
  event: T,
): T {
  if (typeof event.request?.url === 'string') event.request.url = redactUrl(event.request.url);

  const trace = event.contexts?.['trace'] as { data?: Record<string, unknown> } | undefined;
  redactAttributes(trace?.data);

  for (const span of event.spans ?? []) {
    redactAttributes((span as { data?: Record<string, unknown> }).data);
  }

  for (const crumb of event.breadcrumbs ?? []) {
    const data = (crumb as { data?: Record<string, unknown> }).data;
    if (data !== undefined && typeof data['url'] === 'string') {
      data['url'] = redactUrl(data['url']);
    }
  }

  return event;
}

export function sentryInitOptions(config: Config): Sentry.NodeOptions {
  return {
    dsn: config.SENTRY_DSN,
    environment: config.SENTRY_ENVIRONMENT,
    /*
     * The commit this build came from. Without it a stack trace points at line numbers in a
     * source nobody can identify afterwards, which is most of the value of having the trace.
     *
     * Spread rather than assigned, so an absent release is an ABSENT KEY. `release: undefined`
     * would be equivalent, but `release: ''` - which is what an unpassed Docker build arg used to
     * produce - is not: it makes release health report on a release nobody can name. `config.ts`
     * normalizes the empty case to undefined and this preserves it.
     */
    ...(config.SENTRY_RELEASE === undefined ? {} : { release: config.SENTRY_RELEASE }),
    /*
     * **The SDK must not capture Fastify errors itself, and this line is why every 5xx used to
     * arrive with no `where` tag and no route.**
     *
     * `@sentry/node` 10 hooks Fastify 5's diagnostics channel and captures a failing request
     * before `app.ts`'s `setErrorHandler` runs. Two captures of one `Error` means the Dedupe
     * integration keeps the FIRST and drops the second - so the event that reached Sentry was the
     * SDK's, which knows nothing about `where`, `method`, `route` or `userId`, and ours, which is
     * the whole grouping design, was thrown away. Nothing about that is visible from inside the
     * process: `capture` ran, returned an event id, and an issue appeared. Only the tags on the
     * issue were missing. Found by pointing the forced-5xx drill at a collector and reading the
     * envelope; asserted now by `test/monitoring-sdk.test.ts`.
     *
     * Only the ERROR CAPTURE is turned off. The Fastify tracing instrumentation stays, which is
     * what names a transaction `GET /clubs/:id` instead of `GET /clubs/<uuid>`.
     */
    integrations: [Sentry.fastifyIntegration({ shouldHandleError: () => false })],
    /*
     * A sampler rather than a flat `tracesSampleRate`, because a flat rate cannot say "never trace
     * the liveness poll". The SDK ignores `tracesSampleRate` entirely whenever a sampler is
     * present, so setting both would be two sources of truth for one number, one of which does
     * nothing.
     */
    /*
     * Both sinks, because they are independent. See `redactEvent`.
     */
    beforeSend: (event) => redactEvent(event),
    beforeSendTransaction: (event) => redactEvent(event),
    tracesSampler: (context) => {
      const path = sampledPath(context);
      if (path !== undefined && UNTRACED_PATHS.has(path)) return 0;
      /*
       * Inherit an incoming trace's decision where there is one, and fall back to our rate where
       * there is not. Half a distributed trace is worse than none: the phone's span says the send
       * took two seconds and the server half - the half that says why - is missing, because both
       * ends rolled their own dice.
       */
      return context.inheritOrSampleWith(config.SENTRY_TRACES_SAMPLE_RATE);
    },
  };
}

/**
 * Start the SDK for this process, once.
 *
 * **Called from `instrument.ts`, which every entrypoint imports first**, so this runs before
 * `fastify`, `pg` and `ioredis` are loaded and the OpenTelemetry instrumentation can wrap them.
 * `initMonitoring` calls it too, for the callers that have no preload - a test, or a tool that
 * imports a module directly - and the guard below is what makes calling it twice safe rather than
 * destructive.
 */
export function startSentry(config: Config): void {
  if (!reportingEnabled(config)) return;
  /*
   * Already running. `Sentry.init` is not idempotent: a second call builds a second client and
   * makes it current, and the instrumentation registered by the first one goes on reporting into
   * a client nothing flushes. Silence that looks exactly like working.
   */
  if (Sentry.getClient() !== undefined) return;
  Sentry.init(sentryInitOptions(config));
}

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
  const enabled = reportingEnabled(config);

  if (enabled) {
    startSentry(config);
    /*
     * The role, on the global scope rather than in `initialScope`.
     *
     * `initialScope` is an init option, and init now usually happens in `instrument.ts` - which
     * runs before this module knows whether it is the api, the gateway or the worker. Setting the
     * tag here is the same tag on the same reports; it is only later.
     */
    Sentry.getGlobalScope().setTag('service', service);

    if (config.SENTRY_RELEASE === undefined) {
      /*
       * Reporting is on and nothing will say which build a report came from.
       *
       * The likeliest cause is a deploy that skipped `--build-arg SENTRY_RELEASE=$(git rev-parse
       * HEAD)`, which is silent everywhere else: the image builds, the app boots, errors arrive,
       * and every one of them is against unknown source. Said out loud once per boot, at error
       * level, because it is a defect in the deploy rather than a preference.
       */
      logger.error(
        { service },
        'SENTRY_DSN is set but SENTRY_RELEASE is not: reports will not name a build. ' +
          'Deploy with --build-arg SENTRY_RELEASE="$(git rev-parse HEAD)".',
      );
    }
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
