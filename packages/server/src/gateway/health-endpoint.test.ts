/**
 * The gateway has an HTTP surface, and it is the one Fly reads.
 *
 * > **The defect this file exists for: the gateway had no HTTP surface at all.** `ws` stands up an
 * > internal HTTP server when it is given a `port`, and that server answers `426 Upgrade Required`
 * > to every ordinary request. So there was nothing for a platform health check to point at, and
 * > the API's own check was `async () => ({ ok: true })`, which cannot fail. Between them, a
 * > deploy against an unreachable database went green and took live traffic.
 *
 * So `ws` is now given an `http.Server` we made ourselves, and it attaches its `upgrade` listener
 * to it. That is one restructure with four things to keep true, and each is a test below:
 *
 *  1. `/ready` answers a real verdict about real dependencies.
 *  2. The WebSocket upgrade still works, on the same port, at the same path, with the same timers.
 *  3. `close()` still finishes. With an external server `wss.close()` deliberately does NOT close
 *     it, and Fly's prober holds a keep-alive socket - so without `closeAllConnections()` the
 *     shutdown hangs, SIGTERM never reaches `pool.end()`, and Fly SIGKILLs the machine mid-deploy.
 *  4. Nothing else is served.
 *
 * These tests need no database and no Redis: they stand a real gateway on an ephemeral port with
 * stub dependencies and drive it with a real socket and a real `fetch`.
 */

import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import type { Redis } from 'ioredis';
import { afterEach, describe, expect, it } from 'vitest';
import type { Auth } from '../auth.ts';
import type { Db } from '../db/client.ts';
import type { Monitor } from '../monitoring.ts';
import type { RateLimiter } from '../bus/redis.ts';
import { createGateway, type Gateway } from './server.ts';

/** Short enough that the handshake test is a test rather than a wait. */
const AUTH_TIMEOUT_MS = 150;

/** ioredis in subscriber mode, reduced to the three members the gateway touches. */
const stubSubscriber = () =>
  ({
    subscribe: async () => 1,
    unsubscribe: async () => 0,
    on: () => undefined,
  }) as unknown as Redis;

const stubRateLimiter: RateLimiter = { tryConsume: async () => true };
const stubAuth = { api: { getSession: async () => null } } as unknown as Auth;

/** A database that answers the readiness query. */
const healthyDb = () => ({ execute: async () => [] }) as unknown as Db;
/** A database that is not there, in the shape `pg` refuses in. */
const deadDb = () =>
  ({
    execute: async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.1:5432');
    },
  }) as unknown as Db;

const healthyRedis = () => ({ ping: async () => 'PONG' }) as unknown as Redis;

type Harness = {
  gateway: Gateway;
  /** `http://127.0.0.1:<port>`, for `fetch`. */
  origin: string;
  /** `ws://127.0.0.1:<port>`, for the upgrade. */
  wsUrl: string;
  captured: Array<{ where: string; context: Record<string, unknown> | undefined }>;
};

const open: Harness[] = [];

afterEach(async () => {
  while (open.length > 0) await open.pop()!.gateway.close();
});

async function standGateway(overrides: { db?: Db; redis?: Redis } = {}): Promise<Harness> {
  const captured: Harness['captured'] = [];
  const monitor: Monitor = {
    capture(_error, where, context) {
      captured.push({ where, context });
    },
    async flush() {},
  };

  const gateway = createGateway(
    {
      db: overrides.db ?? healthyDb(),
      auth: stubAuth,
      redis: overrides.redis ?? healthyRedis(),
      subscriber: stubSubscriber(),
      rateLimiter: stubRateLimiter,
      gatewayId: 'health-endpoint-test',
      monitor,
      log: () => undefined,
    },
    { port: 0, authTimeoutMs: AUTH_TIMEOUT_MS, handshakeTimeoutMs: AUTH_TIMEOUT_MS },
  );

  await new Promise<void>((resolve) => gateway.wss.once('listening', () => resolve()));
  const { port } = gateway.wss.address() as AddressInfo;
  const harness: Harness = {
    gateway,
    origin: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
    captured,
  };
  open.push(harness);
  return harness;
}

type Reply = { frames: Array<{ t: string; d?: Record<string, unknown> }>; closed: boolean };

/**
 * Connect, optionally send `auth`, and collect everything the gateway says until it closes.
 *
 * Lifted from `handshake.test.ts`, which is where the behaviour it drives is actually specified.
 * Resolves on close, or after `settleMs` of quiet if the socket is still open - which is how a
 * socket that answers NOTHING is caught rather than waited on for the whole test timeout.
 */
