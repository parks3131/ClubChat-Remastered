/**
 * The unified chat list.
 *
 * `GET /conversations` is the landing screen's read: every club chat and every DM the caller
 * has, newest activity first, with the last thing said in each. It is `listDmThreads`
 * generalised from one scope to several, so the tests that matter are the ones about **which
 * scopes appear** and **what the preview is allowed to say**.
 *
 * Two of these exist specifically to fail if somebody simplifies the query:
 *
 *  - Removing the scope filter makes race and Eboard channels appear, which is a product
 *    decision rather than an oversight - see `CONVERSATION_SCOPES`.
 *  - Passing the channel id where the predicate wants `scope_id` makes every DM read as
 *    read-only, which looks like a permissions bug and is a join bug.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { buildApp } from '../api/app.ts';
import { createAuth, type Auth } from '../auth.ts';
import type { Config } from '../config.ts';
import { clubMemberships, users } from '../db/schema.ts';
import { getChannelRef } from '../domain/reads.ts';
import { sendMessage, softDeleteMessage } from '../domain/send-message.ts';
import { loadAccessContext } from '../policy/context.ts';
import { FakeMediaStore } from '../media/store.ts';
import { silentMonitor } from '../monitoring.ts';
import { allowAll } from './fake-limiter.ts';
import { startTestDb, type TestDb } from './harness.ts';

let h: TestDb;
let app: FastifyInstance;
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

type Actor = { userId: string; token: string; name: string };

async function signUp(name: string): Promise<Actor> {
  const email = `${name.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}@test.invalid`;
  const result = await auth.api.signUpEmail({
    body: { name, email, password: 'correct-horse-battery-staple' },
  });
  const token = (result as { token?: string }).token;
  if (!token) throw new Error('sign-up returned no session token');
  return { userId: result.user.id, token, name };
}

async function as(
  actor: Actor,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
): Promise<{ status: number; body: any }> {
  const response = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${actor.token}` },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  return {
    status: response.statusCode,
    body: response.body.length > 0 ? JSON.parse(response.body) : null,
  };
}

async function createClubAs(
  actor: Actor,
  name = `Club ${crypto.randomUUID().slice(0, 6)}`,
): Promise<{ clubId: string; channelId: string; name: string }> {
  const created = await as(actor, 'POST', '/clubs', { name, sport: 'running' });
  expect(created.status).toBe(201);
  return { clubId: created.body.clubId, channelId: created.body.mainChannelId, name };
}

async function join(clubId: string, actor: Actor, role: 'member' | 'admin' = 'member') {
  await h.db.insert(clubMemberships).values({ clubId, userId: actor.userId, role });
}

/** Post the way the gateway does - sending is a frame, not a route. */
async function post(actor: Actor, channelId: string, body: string): Promise<number> {
  const channel = await getChannelRef(h.db, channelId);
  if (!channel) throw new Error('no such channel');
  const ctx = await loadAccessContext(h.db, actor.userId);
  const result = await sendMessage(h.db, ctx, channel, {
    channelId,
    clientMsgId: crypto.randomUUID(),
    body,
  });
  if (!result.ok) throw new Error(`send refused: ${result.code}`);
  return result.message.seq;
}

async function conversations(actor: Actor) {
  const response = await as(actor, 'GET', '/conversations');
  expect(response.status).toBe(200);
  return response.body.conversations as Array<Record<string, any>>;
}

beforeAll(async () => {
  h = await startTestDb();
  auth = createAuth(h.db, {
    secret: 'test-secret-not-a-real-one',
    baseURL: config.BETTER_AUTH_URL,
  });
  app = buildApp({ db: h.db, auth, config, mediaStore: new FakeMediaStore(), monitor: silentMonitor(), limiter: allowAll() });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close().catch(() => undefined);
  await h?.stop().catch(() => undefined);
});

