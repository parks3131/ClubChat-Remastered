/**
 * A deduplicated retry must still publish, because the append and the publish are not atomic.
 *
 * > **The assumption the old code made is that a `deduplicated: true` answer proves the original
 * > was delivered. It proves only that the ROW exists.** The two writes are a Postgres commit and
 * > a Redis publish, in that order, with no transaction across them - so a first attempt that
 * > committed and then died, or whose publish threw, leaves a message that is durable and was
 * > never fanned out. The client retries with the same `client_msg_id`, the server recognises it,
 * > returns the original `seq`, and skips the publish forever. Nothing reports it.
 *
 * The symptom is the one that gets described as "it did not show up until I backgrounded the
 * app": every other member's client eventually finds the message on its next `/sync`, because it
 * really is in the channel log. Realtime is the only thing that was lost, and realtime failing
 * silently is the shape of bug this codebase has shipped more than once.
 *
 * Routed here from the branch that fixed the identical shape in `worker/effects.ts`
 * `postSystemMessage`, which returned early without publishing on a dedup hit.
 *
 * **Publishing unconditionally is safe, and the client rules that make it safe are these three:**
 * `decideGap` answers `ignore` with `syncAfter: false` for any seq at or below the local maximum
 * (`packages/shared/src/protocol.ts:292`); `applyIncoming` upserts the envelope and backfills
 * nothing on an `ignore` (`packages/client-core/src/chat-client.ts`); and the device's own store
 * is `ON CONFLICT (channel_id, seq) DO UPDATE` (`apps/mobile/src/sqlite-store.ts:228`). A
 * duplicate `msg.new` for a seq the client already holds is therefore an idempotent write and
 * nothing else - pinned by the existing client test "ignores a duplicate seq, so a sender own
 * msg.new after its ack is a no-op". Notifications are unaffected either way: they ride the
 * outbox event, and `appendMessage` writes no outbox event for a deduplicated retry.
 *
 * A duplicate publish is strictly cheaper than a lost one.
 */

import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { Redis } from 'ioredis';
import type { Auth } from '../auth.ts';
import type { Db } from '../db/client.ts';
import type { RateLimiter } from '../bus/redis.ts';
import { channelTopic, createRedis } from '../bus/redis.ts';
import { createGateway, type Gateway } from '../gateway/server.ts';
import { seedClub, startTestDb, startTestRedis, type TestDb, type TestRedis } from './harness.ts';

let pg: TestDb;
let redisFixture: TestRedis;
let db: Db;
let redis: Redis;
let subscriber: Redis;
/** An independent connection, so what the gateway published is observed rather than inferred. */
let watcher: Redis;
let gateway: Gateway;
let url: string;

/**
 * The session, stubbed.
 *
 * The defect is on the send path, so standing up better-auth to reach it would be ceremony
 * around the part under test. The database underneath is real, which is the part that matters:
 * the access context, the membership check and the channel log are all the shipping code.
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
  watcher = createRedis(redisFixture.url);

  gateway = createGateway(
    {
      db,
      auth: stubAuth,
      redis,
      subscriber,
      rateLimiter: allowEverySend,
      gatewayId: 'republish-test',
      log: () => undefined,
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
  watcher.disconnect();
  await pg.stop();
  await redisFixture.stop();
});

type Frame = { t: string; d: Record<string, unknown> };

/** A connected socket, with every frame it has been sent kept for the assertions. */
async function connect(): Promise<{ socket: WebSocket; frames: Frame[]; waitFor: (t: string) => Promise<Frame> }> {
  const socket = new WebSocket(url);
  const frames: Frame[] = [];
  socket.on('message', (raw: Buffer) => frames.push(JSON.parse(raw.toString()) as Frame));
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });

  const waitFor = async (t: string): Promise<Frame> => {
    const seen = frames.filter((frame) => frame.t === t).length;
    await vi.waitFor(() => expect(frames.filter((frame) => frame.t === t).length).toBeGreaterThan(seen), {
      timeout: 10_000,
    });
    return frames.filter((frame) => frame.t === t).at(-1)!;
  };

  return { socket, frames, waitFor };
}

it('publishes again for a deduplicated retry, rather than assuming the first one was delivered', async () => {
  const club = await seedClub(db);
  sessionUserId = club.ownerId;

  /*
   * Watched on a connection of its own. Counting what the gateway's own subscriber received
   * would be counting the wrong thing - a gateway holding no socket for this channel is not
   * subscribed to it at all, which is the point of per-channel topics.
   */
  const published: number[] = [];
  await watcher.subscribe(channelTopic(club.channelId));
  watcher.on('message', (_topic: string, raw: string) => {
    published.push((JSON.parse(raw) as { seq: number }).seq);
  });

  const { socket, waitFor } = await connect();
  socket.send(
    JSON.stringify({
      t: 'auth',
      d: { token: 'a-token', deviceId: crypto.randomUUID(), platform: 'ios' },
    }),
  );
  await waitFor('auth.ok');

  // The message, and the id that makes its retry idempotent.
  const clientMsgId = crypto.randomUUID();
  const frame = {
    t: 'msg.send',
    d: { clientMsgId, channelId: club.channelId, type: 'text', body: 'said once, sent twice' },
  };

  socket.send(JSON.stringify(frame));
  const first = await waitFor('msg.ack');
  const seq = first.d['seq'] as number;
  await vi.waitFor(() => expect(published).toEqual([seq]), { timeout: 10_000 });

  /*
   * The retry the outbox makes after a socket flap - the SAME `client_msg_id`, which is exactly
   * what makes it safe to retry. The server recognises it, burns no sequence number, and returns
   * the original seq. Whether the first attempt's publish ever happened is not a thing it knows.
   */
  socket.send(JSON.stringify(frame));
  const second = await waitFor('msg.ack');
  expect(second.d['seq'], 'a retry must be deduplicated, not appended twice').toBe(seq);

  await vi.waitFor(
    () =>
      expect(
        published,
        'the retry skipped the fan-out, so a first attempt that died between the commit and the publish loses realtime for that message permanently',
      ).toEqual([seq, seq]),
    { timeout: 10_000 },
  );

  socket.close();
});
