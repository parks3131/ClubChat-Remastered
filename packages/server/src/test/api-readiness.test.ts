/**
 * What `/ready` says when a dependency is not there, and what `/health` keeps saying regardless.
 *
 * > **The defect this file exists for: `/health` cannot fail.** It was
 * > `app.get('/health', async () => ({ ok: true }))` - a fact about the event loop and nothing
 * > else. Fly gates BOTH traffic routing and deploy success on a check like this, so a deploy
 * > against an unreachable database would go green and immediately take live traffic, and every
 * > request it took would 500. A check that answers from process memory is a check that reports
 * > the one condition that never needs reporting.
 *
 * Two endpoints rather than one, because they answer different questions:
 *
 *  - `/health` is liveness. It touches nothing, so it stays exactly as it was, and the tests in
 *    `edge-hardening.test.ts` and `rate-limit-routes.test.ts` that lean on it stay true.
 *  - `/ready` is readiness, and it is the one Fly points at.
 *
 * The grading is deliberately ASYMMETRIC, which is the part most likely to be "fixed" by somebody
 * who has not read `SPEC/TECH/11-failure-modes.md`. Postgres unreachable is a 503, because with
 * Postgres down every route 500s and removing this instance from rotation loses nothing. Redis
 * unreachable is still a 200, because that document records Redis being wiped or unavailable as a
 * DEGRADE - realtime stops, clients keep working over REST and recover via sync, the limiter fails
 * open, and no data is lost - and calls that property non-negotiable. Every instance shares one
 * Redis, so failing readiness on it would remove them all at once and turn a documented degrade
 * into a total outage.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { buildApp } from '../api/app.ts';
import { createAuth, type Auth } from '../auth.ts';
import { createRedis } from '../bus/redis.ts';
import type { Config } from '../config.ts';
import { createDb, createPool, type Db } from '../db/client.ts';
import { FakeMediaStore } from '../media/store.ts';
import type { Monitor } from '../monitoring.ts';
import { allowAll } from './fake-limiter.ts';
import { startTestDb, startTestRedis, type TestDb, type TestRedis } from './harness.ts';

let h: TestDb;
let redisFixture: TestRedis;
let auth: Auth;
let liveRedis: Redis;

/** A Postgres that is not there. Port 1 refuses instantly, which is a rotated host or a dead Neon. */
let deadPool: pg.Pool;
let deadDb: Db;
/** A Redis that is not there, reached through the real ioredis client with its real retry policy. */
let deadRedis: Redis;

let captured: Array<{ where: string; context: Record<string, unknown> | undefined }>;
let app: FastifyInstance | undefined;

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

/** A monitor that records rather than sends, so the assertion is about what an operator is told. */
function spyMonitor(): Monitor {
  return {
    capture(_error, where, context) {
      captured.push({ where, context });
    },
    async flush() {},
  };
}

async function standApp(deps: {
  db: Db;
  redis?: Redis | undefined;
  readinessTimeoutMs?: number;
}): Promise<FastifyInstance> {
  await app?.close().catch(() => undefined);
  app = buildApp({
    db: deps.db,
    auth,
    config,
    mediaStore: new FakeMediaStore(),
    monitor: spyMonitor(),
    limiter: allowAll(),
    redis: deps.redis,
    ...(deps.readinessTimeoutMs === undefined
      ? {}
      : { readinessTimeoutMs: deps.readinessTimeoutMs }),
  });
  await app.ready();
  return app;
}

beforeAll(async () => {
  [h, redisFixture] = await Promise.all([startTestDb(), startTestRedis()]);
  auth = createAuth(h.db, {
    secret: 'test-secret-not-a-real-one-at-all',
    baseURL: config.BETTER_AUTH_URL,
  });
  liveRedis = createRedis(redisFixture.url);
  liveRedis.on('error', () => undefined);

  deadPool = createPool('postgres://nobody:nothing@127.0.0.1:1/nothing', {
    // The pool reports connection-level faults to stderr by default, and this test causes them
    // on purpose. Silenced so a passing run is quiet.
    onConnectionError: () => undefined,
  });
  deadDb = createDb(deadPool);

  deadRedis = createRedis('redis://127.0.0.1:1');
  deadRedis.on('error', () => undefined);
}, 120_000);

afterAll(async () => {
  await app?.close().catch(() => undefined);
  deadRedis?.disconnect();
  liveRedis?.disconnect();
  await deadPool?.end().catch(() => undefined);
  await h?.stop().catch(() => undefined);
  await redisFixture?.stop().catch(() => undefined);
});

beforeEach(() => {
  captured = [];
});

