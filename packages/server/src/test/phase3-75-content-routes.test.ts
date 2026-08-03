/**
 * The content HTTP surface: meetings, calendar events, routines and news.
 *
 * Four features that look alike, and the tests are mostly about the ways they deliberately
 * differ - who may edit, and what notifies. The silences are the fragile part: a routine
 * notifies nobody, and editing or deleting news notifies nobody, and both are the sort of
 * property a later change breaks without failing anything.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { buildApp } from '../api/app.ts';
import { createAuth, type Auth } from '../auth.ts';
import type { Config } from '../config.ts';
import { clubMemberships } from '../db/schema.ts';
import { FakeMediaStore } from '../media/store.ts';
import { silentMonitor } from '../monitoring.ts';
import { allowAll } from './fake-limiter.ts';
import { RecordingPushSender } from '../push/sender.ts';
import { drainOnce } from '../worker/drain.ts';
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
  return { clubId: created.body.clubId, channelId: created.body.channelId };
}

async function join(clubId: string, actor: Actor, role: 'member' | 'admin' = 'member') {
  await h.db.insert(clubMemberships).values({ clubId, userId: actor.userId, role });
}

async function eboardIdOf(clubId: string): Promise<string> {
  const rows = await h.db.execute<{ id: string }>(
    sql`SELECT id::text AS id FROM eboard_channels WHERE club_id = ${clubId}`,
  );
  const id = rows.rows[0]?.id;
  if (!id) throw new Error('club has no eboard space');
  return id;
}

/** Outbox rows written for a club, which is how "notifies nobody" is asserted. */
async function outboxTypes(clubId: string): Promise<string[]> {
  const rows = await h.db.execute<{ event_type: string }>(
    sql`SELECT event_type FROM outbox WHERE partition_key = ${clubId} ORDER BY id`,
  );
  return rows.rows.map((r) => r.event_type);
}

/**
 * Run the effects the routes queued.
 *
 * Most tests in this file assert on the outbox ROW, which is the right level for "does creating
 * this notify anybody". The cancellation line is not like that: it is a message in a channel that
 * only exists once the handler has run, so this drains for real.
 *
 * The Redis stub records nothing and is never asserted on - it is here because publishing is how
 * an open chat learns about the line, and a handler that publishes must not be able to throw for
 * want of a bus.
 */
async function drainOutbox(): Promise<Array<{ topic: string; payload: string }>> {
  const published: Array<{ topic: string; payload: string }> = [];
  await drainOnce(h.db, {
    db: h.db,
    redis: {
      publish: async (topic: string, payload: string) => {
        published.push({ topic, payload });
        return 0;
      },
    } as never,
    push: new RecordingPushSender(),
    log: () => undefined,
    // Pushes are deferred by eight real seconds in production. Dropped here: this test is about
    // what lands in the channel, and nothing about it depends on a push having gone out.
    defer: () => undefined,
  });
  return published;
}

