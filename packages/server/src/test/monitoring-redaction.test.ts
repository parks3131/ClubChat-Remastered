/**
 * A live invite token, and whether it leaves the process.
 *
 * `monitoring.test.ts` proves `redactUrl` transforms a string. That is not the same claim as "the
 * SDK does not send the token", and the gap between those two is exactly where this defect lived:
 * the route author DID think about the credential in the URL, wrote a docblock saying so, and
 * closed the pino sink with `logLevel: 'warn'`. Two Sentry sinks stayed open behind it, and no
 * assertion about our own code could see them, because the SDK builds those payloads itself.
 *
 * So this file builds a real client from the real options with a capturing transport, sends the
 * two event shapes that carry a URL, and greps the serialized envelope for the secret. It asserts
 * the negative - the token is gone - and then the positive, that the event still arrived with the
 * fields that make it worth having. A redactor that drops the event is not a fix: it would take
 * the 5xx with it, and an error you cannot see is worse than a URL you should not have logged.
 *
 * Why an invite token is worth this much care: it is a bearer credential. Holding it joins the
 * club, and `clubs.invite_token` joins INSTANTLY, past whatever join policy the club chose. A
 * token sitting in a Sentry issue is redeemable by anyone with access to that Sentry project for
 * as long as the club has not rotated it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Sentry from '@sentry/node';
import type { Config } from '../config.ts';
import { sentryInitOptions } from '../monitoring.ts';

/** Distinctive enough that a substring search cannot match it by accident. */
const TOKEN = 'ZZTOPSECRETTOKEN0123456789abcdefghijABCDEFG';

const config = {
  SENTRY_DSN: 'https://0123456789abcdef0123456789abcdef@o0.ingest.us.sentry.io/1',
  SENTRY_ENVIRONMENT: 'test',
  SENTRY_RELEASE: 'test-release',
  /* 1, not 0. The transaction sink is the one a sample rate can hide. */
  SENTRY_TRACES_SAMPLE_RATE: 1,
} as unknown as Config;

/** Every envelope item, serialized exactly as it would have been posted. */
const wire: string[] = [];

beforeAll(() => {
  Sentry.init({
    ...sentryInitOptions(config),
    transport: () =>
      ({
        send: async (envelope: unknown) => {
          const [, items] = envelope as [unknown, Array<[unknown, unknown]>];
          for (const [, item] of items) wire.push(JSON.stringify(item));
          return {};
        },
        flush: async () => true,
      }) as never,
  });
});

afterAll(async () => {
  await Sentry.close(2000);
});

describe('an error event carrying an invite URL', () => {
  it('reaches the transport with the token replaced and the rest intact', async () => {
    Sentry.captureEvent({
      message: 'boom',
      request: { url: `https://api.clubchatapp.com/invites/${TOKEN}/preview` },
      contexts: { trace: { data: { 'url.full': `https://api.clubchatapp.com/invites/${TOKEN}/preview` } } },
    } as never);
    await Sentry.flush(5000);

    const payload = wire.join('\n');
    expect(payload).not.toContain(TOKEN);
    // Still sent, and still says which endpoint. Dropping it would be the wrong cure.
    expect(payload).toContain('/invites/[redacted]/preview');
    expect(payload).toContain('boom');
  });
});

describe('a transaction carrying an invite URL in its span attributes', () => {
  it('reaches the transport with the token replaced in every URL attribute', async () => {
    const url = `https://api.clubchatapp.com/invites/${TOKEN}/preview`;
    Sentry.captureEvent({
      type: 'transaction',
      transaction: 'GET /invites/:token/preview',
      contexts: {
        trace: {
          data: { 'url.full': url, 'url.path': `/invites/${TOKEN}/preview`, 'http.target': `/invites/${TOKEN}/preview` },
        },
      },
      spans: [{ description: 'GET', data: { 'url.full': url, 'http.url': url } }],
    } as never);
    await Sentry.flush(5000);

    const payload = wire.join('\n');
    expect(payload).not.toContain(TOKEN);
    // The transaction NAME is the route pattern, which is safe and is the useful half.
    expect(payload).toContain('GET /invites/:token/preview');
  });
});