async function speak(url: string, frame: unknown | null, settleMs = 600): Promise<Reply> {
  const socket = new WebSocket(url);
  const frames: Reply['frames'] = [];

  return new Promise<Reply>((resolve) => {
    const settle = setTimeout(() => {
      socket.terminate();
      resolve({ frames, closed: false });
    }, settleMs);

    socket.on('open', () => {
      if (frame !== null) socket.send(JSON.stringify(frame));
    });
    socket.on('message', (raw: Buffer) => {
      frames.push(JSON.parse(raw.toString()) as { t: string });
    });
    socket.on('close', () => {
      clearTimeout(settle);
      resolve({ frames, closed: true });
    });
    socket.on('error', () => undefined);
  });
}

describe('the gateway readiness endpoint', () => {
  it('answers 200 when its dependencies answer', async () => {
    const { origin } = await standGateway();

    const response = await fetch(`${origin}/ready`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  /**
   * The verdict is real, which is the entire difference from what was there before. A gateway
   * that cannot reach Postgres cannot resolve a session or authorize a subscribe, so every
   * handshake it accepts ends in `auth.err`.
   */
  it('answers 503 when Postgres is unreachable, and says nothing about why', async () => {
    const { origin, captured } = await standGateway({ db: deadDb() });

    const response = await fetch(`${origin}/ready`);
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(JSON.parse(body)).toEqual({ error: 'not_ready' });
    for (const leak of ['ECONNREFUSED', '5432', '10.0.0.1']) {
      expect(body, `the body must not name ${leak}`).not.toContain(leak);
    }
    const postgres = captured.filter((entry) => entry.context?.['dependency'] === 'postgres');
    expect(postgres).toHaveLength(1);
    expect(postgres[0]?.where).toBe('gateway.ready');
  });

  /** Liveness touches nothing, so a dead database must not restart every gateway at once. */
  it('answers 200 on /health with the database down', async () => {
    const { origin, captured } = await standGateway({ db: deadDb() });

    const response = await fetch(`${origin}/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(captured).toEqual([]);
  });

  it('serves nothing else', async () => {
    const { origin } = await standGateway();

    const response = await fetch(`${origin}/clubs`);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('');
  });

  /**
   * The restructure's real risk, stated as a test.
   *
   * `ws` no longer owns the HTTP server, so the upgrade now arrives through a listener it
   * attached to ours. If that wiring were wrong the socket would never connect - and the timer
   * that answers a silent socket has to survive with it, because a client that connects and is
   * never answered is the hang `handshake.test.ts` exists for.
   */
  it('still upgrades a WebSocket, on the same port, with the auth timer intact', async () => {
    const { wsUrl } = await standGateway();

    const reply = await speak(wsUrl, null);

    expect(reply.frames.map((f) => f.t)).toEqual(['auth.err']);
    expect(reply.frames[0]?.d).toEqual({ code: 'timeout' });
    expect(reply.closed).toBe(true);
  });

  /**
   * THE ONE THAT COSTS A DEPLOY.
   *
   * `wss.close()` deliberately does NOT close a server it did not create, so shutting the gateway
   * down is now this file's problem rather than `ws`'s. Two kinds of HTTP connection a health
   * prober produces, and only one of them is handled for free:
   *
   *  - An IDLE keep-alive socket, between polls. `server.close()` has closed those itself since
   *    Node 19, so this needs nothing - which is worth pinning, because it is the state a prober
   *    is in almost all of the time.
   *  - A socket with a request IN FLIGHT, which is what SIGTERM during a rolling deploy lands on.
   *    `server.close()` waits for it, and a readiness probe waits on a database. Without
   *    `closeAllConnections()` shutdown stalls behind it, SIGTERM never reaches `pool.end()` in
   *    `main.ts`, and Fly SIGKILLs the machine part way through the deploy.
   *
   * The elapsed time is the assertion, not the test timeout, so a regression here reports the
   * number it took rather than "timed out" - and the number says which of the two broke.
   */
  it('shuts down while a health prober holds a connection, idle or mid-request', async () => {
    // A database that never answers, so the in-flight probe below stays in flight.
    const hanging = { execute: () => new Promise<never>(() => undefined) } as unknown as Db;
    const harness = await standGateway({ db: hanging, redis: healthyRedis() });
    const index = open.indexOf(harness);
    if (index >= 0) open.splice(index, 1);

    // One completed request, read to the end, so its connection goes back to the pool alive.
    expect((await fetch(`${harness.origin}/health`)).status).toBe(200);

    // And one that will not come back, because its readiness probe cannot.
    const inFlight = fetch(`${harness.origin}/ready`).catch(() => undefined);
    // Long enough for the request to reach the handler, which is what makes it "active".
    await new Promise((resolve) => setTimeout(resolve, 100));

    const startedAt = Date.now();
    await harness.gateway.close();
    const elapsed = Date.now() - startedAt;

    /*
     * Generous against the milliseconds this takes when it works, and decisive against the
     * failure: left waiting on the in-flight request, the earliest it could finish is
     * `READINESS_TIMEOUT_MS`, which is two seconds.
     */
    expect(elapsed).toBeLessThan(500);
    await inFlight;
  }, 10_000);
});
