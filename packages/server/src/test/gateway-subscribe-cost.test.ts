/**
 * Subscribing to many channels costs one round trip, not one per channel.
 *
 * > **The gateway awaited `getChannelRef` once per id, sequentially, inside the `subscribe`
 * > handler's loop - and `SubscribeFrame` admits 200 channel ids.** So a client resubscribing
 * > after a reconnect serialized up to two hundred database round trips inside a single frame,
 * > with that socket's frame queue holding everything else behind it. The event that produces a
 * > great many reconnects at once is a gateway restarting, so this was at its worst exactly when
 * > the system was already unhappy.
 *
 * [`SPEC/TECH/20`](../../../../SPEC/TECH/20-road-to-the-first-club.md) milestone 2 names it: "the
 * connect path's per-channel round trips, the same shape TECH/18 already removed from `/sync`".
 * It is the same defect and, as of 2026-08-21, the same fix - `getChannelRefs` serves both.
 *
 * **Why this needs its own file rather than a case in the fixture guards.** Those read the query
 * count off the HTTP tracer, which exists per request. A socket frame is not a request and has no
 * such context, so this counts statements off the pool directly, the way `hot-path-plans.test.ts`
 * does and for the same reason: drizzle checks a client out of the pool for everything, so
 * wrapping `pool.query` instead would miss every transaction.
 */

import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type pg from 'pg';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Auth } from '../auth.ts';
import type { Db } from '../db/client.ts';
import type { RateLimiter } from '../bus/redis.ts';
import { createRedis } from '../bus/redis.ts';
import { createGateway, type Gateway } from '../gateway/server.ts';
import { seedClub, startTestDb, startTestRedis, type TestDb, type TestRedis } from './harness.ts';

let pgFixture: TestDb;
let redisFixture: TestRedis;
let db: Db;
let redis: Redis;
let subscriber: Redis;
let gateway: Gateway;
let url: string;

/** Every statement the pool ran, newest last. Reset by each measurement. */
let statements: string[] = [];

let sessionUserId = '';
const stubAuth = {
  api: {
    getSession: async () => ({ user: { id: sessionUserId }, session: { id: 'sess-1' } }),
  },
} as unknown as Auth;

const allowEverySend: RateLimiter = { tryConsume: async () => true };

/**
 * Record what each pooled client is asked to run.
 *
 * The same chokepoint `dev/queries.ts` counts at, for the same reason.
 */
function recordStatements(pool: pg.Pool): void {
  const wrapped = new WeakSet<object>();
  const connect = pool.connect.bind(pool);
  const wrap = (client: pg.PoolClient): pg.PoolClient => {
    if (wrapped.has(client)) return client;
    wrapped.add(client);
    const original = client.query.bind(client) as (...a: unknown[]) => unknown;
    client.query = function (...args: unknown[]) {
      const first = args[0];
      if (typeof first === 'string') statements.push(first);
      else if (first !== null && typeof first === 'object' && 'text' in first) {
        statements.push((first as { text: string }).text);
      }
      return original(...args);
    } as typeof client.query;
    return client;
  };
  pool.connect = function (callback?: unknown) {
    if (typeof callback === 'function') {
      return (connect as (cb: unknown) => unknown)(
        (error: unknown, client: pg.PoolClient | undefined, done: unknown) => {
          if (client) wrap(client);
          (callback as (...a: unknown[]) => unknown)(error, client, done);
        },
      );
    }
    return (connect as () => Promise<pg.PoolClient>)().then(wrap);
  } as typeof pool.connect;
}

