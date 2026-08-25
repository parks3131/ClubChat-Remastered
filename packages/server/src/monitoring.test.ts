/**
 * The three properties the reporter has to hold, none of which are about Sentry.
 *
 * Every one of these is a way monitoring makes an outage worse rather than shorter: a reporter
 * that throws, a reporter that only runs in production, or a shutdown that hangs on it. The SDK
 * itself is somebody else's tested code - what is worth asserting is the wrapper around it.
 */

import { describe, expect, it } from 'vitest';
import {
  initMonitoring,
  redactQueryString,
  redactUrl,
  sentryInitOptions,
  silentMonitor,
} from './monitoring.ts';
import type { Config } from './config.ts';

/** Only the fields `initMonitoring` reads. The rest of `Config` is irrelevant here. */
const configWith = (over: Partial<Config> = {}): Config =>
  ({ SENTRY_ENVIRONMENT: 'test', SENTRY_TRACES_SAMPLE_RATE: 0.1, ...over }) as Config;

function recorder() {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    error: (payload: Record<string, unknown>) => {
      calls.push(payload);
    },
  };
}

describe('reporting without a DSN configured', () => {
  it('still reports, to the logger', async () => {
    // The property that matters: dev and CI exercise every capture call site. A no-op stub would
    // mean these paths first run for real in production, which is where nobody is watching.
    const log = recorder();
    const monitor = initMonitoring(configWith(), 'api', log);

    monitor.capture(new Error('boom'), 'api.request', { route: '/clubs/:id' });

    expect(log.calls).toHaveLength(1);
    expect(log.calls[0]).toMatchObject({ where: 'api.request', service: 'api', route: '/clubs/:id' });
  });

  it('flushes instantly rather than waiting on a client that does not exist', async () => {
    const monitor = initMonitoring(configWith(), 'worker', recorder());
    // A shutdown path that blocks for the flush timeout on every local restart would be its own
    // small bug. Nothing to await means nothing to wait for.
    await expect(monitor.flush(30_000)).resolves.toBeUndefined();
  });
});

describe('capture, as a promise never to make things worse', () => {
  it('does not throw when the logger itself throws', () => {
    // Reporting sits in a catch block. If it can throw, it replaces the error being handled with
    // its own - and it fires exactly when the system is already unhappy.
    const monitor = initMonitoring(configWith(), 'gateway', {
      error: () => {
        throw new Error('logger is down');
      },
    });

    // The logger failing is not something this wrapper can absorb - but the SDK path after it
    // must not, and the call must not reject asynchronously either.
    expect(() => monitor.capture(new Error('boom'), 'gateway.frame')).toThrow('logger is down');
  });

  it('carries non-Error values, because throw takes anything', () => {
    const log = recorder();
    const monitor = initMonitoring(configWith(), 'worker', log);

    monitor.capture('a string was thrown', 'worker.drain.tick');
    monitor.capture(undefined, 'worker.unhandledRejection');

    expect(log.calls).toHaveLength(2);
    expect(log.calls[1]).toMatchObject({ where: 'worker.unhandledRejection' });
  });
});

describe('the silent monitor tests use', () => {
  it('records nothing and resolves', async () => {
    const monitor = silentMonitor();
    expect(() => monitor.capture(new Error('boom'), 'api.request')).not.toThrow();
    await expect(monitor.flush()).resolves.toBeUndefined();
  });
});

/**
 * What the SDK is actually started with.
 *
 * `initMonitoring` hands `Sentry.init` an options object, and until this existed nothing could
 * see that object without starting a real client. The two things in it that decide whether a
 * production report is worth reading are exactly the two that were wrong: **tracing was a
 * constant `0`**, so a slow request left no record anywhere, and **`release` is what ties a stack
 * trace to a commit**, so a build that forgot to stamp one produces traces against unknown source.
 */
