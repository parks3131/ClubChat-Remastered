/**
 * That the limiter is actually wired in, which the policy tests cannot tell you.
 *
 * `api/rate-limit.test.ts` pins the arithmetic: which bucket, which key, how loose. All of that
 * stays true if the hook is never registered. **The failure this file exists to catch is the
 * limiter being correct and unreachable** - a policy nothing consults looks exactly like a policy
 * that always allows.
 *
 * So the limiter here is a counter rather than Redis: the question is whether the request path
 * asks it and honours the answer, not whether a token bucket refills correctly.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../api/app.ts';
import { createAuth, type Auth } from '../auth.ts';
import type { Config } from '../config.ts';
import { FakeMediaStore } from '../media/store.ts';
import { silentMonitor } from '../monitoring.ts';
import { allowFirst } from './fake-limiter.ts';
import { startTestDb, type TestDb } from './harness.ts';

let h: TestDb;
let auth: Auth;

const config = {
  LOG_LEVEL: 'error',
  CLIENT_ORIGIN: 'http://localhost:8081',
  BETTER_AUTH_URL: 'http://localhost:3000',
  S3_BUCKET_PUBLIC: 'identity',
  S3_BUCKET_PRIVATE: 'content',
  MEDIA_SIGNING_SECRET: 'test-signing-secret-not-real',
  MEDIA_CDN_BASE_URL: 'http://cdn.invalid/content',
  MEDIA_URL_MODE: 'cdn',
} as unknown as Config;

/** An app whose limiter allows exactly `n` consumptions, then refuses everything. */
function appAllowing(n: number): FastifyInstance {
  return buildApp({
    db: h.db,
    auth,
    config,
    mediaStore: new FakeMediaStore(),
    monitor: silentMonitor(),
    limiter: allowFirst(n),
  });
}

async function signUpToken(name: string): Promise<string> {
  const email = `${name.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}@test.invalid`;
  const result = await auth.api.signUpEmail({
    body: { name, email, password: 'correct-horse-battery-staple' },
  });
  const token = (result as { token?: string }).token;
  if (!token) throw new Error('sign-up returned no session token');
  return token;
}

beforeAll(async () => {
  h = await startTestDb();
  auth = createAuth(h.db, {
    secret: 'test-secret-not-a-real-one',
    baseURL: config.BETTER_AUTH_URL,
  });
}, 120_000);

afterAll(async () => {
  await h?.stop().catch(() => undefined);
});

describe('an authenticated route', () => {
  it('refuses with 429 and a Retry-After once the bucket is empty', async () => {
    const app = appAllowing(1);
    await app.ready();
    const token = await signUpToken('LimitedReader');
    const headers = { authorization: `Bearer ${token}` };

    const first = await app.inject({ method: 'GET', url: '/me', headers });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({ method: 'GET', url: '/me', headers });
    expect(second.statusCode).toBe(429);
    expect(JSON.parse(second.body)).toEqual({ error: 'rate_limited' });
    // Without this a client's only strategy is to retry immediately, which turns the limit into
    // a hot loop against the thing it protects.
    expect(Number(second.headers['retry-after'])).toBeGreaterThanOrEqual(1);

    await app.close();
  });

  it('checks the session BEFORE spending anybody tokens', async () => {
    /*
     * Ordering, and it is a real attack rather than tidiness: if the limiter ran first it would
     * have to key on something an unauthenticated caller controls, and an attacker could exhaust
     * a stranger's bucket by guessing their id. Unauthenticated gets 401 and consumes nothing.
     */
    const app = appAllowing(0);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/me' });
    expect(response.statusCode).toBe(401);

    await app.close();
  });
});

describe('the auth endpoints', () => {
  it('are limited without a session, since there is no user to key on', async () => {
    // The one limit that is a security control: unlimited attempts here is unlimited credential
    // guessing. It has to apply to callers who have not signed in, by definition.
    const app = appAllowing(0);
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: 'nobody@test.invalid', password: 'wrong-password-entirely' },
    });

    expect(response.statusCode).toBe(429);
    expect(Number(response.headers['retry-after'])).toBeGreaterThanOrEqual(1);

    await app.close();
  });
});

describe('what is deliberately not limited', () => {
  it('leaves the health check alone', async () => {
    // Health is polled by the platform, not by a member, and a rate-limited health check reports
    // the service as down for the one reason that is not down.
    const app = appAllowing(0);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);

    await app.close();
  });
});
