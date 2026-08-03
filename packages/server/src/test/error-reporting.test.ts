/**
 * That a failed request actually reaches the monitor.
 *
 * `monitoring.test.ts` proves the reporter behaves; this proves something different and easier to
 * get wrong: **that the error handler is installed and calls it**. A `setErrorHandler` that was
 * never registered, or registered on a scope the routes are not in, fails exactly this way - every
 * request still works, every failure still answers 500, and the report silently goes nowhere. That
 * is the state the server was in before there was an error handler at all.
 *
 * The throwing route is registered on the built instance rather than shipped in `app.ts`, so the
 * production surface gains nothing and the handler under test is the real one.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../api/app.ts';
import { createAuth, type Auth } from '../auth.ts';
import type { Config } from '../config.ts';
import { FakeMediaStore } from '../media/store.ts';
import type { Monitor } from '../monitoring.ts';
import { allowAll } from './fake-limiter.ts';
import { startTestDb, type TestDb } from './harness.ts';

let h: TestDb;
let auth: Auth;

const config = {
  LOG_LEVEL: 'silent',
  CLIENT_ORIGIN: 'http://localhost:8081',
  BETTER_AUTH_URL: 'http://localhost:3000',
  S3_BUCKET_PUBLIC: 'identity',
  S3_BUCKET_PRIVATE: 'content',
  MEDIA_SIGNING_SECRET: 'test-signing-secret-not-real',
  MEDIA_CDN_BASE_URL: 'http://cdn.invalid/content',
  MEDIA_URL_MODE: 'cdn',
} as unknown as Config;

type Captured = { where: string; context: Record<string, unknown> | undefined };

/** A monitor that records rather than sends, so the assertion is about what was reported. */
function spyMonitor(): { captured: Captured[]; monitor: Monitor } {
  const captured: Captured[] = [];
  return {
    captured,
    monitor: {
      capture(_error, where, context) {
        captured.push({ where, context });
      },
      async flush() {},
    },
  };
}

beforeAll(async () => {
  h = await startTestDb();
  auth = createAuth(h.db, { secret: 'test-secret-not-a-real-one', baseURL: config.BETTER_AUTH_URL });
}, 120_000);

afterAll(async () => {
  await h?.stop().catch(() => undefined);
});

describe('a request that throws', () => {
  it('is captured, with the route pattern rather than the URL', async () => {
    const spy = spyMonitor();
    const app: FastifyInstance = buildApp({
      db: h.db,
      auth,
      config,
      mediaStore: new FakeMediaStore(),
      monitor: spy.monitor,
      limiter: allowAll(),
    });
    // Registered here, not in `app.ts`: the production API has no route that throws on purpose.
    app.get('/__boom/:id', async () => {
      throw new Error('deliberate failure');
    });
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/__boom/abc' });

    expect(response.statusCode).toBe(500);
    // The caller learns nothing about the failure beyond that there was one.
    expect(JSON.parse(response.body)).toEqual({ error: 'internal' });

    expect(spy.captured).toHaveLength(1);
    expect(spy.captured[0]?.where).toBe('api.request');
    /*
     * The PATTERN. Reporting `/__boom/abc` would make a distinct issue per id, which in the real
     * API means a distinct issue per club - and buries the fact that one route is failing under
     * a thousand issues that each happened once.
     */
    expect(spy.captured[0]?.context).toMatchObject({ method: 'GET', route: '/__boom/:id' });

    await app.close();
  });

  it('does not capture a refusal, because a 4xx is the API working', async () => {
    // The signal has to stay readable. An API that reports every unauthenticated request as an
    // incident produces an incident feed nobody reads.
    const spy = spyMonitor();
    const app = buildApp({
      db: h.db,
      auth,
      config,
      mediaStore: new FakeMediaStore(),
      monitor: spy.monitor,
      limiter: allowAll(),
    });
    await app.ready();

    const unauthenticated = await app.inject({ method: 'GET', url: '/me' });
    expect(unauthenticated.statusCode).toBe(401);

    /*
     * Authenticated, deliberately. The malformed-id refusal is a 404 from the uuid hook, and that
     * hook runs AFTER the session check - so an unauthenticated request never reaches it and
     * answers 401 instead, which is the correct order and not the case being tested here.
     */
    const email = `boom-${crypto.randomUUID().slice(0, 8)}@test.invalid`;
    const signUp = await auth.api.signUpEmail({
      body: { name: 'Boom', email, password: 'correct-horse-battery-staple' },
    });
    const token = (signUp as { token?: string }).token;

    const malformedId = await app.inject({
      method: 'GET',
      url: '/clubs/not-a-uuid',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(malformedId.statusCode).toBe(404);

    expect(spy.captured).toEqual([]);

    await app.close();
  });
});
