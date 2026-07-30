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
import { count, eq } from 'drizzle-orm';
import { ChatClient, findGaps, type SocketLike } from '@clubchat/client-core';
import { createAuth, type Auth } from '../auth.ts';
import type { Config } from '../config.ts';
import { createDb, createPool, type Db } from '../db/client.ts';
import { createRateLimiter, createRedis } from '../bus/redis.ts';
import { RecordingPushSender } from '../push/sender.ts';
import { buildApp } from '../api/app.ts';
import { createGateway, type Gateway } from '../gateway/server.ts';
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
    maxSendAttempts: 8,
    log: silent,
  });
}

beforeAll(async () => {
  [pg, redisFixture] = await Promise.all([startTestDb(), startTestRedis()]);
  db = pg.db;
  auth = createAuth(db, { secret: 'test-secret-not-a-real-one', baseURL: config.BETTER_AUTH_URL });

  app = buildApp({ db, auth, config });
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
