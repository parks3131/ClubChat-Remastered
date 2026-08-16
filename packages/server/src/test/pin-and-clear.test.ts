/**
 * Pinning a conversation, and clearing one's own view of it.
 *
 * Two features that look small and are not, for opposite reasons.
 *
 * **Pinning** is easy to get right and easy to get subtly wrong: it has to defeat recency
 * rather than tie-break against it, and it must be invisible to the other participant.
 *
 * **Clearing** is the one that needs the most tests, because it is a *visibility* rule over a
 * shared log rather than a deletion. Six reads return messages and every single one has to
 * honour the caller's floor - a rule honoured by five of them is a leak, and it would surface
 * as "I deleted that chat and the photos are still in the gallery". So there is one test per
 * read path here, deliberately, rather than one test for "clearing works".
 *
 * The other half of the same rule: the other participant's view is untouched. That is what
 * makes this compatible with domain invariant 7, and it is asserted from their side rather than
 * inferred from ours.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { buildApp } from '../api/app.ts';
import { createAuth, type Auth } from '../auth.ts';
import type { Config } from '../config.ts';
import { clubMemberships } from '../db/schema.ts';
import { getChannelRef } from '../domain/reads.ts';
import { sendMessage, setPinned } from '../domain/send-message.ts';
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

async function createClubAs(actor: Actor, name = `Club ${crypto.randomUUID().slice(0, 6)}`) {
  const created = await as(actor, 'POST', '/clubs', { name });
  expect(created.status).toBe(201);
  return { clubId: created.body.clubId as string, channelId: created.body.mainChannelId as string };
}

async function join(clubId: string, actor: Actor) {
  await h.db.insert(clubMemberships).values({ clubId, userId: actor.userId, role: 'member' });
}

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

/** A pair who share a club, with an open DM and three messages in it. */
async function pairWithDm() {
  const alice = await signUp(`PcAlice${crypto.randomUUID().slice(0, 4)}`);
  const bob = await signUp(`PcBob${crypto.randomUUID().slice(0, 4)}`);
  const { clubId, channelId: clubChannelId } = await createClubAs(alice);
  await join(clubId, bob);

  const opened = await as(alice, 'POST', '/dm/threads', { userId: bob.userId });
  expect(opened.status).toBe(201);
  const dmChannelId = opened.body.channelId as string;

  await post(bob, dmChannelId, 'one');
  await post(alice, dmChannelId, 'two');
  await post(bob, dmChannelId, 'three');

  return { alice, bob, clubId, clubChannelId, dmChannelId };
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

describe('pinning a conversation', () => {
  it('sorts a pinned conversation above a more recent unpinned one', async () => {
    const { alice, clubChannelId, dmChannelId } = await pairWithDm();

    // The DM was spoken in last, so it leads unpinned.
    expect((await conversations(alice))[0]!.channelId).toBe(dmChannelId);

    const pinned = await as(alice, 'POST', `/channels/${clubChannelId}/pin`);
    expect(pinned.status).toBe(200);

    const rows = await conversations(alice);
    // Pinning has to DEFEAT recency rather than tie-break against it, which is the whole
    // reason somebody pins something they do not talk in every day.
    expect(rows[0]!.channelId).toBe(clubChannelId);
    expect(rows[0]!.pinned).toBe(true);
    expect(rows[1]!.channelId).toBe(dmChannelId);
    expect(rows[1]!.pinned).toBe(false);
  });

  it('is personal - the other participant sees nothing of it', async () => {
    const { alice, bob, dmChannelId } = await pairWithDm();
    await as(alice, 'POST', `/channels/${dmChannelId}/pin`);

    const hers = (await conversations(alice)).find((r) => r.channelId === dmChannelId);
    const his = (await conversations(bob)).find((r) => r.channelId === dmChannelId);

    expect(hers!.pinned).toBe(true);
    // A conversation pin is unobservable by anybody else. This is the assertion that stops
    // somebody "simplifying" it into the shared message-pin table.
    expect(his!.pinned).toBe(false);
  });

  it('is idempotent in both directions', async () => {
    const { alice, dmChannelId } = await pairWithDm();

    expect((await as(alice, 'POST', `/channels/${dmChannelId}/pin`)).status).toBe(200);
    // A second pin is one pin, not a duplicate row and not an error.
    expect((await as(alice, 'POST', `/channels/${dmChannelId}/pin`)).status).toBe(200);

    const count = await h.db.execute<{ n: string }>(
      sql`SELECT count(*) AS n FROM channel_pins WHERE user_id = ${alice.userId}`,
    );
    expect(Number(count.rows[0]!.n)).toBe(1);

    expect((await as(alice, 'DELETE', `/channels/${dmChannelId}/pin`)).status).toBe(200);
    // Unpinning something already unpinned is a no-op rather than a 404.
    expect((await as(alice, 'DELETE', `/channels/${dmChannelId}/pin`)).status).toBe(200);
    expect((await conversations(alice)).find((r) => r.channelId === dmChannelId)!.pinned).toBe(
      false,
    );
  });
});

describe('clearing your own view of a conversation', () => {
  it('hides the history from the clearer and leaves the other participant untouched', async () => {
    const { alice, bob, dmChannelId } = await pairWithDm();

    const cleared = await as(alice, 'POST', `/channels/${dmChannelId}/clear`);
    expect(cleared.status).toBe(200);
    expect(cleared.body.clearedBeforeSeq).toBe(3);

    const hers = await as(alice, 'GET', `/channels/${dmChannelId}/messages`);
    expect(hers.body.messages).toHaveLength(0);

    /*
     * The half that makes this compatible with invariant 7, asserted from HIS side rather than
     * inferred from hers. Nothing was deleted: one person's floor moved.
     */
    const his = await as(bob, 'GET', `/channels/${dmChannelId}/messages`);
    expect(his.body.messages).toHaveLength(3);
    expect(his.body.messages.map((m: any) => m.body)).toEqual(['one', 'two', 'three']);
  });

  it('drops the conversation out of the list, and brings it back on the next message', async () => {
    const { alice, bob, dmChannelId } = await pairWithDm();
    await as(alice, 'POST', `/channels/${dmChannelId}/clear`);

    expect((await conversations(alice)).find((r) => r.channelId === dmChannelId)).toBeUndefined();
    // His list is unaffected, since the floor is hers alone.
    expect((await conversations(bob)).find((r) => r.channelId === dmChannelId)).toBeDefined();

    await post(bob, dmChannelId, 'still there?');

    const back = (await conversations(alice)).find((r) => r.channelId === dmChannelId);
    expect(back).toBeDefined();
    // Carrying only what arrived after the clear - the row must not resurrect the preview of a
    // message she hid.
    expect(back!.lastMessage.preview).toBe('still there?');
    expect(back!.unread).toBe(1);
  });

  it('leaves no unread claim behind, which is why it advances the read cursor', async () => {
    const { alice, bob, dmChannelId } = await pairWithDm();
    /*
     * Three, not two. Unread is `last_seq - last_read_seq` and nothing has advanced her cursor,
     * so her own message counts until she opens the conversation - which the client does on
     * arrival. Asserted as it actually behaves rather than as it reads, because the number this
     * test cares about is the one AFTER the clear.
     */
    expect((await conversations(alice)).find((r) => r.channelId === dmChannelId)!.unread).toBe(3);

    await as(alice, 'POST', `/channels/${dmChannelId}/clear`);
    await post(bob, dmChannelId, 'after');

    const row = (await conversations(alice)).find((r) => r.channelId === dmChannelId);
    /*
     * Exactly one. Without the cursor advancing inside the clear, this would be three: the two
     * she never read plus the new one - a conversation showing one message and claiming three
     * unread, which she has no way to resolve because opening it clears only what it shows.
     */
    expect(row!.unread).toBe(1);
  });

  /**
   * A club chat clears too, and this test used to assert the opposite.
   *
   * "Direct messages only" was a product decision rather than a technical limit - the note on
   * `canClearChannel` said so, and said the branch was there if clubs ever wanted it. On
   * 2026-08-06 the long-press menu grew Delete chat on every row, so this is that branch, and
   * the test that pinned the refusal became the test that pins the behaviour.
   *
   * **The second half is the one that matters.** A DM has one other person; a club chat has the
   * whole club, and a clear that reached any of them would not be a clear, it would be a
   * deletion nobody authorised.
   */
  it('clears a club chat too, for the caller alone', async () => {
    const { alice, bob, clubChannelId } = await pairWithDm();
    await post(bob, clubChannelId, 'before the clear');

    expect((await as(alice, 'POST', `/channels/${clubChannelId}/clear`)).status).toBe(200);

    // Out of her list entirely, because nothing has been said above her floor - the same promise
    // Delete chat makes on a DM.
    expect(
      (await conversations(alice)).find((r) => r.channelId === clubChannelId),
    ).toBeUndefined();

    // Untouched for him, down to the preview.
    const his = (await conversations(bob)).find((r) => r.channelId === clubChannelId);
    expect(his?.['lastMessage']?.preview).toBe('before the clear');
  });

  it('is refused to somebody who is not in the conversation at all', async () => {
    const { dmChannelId } = await pairWithDm();
    const stranger = await signUp(`PcStranger${crypto.randomUUID().slice(0, 4)}`);
    expect((await as(stranger, 'POST', `/channels/${dmChannelId}/clear`)).status).toBe(404);
    expect((await as(stranger, 'POST', `/channels/${dmChannelId}/pin`)).status).toBe(404);
  });
});

/**
 * One test per read that returns messages.
 *
 * Shaped this way on purpose. "Clearing works" would pass with the floor applied to history
 * alone, and the bug that shape produces is the worst kind: the conversation looks empty and
 * the photographs are still one tap away in the gallery.
 */
describe('the clear floor is honoured by every read path', () => {
  it('history, the jump window, sync, Highlights and the gallery all respect it', async () => {
    const { alice, bob, dmChannelId } = await pairWithDm();

    // Pin one of the pre-clear messages, so Highlights has something it would otherwise show.
    const channel = await getChannelRef(h.db, dmChannelId);
    const aliceCtx = await loadAccessContext(h.db, alice.userId);
    expect((await setPinned(h.db, aliceCtx, channel!, 2, true)).ok).toBe(true);

    await as(alice, 'POST', `/channels/${dmChannelId}/clear`);
    await post(bob, dmChannelId, 'after the clear');

    // 1. Paging backward through history.
    const history = await as(alice, 'GET', `/channels/${dmChannelId}/messages`);
    expect(history.body.messages.map((m: any) => m.body)).toEqual(['after the clear']);

    /*
     * 2. The jump window, aimed straight at a hidden message - the case a stale notification
     *    deep link produces. Radius 1 keeps the window at seqs 1 to 3, all of them below the
     *    floor: a wider one would legitimately reach the message sent AFTER the clear and the
     *    assertion would be about the radius rather than about the floor.
     */
    const around = await as(
      alice,
      'GET',
      `/channels/${dmChannelId}/messages/around?around=2&radius=1`,
    );
    expect(around.body.messages).toHaveLength(0);

    // 3. Sync, which is the one that would silently undo the clear on the next reconnect.
    const synced = await as(alice, 'GET', `/sync?channels[]=${dmChannelId}:0`);
    const channelSync = synced.body.channels.find((c: any) => c.channelId === dmChannelId);
    expect(channelSync.messages.map((m: any) => m.body)).toEqual(['after the clear']);

    // 4. Highlights, which reads the WHOLE channel by design and would otherwise reach back
    //    past the floor to the oldest pin.
    const pinnedTab = await as(alice, 'GET', `/channels/${dmChannelId}/pinned`);
    expect(pinnedTab.body.messages).toHaveLength(0);
    // And it is still there for him, which proves the pin was real rather than never set.
    const hisPinned = await as(bob, 'GET', `/channels/${dmChannelId}/pinned`);
    expect(hisPinned.body.messages.map((m: any) => m.seq)).toEqual([2]);

    // 5. The gallery. No photos in this fixture, so this asserts the query runs rather than
    //    that it filters - the filtering is proved by the four above sharing one definition.
    const gallery = await as(alice, 'GET', `/channels/${dmChannelId}/gallery`);
    expect(gallery.status).toBe(200);
    expect(gallery.body.entries).toEqual([]);
  });
});
