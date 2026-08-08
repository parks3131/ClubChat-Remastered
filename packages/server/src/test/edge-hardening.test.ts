/**
 * The edge configuration: security headers, and whether a forwarded address is believed.
 *
 * > **Both were findings of the 2026-08-08 security audit, and both are the kind that come back.**
 * > There were no security headers at all - zero occurrences of any of them anywhere in the
 * > codebase - and `trustProxy` was mentioned once, in a comment explaining what it would do if it
 * > were configured.
 *
 * They are tested together because they share a failure mode rather than a subject: neither is
 * reachable from any screen, so nothing in the product gets worse when they silently stop working.
 * A header that stops being sent breaks no feature and fails no other test, and a `trustProxy`
 * quietly reset to its default degrades one rate limit into a global one while every request still
 * succeeds. Only an assertion that looks straight at them notices.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../api/app.ts';
import { createAuth, type Auth } from '../auth.ts';
import { trustProxyOption, type Config } from '../config.ts';
import { FakeMediaStore } from '../media/store.ts';
import { silentMonitor } from '../monitoring.ts';
import { allowAll } from './fake-limiter.ts';
import { startTestDb, type TestDb } from './harness.ts';

let h: TestDb;
let auth: Auth;

const baseConfig = {
  LOG_LEVEL: 'error',
  CLIENT_ORIGIN: 'http://localhost:8081',
  BETTER_AUTH_URL: 'http://localhost:3000',
  S3_BUCKET_PUBLIC: 'identity',
  S3_BUCKET_PRIVATE: 'content',
  MEDIA_SIGNING_SECRET: 'test-signing-secret-not-real',
  MEDIA_CDN_BASE_URL: 'http://cdn.invalid/content',
  MEDIA_URL_MODE: 'cdn',
} as unknown as Config;

function appWith(overrides: Partial<Config> = {}): FastifyInstance {
  return buildApp({
    db: h.db,
    auth,
    config: { ...baseConfig, ...overrides },
    mediaStore: new FakeMediaStore(),
    monitor: silentMonitor(),
    limiter: allowAll(),
  });
}

beforeAll(async () => {
  h = await startTestDb();
  auth = createAuth(h.db, {
    secret: 'test-secret-not-a-real-one-at-all',
    baseURL: 'http://localhost:3000',
    clientOrigin: 'http://localhost:8081',
    dev: true,
  });
});

afterAll(async () => {
  await h.stop();
});

describe('security headers', () => {
  it('sets them on every response, including refusals', async () => {
    const app = appWith();

    // An unauthenticated 401 carries them too. A header applied only on the happy path is a
    // header absent from most of what an attacker actually sees.
    for (const url of ['/health', '/channels']) {
      const response = await app.inject({ method: 'GET', url });
      const headers = response.headers as Record<string, string>;

      expect(headers['x-content-type-options']).toBe('nosniff');
      expect(headers['referrer-policy']).toBe('no-referrer');
      expect(headers['strict-transport-security']).toContain('max-age=');
      expect(headers['content-security-policy']).toContain("default-src 'none'");
    }

    await app.close();
  });

  it('answers the framing question the same way twice', async () => {
    const app = appWith();
    const headers = (await app.inject({ method: 'GET', url: '/health' })).headers as Record<
      string,
      string
    >;

    /*
     * `X-Frame-Options` and CSP's `frame-ancestors` both decide whether this may be framed, and
     * helmet's defaults answer them differently: SAMEORIGIN against `frame-ancestors 'none'`.
     * Neither is dangerous alone; the point is that two headers disagreeing about one question
     * get resolved later by whichever a reader happens to look at first.
     */
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");

    await app.close();
  });

  it('keeps the policy free of sources a JSON API has no use for', async () => {
    const app = appWith();
    const csp = (await app.inject({ method: 'GET', url: '/health' })).headers[
      'content-security-policy'
    ] as string;

    // helmet merges its document-shaped defaults underneath unless told not to. They are not
    // wrong, they are misleading: this process serves JSON and one 302 and never a document, so
    // a policy advertising script and style sources describes a thing that does not exist.
    expect(csp).not.toContain('script-src');
    expect(csp).not.toContain('unsafe-inline');

    await app.close();
  });

  it('does not fight the CORS the web client depends on', async () => {
    const app = appWith();
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://localhost:8081' },
    });
    const headers = response.headers as Record<string, string>;

    // `Cross-Origin-Resource-Policy` defaults to same-origin, and this API is deliberately read
    // from another origin - the Expo web client on a different port. Left at the default it would
    // refuse the browser while native carried on working, which is the shape of failure this
    // project has already shipped twice.
    expect(headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(headers['access-control-allow-origin']).toBe('http://localhost:8081');

    await app.close();
  });
});

