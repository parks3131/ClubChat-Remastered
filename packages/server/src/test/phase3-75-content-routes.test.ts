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

describe('meetings', () => {
  it('lets any Eboard member create one and only the creator edit or delete it', async () => {
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

    // The owner is in the space and did not create it: view-only, and told so distinguishably.
    const asOwner = await as(owner, 'GET', `/meetings/${meetingId}`);
    expect(asOwner.status).toBe(200);
    expect(asOwner.body.meeting.isCreator).toBe(false);
    expect(asOwner.body.meeting.creatorName).toBe('MeetingAdmin');
    expect((await as(owner, 'PATCH', `/meetings/${meetingId}`, { title: 'Hijack' })).status).toBe(
      403,
    );
    expect((await as(owner, 'DELETE', `/meetings/${meetingId}`)).status).toBe(403);

    // An ordinary member has no visibility of the space at all.
    expect((await as(member, 'GET', `/meetings/${meetingId}`)).status).toBe(404);
    expect((await as(member, 'GET', `/eboards/${eboardId}/meetings`)).status).toBe(404);
    expect(
      (await as(member, 'POST', `/eboards/${eboardId}/meetings`, {
        title: 'No',
        startsAt: '2027-03-01T18:00:00.000Z',
      })).status,
    ).toBe(404);

    // The creator can.
    const patched = await as(secondAdmin, 'PATCH', `/meetings/${meetingId}`, {
      title: 'Budget review (moved)',
    });
    expect(patched.status).toBe(200);
    const after = await as(secondAdmin, 'GET', `/meetings/${meetingId}`);
    expect(after.body.meeting.title).toBe('Budget review (moved)');
    // An absent field kept its value rather than clearing it.
    expect(after.body.meeting.startsAt).toBeTruthy();

    expect((await as(secondAdmin, 'DELETE', `/meetings/${meetingId}`)).status).toBe(200);
    expect((await as(secondAdmin, 'GET', `/meetings/${meetingId}`)).status).toBe(404);
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
