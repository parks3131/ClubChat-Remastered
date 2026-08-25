/**
 * What actually leaves the process, read off the wire.
 *
 * `monitoring.test.ts` asserts the wrapper's three properties without starting a client, on the
 * argument that the SDK is somebody else's tested code. That argument has one hole, and this file
 * is it: **the SDK does things to our events that no assertion about our own code can see.**
 *
 * The defect that produced this file, found by pointing a drill at a collector and reading the
 * envelope rather than by reading the code:
 *
 * > Every 5xx reached Sentry with **no `where` tag and no `method`/`route`/`userId` context**.
 * > `@sentry/node` 10 captures Fastify errors itself, through the diagnostics channel, before
 * > `app.ts`'s error handler runs. Two captures of one Error means the Dedupe integration keeps
 * > the first and drops the second - so the event that survived was the SDK's, which knows
 * > nothing about `where`, and ours, which is the entire grouping design, was thrown away.
 *
 * Nothing about that is visible from inside: `capture` was called, it did not throw, an event id
 * came back, and an issue appeared in Sentry. Only the tags on the issue were missing, and only
 * somebody looking at the issue would ever know. So the assertion has to be made against a real
 * client with a real transport, which is what this file costs and why it is one file.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Sentry from '@sentry/node';
import type { Config } from '../config.ts';
import { DRILL_ROUTE, forceFiveHundred } from '../drills/forced-5xx.ts';
import { initMonitoring, sentryInitOptions, type Monitor } from '../monitoring.ts';

/** Only what `initMonitoring` reads. The DSN is a syntactically valid one for a project that does not exist. */
const config = {
  SENTRY_DSN: 'https://0123456789abcdef0123456789abcdef@o0.ingest.us.sentry.io/1',
  SENTRY_ENVIRONMENT: 'test',
  SENTRY_RELEASE: 'test-release',
  SENTRY_TRACES_SAMPLE_RATE: 0,
} as unknown as Config;

/** One event as Sentry would have received it: tags, contexts and all. */
type SentEvent = {
  tags?: Record<string, unknown>;
  contexts?: Record<string, Record<string, unknown> | undefined>;
  exception?: { values?: Array<{ value?: string }> };
};

const sent: SentEvent[] = [];
let monitor: Monitor;

beforeAll(() => {
  /*
   * The real options, plus a transport that keeps the envelope instead of posting it. Everything
   * this file is about - the integrations, the dedupe, who captures a Fastify error - is decided
   * by those options, so building the client any other way would test a different client.
   */
  Sentry.init({
    ...sentryInitOptions(config),
    transport: () =>
      ({
        send: async (envelope: unknown) => {
          const [, items] = envelope as [unknown, Array<[{ type: string }, SentEvent]>];
          for (const [header, item] of items) if (header.type === 'event') sent.push(item);
          return {};
        },
        flush: async () => true,
      }) as never,
  });

  // Finds the client above rather than starting a second one, and tags the role on it.
  monitor = initMonitoring(config, 'api', { error: () => undefined });
});

afterAll(async () => {
  await Sentry.close(2000);
});

describe('a 5xx, as Sentry receives it', () => {
  it('arrives once, with the where tag and the route context intact', async () => {
    await forceFiveHundred(monitor);
    await monitor.flush(5000);

    /*
     * Exactly one. Two would mean the SDK is still capturing Fastify errors alongside the error
     * handler, and which of the two survives is then decided by Dedupe rather than by us.
     */
    expect(sent).toHaveLength(1);
    const event = sent[0];

    expect(event?.exception?.values?.[0]?.value).toContain('monitoring drill');
    // `where` is how reports group by cause. Without it every 5xx in the system is one issue.
    expect(event?.tags).toMatchObject({ where: 'api.request', service: 'api' });
    // The route PATTERN, which is what makes an issue say which endpoint is failing.
    expect(event?.contexts?.['detail']).toMatchObject({ method: 'GET', route: DRILL_ROUTE });
  });
});