describe('trustProxy', () => {
  /*
   * The parsing, which is where the dangerous mistake lives.
   *
   * `'false'` is a non-empty string and therefore truthy, so the obvious wiring - handing the raw
   * environment value straight to Fastify - trusts every hop precisely when it was told not to.
   * That is not a loosened setting, it is an inverted one: on a directly reachable process it lets
   * any caller forge `X-Forwarded-For` and take a fresh rate-limit bucket per request.
   */
  it('reads the string forms without inverting the safe one', () => {
    expect(trustProxyOption('false')).toBe(false);
    expect(trustProxyOption('False')).toBe(false);
    expect(trustProxyOption('')).toBe(false);
    expect(trustProxyOption('   ')).toBe(false);
    // Absent is the same as false, which is also what the schema default supplies.
    expect(trustProxyOption(undefined)).toBe(false);

    expect(trustProxyOption('true')).toBe(true);
    // A hop count. `1` is the Fly.io answer, where the edge proxy is the only ingress.
    expect(trustProxyOption('1')).toBe(1);
    expect(trustProxyOption('2')).toBe(2);

    // Not a number and not a keyword, so it is an address list and proxy-addr parses it.
    expect(trustProxyOption('10.0.0.0/8,192.168.1.1')).toBe('10.0.0.0/8,192.168.1.1');
    // "1abc" must not be read as 1 and quietly trusted for one hop.
    expect(trustProxyOption('1abc')).toBe('1abc');
  });

  it('ignores a forwarded address by default and honours one when configured', async () => {
    const forwarded = { 'x-forwarded-for': '203.0.113.9' };

    /*
     * Both halves ask the same question through the same route, deliberately.
     *
     * The first draft read `socket.remoteAddress` for the closed case and `request.ip` for the
     * open one, which is two different measurements and therefore not a comparison - the closed
     * assertion would have passed whatever `trustProxy` did, because the raw socket address is not
     * the value being configured.
     */
    const whoami = (app: FastifyInstance) => {
      app.get('/whoami', async (request) => ({ ip: request.ip }));
      return app;
    };

    // Default: the header is a claim from a stranger and means nothing.
    const closed = whoami(appWith());
    const closedIp = (await closed.inject({ method: 'GET', url: '/whoami', headers: forwarded }))
      .json<{ ip: string }>().ip;
    expect(closedIp).not.toBe('203.0.113.9');
    await closed.close();

    /*
     * Configured: the address is believed, which is the whole point - `request.ip` is what keys
     * the per-IP sign-in bucket, the one limit here that is a security control rather than an
     * abuse ceiling. Behind a proxy without this, every caller in the world shares the proxy's
     * address and one bucket covers the internet.
     *
     * Asserted through a route that reports what the server concluded, rather than by reaching
     * into Fastify's internals, so this keeps testing the thing that matters if the plumbing
     * changes.
     */
    const open = whoami(appWith({ TRUST_PROXY: '1' } as Partial<Config>));
    const openIp = (await open.inject({ method: 'GET', url: '/whoami', headers: forwarded }))
      .json<{ ip: string }>().ip;
    expect(openIp).toBe('203.0.113.9');
    await open.close();
  });
});