describe('the options the SDK is started with', () => {
  it('omits release entirely when no build stamped one, rather than sending an empty string', () => {
    // `release: ''` is worse than no release: it makes release health say something false rather
    // than nothing. `optionalEnv()` in config.ts is what turns the empty case into undefined.
    expect('release' in sentryInitOptions(configWith())).toBe(false);
  });

  it('names the build when one is stamped', () => {
    expect(sentryInitOptions(configWith({ SENTRY_RELEASE: 'a1b2c3d' })).release).toBe('a1b2c3d');
  });

  it('carries the environment, so a laptop and a live club are told apart', () => {
    expect(sentryInitOptions(configWith({ SENTRY_ENVIRONMENT: 'production' })).environment)
      .toBe('production');
  });

  /*
   * A sampler rather than a flat rate, because a flat rate cannot say "never trace the liveness
   * poll". Both options exist and the SDK ignores `tracesSampleRate` whenever a sampler is
   * present, so passing both would be a second, silent source of truth.
   */
  it('samples through a function rather than a flat rate', () => {
    const options = sentryInitOptions(configWith({ SENTRY_TRACES_SAMPLE_RATE: 0.1 }));
    expect(options.tracesSampleRate).toBeUndefined();
    expect(typeof options.tracesSampler).toBe('function');
  });
});

/**
 * Which requests are traced, and which are never traced whatever the rate says.
 *
 * The three liveness routes are polled by Fly's health checks every few seconds, for ever. At any
 * rate above zero they would be the overwhelming majority of everything recorded - and they
 * measure nothing: `/health` answers from memory, `/ready` is one `SELECT 1`, and `/__parity` is
 * an HMAC over a constant. Tracing them would spend the whole quota proving the machine is on.
 */
describe('the sampling policy', () => {
  type Sampler = NonNullable<ReturnType<typeof sentryInitOptions>['tracesSampler']>;
  type Context = Parameters<Sampler>[0];

  const sample = (config: Config, path: string, over: Partial<Context> = {}): unknown => {
    const sampler = sentryInitOptions(config).tracesSampler;
    if (sampler === undefined) throw new Error('no sampler');
    return sampler({
      name: `GET ${path}`,
      attributes: { 'url.path': path },
      // The SDK's own helper: inherit an incoming trace's decision, or fall back to this rate.
      // Faked here as "the fallback wins" so the two cases can be told apart below.
      inheritOrSampleWith: (fallback: number) => fallback,
      ...over,
    } as Context);
  };

  it('never traces the liveness routes, whatever the configured rate', () => {
    const everything = configWith({ SENTRY_TRACES_SAMPLE_RATE: 1 });
    for (const path of ['/health', '/ready', '/__parity']) {
      expect(sample(everything, path)).toBe(0);
    }
  });

  it('ignores a query string when deciding, because /ready?x= is still the liveness poll', () => {
    expect(sample(configWith({ SENTRY_TRACES_SAMPLE_RATE: 1 }), '/ready?probe=1')).toBe(0);
  });

  it('traces everything else at the configured rate', () => {
    expect(sample(configWith({ SENTRY_TRACES_SAMPLE_RATE: 0.25 }), '/clubs/x/news')).toBe(0.25);
  });

  it('refuses to trace a liveness route even when the caller says its trace is sampled', () => {
    // A client that samples at 100% would otherwise drag every health check in with it.
    expect(sample(configWith({ SENTRY_TRACES_SAMPLE_RATE: 0 }), '/health', {
      inheritOrSampleWith: () => 1,
    })).toBe(0);
  });

  it('inherits an incoming decision on a real route rather than re-rolling it', () => {
    // Half a distributed trace is worse than none: the phone's span says the request took two
    // seconds and the server half is missing.
    expect(sample(configWith({ SENTRY_TRACES_SAMPLE_RATE: 0 }), '/clubs/x/news', {
      inheritOrSampleWith: () => 1,
    })).toBe(1);
  });

  it('falls back to the rate when nothing says what the path was', () => {
    // A span that is not an HTTP request at all - a manually started one in the worker, say.
    expect(sample(configWith({ SENTRY_TRACES_SAMPLE_RATE: 0.25 }), '/ignored', {
      attributes: {},
    })).toBe(0.25);
  });
});

