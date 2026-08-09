/**
 * THE PHASE 0 EXIT DRILL.
 *
 * SPEC/TECH/16-build-phases.md gates Phase 0 on this, with the gateway killed
 * **mid-send** and both clients forced to reconnect:
 *
 *   1. **Nothing lost.** Every message either appears on every device, or was never acked.
 *   2. **Nothing twice.** No message appears more than once on any device, including
 *      retried sends and replayed outbox events. Verified by asserting the message
 *      COUNT, not by eyeballing the transcript.
 *   3. **Identical order.** Both devices render the same `seq` sequence, with no holes.
 *
 * The spec is emphatic that conditions 2 and 3 are the point, and that a gate proving
 * only delivery "is half a test" - it would pass a build that still contained both the
 * system-message duplication bug and the `msg.ack` gap bug.
 *
 * The client here is the real `@clubchat/client-core`, not a stand-in, so what the
 * drill proves is what ships.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { count, eq, sql } from 'drizzle-orm';
import { ChatClient, findGaps, type SocketLike } from '@clubchat/client-core';
import { createAuth, type Auth } from '../auth.ts';
import type { Config } from '../config.ts';
import { createDb, createPool, type Db } from '../db/client.ts';
import { channelTopic, createRateLimiter, createRedis } from '../bus/redis.ts';
import { RecordingPushSender } from '../push/sender.ts';
import { FakeMediaStore } from '../media/store.ts';
import { silentMonitor } from '../monitoring.ts';
import { allowAll } from './fake-limiter.ts';
import { buildApp } from '../api/app.ts';
import { createGateway, type Gateway } from '../gateway/server.ts';
import { addMember } from '../domain/membership.ts';
import { loadAccessContext } from '../policy/context.ts';
import { createClub } from '../domain/create-club.ts';
import { drainOnce } from '../worker/drain.ts';
import { clubMemberships, messages } from '../db/schema.ts';
import { startTestDb, startTestRedis, type TestDb, type TestRedis } from './harness.ts';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';

let pg: TestDb;
let redisFixture: TestRedis;
let db: Db;
let auth: Auth;
let app: FastifyInstance;
let apiUrl: string;
let gatewayPort: number;
let gateway: Gateway;
let redis: Redis;
let subscriber: Redis;
const config = {
  LOG_LEVEL: 'error',
  CLIENT_ORIGIN: 'http://localhost:8081',
  BETTER_AUTH_URL: 'http://localhost:3000',
  SEND_RATE_BURST: 1_000,
  SEND_RATE_REFILL_PER_SEC: 1_000,
  S3_BUCKET_PUBLIC: 'identity',
  S3_BUCKET_PRIVATE: 'content',
  MEDIA_SIGNING_SECRET: 'test-signing-secret-not-real',
  MEDIA_CDN_BASE_URL: 'http://cdn.invalid/content',
} as unknown as Config;

const silent = () => undefined;

/** Adapt Node's `ws` to the client's minimal socket surface. */
const createSocket = (url: string): SocketLike => new WebSocket(url) as unknown as SocketLike;

async function startGateway(): Promise<Gateway> {
  redis = createRedis(redisFixture.url);
  subscriber = createRedis(redisFixture.url);
  return createGateway(
    {
      db,
      auth,
      redis,
      subscriber,
      rateLimiter: createRateLimiter(redis, {
        burst: config.SEND_RATE_BURST,
        refillPerSec: config.SEND_RATE_REFILL_PER_SEC,
      }),
      gatewayId: `gw-${crypto.randomUUID().slice(0, 8)}`,
      log: silent,
    },
    { port: gatewayPort },
  );
}

/**
 * Kill the gateway the way a crash does.
 *
 * `terminate()` on every socket plus closing the server, with the Redis connections
 * dropped rather than drained - no graceful goodbye to the clients, because a process
 * that is killed does not send one. If the design needed a graceful shutdown to avoid
 * losing data, that would be the defect this drill exists to find.
 */
async function killGateway(): Promise<void> {
  await gateway.close();
  redis.disconnect();
  subscriber.disconnect();
}