beforeAll(async () => {
  [pgFixture, redisFixture] = await Promise.all([startTestDb(), startTestRedis()]);
  db = pgFixture.db;
  recordStatements(pgFixture.pool);
  redis = createRedis(redisFixture.url);
  subscriber = createRedis(redisFixture.url);

  gateway = createGateway(
    {
      db,
      auth: stubAuth,
      redis,
      subscriber,
      rateLimiter: allowEverySend,
      gatewayId: 'subscribe-cost-test',
      log: () => undefined,
    },
    { port: 0 },
  );
  await new Promise<void>((resolve) => gateway.wss.once('listening', () => resolve()));
  url = `ws://127.0.0.1:${(gateway.wss.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  await gateway.close();
  redis.disconnect();
  subscriber.disconnect();
  await pgFixture.stop();
  await redisFixture.stop();
});

type Frame = { t: string; d: Record<string, unknown> };

async function connectAndAuth(): Promise<{
  socket: WebSocket;
  frames: Frame[];
  waitFor: (t: string) => Promise<Frame>;
}> {
  const socket = new WebSocket(url);
  const frames: Frame[] = [];
  socket.on('message', (raw: Buffer) => frames.push(JSON.parse(raw.toString()) as Frame));
  socket.on('error', () => undefined);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });

  const waitFor = async (t: string): Promise<Frame> => {
    await vi.waitFor(() => expect(frames.some((f) => f.t === t)).toBe(true), { timeout: 10_000 });
    return frames.filter((f) => f.t === t).at(-1)!;
  };

  socket.send(
    JSON.stringify({
      t: 'auth',
      d: { token: 'a-token', deviceId: crypto.randomUUID(), platform: 'ios' },
    }),
  );
  await waitFor('auth.ok');
  return { socket, frames, waitFor };
}

/**
 * How many statements the gateway ran while subscribing to these channels.
 *
 * Counted around the frame rather than around the whole connection, so the handshake's own two
 * round trips are not attributed to the subscribe.
 */
async function subscribeCost(
  peer: { socket: WebSocket; waitFor: (t: string) => Promise<Frame> },
  channelIds: string[],
): Promise<{ cost: number; granted: number }> {
  statements = [];
  peer.socket.send(JSON.stringify({ t: 'subscribe', d: { channelIds } }));
  const reply = await peer.waitFor('subscribed');
  const cost = statements.length;
  const granted = (reply.d['granted'] as string[] | undefined)?.length ?? 0;
  return { cost, granted };
}

it('subscribes to twenty channels in no more statements than one', async () => {
  const club = await seedClub(db);
  sessionUserId = club.ownerId;

  /*
   * Twenty channels the caller really is a member of, so the measurement covers the GRANTED path
   * rather than the cheap rejection. Races are the natural way to get many channels inside one
   * club, which is also what a real member of an active club has.
   */
  const channelIds: string[] = [club.channelId];
  for (let i = 0; i < 19; i += 1) {
    const raceRows = await db.execute<{ id: string }>(
      sql`insert into races (club_id, name) values (${club.clubId}, ${`Cost Race ${i}`}) returning id`,
    );
    const raceId = raceRows.rows[0]!.id;
    await db.execute(
      sql`insert into race_memberships (race_id, user_id) values (${raceId}, ${club.ownerId})`,
    );
    const channelRows = await db.execute<{ id: string }>(
      sql`insert into channels (club_id, scope, scope_id)
          values (${club.clubId}, 'race', ${raceId}) returning id`,
    );
    channelIds.push(channelRows.rows[0]!.id);
  }

  const peer = await connectAndAuth();

  const one = await subscribeCost(peer, [channelIds[0]!]);
  expect(one.granted, 'the single subscribe must actually be granted, or this measures a refusal').toBe(1);

  // A second socket, because the first is now already attached to that channel and the gateway
  // short-circuits a repeat subscribe at the in-process map rather than at the database.
  const second = await connectAndAuth();
  const twenty = await subscribeCost(second, channelIds);
  expect(twenty.granted, 'all twenty must be granted, or this measures rejections').toBe(20);

  console.log(
    `[measured] subscribe  1 channel: ${one.cost} statements, 20 channels: ${twenty.cost} statements`,
  );

  expect(
    twenty.cost,
    'a client resubscribing after a reconnect must not pay a round trip per channel',
  ).toBe(one.cost);

  peer.socket.close();
  second.socket.close();
});

/**
 * And it must still grant a channel id sent in upper case.
 *
 * > **This is the regression the batching nearly shipped, on the one path no Fastify hook
 * > covers.** The gateway is a separate process: the uuid hook in `app.ts` that canonicalizes
 * > route params does not run here, and `Uuid` in `packages/shared` is `z.string().uuid()`, which
 * > accepts either spelling. Before batching, `getChannelRef` compared in SQL and either spelling
 * > matched; after it, the ref arrives in a `Map` keyed by the lower case id Postgres returns, so
 * > an upper case id would have been silently REJECTED - a member's chat simply stops being live,
 * > with the socket healthy and the frame answered `200`-shaped.
 *
 * Caught by an adversarial review of the change rather than by the change's own tests, which is
 * the whole argument for running one.
 */
it('grants a channel whose id was sent in upper case', async () => {
  const club = await seedClub(db);
  sessionUserId = club.ownerId;

  const peer = await connectAndAuth();
  const result = await subscribeCost(peer, [club.channelId.toUpperCase()]);

  expect(
    result.granted,
    'a uuid has two spellings and both used to work; batching must not have changed that',
  ).toBe(1);

  peer.socket.close();
});