describe('GET /ready', () => {
  /**
   * THE ONE THAT MATTERS. This is the deploy gate.
   *
   * An instance that cannot reach Postgres must not be routed to and must not let a deploy go
   * green, because every route it serves is about to 500.
   */
  it('answers 503 when Postgres is unreachable', async () => {
    const instance = await standApp({ db: deadDb, redis: liveRedis });

    const response = await instance.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body)).toEqual({ error: 'not_ready' });
  });

  /**
   * A health endpoint is the most-read unauthenticated surface a deployment has, and it is read
   * by anyone who can reach the port. It says whether we are ready and NOTHING else: not which
   * dependency, not the driver's text, not a host, a port or a credential.
   */
  it('tells an unauthenticated reader nothing about why', async () => {
    const instance = await standApp({ db: deadDb, redis: liveRedis });

    const response = await instance.inject({ method: 'GET', url: '/ready' });

    const body = response.body.toLowerCase();
    for (const leak of ['econnrefused', '5432', 'postgres', 'nobody', 'nothing', '127.0.0.1']) {
      expect(body, `the body must not name ${leak}`).not.toContain(leak);
    }
  });

  /** The other half: a 503 nobody is told about is a machine quietly out of rotation forever. */
  it('captures the Postgres failure so an operator learns of it', async () => {
    const instance = await standApp({ db: deadDb, redis: liveRedis });

    await instance.inject({ method: 'GET', url: '/ready' });

    const postgres = captured.filter((entry) => entry.context?.['dependency'] === 'postgres');
    expect(postgres).toHaveLength(1);
    expect(postgres[0]?.where).toBe('api.ready');
  });

  /**
   * The asymmetry, stated as a test so it cannot be "fixed" by accident.
   *
   * `SPEC/TECH/11-failure-modes.md` records an unavailable Redis as a degrade with no data loss,
   * and calls that non-negotiable. Every instance shares one Redis, so a 503 here would remove
   * every instance at once - converting a documented degrade into the total outage it exists to
   * prevent.
   */
  it('stays 200 when Redis is unreachable, and reports it anyway', async () => {
    const instance = await standApp({ db: h.db, redis: deadRedis });

    const response = await instance.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true });

    const redisCaptures = captured.filter((entry) => entry.context?.['dependency'] === 'redis');
    expect(redisCaptures).toHaveLength(1);
    expect(redisCaptures[0]?.where).toBe('api.ready');
  }, 20_000);

  /** Everything up: the check has to be able to say yes, or the 503s above prove nothing. */
  it('answers 200 when both dependencies answer', async () => {
    const instance = await standApp({ db: h.db, redis: liveRedis });

    const response = await instance.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true });
    expect(captured).toEqual([]);
  });

  /**
   * A dependency that HANGS is the case a naive probe cannot survive, and it is the likely one:
   * the pool's `connectionTimeoutMillis` is 10 seconds and ioredis queues offline and retries, so
   * both dependencies can sit far past any sane check interval. Fly would read that as a failure
   * anyway - after its own timeout, having held a prober the whole time - and the handler would
   * still be running when the next poll arrived.
   */
  it('answers 503 promptly when the Postgres probe never settles', async () => {
    const hanging = { execute: () => new Promise<never>(() => undefined) } as unknown as Db;
    const instance = await standApp({ db: hanging, redis: liveRedis, readinessTimeoutMs: 50 });

    const startedAt = Date.now();
    const response = await instance.inject({ method: 'GET', url: '/ready' });
    const elapsed = Date.now() - startedAt;

    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body)).toEqual({ error: 'not_ready' });
    // The number that matters is not 500: it is that this is nowhere near the pool's 10 seconds.
    expect(elapsed).toBeLessThan(500);

    const postgres = captured.filter((entry) => entry.context?.['dependency'] === 'postgres');
    expect(postgres).toHaveLength(1);
  });

  /**
   * Sentry has a quota, and a check polled every few seconds during an outage is the fastest way
   * to spend it - during exactly the incident the quota is for. So the report fires on the
   * TRANSITION into failure, not on every poll, while the log records every one.
   */
  it('captures once per outage, not once per poll', async () => {
    const instance = await standApp({ db: deadDb, redis: liveRedis });

    await instance.inject({ method: 'GET', url: '/ready' });
    await instance.inject({ method: 'GET', url: '/ready' });
    await instance.inject({ method: 'GET', url: '/ready' });

    expect(captured.filter((entry) => entry.context?.['dependency'] === 'postgres')).toHaveLength(1);
  });

  /**
   * Fails CLOSED when the process was never given a Redis at all.
   *
   * That is a wiring fault rather than an outage: nothing can be said about a dependency that was
   * not supplied, and "ready" is the wrong answer to a question that was not asked.
   */
  it('answers 503 when no Redis was wired in', async () => {
    const instance = await standApp({ db: h.db });

    const response = await instance.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body)).toEqual({ error: 'not_ready' });
    expect(captured.filter((entry) => entry.context?.['dependency'] === 'not_wired')).toHaveLength(1);
  });
});

describe('GET /health', () => {
  /**
   * Liveness answers from process memory, and that is the whole point of it being separate.
   *
   * Fly restarts a machine that fails its liveness check. If liveness consulted the database, a
   * database blip would restart every machine at once - which is the outage amplifier readiness
   * exists to avoid, applied to the one check that can kill the process.
   */
  it('stays 200 with every dependency broken', async () => {
    const instance = await standApp({ db: deadDb, redis: deadRedis });

    const response = await instance.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true });
    // It touched nothing, so there was nothing to report.
    expect(captured).toEqual([]);
  });
});