async function signUp(name: string): Promise<{ userId: string; token: string }> {
  const email = `${name.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}@test.invalid`;
  const result = await auth.api.signUpEmail({
    body: { name, email, password: 'correct-horse-battery-staple' },
  });
  const token = (result as { token?: string }).token;
  if (!token) throw new Error('sign-up returned no session token');
  return { userId: result.user.id, token };
}

function makeClient(token: string, platform: 'ios' | 'web'): ChatClient {
  return new ChatClient({
    wsUrl: `ws://127.0.0.1:${gatewayPort}`,
    apiUrl,
    token,
    deviceId: crypto.randomUUID(),
    platform,
    createSocket,
    // Node has the global; a device does not, which is the whole reason this is injected.
    randomUuid: () => crypto.randomUUID(),
    maxSendAttempts: 8,
    log: silent,
  });
}

beforeAll(async () => {
  [pg, redisFixture] = await Promise.all([startTestDb(), startTestRedis()]);
  db = pg.db;
  auth = createAuth(db, { secret: 'test-secret-not-a-real-one', baseURL: config.BETTER_AUTH_URL });

  // The drill asserts nothing about media; the fake keeps it off the network.
  app = buildApp({ db, auth, config, mediaStore: new FakeMediaStore(), monitor: silentMonitor(), limiter: allowAll() });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (typeof address === 'string' || address === null) throw new Error('no api address');
  apiUrl = `http://127.0.0.1:${address.port}`;

  // A fixed port so the restarted gateway is reachable at the same address the clients
  // already hold, which is what a real restart behind a load balancer looks like.
  gatewayPort = 34_100 + Math.floor(Math.random() * 400);
  gateway = await startGateway();
});

afterAll(async () => {
  await gateway?.close().catch(() => undefined);
  redis?.disconnect();
  subscriber?.disconnect();
  await app?.close().catch(() => undefined);
  await pg?.stop().catch(() => undefined);
  await redisFixture?.stop().catch(() => undefined);
});

