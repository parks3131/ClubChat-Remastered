/**
 * The handshake always answers, and answers exactly once.
 *
 * > **The defect this file exists for: an exception during the handshake answered nothing,
 * > closed nothing, and hung the app forever.** The auth timer was cleared on ENTRY to the
 * > `auth` case rather than when the handshake was answered, and the generic per-frame catch
 * > deliberately keeps the socket open and says nothing - correct for a bad `msg.send`, fatal
 * > for a handshake. So a throw from anywhere inside `handleAuth` sent no `auth.ok`, no
 * > `auth.err` and no close, and the client awaits that reply with its only rejector being
 * > `onclose`. The likeliest thrower was the Redis write in `registry.register`: Redis restarts
 * > for thirty seconds and every phone that cold-opens in that window sits on the loading
 * > spinner until it is force-quit. `SPEC/PRD/03` rules that outcome out absolutely.
 *
 * These tests need no database and no Redis: they stand a real gateway on an ephemeral port
 * with stub dependencies, and drive it with a real socket. That is the level the defect lives
 * at - the wiring between the timer, the handler and the catch - so it is the level to test.
 */

import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import type { Redis } from 'ioredis';
import { afterEach, describe, expect, it } from 'vitest';
import type { Auth } from '../auth.ts';
import type { Db } from '../db/client.ts';
import type { RateLimiter } from '../bus/redis.ts';
import { createGateway, type Gateway } from './server.ts';

/** Short enough that a timeout test is a test rather than a wait. */
const AUTH_TIMEOUT_MS = 150;
const HANDSHAKE_TIMEOUT_MS = 150;

/** ioredis in subscriber mode, reduced to the three members the gateway touches. */
const stubSubscriber = () =>
  ({
    subscribe: async () => 1,
    unsubscribe: async () => 0,
    on: () => undefined,
  }) as unknown as Redis;

const stubRateLimiter: RateLimiter = { tryConsume: async () => true };

type Harness = {
  gateway: Gateway;
  url: string;
};

const open: Harness[] = [];

afterEach(async () => {
  while (open.length > 0) await open.pop()!.gateway.close();
});

async function standGateway(overrides: {
  auth: Auth;
  db?: Db;
  redis?: Redis;
}): Promise<Harness> {
  const gateway = createGateway(
    {
      // Never reached in these tests unless a case says so, and a stub that throws on any
      // property access is exactly the "handshake threw" condition under test.
      db: overrides.db ?? ({} as Db),
      auth: overrides.auth,
      redis: overrides.redis ?? ({} as unknown as Redis),
      subscriber: stubSubscriber(),
      rateLimiter: stubRateLimiter,
      gatewayId: 'test-gateway',
      log: () => undefined,
    },
    { port: 0, authTimeoutMs: AUTH_TIMEOUT_MS, handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS },
  );

  await new Promise<void>((resolve) => gateway.wss.once('listening', () => resolve()));
  const { port } = gateway.wss.address() as AddressInfo;
  const harness = { gateway, url: `ws://127.0.0.1:${port}` };
  open.push(harness);
  return harness;
}

type Reply = { frames: Array<{ t: string; d?: Record<string, unknown> }>; closed: boolean };

/**
 * Connect, optionally send `auth`, and collect everything the gateway says until it closes.
 *
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

const authFrame = {
  t: 'auth',
  id: 'corr-1',
  d: {
    token: 'a-token',
    deviceId: '22222222-2222-4222-8222-222222222222',
    platform: 'ios',
  },
};

describe('the handshake', () => {
  /**
   * THE ONE THAT MATTERS.
   *
   * Whatever goes wrong inside the handler, the client gets an answer. Without it the app sits
   * on a spinner until it is force-quit, because `connect()` awaits a promise whose only
   * rejector is a close that never comes.
   */
  it('answers auth.err and closes when the handler throws', async () => {
    const auth = {
      api: {
        getSession: async () => {
          throw new Error('Stream isn\'t writeable and enableOfflineQueue options is false');
        },
      },
    } as unknown as Auth;

    const { url } = await standGateway({ auth });
    const reply = await speak(url, authFrame);

    expect(reply.frames.map((f) => f.t)).toEqual(['auth.err']);
    expect(reply.closed, 'a handshake that failed must close the socket').toBe(true);
  });

  /**
   * The same guarantee one layer deeper, where the real thrower lives.
   *
   * `registry.register` is a Redis write on `maxRetriesPerRequest: 3`, and everything after the
   * token resolves - the access context, the channel list, the registry - runs against a
   * dependency that can be down. A session that resolves and a read that then fails is the
   * shape of a Redis or Postgres blip during a cold open.
   */
  it('answers auth.err when the failure is after the token resolved', async () => {
    const auth = {
      api: {
        getSession: async () => ({
          user: { id: '11111111-1111-4111-8111-111111111111' },
          session: { id: 'sess-1' },
        }),
      },
    } as unknown as Auth;

    // `db` is an empty object, so the access-context read throws on its first property access.
    const { url } = await standGateway({ auth });
    const reply = await speak(url, authFrame);

    expect(reply.frames.map((f) => f.t)).toEqual(['auth.err']);
    expect(reply.closed).toBe(true);
  });

  /**
   * A handler that never returns is the other half of the same defect, and the reason the timer
   * must OUTLIVE the handler rather than being cleared on entry to it. A hung dependency used to
   * mean a socket that answered nothing forever.
   */
  it('answers auth.err when the handler never settles', async () => {
    const auth = {
      api: {
        getSession: () => new Promise(() => undefined),
      },
    } as unknown as Auth;

    const { url } = await standGateway({ auth });
    const reply = await speak(url, authFrame);

    expect(reply.frames.map((f) => f.t)).toEqual(['auth.err']);
    expect(reply.frames[0]?.d).toEqual({ code: 'timeout' });
    expect(reply.closed).toBe(true);
  });

  /** The rule that was already there, kept honest: a socket that never authenticates is closed. */
  it('closes a socket that never sends auth', async () => {
    const auth = { api: { getSession: async () => null } } as unknown as Auth;

    const { url } = await standGateway({ auth });
    const reply = await speak(url, null);

    expect(reply.frames.map((f) => f.t)).toEqual(['auth.err']);
    expect(reply.frames[0]?.d).toEqual({ code: 'timeout' });
    expect(reply.closed).toBe(true);
  });

  /**
   * Exactly one, not "at least one".
   *
   * A refused token answers immediately, and the timer that was armed to catch a silent socket
   * must not then fire a second `auth.err` at a socket that has already been answered.
   */
  it('answers a refused token once, and does not follow it with a timeout', async () => {
    const auth = { api: { getSession: async () => null } } as unknown as Auth;

    const { url } = await standGateway({ auth });
    const reply = await speak(url, authFrame, 500);

    expect(reply.frames.map((f) => f.t)).toEqual(['auth.err']);
    expect(reply.frames[0]?.d).toEqual({ code: 'invalid_token' });
    // The correlation id rides back, so a client with several frames in flight can match it.
    expect(reply.frames[0]).toMatchObject({ id: 'corr-1' });
    expect(reply.closed).toBe(true);
  });
});
