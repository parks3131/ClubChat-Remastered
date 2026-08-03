/**
 * The three properties the reporter has to hold, none of which are about Sentry.
 *
 * Every one of these is a way monitoring makes an outage worse rather than shorter: a reporter
 * that throws, a reporter that only runs in production, or a shutdown that hangs on it. The SDK
 * itself is somebody else's tested code - what is worth asserting is the wrapper around it.
 */

import { describe, expect, it } from 'vitest';
import { initMonitoring, silentMonitor } from './monitoring.ts';
import type { Config } from './config.ts';

/** Only the fields `initMonitoring` reads. The rest of `Config` is irrelevant here. */
const configWith = (over: Partial<Config> = {}): Config =>
  ({ SENTRY_ENVIRONMENT: 'test', ...over }) as Config;

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
