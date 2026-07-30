/**
 * Pin, soft delete, and the merged calendar.
 *
 * The pin tests are the ones that matter most in this phase. `setPinned` and
 * `softDeleteMessage` exist as separate commands to close a v1 defect - any member could pin
 * their own message and then retro-flip it into an announcement - and neither had an HTTP route
 * until now, so the fix had never been exercised from outside its own unit test. PRD/18 asks
 * for exactly this: "Members cannot pin or announce - **verified by attempting the write
 * directly, not by the button being hidden**."
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { buildApp } from '../api/app.ts';
import { createAuth, type Auth } from '../auth.ts';
import type { Config } from '../config.ts';
import { clubMemberships, messageReactions, messages } from '../db/schema.ts';
import { sendMessage } from '../domain/send-message.ts';
import { getChannelRef } from '../domain/reads.ts';
import { loadAccessContext } from '../policy/context.ts';
import { FakeMediaStore } from '../media/store.ts';
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

async function createClubAs(actor: Actor): Promise<{ clubId: string; channelId: string }> {
  const created = await as(actor, 'POST', '/clubs', {
    name: `Club ${crypto.randomUUID().slice(0, 6)}`,
    sport: 'running',
  });
  expect(created.status).toBe(201);
  return { clubId: created.body.clubId, channelId: created.body.mainChannelId };
}

async function join(clubId: string, actor: Actor, role: 'member' | 'admin' = 'member') {
  await h.db.insert(clubMemberships).values({ clubId, userId: actor.userId, role });
}

/**
 * Post a message the way the gateway does.
 *
 * Sending is a WebSocket frame rather than a route, so this goes through the same domain
 * command the gateway calls. The tests below are about the HTTP routes that act ON a message.
 */
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

async function outboxTypes(channelId: string): Promise<string[]> {
  const rows = await h.db.execute<{ event_type: string }>(
    sql`SELECT event_type FROM outbox WHERE partition_key = ${channelId} ORDER BY id`,
  );
  return rows.rows.map((r) => r.event_type);
}

beforeAll(async () => {
  h = await startTestDb();
  auth = createAuth(h.db, {
    secret: 'test-secret-not-a-real-one',
    baseURL: config.BETTER_AUTH_URL,
  });
  app = buildApp({ db: h.db, auth, config, mediaStore: new FakeMediaStore() });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close().catch(() => undefined);
  await h?.stop().catch(() => undefined);
});

describe('pinning: the column-level authority trap, finally reachable', () => {
  it('refuses a member pinning their OWN message', async () => {
    const owner = await signUp('PinTrapOwner');
    const member = await signUp('PinTrapMember');
    const { clubId, channelId } = await createClubAs(owner);
    await join(clubId, member);

    const seq = await post(member, channelId, 'my own message');

    /*
     * The v1 defect, attempted directly. A single row-level rule of "its sender, or an admin"
     * covers this write, and it is the wrong rule for the `pinned` column: a member who could
     * pin their own message could then retro-flip it into an announcement and notify the whole
     * club. 403 rather than 404 because they can obviously see their own message.
     */
    const refused = await as(member, 'POST', `/channels/${channelId}/messages/${seq}/pinned`, {
      pinned: true,
    });
    expect(refused.status).toBe(403);

    // And nothing changed in the row, which is the assertion that a hidden button cannot make.
    const rows = await h.db
      .select({ pinned: messages.pinned })
      .from(messages)
      .where(and(eq(messages.channelId, channelId), eq(messages.seq, seq)));
    expect(rows[0]?.pinned).toBe(false);

    // An admin of the space can.
    const allowed = await as(owner, 'POST', `/channels/${channelId}/messages/${seq}/pinned`, {
      pinned: true,
    });
    expect(allowed.status).toBe(200);
    expect(allowed.body.message.pinned).toBe(true);
    // Pinning notifies nobody: pins are reference, not interruption. The only outbox row is
    // the pin publication itself, which drives the live update rather than a notification.
    expect(await outboxTypes(channelId)).toContain('message.pinned');
  });

  it('never lets a pin carry a type change with it', async () => {
    const owner = await signUp('PinTypeOwner');
    const { clubId, channelId } = await createClubAs(owner);
    const seq = await post(owner, channelId, 'ordinary text');

    // The route takes only `pinned`. Anything else in the body is ignored rather than trusted,
    // which is why this is one narrow route and not a PATCH over the message.
    const response = await as(owner, 'POST', `/channels/${channelId}/messages/${seq}/pinned`, {
      pinned: true,
      type: 'announcement',
      body: 'rewritten',
    });
    expect(response.status).toBe(200);

    const rows = await h.db
      .select({ type: messages.type, body: messages.body, pinned: messages.pinned })
      .from(messages)
      .where(and(eq(messages.channelId, channelId), eq(messages.seq, seq)));
    expect(rows[0]?.pinned).toBe(true);
    // Still an ordinary message. The retro-flip is what the split exists to prevent.
    expect(rows[0]?.type).toBe('text');
    expect(rows[0]?.body).toBe('ordinary text');
  });

  it('unpins, and refuses a member of another club entirely', async () => {
    const owner = await signUp('UnpinOwner');
    const stranger = await signUp('UnpinStranger');
    const { channelId } = await createClubAs(owner);
    await createClubAs(stranger);
    const seq = await post(owner, channelId, 'pin me');

    await as(owner, 'POST', `/channels/${channelId}/messages/${seq}/pinned`, { pinned: true });
    const unpinned = await as(owner, 'POST', `/channels/${channelId}/messages/${seq}/pinned`, {
      pinned: false,
    });
    expect(unpinned.body.message.pinned).toBe(false);

    // 404 for somebody with no business in this channel: not even the existence is confirmed.
    expect(
      (await as(stranger, 'POST', `/channels/${channelId}/messages/${seq}/pinned`, {
        pinned: true,
      })).status,
    ).toBe(404);
  });

  it('rejects a seq that is not a positive integer', async () => {
    const owner = await signUp('SeqOwner');
    const { channelId } = await createClubAs(owner);

    for (const seq of ['0', '-1', 'abc']) {
      const response = await as(owner, 'POST', `/channels/${channelId}/messages/${seq}/pinned`, {
        pinned: true,
      });
      expect(response.status, seq).toBe(400);
    }
  });
});