/** The Eboard space's own chat channel, which is where its cards and lines land. */
async function eboardChannelOf(eboardId: string): Promise<string> {
  const rows = await h.db.execute<{ id: string }>(
    sql`SELECT id::text AS id FROM channels WHERE scope = 'eboard' AND scope_id = ${eboardId}::uuid`,
  );
  const id = rows.rows[0]?.id;
  if (!id) throw new Error('eboard channel not found');
  return id;
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

describe('meetings', () => {
  /*
   * Three rules in one test, because the interesting part is where they DIFFER:
   * create is open to the space, edit is creator-only, and cancel is open to the space again.
   * Testing them apart is what let the middle one quietly become the rule for all three.
   */
  it('lets any Eboard member create and cancel, but only the creator edit', async () => {
    const owner = await signUp('MeetingOwner');
    const secondAdmin = await signUp('MeetingAdmin');
    const member = await signUp('MeetingMember');
    const { clubId } = await createClubAs(owner);
    await join(clubId, member);
    const eboardId = await eboardIdOf(clubId);

    // Promotion auto-joins the Eboard space, which is how the second admin gets in.
    await as(owner, 'POST', `/clubs/${clubId}/members`, { userId: secondAdmin.userId });
    await as(owner, 'PATCH', `/clubs/${clubId}/members/${secondAdmin.userId}/role`, {
      role: 'admin',
    });

    const created = await as(secondAdmin, 'POST', `/eboards/${eboardId}/meetings`, {
      title: 'Budget review',
      startsAt: '2027-03-01T18:00:00.000Z',
    });
    expect(created.status).toBe(201);
    const meetingId = created.body.meetingId;

    // The owner is in the space and did not create it: cannot EDIT it, and told so
    // distinguishably - 403 rather than 404, because they can plainly see the thing.
    const asOwner = await as(owner, 'GET', `/meetings/${meetingId}`);
    expect(asOwner.status).toBe(200);
    expect(asOwner.body.meeting.isCreator).toBe(false);
    expect(asOwner.body.meeting.creatorName).toBe('MeetingAdmin');
    expect((await as(owner, 'PATCH', `/meetings/${meetingId}`, { title: 'Hijack' })).status).toBe(
      403,
    );

    // An ordinary member has no visibility of the space at all.
    expect((await as(member, 'GET', `/meetings/${meetingId}`)).status).toBe(404);
    expect((await as(member, 'GET', `/eboards/${eboardId}/meetings`)).status).toBe(404);
    expect(
      (await as(member, 'POST', `/eboards/${eboardId}/meetings`, {
        title: 'No',
        startsAt: '2027-03-01T18:00:00.000Z',
      })).status,
    ).toBe(404);

    // The creator can edit.
    const patched = await as(secondAdmin, 'PATCH', `/meetings/${meetingId}`, {
      title: 'Budget review (moved)',
    });
    expect(patched.status).toBe(200);
    const after = await as(secondAdmin, 'GET', `/meetings/${meetingId}`);
    expect(after.body.meeting.title).toBe('Budget review (moved)');
    // An absent field kept its value rather than clearing it.
    expect(after.body.meeting.startsAt).toBeTruthy();

    /*
     * And ANYBODY in the space cancels it - here the owner, who did not create it and was
     * refused the edit four lines up. The pair of expectations is the rule: a meeting only its
     * absent author could call off is what opening this avoids.
     */
    expect((await as(owner, 'DELETE', `/meetings/${meetingId}`)).status).toBe(200);
    expect((await as(secondAdmin, 'GET', `/meetings/${meetingId}`)).status).toBe(404);
  });

  /**
   * Cancelling narrates itself into board chat, and that is the reason it may be open.
   *
   * The card goes - it would otherwise link to nothing - and "X cancelled <title>" takes its
   * place. A card that silently disappeared would tell a board that planned around the meeting
   * nothing about why their calendar changed.
   */
  it('replaces the card with a cancellation line naming who called it off', async () => {
    const owner = await signUp('CancelOwner');
    const other = await signUp('CancelOther');
    const { clubId } = await createClubAs(owner);
    const eboardId = await eboardIdOf(clubId);

    await as(owner, 'POST', `/clubs/${clubId}/members`, { userId: other.userId });
    await as(owner, 'PATCH', `/clubs/${clubId}/members/${other.userId}/role`, { role: 'admin' });

    const created = await as(owner, 'POST', `/eboards/${eboardId}/meetings`, {
      title: 'Budget review',
      startsAt: '2027-03-01T18:00:00.000Z',
    });
    expect(created.status).toBe(201);

    await drainOutbox();

    const channelId = await eboardChannelOf(eboardId);
    const cards = await h.db.execute<{ id: string; type: string; body: string }>(sql`
      SELECT id::text AS id, type, body FROM messages
       WHERE channel_id = ${channelId}::uuid AND linked_meeting_id = ${created.body.meetingId}::uuid
    `);
    expect(cards.rows).toHaveLength(1);
    expect(cards.rows[0]?.type).toBe('meeting');

    // Cancelled by the OTHER member, not its creator - which is the whole point of the line.
    expect((await as(other, 'DELETE', `/meetings/${created.body.meetingId}`)).status).toBe(200);
    const published = await drainOutbox();

    const afterCard = await h.db.execute<{ deleted_at: string | null }>(sql`
      SELECT deleted_at FROM messages WHERE id = ${cards.rows[0]?.id}::uuid
    `);
    expect(afterCard.rows[0]?.deleted_at).not.toBeNull();

    /*
     * The removal has to go out as an UPDATE frame, and this asserts the SHAPE rather than
     * merely that something was published.
     *
     * `Published` treats a payload with no `kind` as a whole new message, so the hand-rolled
     * frame this used to send arrived claiming to be a message and carrying three fields of one.
     * No client could read it, and because history syncs forward from the last seq a device
     * holds, a cached card is never re-read - so a cancelled meeting kept its card forever, on
     * every device, across reloads. Nothing failed; it just silently never happened.
     */
    const updates = published
      .map((p) => JSON.parse(p.payload) as { kind?: string; seq?: number; update?: unknown })
      .filter((p) => p.kind === 'update');
    expect(updates).toContainEqual(
      expect.objectContaining({
        kind: 'update',
        update: expect.objectContaining({ deletedAt: expect.any(String), pinned: false }),
      }),
    );

    const lines = await h.db.execute<{ body: string }>(sql`
      SELECT body FROM messages
       WHERE channel_id = ${channelId}::uuid AND type = 'system' AND deleted_at IS NULL
       ORDER BY seq DESC LIMIT 1
    `);
    expect(lines.rows[0]?.body).toBe('CancelOther cancelled Budget review');
  });

  it('splits upcoming from past by the clock, with nothing stored', async () => {
    const owner = await signUp('SplitOwner');
    const { clubId } = await createClubAs(owner);
    const eboardId = await eboardIdOf(clubId);

    const soon = await as(owner, 'POST', `/eboards/${eboardId}/meetings`, {
      title: 'Next week',
      startsAt: '2099-01-01T18:00:00.000Z',
    });
    const old = await as(owner, 'POST', `/eboards/${eboardId}/meetings`, {
      title: 'Last year',
      startsAt: '2020-01-01T18:00:00.000Z',
    });
    expect(soon.status).toBe(201);
    expect(old.status).toBe(201);

    const upcoming = await as(owner, 'GET', `/eboards/${eboardId}/meetings?when=upcoming`);
    expect(upcoming.body.meetings.map((m: { title: string }) => m.title)).toEqual(['Next week']);

    const past = await as(owner, 'GET', `/eboards/${eboardId}/meetings?when=past`);
    expect(past.body.meetings.map((m: { title: string }) => m.title)).toEqual(['Last year']);

    // Default is upcoming, so the hub lands on the useful half.
    const defaulted = await as(owner, 'GET', `/eboards/${eboardId}/meetings`);
    expect(defaulted.body.meetings.map((m: { title: string }) => m.title)).toEqual(['Next week']);
  });
});

describe('calendar events', () => {
  it('is admin-only to create and refuses a member', async () => {
    const owner = await signUp('EventOwner');
    const member = await signUp('EventMember');
    const { clubId } = await createClubAs(owner);
    await join(clubId, member);

    const body = {
      type: 'practice' as const,
      title: 'Track session',
      startsAt: '2027-04-01T17:00:00.000Z',
    };
    expect((await as(member, 'POST', `/clubs/${clubId}/events`, body)).status).toBe(404);

    const created = await as(owner, 'POST', `/clubs/${clubId}/events`, body);
    expect(created.status).toBe(201);

    // A member cannot delete it either.
    expect((await as(member, 'DELETE', `/events/${created.body.eventId}`)).status).toBe(404);
    expect((await as(owner, 'DELETE', `/events/${created.body.eventId}`)).status).toBe(200);
  });

  /*
   * The read is WIDER than the write, and that asymmetry is the point of this test.
   *
   * Creating an event notifies every member of the club and posts a card into club chat. If the
   * read were admin-gated to match the write, every one of those notifications would open a 404
   * for the people it was sent to - which is exactly what the screen-less version of this feature
   * did, by routing the tap somewhere else entirely.
   */
  it('lets any member read an event, and tells only admins they can manage it', async () => {
    const owner = await signUp('EventReadOwner');
    const member = await signUp('EventReadMember');
    const outsider = await signUp('EventReadOutsider');
    const { clubId } = await createClubAs(owner);
    await join(clubId, member);

    const created = await as(owner, 'POST', `/clubs/${clubId}/events`, {
      type: 'practice' as const,
      title: 'Hill repeats',
      startsAt: '2027-04-01T17:00:00.000Z',
      endsAt: '2027-04-01T19:00:00.000Z',
      location: 'The reservoir',
      description: 'Bring a headlamp.',
    });
    expect(created.status).toBe(201);
    const eventId = created.body.eventId;

    const asMember = await as(member, 'GET', `/events/${eventId}`);
    expect(asMember.status).toBe(200);
    expect(asMember.body.event.title).toBe('Hill repeats');
    expect(asMember.body.event.location).toBe('The reservoir');
    expect(asMember.body.event.description).toBe('Bring a headlamp.');
    expect(asMember.body.event.clubId).toBe(clubId);
    // Who added it, which is what makes admin-only deletion legible rather than arbitrary.
    expect(asMember.body.event.creatorName).toBe(owner.name);
    // ISO 8601, not Postgres's own format - the `::text` trap `isoUtc` exists to avoid.
    expect(asMember.body.event.startsAt).toBe('2027-04-01T17:00:00.000Z');
    expect(asMember.body.event.endsAt).toBe('2027-04-01T19:00:00.000Z');
    // A member reads it and cannot manage it, which is what the delete screen keys off.
    expect(asMember.body.event.canManage).toBe(false);

    const asOwner = await as(owner, 'GET', `/events/${eventId}`);
    expect(asOwner.body.event.canManage).toBe(true);

    // 404 rather than 403 outside the club: the event's existence is club information too.
    expect((await as(outsider, 'GET', `/events/${eventId}`)).status).toBe(404);

    expect((await as(owner, 'DELETE', `/events/${eventId}`)).status).toBe(200);
    expect((await as(member, 'GET', `/events/${eventId}`)).status).toBe(404);
  });

  /**
   * **Any club admin deletes any event, not only the one who added it** - the opposite of a poll.
   *
   * A cancelled practice that only its absent author could remove is the failure this avoids, and
   * `canManage` has to say so or the second admin's screen hides a button they are allowed to
   * press.
   */
  it('lets a second admin manage an event they did not create', async () => {
    const owner = await signUp('EventAdminOne');
    const secondAdmin = await signUp('EventAdminTwo');
    const { clubId } = await createClubAs(owner);
    await join(clubId, secondAdmin, 'admin');

    const created = await as(owner, 'POST', `/clubs/${clubId}/events`, {
      type: 'other' as const,
      title: 'Team dinner',
      startsAt: '2027-04-02T17:00:00.000Z',
    });
    expect(created.status).toBe(201);

    const seen = await as(secondAdmin, 'GET', `/events/${created.body.eventId}`);
    expect(seen.status).toBe(200);
    expect(seen.body.event.canManage).toBe(true);
    // An optional end is absent rather than invented.
    expect(seen.body.event.endsAt).toBe(null);
    expect((await as(secondAdmin, 'DELETE', `/events/${created.body.eventId}`)).status).toBe(200);
  });

  it('rejects an invented event type at the route', async () => {
    const owner = await signUp('TypeOwner');
    const { clubId } = await createClubAs(owner);
    const bad = await as(owner, 'POST', `/clubs/${clubId}/events`, {
      type: 'wedding',
      title: 'nope',
      startsAt: '2027-04-01T17:00:00.000Z',
    });
    expect(bad.status).toBe(400);
  });
});

describe('routines', () => {
  it('creates a workout that notifies nobody and posts nothing', async () => {
    const owner = await signUp('RoutineOwner');
    const member = await signUp('RoutineMember');
    const { clubId } = await createClubAs(owner);
    await join(clubId, member);

    const before = await outboxTypes(clubId);

    const created = await as(owner, 'POST', `/clubs/${clubId}/workouts`, {
      workoutDate: '2027-05-03',
      activityType: 'run',
      title: 'Easy 5k',
    });
    expect(created.status).toBe(201);

    // The silence is the point: a week of workouts authored in one sitting must not fire seven
    // notifications, and the mechanism is the absence of an outbox row rather than a filter.
    expect(await outboxTypes(clubId)).toEqual(before);

    // A member reads the week and cannot write to it.
    const week = await as(member, 'GET', `/clubs/${clubId}/routines?monday=2027-05-03`);
    expect(week.status).toBe(200);
    expect(week.body.days).toHaveLength(7);
    expect(week.body.days[0].date).toBe('2027-05-03');
    expect(week.body.days[0].workouts).toHaveLength(1);
    // A day with nothing scheduled says so explicitly rather than being an empty absence.
    expect(week.body.days[1].restDay).toBe(true);

    expect(
      (await as(member, 'POST', `/clubs/${clubId}/workouts`, {
        workoutDate: '2027-05-04',
        activityType: 'run',
        title: 'No',
      })).status,
    ).toBe(404);
    expect((await as(member, 'DELETE', `/workouts/${created.body.workoutId}`)).status).toBe(404);

    // Any admin edits any workout, not only its author.
    expect((await as(owner, 'DELETE', `/workouts/${created.body.workoutId}`)).status).toBe(200);
  });

  it('requires the Monday rather than guessing the caller timezone', async () => {
    const owner = await signUp('MondayOwner');
    const { clubId } = await createClubAs(owner);
    expect((await as(owner, 'GET', `/clubs/${clubId}/routines`)).status).toBe(400);
    expect((await as(owner, 'GET', `/clubs/${clubId}/routines?monday=next`)).status).toBe(400);
  });
});

describe('news', () => {
  it('refuses an empty post, and accepts body-only', async () => {
    const owner = await signUp('NewsOwner');
    const { clubId } = await createClubAs(owner);

    expect((await as(owner, 'POST', `/clubs/${clubId}/news`, {})).status).toBe(400);
    expect((await as(owner, 'POST', `/clubs/${clubId}/news`, { body: '   ' })).status).toBe(400);

    const created = await as(owner, 'POST', `/clubs/${clubId}/news`, { body: 'We won.' });
    expect(created.status).toBe(201);
  });

  it('lets any admin edit any post, and notifies only on create', async () => {
    const owner = await signUp('NewsEditOwner');
    const other = await signUp('NewsEditAdmin');
    const member = await signUp('NewsEditMember');
    const { clubId } = await createClubAs(owner);
    await join(clubId, other, 'admin');
    await join(clubId, member);

    const created = await as(owner, 'POST', `/clubs/${clubId}/news`, { body: 'First draft' });
    const postId = created.body.postId;
    const afterCreate = await outboxTypes(clubId);
    expect(afterCreate).toContain('news.created');

    // An admin who did not author it can still edit and delete it.
    expect((await as(other, 'PATCH', `/news/${postId}`, { body: 'Corrected' })).status).toBe(200);
    // Editing notifies nobody: no new outbox row.
    expect(await outboxTypes(clubId)).toEqual(afterCreate);

    expect((await as(member, 'PATCH', `/news/${postId}`, { body: 'nope' })).status).toBe(404);
    expect((await as(member, 'DELETE', `/news/${postId}`)).status).toBe(404);

    // An edit cannot empty a post that has no photo.
    expect((await as(other, 'PATCH', `/news/${postId}`, { body: '' })).status).toBe(400);

    const feed = await as(member, 'GET', `/clubs/${clubId}/news`);
    expect(feed.status).toBe(200);
    expect(feed.body.posts).toHaveLength(1);
    expect(feed.body.posts[0].body).toBe('Corrected');
    expect(feed.body.posts[0].authorName).toBe('NewsEditOwner');
    expect(feed.body.hasMore).toBe(false);

    expect((await as(other, 'DELETE', `/news/${postId}`)).status).toBe(200);
    // Deleting notifies nobody either.
    expect(await outboxTypes(clubId)).toEqual(afterCreate);
  });

  it('reacts with the chat emoji set and nothing else', async () => {
    const owner = await signUp('NewsReactOwner');
    const member = await signUp('NewsReactMember');
    const { clubId } = await createClubAs(owner);
    await join(clubId, member);

    const created = await as(owner, 'POST', `/clubs/${clubId}/news`, { body: 'Race recap' });
    const postId = created.body.postId;

    // PRD/06 rule 4: the same set as chat. A unicorn is not in it, and the column now has a
    // check constraint saying so even if a route forgets.
    expect((await as(member, 'POST', `/news/${postId}/reactions`, { emoji: '🦄' })).status).toBe(
      400,
    );
    expect((await as(member, 'POST', `/news/${postId}/reactions`, { emoji: 'lgtm' })).status).toBe(
      400,
    );

    // Every club member reacts, not only admins.
    const on = await as(member, 'POST', `/news/${postId}/reactions`, { emoji: '🔥' });
    expect(on.status).toBe(200);
    expect(on.body.reacted).toBe(true);

    const feed = await as(member, 'GET', `/clubs/${clubId}/news`);
    expect(feed.body.posts[0].reactions).toEqual([{ emoji: '🔥', count: 1, mine: true }]);

    // The author sees the count and that it is not theirs.
    const asOwner = await as(owner, 'GET', `/news/${postId}`);
    expect(asOwner.body.post.reactions).toEqual([{ emoji: '🔥', count: 1, mine: false }]);

    // The same gesture removes it.
    const off = await as(member, 'POST', `/news/${postId}/reactions`, { emoji: '🔥' });
    expect(off.body.reacted).toBe(false);
    expect((await as(member, 'GET', `/news/${postId}`)).body.post.reactions).toEqual([]);
  });

  it('pages newest-first by timestamp rather than by offset', async () => {
    const owner = await signUp('NewsPageOwner');
    const { clubId } = await createClubAs(owner);

    for (const n of [1, 2, 3]) {
      const created = await as(owner, 'POST', `/clubs/${clubId}/news`, { body: `Post ${n}` });
      expect(created.status).toBe(201);
      // Distinct timestamps, so the cursor has something to bite on.
      await h.db.execute(
        sql`UPDATE news_posts SET created_at = now() + (${n} * interval '1 minute')
             WHERE id = ${created.body.postId}`,
      );
    }

    const first = await as(owner, 'GET', `/clubs/${clubId}/news?limit=2`);
    expect(first.body.posts.map((p: { body: string }) => p.body)).toEqual(['Post 3', 'Post 2']);
    expect(first.body.hasMore).toBe(true);

    const next = await as(
      owner,
      'GET',
      `/clubs/${clubId}/news?limit=2&before=${encodeURIComponent(first.body.posts[1].createdAt)}`,
    );
    expect(next.body.posts.map((p: { body: string }) => p.body)).toEqual(['Post 1']);
    expect(next.body.hasMore).toBe(false);
  });

  it('serves nothing to a non-member, by direct id or by feed', async () => {
    const owner = await signUp('NewsScopeOwner');
    const outsider = await signUp('NewsScopeOutsider');
    const { clubId } = await createClubAs(owner);
    const created = await as(owner, 'POST', `/clubs/${clubId}/news`, { body: 'Private-ish' });

    expect((await as(outsider, 'GET', `/clubs/${clubId}/news`)).status).toBe(404);
    expect((await as(outsider, 'GET', `/news/${created.body.postId}`)).status).toBe(404);
    expect(
      (await as(outsider, 'POST', `/news/${created.body.postId}/reactions`, { emoji: '🔥' }))
        .status,
    ).toBe(404);
  });
});

describe('the session boundary', () => {
  it('refuses every content route without a session', async () => {
    const id = crypto.randomUUID();
    for (const [method, url] of [
      ['POST', `/eboards/${id}/meetings`],
      ['GET', `/eboards/${id}/meetings`],
      ['GET', `/meetings/${id}`],
      ['PATCH', `/meetings/${id}`],
      ['DELETE', `/meetings/${id}`],
      ['POST', `/clubs/${id}/events`],
      ['GET', `/events/${id}`],
      ['DELETE', `/events/${id}`],
      ['POST', `/clubs/${id}/workouts`],
      ['GET', `/clubs/${id}/routines`],
      ['POST', `/clubs/${id}/news`],
      ['GET', `/clubs/${id}/news`],
      ['POST', `/news/${id}/reactions`],
    ] as const) {
      const response = await app.inject({ method, url, payload: {} });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
  });
});
