/**
 * One drowning subscriber must cost itself its connection, and cost its neighbours nothing.
 *
 * > **The fan-out loop wrote to every subscriber on the sole condition that the socket was
 * > OPEN**, which is the site the 2026-08-19 review named: per-channel topics mean one publish
 * > reaches a gateway and is written to every socket it holds for that channel, so a single
 * > member whose phone has stopped reading accumulates the whole channel's traffic in this
 * > process's memory. In a 300 member club that is one bad network turning into an unbounded
 * > allocation on a machine nobody is watching.
 *
 * `write-ceiling.test.ts` proves the gate itself against a stub-only gateway. This proves the
 * property that only shows up with more than one socket in the loop, and it is the property a
 * ceiling could plausibly get wrong: dropping the drowning socket must not skip, delay or
 * corrupt delivery to the healthy ones beside it in the same iteration.
 *
 * Real Postgres, real Redis, a real subscribe and a real publish. The one thing faked is
 * `bufferedAmount`, because producing it honestly means a peer that has really stopped reading
 * for real seconds.
 */

import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { Redis } from 'ioredis';
import type { Auth } from '../auth.ts';
import type { Db } from '../db/client.ts';
import type { RateLimiter } from '../bus/redis.ts';
import { createRedis } from '../bus/redis.ts';
import { createGateway, WRITE_BUFFER_CEILING_BYTES, type Gateway } from '../gateway/server.ts';
import { seedClub, startTestDb, startTestRedis, type TestDb, type TestRedis } from './harness.ts';

let pg: TestDb;
let redisFixture: TestRedis;
let db: Db;
let redis: Redis;
let subscriber: Redis;
let gateway: Gateway;
let url: string;
const warnings: string[] = [];

/**
 * The session, stubbed.
 *
 * The behaviour under test is on the fan-out path, so standing up better-auth to reach it would
 * be ceremony around the part that matters. The database underneath is real, which is what lets
 * the access context, the membership check and the subscribe all be the shipping code.
 */
let sessionUserId = '';
const stubAuth = {
  api: {
    getSession: async () => ({ user: { id: sessionUserId }, session: { id: 'sess-1' } }),
  },
} as unknown as Auth;

const allowEverySend: RateLimiter = { tryConsume: async () => true };

beforeAll(async () => {
  [pg, redisFixture] = await Promise.all([startTestDb(), startTestRedis()]);
  db = pg.db;
  redis = createRedis(redisFixture.url);
  subscriber = createRedis(redisFixture.url);

  gateway = createGateway(
    {
      db,
      auth: stubAuth,
      redis,
      subscriber,
      rateLimiter: allowEverySend,
      gatewayId: 'fanout-ceiling-test',
      log: (level, message) => {
        if (level === 'warn') warnings.push(message);
      },
    },
    { port: 0 },
  );
  await new Promise<void>((resolve) => gateway.wss.once('listening', () => resolve()));
  url = `ws://127.0.0.1:${(gateway.wss.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await gateway.close();
  redis.disconnect();
  subscriber.disconnect();
  await pg.stop();
  await redisFixture.stop();
});

type Frame = { t: string; d: Record<string, unknown> };
type Peer = {
  socket: WebSocket;
  frames: Frame[];
  closed: boolean;
  waitFor: (t: string) => Promise<Frame>;
};

/** A connected, authenticated socket, with everything the gateway sends it kept. */
async function connect(): Promise<Peer> {
  const socket = new WebSocket(url);
  const peer: Peer = { socket, frames: [], closed: false, waitFor: async () => ({}) as Frame };

  socket.on('message', (raw: Buffer) => peer.frames.push(JSON.parse(raw.toString()) as Frame));
  socket.on('close', () => {
    peer.closed = true;
  });
  socket.on('error', () => undefined);

  peer.waitFor = async (t) => {
    await vi.waitFor(() => expect(peer.frames.some((frame) => frame.t === t)).toBe(true), {
      timeout: 10_000,
    });
    return peer.frames.filter((frame) => frame.t === t).at(-1)!;
  };

  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });

  socket.send(
    JSON.stringify({
      t: 'auth',
      d: { token: 'a-token', deviceId: crypto.randomUUID(), platform: 'ios' },
    }),
  );
  await peer.waitFor('auth.ok');
  return peer;
}

/**
 * The gateway's end of the connection that peer just opened.
 *
 * `wss.clients` is a `Set` in insertion order, so the newest accepted socket is the last one.
 * `bufferedAmount` is a property of this end and no client can move it from the outside, which
 * is why the test has to reach for it here.
 */
function newestServerEnd(): WebSocket {
  const sockets = [...gateway.wss.clients];
  return sockets[sockets.length - 1]!;
}

it('drops the subscriber whose backlog is past the ceiling, and delivers to the ones beside it', async () => {
  const club = await seedClub(db);
  sessionUserId = club.ownerId;

  /*
   * The order these subscribe in is the order the fan-out iterates them, and it is chosen: the
   * drowning socket sits BETWEEN two healthy ones, so a ceiling that broke out of the loop, or
   * that mutated the Set from under its own iterator, shows up as `healthyAfter` never getting
   * the message rather than as an exception somewhere.
   */
  const healthyBefore = await connect();
  const drowning = await connect();
  const drowningServerEnd = newestServerEnd();
  const healthyAfter = await connect();
  const sender = await connect();

  for (const peer of [healthyBefore, drowning, healthyAfter, sender]) {
    peer.socket.send(JSON.stringify({ t: 'subscribe', d: { channelIds: [club.channelId] } }));
    await peer.waitFor('subscribed');
  }

  Object.defineProperty(drowningServerEnd, 'bufferedAmount', {
    get: () => WRITE_BUFFER_CEILING_BYTES + 1,
    configurable: true,
  });

  sender.socket.send(
    JSON.stringify({
      t: 'msg.send',
      d: {
        clientMsgId: crypto.randomUUID(),
        channelId: club.channelId,
        type: 'text',
        body: 'one of you is not reading this',
      },
    }),
  );

  const before = await healthyBefore.waitFor('msg.new');
  const after = await healthyAfter.waitFor('msg.new');
  expect(before.d['body']).toBe('one of you is not reading this');
  expect(
    after.d['body'],
    'a subscriber dropped mid fan-out must not cost the subscribers after it their message',
  ).toBe('one of you is not reading this');

  await vi.waitFor(() => expect(drowning.closed).toBe(true), { timeout: 10_000 });
  expect(
    drowning.frames.some((frame) => frame.t === 'msg.new'),
    'nothing may be added to a backlog already past the ceiling',
  ).toBe(false);
  expect(warnings).toContain('write buffer past the ceiling, dropping the socket');

  for (const peer of [healthyBefore, healthyAfter, sender]) peer.socket.close();
});