describe('soft delete', () => {
  it('lets the sender delete their own and leaves a tombstone', async () => {
    const owner = await signUp('DelSenderOwner');
    const member = await signUp('DelSenderMember');
    const { clubId, channelId } = await createClubAs(owner);
    await join(clubId, member);

    const seq = await post(member, channelId, 'oops');
    // React first, so clearing reactions on delete can be asserted (PRD/05 rule 9).
    await as(owner, 'POST', `/channels/${channelId}/messages/${seq}/reactions`, { emoji: '😂' });

    const deleted = await as(member, 'DELETE', `/channels/${channelId}/messages/${seq}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body.message.deletedAt).toBeTruthy();
    // A tombstone, not a removal: the row survives so the replies around it stay readable.
    expect(deleted.body.message.body).toBeNull();

    const rows = await h.db
      .select({ id: messages.id, pinned: messages.pinned })
      .from(messages)
      .where(and(eq(messages.channelId, channelId), eq(messages.seq, seq)));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.pinned).toBe(false);

    const left = await h.db
      .select()
      .from(messageReactions)
      .where(eq(messageReactions.messageId, rows[0]!.id));
    expect(left).toHaveLength(0);
  });

  it('lets an admin delete somebody else and refuses a member doing so', async () => {
    const owner = await signUp('DelAdminOwner');
    const a = await signUp('DelAdminA');
    const b = await signUp('DelAdminB');
    const { clubId, channelId } = await createClubAs(owner);
    await join(clubId, a);
    await join(clubId, b);

    const seq = await post(a, channelId, 'from a');

    // One member cannot delete another's message.
    expect((await as(b, 'DELETE', `/channels/${channelId}/messages/${seq}`)).status).toBe(403);
    // An admin of the space can.
    expect((await as(owner, 'DELETE', `/channels/${channelId}/messages/${seq}`)).status).toBe(200);
  });

  it('answers 404 for a message that does not exist in a channel the caller can read', async () => {
    const owner = await signUp('DelGhostOwner');
    const { channelId } = await createClubAs(owner);
    expect((await as(owner, 'DELETE', `/channels/${channelId}/messages/9999`)).status).toBe(404);
  });
});

describe('sender attribution', () => {
  /**
   * A group chat that does not say who is talking is unusable, and the name reaches the client
   * only because every read path joins `users`. There are four of those paths and they are
   * separate queries, so a change to one does not touch the others: this asserts each carries
   * the name rather than trusting that the join was copied everywhere.
   */
  it('carries the sender name on history, sync, the window around a seq, and highlights', async () => {
    const owner = await signUp('AttributionOwner');
    const member = await signUp('AttributionMember');
    const { clubId, channelId } = await createClubAs(owner);
    await join(clubId, member);

    const seq = await post(member, channelId, 'who said this');
    await as(owner, 'POST', `/channels/${channelId}/messages/${seq}/pinned`, { pinned: true });

    const named = (body: { messages: Array<{ seq: number; senderName: string | null }> }) =>
      body.messages.find((m) => m.seq === seq)?.senderName;

    const history = await as(owner, 'GET', `/channels/${channelId}/messages`);
    expect(named(history.body)).toBe('AttributionMember');

    const sync = await as(owner, 'GET', `/sync?channels[]=${channelId}:0`);
    expect(named(sync.body.channels[0])).toBe('AttributionMember');

    const around = await as(owner, 'GET', `/channels/${channelId}/messages?around=${seq}`);
    expect(named(around.body)).toBe('AttributionMember');

    const pinned = await as(owner, 'GET', `/channels/${channelId}/pinned`);
    expect(named(pinned.body)).toBe('AttributionMember');
  });

  /**
   * A message outlives the account that sent it. Deletion is anonymise-and-block rather than a
   * row removal - `messages_sender_id_users_id_fk` is RESTRICT, so it could not be a removal
   * even if we wanted one - and this asserts the anonymised name actually reaches the bubble
   * rather than the real one surviving in chat after the account is gone.
   */
  it('reads a deleted account\'s messages as the anonymised name, keeping the body', async () => {
    const owner = await signUp('LeaverClubOwner');
    const leaver = await signUp('LeaverMember');
    const { clubId, channelId } = await createClubAs(owner);
    await join(clubId, leaver);

    const seq = await post(leaver, channelId, 'sent before leaving');
    expect((await as(leaver, 'DELETE', '/me')).status).toBe(200);

    const history = await as(owner, 'GET', `/channels/${channelId}/messages`);
    const row = history.body.messages.find((m: { seq: number }) => m.seq === seq);
    expect(row).toBeDefined();
    // The conversation still reads. Only the attribution changes.
    expect(row.body).toBe('sent before leaving');
    expect(row.senderName).toBe('Deleted member');
  });
});

describe('Highlights, and jump-to-message', () => {
  it('finds a pin far outside the loaded window', async () => {
    const owner = await signUp('HighlightOwner');
    const { channelId } = await createClubAs(owner);

    // Pin the very first message, then bury it. v1 computed Highlights from a bounded slice of
    // history, so a pin this old silently vanished from the list whose whole job is to keep it
    // findable - which is debt item 6.
    const buried = await post(owner, channelId, 'the oldest pin');
    await as(owner, 'POST', `/channels/${channelId}/messages/${buried}/pinned`, { pinned: true });

    for (let i = 0; i < 60; i += 1) {
      await post(owner, channelId, `filler ${i}`);
    }

    // The default history page would not reach it.
    const page = await as(owner, 'GET', `/channels/${channelId}/messages`);
    expect(page.body.messages.some((m: { seq: number }) => m.seq === buried)).toBe(false);

    // Highlights does, because it queries the whole channel.
    const pinned = await as(owner, 'GET', `/channels/${channelId}/pinned`);
    expect(pinned.status).toBe(200);
    expect(pinned.body.messages.map((m: { seq: number }) => m.seq)).toEqual([buried]);
    expect(pinned.body.hasMore).toBe(false);
  });

  it('drops a tombstone out of both Highlights tabs', async () => {
    const owner = await signUp('TombstoneOwner');
    const { channelId } = await createClubAs(owner);

    const seq = await post(owner, channelId, 'pin then delete');
    await as(owner, 'POST', `/channels/${channelId}/messages/${seq}/pinned`, { pinned: true });
    expect((await as(owner, 'GET', `/channels/${channelId}/pinned`)).body.messages).toHaveLength(1);

    await as(owner, 'DELETE', `/channels/${channelId}/messages/${seq}`);
    // A soft delete clears the pin, so this would pass anyway - the assertion is that
    // Highlights never lists "this message was deleted" as club reference material.
    expect((await as(owner, 'GET', `/channels/${channelId}/pinned`)).body.messages).toEqual([]);
    expect((await as(owner, 'GET', `/channels/${channelId}/announcements`)).body.messages).toEqual(
      [],
    );
  });

  it('returns a window centred on a message, with both boundaries reported', async () => {
    const owner = await signUp('AroundOwner');
    const { channelId } = await createClubAs(owner);

    const seqs: number[] = [];
    for (let i = 0; i < 50; i += 1) {
      seqs.push(await post(owner, channelId, `message ${i}`));
    }
    const target = seqs[25]!;

    const window = await as(
      owner,
      'GET',
      `/channels/${channelId}/messages/around?around=${target}&radius=5`,
    );
    expect(window.status).toBe(200);
    const returned = window.body.messages.map((m: { seq: number }) => m.seq);
    // The target plus five either side, oldest first.
    expect(returned).toEqual([
      target - 5,
      target - 4,
      target - 3,
      target - 2,
      target - 1,
      target,
      target + 1,
      target + 2,
      target + 3,
      target + 4,
      target + 5,
    ]);
    // Both directions still have more, which is what lets a client page either way.
    expect(window.body.hasBefore).toBe(true);
    expect(window.body.hasAfter).toBe(true);
  });

  it('reports no boundary at the ends of the log', async () => {
    const owner = await signUp('EdgeOwner');
    const { channelId } = await createClubAs(owner);

    const first = await post(owner, channelId, 'first');
    const second = await post(owner, channelId, 'second');

    const atStart = await as(
      owner,
      'GET',
      `/channels/${channelId}/messages/around?around=${first}&radius=1`,
    );
    expect(atStart.body.hasBefore).toBe(false);
    expect(atStart.body.hasAfter).toBe(false);
    expect(atStart.body.messages.map((m: { seq: number }) => m.seq)).toEqual([first, second]);
  });

  it('refuses Highlights and the window to somebody outside the channel', async () => {
    const owner = await signUp('HlScopeOwner');
    const stranger = await signUp('HlScopeStranger');
    const { channelId } = await createClubAs(owner);
    await createClubAs(stranger);
    await post(owner, channelId, 'private');

    for (const path of ['pinned', 'announcements', 'messages/around?around=1']) {
      const response = await as(stranger, 'GET', `/channels/${channelId}/${path}`);
      expect(response.status, path).toBe(404);
    }
  });

  it('requires an around parameter rather than defaulting to somewhere', async () => {
    const owner = await signUp('AroundParamOwner');
    const { channelId } = await createClubAs(owner);
    expect((await as(owner, 'GET', `/channels/${channelId}/messages/around`)).status).toBe(400);
    expect(
      (await as(owner, 'GET', `/channels/${channelId}/messages/around?around=0`)).status,
    ).toBe(400);
  });
});

describe('the merged calendar', () => {
  it('merges events, races and meetings, and tags each row with its club', async () => {
    const owner = await signUp('CalOwner');
    const { clubId } = await createClubAs(owner);
    const eboardId = (
      await h.db.execute<{ id: string }>(
        sql`SELECT id::text AS id FROM eboard_channels WHERE club_id = ${clubId}`,
      )
    ).rows[0]!.id;

    await as(owner, 'POST', `/clubs/${clubId}/events`, {
      type: 'practice',
      title: 'Future practice',
      startsAt: '2099-06-01T17:00:00.000Z',
    });
    await as(owner, 'POST', `/clubs/${clubId}/events`, {
      type: 'practice',
      title: 'Old practice',
      startsAt: '2020-06-01T17:00:00.000Z',
    });
    await as(owner, 'POST', `/clubs/${clubId}/races`, {
      name: 'Season opener',
      raceDate: '2099-07-04',
    });
    await as(owner, 'POST', `/eboards/${eboardId}/meetings`, {
      title: 'Board sync',
      startsAt: '2099-08-01T18:00:00.000Z',
    });

    const all = await as(owner, 'GET', `/calendar?club=${clubId}`);
    expect(all.status).toBe(200);
    const kinds = new Set(all.body.items.map((i: { kind: string }) => i.kind));
    expect(kinds).toEqual(new Set(['event', 'race', 'meeting']));
    expect(all.body.items.every((i: { clubName: string }) => i.clubName.startsWith('Club '))).toBe(
      true,
    );

    // Upcoming ascending, so the next thing is first.
    const upcoming = await as(owner, 'GET', `/calendar?club=${clubId}&when=upcoming`);
    const titles = upcoming.body.items.map((i: { title: string }) => i.title);
    // June, then July, then August: ascending by date, whatever kind each row is.
    expect(titles).toEqual(['Future practice', 'Season opener', 'Board sync']);
    expect(titles).not.toContain('Old practice');

    // Past descending.
    const past = await as(owner, 'GET', `/calendar?club=${clubId}&when=past`);
    expect(past.body.items.map((i: { title: string }) => i.title)).toEqual(['Old practice']);
  });

  it('keeps an open deadline-less poll out of Past', async () => {
    const owner = await signUp('CalPollOwner');
    const { clubId } = await createClubAs(owner);

    // No deadline at all, which is the case that a date comparison would drop into Past -
    // where nobody would ever vote in it.
    await as(owner, 'POST', `/clubs/${clubId}/polls`, {
      question: 'Open ended?',
      options: ['Yes', 'No'],
    });

    const past = await as(owner, 'GET', `/calendar?club=${clubId}&when=past`);
    expect(past.body.items.map((i: { title: string }) => i.title)).not.toContain('Open ended?');

    const upcoming = await as(owner, 'GET', `/calendar?club=${clubId}&when=upcoming`);
    const poll = upcoming.body.items.find((i: { kind: string }) => i.kind === 'poll');
    expect(poll).toBeTruthy();
    expect(poll.open).toBe(true);
    // A poll has a deadline rather than a day, so it sorts last among dated rows.
    expect(poll.at).toBeNull();
  });

  it('hides an Eboard meeting from a non-member and shows every race to everyone', async () => {
    const owner = await signUp('CalScopeOwner');
    const member = await signUp('CalScopeMember');
    const { clubId } = await createClubAs(owner);
    await join(clubId, member);
    const eboardId = (
      await h.db.execute<{ id: string }>(
        sql`SELECT id::text AS id FROM eboard_channels WHERE club_id = ${clubId}`,
      )
    ).rows[0]!.id;

    await as(owner, 'POST', `/eboards/${eboardId}/meetings`, {
      title: 'Private sync',
      startsAt: '2099-09-01T18:00:00.000Z',
    });
    await as(owner, 'POST', `/clubs/${clubId}/races`, {
      name: 'Visible to all',
      raceDate: '2099-09-15',
    });

    const asMember = await as(member, 'GET', `/calendar?club=${clubId}`);
    const titles = asMember.body.items.map((i: { title: string }) => i.title);
    expect(titles).not.toContain('Private sync');
    // Every race is visible to every club member, whether or not they can enter it...
    expect(titles).toContain('Visible to all');
    const race = asMember.body.items.find((i: { kind: string }) => i.kind === 'race');
    // ...and the row says which it is.
    expect(race.accessible).toBe(false);
  });

  it('marks exactly the days that carry something, and no poll', async () => {
    const owner = await signUp('MarkerOwner');
    const { clubId } = await createClubAs(owner);

    await as(owner, 'POST', `/clubs/${clubId}/events`, {
      type: 'practice',
      title: 'On the 12th',
      startsAt: '2098-05-12T17:00:00.000Z',
    });
    await as(owner, 'POST', `/clubs/${clubId}/polls`, {
      question: 'Closing in May?',
      options: ['a', 'b'],
      closesInMinutes: 60,
    });

    const markers = await as(owner, 'GET', `/calendar/markers?club=${clubId}&year=2098&month=5`);
    expect(markers.status).toBe(200);
    expect(markers.body.days).toEqual(['2098-05-12']);

    // A month with nothing in it gets no filler days from its neighbours.
    const empty = await as(owner, 'GET', `/calendar/markers?club=${clubId}&year=2098&month=6`);
    expect(empty.body.days).toEqual([]);

    expect((await as(owner, 'GET', '/calendar/markers?year=2098')).status).toBe(400);
  });

  it('serves another club nothing, by passing its id', async () => {
    const ownerA = await signUp('CalIsolationA');
    const ownerB = await signUp('CalIsolationB');
    const { clubId: clubA } = await createClubAs(ownerA);
    await createClubAs(ownerB);

    await as(ownerA, 'POST', `/clubs/${clubA}/events`, {
      type: 'practice',
      title: 'A private practice',
      startsAt: '2099-10-01T17:00:00.000Z',
    });

    // Every access rule is inside the query, so somebody else's club id yields an empty list
    // rather than an error - the same answer as a club with nothing in it.
    const probe = await as(ownerB, 'GET', `/calendar?club=${clubA}`);
    expect(probe.status).toBe(200);
    expect(probe.body.items).toEqual([]);

    // And the cross-club view shows only their own.
    const merged = await as(ownerB, 'GET', '/calendar');
    expect(merged.body.items.map((i: { title: string }) => i.title)).not.toContain(
      'A private practice',
    );
  });
});