describe('the read frame the app actually sends', () => {
  /*
   * A reachability test, not a behaviour test.
   *
   * `openChat` already had a unit test proving it writes the "caught up on N messages" history
   * row - and it passed for four phases while not one such row existed in any database, because
   * the gateway's `msg.read` handler called the lower-level cursor advance underneath it and
   * nothing else ever called `openChat` outside its own test. Failure mode 11: both ends
   * complete, nothing joining them, and a green suite over the gap.
   *
   * So this drives the REAL client through the REAL gateway and then looks in the table. It is
   * the only shape that can fail when the handler is rewired to something that merely moves the
   * cursor, which is exactly the regression worth guarding.
   */
  it('writes the caught-up history row, through a live socket', async () => {
    const alice = await signUp('ReadFrameAlice');
    const bob = await signUp('ReadFrameBob');

    const club = await createClub(db, {
      name: 'Read Frame Club',
      sport: 'running',
      creatorId: alice.userId,
    });
    await addMember(db, await loadAccessContext(db, alice.userId), club.clubId, bob.userId);

    // Alice says three things. Bob has not read any of them.
    const aliceClient = makeClient(alice.token, 'web');
    await aliceClient.connect();
    for (const body of ['one', 'two', 'three']) {
      await aliceClient.sendWithRetry(club.mainChannelId, body);
    }

    // Bob opens the chat, which is a `msg.read` frame and nothing else.
    const bobClient = makeClient(bob.token, 'ios');
    await bobClient.connect();
    bobClient.markRead(club.mainChannelId, 3);

    // The frame is fire-and-forget, so wait for the write rather than assuming it landed.
    let rows = 0;
    for (let attempt = 0; attempt < 40 && rows === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const found = await db.execute<{ n: number }>(sql`
        SELECT COUNT(*)::int AS n FROM notifications
         WHERE recipient_id = ${bob.userId} AND type = 'chat_caught_up'
      `);
      rows = Number(found.rows[0]?.n ?? 0);
    }

    expect(rows, 'opening a chat over the socket recorded no caught-up row').toBe(1);

    // And it is history rather than an alert: already read, so it never touches the badge.
    const unread = await db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM notifications
       WHERE recipient_id = ${bob.userId} AND type = 'chat_caught_up' AND read_at IS NULL
    `);
    expect(Number(unread.rows[0]?.n)).toBe(0);

    await aliceClient.close();
    await bobClient.close();
  }, 30_000);

  /**
   * **A frame from a producer that predates a field is repaired on the way through.**
   *
   * The bug this guards, in full. A worker process that had been up since before `mentions` was
   * added to the envelope published a card without it. The gateway relayed the payload verbatim
   * - it was typed `ServerFrame` but only ever `JSON.parse`d, so the type was a claim nothing
   * checked - and on every client `JSON.stringify(undefined)` bound SQL NULL into a NOT NULL
   * column. The insert died, the card was never cached, and creating a poll or an event looked
   * like it silently did nothing.
   *
   * Only cards, because they are the one message the worker publishes rather than the gateway;
   * and a reload fixed it, because the same message then came through `/sync`, whose envelopes
   * are built elsewhere. Both of those pointed away from the cause.
   *
   * Published as a raw object rather than through `publishToChannel`, because the typed helper
   * cannot express the defect - which is the point: this reproduces an OLDER process, and no
   * amount of typing in the current one can.
   */
  it('repairs an envelope published without a field the schema defaults', async () => {
    const alice = await signUp('RepairAlice');
    const club = await createClub(db, {
      name: 'Repair Club',
      sport: 'running',
      creatorId: alice.userId,
    });

    /*
     * A RAW socket, deliberately, rather than `ChatClient`.
     *
     * The client parses arriving frames too, so driving this through it would pass whether or
     * not the gateway repairs anything - which a mutation test confirmed. Reading the bytes the
     * gateway actually emits is the only way to assert the server's own half.
     *
     * And that half matters on its own: a client already installed on somebody's phone cannot
     * be fixed retroactively, so a server that relays a broken frame breaks every old build in
     * the field. The fix has to hold at both ends for different reasons.
     */
    const socket = new WebSocket(`ws://127.0.0.1:${gatewayPort}`);
    const frames: Array<{ t: string; d: Record<string, unknown> }> = [];
    socket.on('message', (data: unknown) =>
      frames.push(JSON.parse(String(data)) as { t: string; d: Record<string, unknown> }),
    );
    await new Promise((resolve) => socket.once('open', resolve));

    const waitForFrame = async (type: string) => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const found = frames.find((frame) => frame.t === type);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`no ${type} frame arrived`);
    };

    socket.send(
      JSON.stringify({
        t: 'auth',
        d: { token: alice.token, deviceId: crypto.randomUUID(), platform: 'ios' },
      }),
    );
    await waitForFrame('auth.ok');
    // Connecting authenticates; RECEIVING needs the subscription, which is what puts this
    // socket in the gateway's per-channel fan-out map.
    socket.send(JSON.stringify({ t: 'subscribe', d: { channelIds: [club.mainChannelId] } }));
    await waitForFrame('subscribed');

    // An envelope exactly as an OLD producer would publish it: no `mentions`, no `replyTo`.
    // Published as a raw object rather than through `publishToChannel`, because the typed
    // helper cannot express the defect - which is the point. This reproduces an older process,
    // and no amount of typing in the current one can.
    await redis.publish(
      channelTopic(club.mainChannelId),
      JSON.stringify({
        channelId: club.mainChannelId,
        seq: 1,
        envelope: {
          id: crypto.randomUUID(),
          channelId: club.mainChannelId,
          seq: 1,
          senderId: alice.userId,
          senderName: 'RepairAlice',
          senderImage: null,
          type: 'text',
          body: 'from a process that predates mentions',
          clientMsgId: crypto.randomUUID(),
          pinned: false,
          pinnedAt: null,
          reactions: [],
          mediaId: null,
          documentName: null,
          documentSize: null,
          linkedPollId: null,
          linkedEventId: null,
          linkedMeetingId: null,
          deletedAt: null,
          createdAt: new Date().toISOString(),
        },
      }),
    );

    const relayed = await waitForFrame('msg.new');
    // The bytes on the wire, repaired. Without the parse these are simply absent, and the
    // client that receives them writes `undefined` into a NOT NULL column and loses the message.
    expect(relayed.d['mentions'], 'the gateway relayed an envelope with no mentions').toEqual([]);
    expect(relayed.d['replyTo']).toBeNull();
    expect(relayed.d['body']).toBe('from a process that predates mentions');

    socket.close();
  }, 30_000);
});