describe('which conversations appear', () => {
  it('carries club chats and DMs in one list, newest activity first', async () => {
    const owner = await signUp('ConvOwner');
    const peer = await signUp('ConvPeer');
    const first = await createClubAs(owner, 'Older Club');
    await join(first.clubId, peer);
    const second = await createClubAs(owner, 'Newer Club');
    await join(second.clubId, peer);

    const opened = await as(owner, 'POST', '/dm/threads', { userId: peer.userId });
    expect(opened.status).toBe(201);
    const dmChannelId = opened.body.channelId;

    // Speak in a deliberate order, so the assertion is about activity rather than creation.
    await post(owner, second.channelId, 'in the newer club');
    await post(owner, first.channelId, 'in the older club');
    await post(peer, dmChannelId, 'and then a direct message');

    const rows = await conversations(owner);

    // Most recent first: the DM was last spoken in, then the older club, then the newer one.
    expect(rows.map((r) => r.channelId)).toEqual([
      dmChannelId,
      first.channelId,
      second.channelId,
    ]);
    expect(rows.map((r) => r.scope)).toEqual(['dm', 'club', 'club']);
  });

  it('leaves out race and Eboard chats, which are reachable but not listed here', async () => {
    const owner = await signUp('ScopeOwner');
    const { clubId, channelId } = await createClubAs(owner);

    /*
     * The Eboard space is created with the club and the owner is already in it, so it needs no
     * setup - it is simply there, with a real channel, and must not appear.
     */
    const race = await as(owner, 'POST', `/clubs/${clubId}/races`, {
      name: 'Sectionals',
      raceDate: '2026-09-12',
    });
    expect(race.status).toBe(201);
    // A roster row, because management authority is not access - without this the race channel
    // would be excluded by the access predicate rather than by the scope filter, and the test
    // would pass for the wrong reason.
    const added = await as(owner, 'POST', `/races/${race.body.raceId}/members`, {
      userId: owner.userId,
    });
    expect(added.status).toBeLessThan(300);

    // Both other channels exist and the caller can reach both.
    const reachable = await as(owner, 'GET', '/channels');
    expect(reachable.body.channels.map((c: any) => c.scope).sort()).toEqual([
      'club',
      'eboard',
      'race',
    ]);

    // And exactly one of them is a conversation.
    const rows = await conversations(owner);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.channelId).toBe(channelId);
    expect(rows[0]!.scope).toBe('club');
  });

  it('shows a non-member nothing of a club they are not in', async () => {
    const owner = await signUp('PrivateOwner');
    const stranger = await signUp('Stranger');
    await createClubAs(owner);

    expect(await conversations(stranger)).toEqual([]);
  });
});