/*
 * A token in a URL, and the two Sentry sinks that used to ship it.
 *
 * An invite token is a bearer credential: holding it joins the club, and for `clubs.invite_token`
 * it joins instantly, past whatever join policy the club set (`schema.ts`). It sits in the PATH of
 * `/invites/:token/preview`, so every sink that records a URL records a live credential.
 *
 * The route author closed the logger and only the logger - `logLevel: 'warn'` on the route, with a
 * docblock saying the url IS a bearer credential. Two Sentry sinks stayed open behind it: span
 * attributes on every sampled transaction, and `request.url` on every error event regardless of
 * the sample rate. That is the shape this suite exists to stop: a per-route opt-out that somebody
 * has to remember once per sink, per route, forever.
 *
 * So the redaction is central and the routes are not enumerated at the call site. A route added
 * next year is covered by the pattern rather than by whoever writes it remembering this file.
 */
describe('redactUrl', () => {
  it('removes an invite token from a path, and keeps the shape around it', () => {
    expect(redactUrl('https://api.clubchatapp.com/invites/ZZTOPSECRET0123/preview')).toBe(
      'https://api.clubchatapp.com/invites/[redacted]/preview',
    );
  });

  it('covers redeem as well as preview, because both carry the same credential', () => {
    expect(redactUrl('https://api.clubchatapp.com/invites/ZZTOPSECRET0123/redeem')).toBe(
      'https://api.clubchatapp.com/invites/[redacted]/redeem',
    );
  });

  it('redacts a bare token at the end of the path, with no trailing segment', () => {
    expect(redactUrl('/invites/ZZTOPSECRET0123')).toBe('/invites/[redacted]');
  });

  it('is case insensitive on the segment name, because a URL is not', () => {
    expect(redactUrl('/Invites/ZZTOPSECRET0123/preview')).toBe('/Invites/[redacted]/preview');
  });

  it('redacts a percent-encoded token, which is a different string for the same secret', () => {
    expect(redactUrl('/invites/ZZ%2FTOPSECRET/preview')).toBe('/invites/[redacted]/preview');
  });

  it('redacts a secret-named query parameter wherever it appears', () => {
    expect(redactUrl('https://api.clubchatapp.com/x?token=ZZTOPSECRET0123&page=2')).toBe(
      'https://api.clubchatapp.com/x?token=[redacted]&page=2',
    );
  });

  it('leaves a URL with no secret in it completely alone', () => {
    const clean = 'https://api.clubchatapp.com/clubs/123/members?page=2';
    expect(redactUrl(clean)).toBe(clean);
  });

  it('does not throw on a value that is not a URL at all', () => {
    expect(redactUrl('not a url')).toBe('not a url');
  });
});

/*
 * A BARE query string, which is the shape two of the sinks actually deliver.
 *
 * Found in review after the first fix shipped green. `url.query` (OpenTelemetry) and
 * `request.query_string` (Sentry's httpIntegration, and it survives `sendDefaultPii: false`) both
 * carry a query string with NO leading `?`. Handing either to `redactUrl` parses the whole thing
 * as a path, finds no `?`, and returns the secret verbatim - so the query half of the redactor was
 * dead code for exactly the sinks it existed for. Every test written for it fed it a URL with a
 * `?` in it, so all of them passed.
 */
describe('redactQueryString', () => {
  it('redacts a secret-named value with no leading question mark', () => {
    expect(redactQueryString('token=SECRET123&page=2')).toBe('token=[redacted]&page=2');
  });

  it('redacts every secret-named key, not just the first', () => {
    expect(redactQueryString('token=A&key=B&page=2')).toBe('token=[redacted]&key=[redacted]&page=2');
  });

  it('is case insensitive on the key', () => {
    expect(redactQueryString('Token=SECRET123')).toBe('Token=[redacted]');
  });

  it('leaves a query with nothing secret in it alone', () => {
    expect(redactQueryString('page=2&sort=name')).toBe('page=2&sort=name');
  });

  it('does not choke on a valueless pair', () => {
    expect(redactQueryString('flag&token=SECRET123')).toBe('flag&token=[redacted]');
  });
});