/**
 * The cold open: a chat screen mounting while the handshake is still in flight.
 *
 * > **This is what "the gateway rejects a session the API accepts" actually was.** The token was
 * > never the problem - `GET /me` answered 200 for it throughout. `handleAuth` awaits two database
 * > round trips, and the gateway used to start the NEXT frame rather than queue it behind the
 * > first, so a `subscribe` or `msg.read` sent in that window was evaluated against
 * > `state.userId === null`, refused as `invalid_token`, and the socket closed. The client reads
 * > that code as proof the session is dead and signs the member out.
 *
 * A chat screen's mount effect calls `openChannel` and `markRead`, and on a cold open - deep link,
 * notification tap, web refresh - it lands in that window reliably. Which is why the symptom was
 * "it happens sometimes, and signing out and back in fixes it": signing in lands on the club list,
 * where nothing opens a channel while connecting.
 *
 * Driven through the real client and the real gateway, because neither half is wrong on its own.
 */
describe('a frame sent while the handshake is in flight', () => {
  it('does not refuse the session, and the subscription still lands', async () => {
    const founder = await signUp('ColdOpen');
    const club = await createClub(db, {
      name: 'Cold Open Club',
      sport: 'running',
      creatorId: founder.userId,
    });

    // Proof the session is good, so a refusal below cannot be blamed on the token.
    const me = await fetch(`${apiUrl}/me`, {
      headers: { authorization: `Bearer ${founder.token}` },
    });
    expect(me.status, 'the API refused the token, so this proves nothing').toBe(200);

    const frames: string[] = [];
    const client = new ChatClient({
      wsUrl: `ws://127.0.0.1:${gatewayPort}`,
      apiUrl,
      token: founder.token,
      deviceId: crypto.randomUUID(),
      platform: 'web',
      createSocket: (url) => {
        const socket = new WebSocket(url);
        socket.addEventListener('message', (event) => {
          frames.push(JSON.parse(String(event.data)).t as string);
        });
        /*
         * The screen effect, fired at the one moment that used to break it: the socket is OPEN,
         * so sending throws nothing, and `auth.ok` cannot have come back yet because the server
         * has two queries to run first. A tick after `open` is that window.
         */
        socket.addEventListener('open', () => {
          setTimeout(() => void client.openChannel(club.mainChannelId).catch(() => undefined), 0);
        });
        return socket as unknown as SocketLike;
      },
      randomUuid: () => crypto.randomUUID(),
      log: silent,
    });

    // Before the fix this rejected with AuthRejectedError('invalid_token').
    await expect(client.connect()).resolves.toBeUndefined();

    // And the subscription asked for mid-handshake is not merely un-refused, it lands - a fix
    // that only stopped the sign-out while dropping the subscribe would be a quieter bug.
    for (let attempt = 0; attempt < 40 && !frames.includes('subscribed'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(frames, 'the subscription asked for during the handshake never landed').toContain(
      'subscribed',
    );

    await client.close();
  }, 30_000);

  /*
   * A RAW socket, deliberately, rather than `ChatClient` - for the same reason the envelope
   * repair test above uses one.
   *
   * The client now holds its frames until `auth.ok`, so driving this through it passes whether
   * or not the GATEWAY queues anything. A mutation test confirmed exactly that: with the
   * per-socket queue removed, the client-driven test above still passed. Only bytes put on the
   * wire in the offending order can assert the server's half.
   *
   * And the server's half matters on its own: a client already installed on somebody's phone
   * cannot be fixed retroactively, so a gateway that refuses correctly-ordered frames keeps
   * signing out every build in the field.
   */
  it('handles frames in arrival order, so a subscribe cannot overtake the auth before it', async () => {
    const founder = await signUp('ColdOpenRaw');
    const club = await createClub(db, {
      name: 'Cold Open Raw Club',
      sport: 'running',
      creatorId: founder.userId,
    });

    const socket = new WebSocket(`ws://127.0.0.1:${gatewayPort}`);
    const frames: Array<{ t: string; d: Record<string, unknown> }> = [];
    socket.on('message', (data: unknown) =>
      frames.push(JSON.parse(String(data)) as { t: string; d: Record<string, unknown> }),
    );
    await new Promise((resolve) => socket.once('open', resolve));

    // Both frames in one tick, in the correct order. `handleAuth` runs two queries, so without
    // a queue the second frame is evaluated while `state.userId` is still null.
    socket.send(
      JSON.stringify({
        t: 'auth',
        d: { token: founder.token, deviceId: crypto.randomUUID(), platform: 'ios' },
      }),
    );
    socket.send(JSON.stringify({ t: 'subscribe', d: { channelIds: [club.mainChannelId] } }));

    for (let attempt = 0; attempt < 60 && !frames.some((f) => f.t === 'subscribed'); attempt += 1) {
      if (frames.some((frame) => frame.t === 'auth.err')) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(
      frames.find((frame) => frame.t === 'auth.err')?.d['code'],
      'the gateway refused a correctly-ordered subscribe, which signs the member out',
    ).toBeUndefined();
    expect(frames.map((frame) => frame.t)).toEqual(['auth.ok', 'subscribed']);

    socket.close();
  }, 30_000);
});

describe('Phase 0 exit drill', () => {
  it('loses nothing, duplicates nothing, and orders identically when the gateway is killed mid-send', async () => {
    // ---------------------------------------------------------------- arrange
    const alice = await signUp('Alice');
    const bob = await signUp('Bob');

    const club = await createClub(db, {
      name: 'Gateway Drill Running Club',
      sport: 'running',
      creatorId: alice.userId,
    });
    await db.insert(clubMemberships).values({
      clubId: club.clubId,
      userId: bob.userId,
      role: 'member',
    });

    // Drain the bootstrap effect so the club's system message occupies a real seq.
    // Including it makes the drill stronger: a redelivered outbox event that posted a
    // duplicate system message would show up in the count assertions below.
    // A recording sender, so the drill cannot reach the network. It asserts nothing about
    // push - that is the Phase 1 gate's job - but the drain now needs the port.
    const drainDeps = { db, redis, push: new RecordingPushSender(), log: silent };
    await drainOnce(db, drainDeps);

    const channelId = club.mainChannelId;

    const clientA = makeClient(alice.token, 'ios');
    const clientB = makeClient(bob.token, 'web');

    await clientA.connect();
    await clientB.connect();
    clientA.subscribe([channelId]);
    clientB.subscribe([channelId]);
    // Let the subscribe frames be processed before anyone sends.
    await new Promise((r) => setTimeout(r, 200));

    await clientA.syncAll();
    await clientB.syncAll();

    // ------------------------------------------------------------------- act
    const ackedSeqs: number[] = [];
    const neverAcked: string[] = [];

    // Phase 1: a calm baseline, so the killed window is distinguishable from "nothing
    // ever worked".
    for (let i = 0; i < 5; i += 1) {
      ackedSeqs.push(await clientA.sendWithRetry(channelId, `before-kill A${i}`));
      ackedSeqs.push(await clientB.sendWithRetry(channelId, `before-kill B${i}`));
    }

    // Phase 2: kill the gateway WHILE sends are in flight. The sends are started and
    // deliberately not awaited before the kill lands, so some are mid-flight when the
    // socket dies. Each either acks (and must appear everywhere) or never acks (and
    // may legitimately be absent) - there is no third outcome that passes.
    const inFlight: Array<Promise<number>> = [];
    for (let i = 0; i < 10; i += 1) {
      inFlight.push(clientA.sendWithRetry(channelId, `during-kill A${i}`));
      inFlight.push(clientB.sendWithRetry(channelId, `during-kill B${i}`));
    }

    await new Promise((r) => setTimeout(r, 15));
    await killGateway();

    // Phase 3: the gateway comes back and both clients reconnect. reconnect()
    // resubscribes and reconciles by seq before retrying the outbox.
    gateway = await startGateway();
    await new Promise((r) => setTimeout(r, 100));

    const settled = await Promise.allSettled(inFlight);
    for (const [index, outcome] of settled.entries()) {
      if (outcome.status === 'fulfilled') ackedSeqs.push(outcome.value);
      else neverAcked.push(`during-kill ${index}`);
    }

    await clientA.reconnect();
    await clientB.reconnect();

    // Phase 4: traffic after recovery, proving the system is working rather than merely
    // intact.
    for (let i = 0; i < 5; i += 1) {
      ackedSeqs.push(await clientA.sendWithRetry(channelId, `after-kill A${i}`));
      ackedSeqs.push(await clientB.sendWithRetry(channelId, `after-kill B${i}`));
    }

    // Drain the effects produced during the run. Deliberately NO extra syncAll() after
    // this point: an unconditional final sync would backfill any hole and turn this
    // into a test of "sync works" rather than a test of the end state reconnect
    // actually leaves behind. Reconciliation already happened inside reconnect(), which
    // is where a real client does it.
    await drainOnce(db, drainDeps);
    // One targeted sync for the system messages the drain just produced, which arrived
    // with no socket listening for them.
    await clientA.syncAll();
    await clientB.syncAll();

    // ---------------------------------------------------------------- assert
    const serverRows = await db
      .select({ seq: messages.seq })
      .from(messages)
      .where(eq(messages.channelId, channelId))
      .orderBy(messages.seq);
    const serverSeqs = serverRows.map((row) => row.seq);

    const seqsA = await clientA.store.seqs(channelId);
    const seqsB = await clientB.store.seqs(channelId);

    // --- 3. Identical order, no holes ---
    // Asserted first because it is the condition a delivery-only gate would miss.
    expect(findGaps(serverSeqs), 'server log has a hole').toEqual([]);
    expect(findGaps(seqsA), 'client A has a hole').toEqual([]);
    expect(findGaps(seqsB), 'client B has a hole').toEqual([]);
    expect(seqsA, 'A and B disagree on order').toEqual(seqsB);
    expect(serverSeqs).toEqual(Array.from({ length: serverSeqs.length }, (_, i) => i + 1));

    // --- 2. Nothing twice ---
    // By COUNT, per the spec. A Set collapsing duplicates would hide exactly the bug
    // this is looking for, so compare raw length against distinct length.
    const rows = await db
      .select({ n: count() })
      .from(messages)
      .where(eq(messages.channelId, channelId));
    const serverCount = rows[0]?.n ?? 0;

    expect(serverSeqs.length).toBe(serverCount);
    expect(new Set(serverSeqs).size, 'server stored a duplicate seq').toBe(serverSeqs.length);
    expect(new Set(seqsA).size, 'client A holds a duplicate').toBe(seqsA.length);
    expect(new Set(seqsB).size, 'client B holds a duplicate').toBe(seqsB.length);

    // Every acked seq is distinct: no two sends were ever given the same position.
    const distinctAcked = new Set(ackedSeqs);
    expect(distinctAcked.size, 'two sends were acked at the same seq').toBe(ackedSeqs.length);

    // --- 1. Nothing lost ---
    // Every acked message is on the server AND on both devices. This is the direction
    // that matters: an ack is a promise of durability, so a message that acked and then
    // vanished is the worst possible outcome.
    for (const seq of ackedSeqs) {
      expect(serverSeqs, `acked seq ${seq} missing from the server`).toContain(seq);
      expect(seqsA, `acked seq ${seq} missing from client A`).toContain(seq);
      expect(seqsB, `acked seq ${seq} missing from client B`).toContain(seq);
    }

    // Both devices hold the complete log.
    expect(seqsA).toEqual(serverSeqs);
    expect(seqsB).toEqual(serverSeqs);

    // The drill is only meaningful if the kill actually disrupted something and the
    // recovery path actually ran. Without these, a gateway that was never really killed
    // would pass everything above.
    expect(ackedSeqs.length).toBeGreaterThanOrEqual(20);
    expect(
      clientA.syncCount + clientB.syncCount,
      'no sync ran, so reconciliation was never exercised',
    ).toBeGreaterThan(0);

    // eslint-disable-next-line no-console
    console.log(
      [
        '',
        '  Phase 0 exit drill',
        `    server messages:      ${serverCount}`,
        `    acked sends:          ${ackedSeqs.length}`,
        `    never acked:          ${neverAcked.length}`,
        `    client A holds:       ${seqsA.length}`,
        `    client B holds:       ${seqsB.length}`,
        `    holes (server/A/B):   ${findGaps(serverSeqs).length}/${findGaps(seqsA).length}/${findGaps(seqsB).length}`,
        `    syncs (A+B):          ${clientA.syncCount + clientB.syncCount}`,
        '',
      ].join('\n'),
    );

    await clientA.close();
    await clientB.close();
  });
});