describe('what a row says', () => {
  it('carries the last message with its sender name, and the club its chat belongs to', async () => {
    const owner = await signUp('SayingOwner');
    const talker = await signUp('Talker');
    const { clubId, channelId } = await createClubAs(owner);
    await join(clubId, talker);
    await post(talker, channelId, 'practice moved to six');

    const [row] = await conversations(owner);

    expect(row!.lastMessage.preview).toBe('practice moved to six');
    // Joined, never stored: this is the sender's CURRENT name.
    expect(row!.lastMessage.senderName).toBe('Talker');
    expect(row!.lastMessage.senderId).toBe(talker.userId);
    expect(row!.lastMessage.deleted).toBe(false);
    // An ISO instant, not Postgres's own rendering. `::text` on a timestamptz emits
    // "2026-07-30 08:42:41.123+00", which a strict validator refuses.
    expect(row!.lastMessage.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(row!.clubId).toBe(clubId);
    expect(row!.otherUserId).toBeNull();
  });

  it('does not resurrect the text of a deleted message', async () => {
    const owner = await signUp('DeleterOwner');
    const { channelId } = await createClubAs(owner);
    const seq = await post(owner, channelId, 'something regrettable');

    const channel = await getChannelRef(h.db, channelId);
    const ctx = await loadAccessContext(h.db, owner.userId);
    const removed = await softDeleteMessage(h.db, ctx, channel!, seq);
    expect(removed.ok).toBe(true);

    const [row] = await conversations(owner);

    expect(row!.lastMessage.deleted).toBe(true);
    // The words are gone rather than merely hidden behind the flag - the tombstone nulls the
    // column, so there is nothing here to leak even if a client ignored `deleted`.
    expect(row!.lastMessage.preview).toBeNull();
  });

  it('reports a conversation nobody has spoken in yet rather than dropping it', async () => {
    const owner = await signUp('QuietOwner');
    const peer = await signUp('QuietPeer');
    const { clubId } = await createClubAs(owner);
    await join(clubId, peer);

    const opened = await as(owner, 'POST', '/dm/threads', { userId: peer.userId });
    const rows = await conversations(owner);
    const dm = rows.find((r) => r.channelId === opened.body.channelId);

    expect(dm).toBeDefined();
    expect(dm!.lastMessage).toBeNull();
    // Sorted by when it was created, so a thread just opened sits at the top rather than below
    // every club that has ever been spoken in.
    expect(rows[0]!.channelId).toBe(opened.body.channelId);
  });

  it('gives a DM the peer name and picture, and the club its own', async () => {
    const owner = await signUp('FaceOwner');
    const peer = await signUp('FacePeer');
    const { clubId, name: clubName } = await createClubAs(owner);
    await join(clubId, peer);
    await as(owner, 'POST', '/dm/threads', { userId: peer.userId });

    // Distinct pictures, because a test with one picture cannot tell "the peer's" from "the
    // club's" - which is exactly how a race once ended up wearing its club's face.
    await h.db.update(users).set({ image: 'peer-picture' }).where(eq(users.id, peer.userId));

    const rows = await conversations(owner);
    const dm = rows.find((r) => r.scope === 'dm');
    const club = rows.find((r) => r.scope === 'club');

    expect(dm!.name).toBe('FacePeer');
    expect(dm!.image).toBe('peer-picture');
    expect(dm!.otherUserId).toBe(peer.userId);
    // A DM belongs to no club at all, which is why `channels.club_id` is nullable.
    expect(dm!.clubId).toBeNull();
    expect(club!.name).toBe(clubName);
  });
});

describe('unread, mute and whether the composer is live', () => {
  it('counts unread from the log and keeps counting while muted', async () => {
    const owner = await signUp('UnreadOwner');
    const talker = await signUp('UnreadTalker');
    const { clubId, channelId } = await createClubAs(owner);
    await join(clubId, talker);

    // Three from somebody else, on top of the club-created system message the worker has not
    // written here - so the count is exactly what was said.
    await post(talker, channelId, 'one');
    await post(talker, channelId, 'two');
    await post(talker, channelId, 'three');

    const before = (await conversations(owner)).find((r) => r.channelId === channelId);
    expect(before!.unread).toBe(3);
    expect(before!.muted).toBe(false);

    const muted = await as(owner, 'POST', `/channels/${channelId}/mute`);
    expect(muted.status).toBeLessThan(300);

    const after = (await conversations(owner)).find((r) => r.channelId === channelId);
    // Mute silences the buzz, not the count. Conflating the two would silently mark things read
    // that nobody looked at.
    expect(after!.muted).toBe(true);
    expect(after!.unread).toBe(3);
  });

  it('says a normal DM can be posted in, and a blocked one cannot', async () => {
    const owner = await signUp('BlockOwner');
    const peer = await signUp('BlockPeer');
    const { clubId } = await createClubAs(owner);
    await join(clubId, peer);
    const opened = await as(owner, 'POST', '/dm/threads', { userId: peer.userId });
    const dmChannelId = opened.body.channelId;

    /*
     * The positive case is the load-bearing one. `canPost` resolves the DM through the access
     * context's thread map, keyed by the CONVERSATION id - so handing the predicate a channel
     * id instead answers false for every thread in the product, and only an assertion that a
     * healthy DM is writable can see it.
     */
    const writable = (await conversations(owner)).find((r) => r.channelId === dmChannelId);
    expect(writable!.canPost).toBe(true);

    const blocked = await as(owner, 'POST', '/blocks', { userId: peer.userId });
    expect(blocked.status).toBeLessThan(300);

    const readOnly = (await conversations(owner)).find((r) => r.channelId === dmChannelId);
    // Still listed, and still readable. Blocking makes a thread read-only rather than deleting
    // it, so the row stays and says so.
    expect(readOnly).toBeDefined();
    expect(readOnly!.canPost).toBe(false);

    // And a club chat is unaffected by any of it.
    const club = (await conversations(owner)).find((r) => r.scope === 'club');
    expect(club!.canPost).toBe(true);
  });
});
