/**
 * A news post as a publication: a headline, a gallery, a place, tags and named people.
 *
 * The post used to be a paragraph and one square photo. Almost everything here is new surface,
 * and three parts of it are the sort that pass a smoke test and are still wrong:
 *
 *  - **The gallery is ordered**, and an order that comes back shuffled looks like a carousel bug
 *    rather than a missing `ORDER BY`.
 *  - **Tags are derived from the body on every write**, so the failure mode is not a bad tag but
 *    a stale one that outlives the sentence it came from.
 *  - **A named member must buzz once and be told twice.** Both inbox rows, one push. That is the
 *    exact defect `7508471` fixed for announcements this morning, and the only thing standing
 *    between this surface and repeating it is the subtraction asserted at the bottom of this file.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { buildApp } from '../api/app.ts';
import { createAuth, type Auth } from '../auth.ts';
import type { Config } from '../config.ts';
import { clubMemberships, devices, mediaObjects } from '../db/schema.ts';
import { FakeMediaStore } from '../media/store.ts';
import { silentMonitor } from '../monitoring.ts';
import { allowAll } from './fake-limiter.ts';
import { RecordingPushSender } from '../push/sender.ts';
import { drainOnce } from '../worker/drain.ts';
import { startTestDb, type TestDb } from './harness.ts';

let h: TestDb;
let app: FastifyInstance;
let auth: Auth;
let push: RecordingPushSender;
let deferred: Array<() => Promise<void>> = [];

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
  });
  expect(created.status).toBe(201);
  return { clubId: created.body.clubId, channelId: created.body.channelId };
}

async function join(clubId: string, actor: Actor, role: 'member' | 'admin' = 'member') {
  await h.db.insert(clubMemberships).values({ clubId, userId: actor.userId, role });
}

/**
 * A photo that has finished uploading.
 *
 * Inserted directly rather than driven through the upload route: this file is about what a post
 * does with photos, and the pipeline that produces them has its own tests.
 */
async function photo(uploader: Actor, clubId: string, channelId: string): Promise<string> {
  const id = crypto.randomUUID();
  await h.db.insert(mediaObjects).values({
    id,
    ownerType: 'message',
    clubId,
    channelId,
    uploaderId: uploader.userId,
    bucket: 'content',
    objectKey: `news/${id}`,
    mime: 'image/jpeg',
    bytes: 2048,
    status: 'ready',
  });
  return id;
}

async function registerDevice(actor: Actor): Promise<void> {
  await h.db.insert(devices).values({
    userId: actor.userId,
    pushToken: `ExponentPushToken[${actor.userId.slice(0, 12)}]`,
    platform: 'ios',
  });
}

/** Drain the outbox, then run the push evaluations it deferred. */
async function drainAndDeliver(): Promise<void> {
  await drainOnce(h.db, {
    db: h.db,
    redis: { publish: async () => 0 } as never,
    push,
    log: () => undefined,
    defer: (fn) => deferred.push(fn),
  });
  const pending = [...deferred];
  deferred = [];
  for (const fn of pending) await fn();
}

async function notificationTypesFor(userId: string): Promise<string[]> {
  const rows = await h.db.execute<{ type: string }>(
    sql`SELECT type FROM notifications WHERE recipient_id = ${userId}::uuid ORDER BY type`,
  );
  return rows.rows.map((row) => row.type);
}

beforeAll(async () => {
  h = await startTestDb();
  auth = createAuth(h.db, {
    secret: 'test-secret-not-a-real-one',
    baseURL: config.BETTER_AUTH_URL,
  });
  push = new RecordingPushSender();
  app = buildApp({
    db: h.db,
    auth,
    config,
    mediaStore: new FakeMediaStore(),
    monitor: silentMonitor(),
    limiter: allowAll(),
  });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await h?.stop();
});

beforeEach(async () => {
  await h.db.execute(
    sql`TRUNCATE notifications, push_deliveries, devices, outbox RESTART IDENTITY CASCADE`,
  );
  push.reset();
  deferred = [];
});

describe('what makes a post valid', () => {
  it('accepts a title alone, which the old rule would have refused', async () => {
    const owner = await signUp('Owner');
    const { clubId } = await createClubAs(owner);

    const created = await as(owner, 'POST', `/clubs/${clubId}/news`, {
      title: 'Evening Run in Binghamton',
    });
    expect(created.status).toBe(201);

    const read = await as(owner, 'GET', `/news/${created.body.postId}`);
    expect(read.body.post.title).toBe('Evening Run in Binghamton');
    expect(read.body.post.body).toBeNull();
  });

  it('accepts photos alone, which is the case the deferred trigger exists for', async () => {
    const owner = await signUp('Owner');
    const { clubId, channelId } = await createClubAs(owner);
    const one = await photo(owner, clubId, channelId);

    const created = await as(owner, 'POST', `/clubs/${clubId}/news`, { mediaIds: [one] });
    expect(created.status).toBe(201);

    const read = await as(owner, 'GET', `/news/${created.body.postId}`);
    expect(read.body.post.mediaIds).toEqual([one]);
  });

  it('still refuses a post with nothing in it', async () => {
    const owner = await signUp('Owner');
    const { clubId } = await createClubAs(owner);

    expect((await as(owner, 'POST', `/clubs/${clubId}/news`, {})).status).toBe(400);
    expect(
      (await as(owner, 'POST', `/clubs/${clubId}/news`, { title: '  ', body: '  ' })).status,
    ).toBe(400);
    expect(
      (await as(owner, 'POST', `/clubs/${clubId}/news`, { title: '', mediaIds: [] })).status,
    ).toBe(400);
  });

  it('refuses a location link with no place to attach it to', async () => {
    const owner = await signUp('Owner');
    const { clubId } = await createClubAs(owner);

    expect(
      (
        await as(owner, 'POST', `/clubs/${clubId}/news`, {
          body: 'Somewhere',
          locationUrl: 'https://maps.example.invalid/x',
        })
      ).status,
    ).toBe(400);
  });

  it('keeps a location name and its link together', async () => {
    const owner = await signUp('Owner');
    const { clubId } = await createClubAs(owner);

    const created = await as(owner, 'POST', `/clubs/${clubId}/news`, {
      body: 'Six miles.',
      locationName: 'Lincoln Memorial, Washington DC',
      locationUrl: 'https://maps.example.invalid/x',
    });
    expect(created.status).toBe(201);

    const read = await as(owner, 'GET', `/news/${created.body.postId}`);
    expect(read.body.post.locationName).toBe('Lincoln Memorial, Washington DC');
    expect(read.body.post.locationUrl).toBe('https://maps.example.invalid/x');
  });
});

describe('the gallery', () => {
  it('keeps the order it was given, which is the carousel order', async () => {
    const owner = await signUp('Owner');
    const { clubId, channelId } = await createClubAs(owner);
    const photos = [];
    for (let i = 0; i < 4; i++) photos.push(await photo(owner, clubId, channelId));

    // Deliberately not sorted: a read that happened to return them by id or by insertion time
    // would agree with a sorted fixture and disagree with a real post.
    const order = [photos[2]!, photos[0]!, photos[3]!, photos[1]!];
    const created = await as(owner, 'POST', `/clubs/${clubId}/news`, {
      title: 'Four of them',
      mediaIds: order,
    });
    expect(created.status).toBe(201);

    const read = await as(owner, 'GET', `/news/${created.body.postId}`);
    expect(read.body.post.mediaIds).toEqual(order);
  });

  it('takes six and refuses a seventh', async () => {
    const owner = await signUp('Owner');
    const { clubId, channelId } = await createClubAs(owner);
    const photos = [];
    for (let i = 0; i < 7; i++) photos.push(await photo(owner, clubId, channelId));

    expect(
      (await as(owner, 'POST', `/clubs/${clubId}/news`, { title: 'Six', mediaIds: photos.slice(0, 6) }))
        .status,
    ).toBe(201);
    expect(
      (await as(owner, 'POST', `/clubs/${clubId}/news`, { title: 'Seven', mediaIds: photos }))
        .status,
    ).toBe(400);
  });

  it('refuses the same photo twice in one carousel', async () => {
    const owner = await signUp('Owner');
    const { clubId, channelId } = await createClubAs(owner);
    const one = await photo(owner, clubId, channelId);

    expect(
      (await as(owner, 'POST', `/clubs/${clubId}/news`, { title: 'Twice', mediaIds: [one, one] }))
        .status,
    ).toBe(400);
  });

  it('refuses an aspect ratio the carousel cannot draw, and defaults to a square', async () => {
    const owner = await signUp('Owner');
    const { clubId } = await createClubAs(owner);

    expect(
      (await as(owner, 'POST', `/clubs/${clubId}/news`, { title: 'Wide', aspect: '3:2' })).status,
    ).toBe(400);

    const created = await as(owner, 'POST', `/clubs/${clubId}/news`, { title: 'Default' });
    const read = await as(owner, 'GET', `/news/${created.body.postId}`);
    expect(read.body.post.aspect).toBe('1:1');
  });

  it('marks a post photo as a post photo, so it stays out of the chat gallery', async () => {
    const owner = await signUp('Owner');
    const { clubId, channelId } = await createClubAs(owner);
    const one = await photo(owner, clubId, channelId);

    await as(owner, 'POST', `/clubs/${clubId}/news`, { title: 'Recap', mediaIds: [one] });

    const rows = await h.db.execute<{ owner_type: string }>(
      sql`SELECT owner_type FROM media_objects WHERE id = ${one}::uuid`,
    );
    // Uploaded as a chat attachment - PRD/13 rule 4 is why it must not stay one.
    expect(rows.rows[0]?.owner_type).toBe('news_post');
  });

  it('replaces the whole gallery on an edit, and leaves it alone when untouched', async () => {
    const owner = await signUp('Owner');
    const { clubId, channelId } = await createClubAs(owner);
    const a = await photo(owner, clubId, channelId);
    const b = await photo(owner, clubId, channelId);

    const created = await as(owner, 'POST', `/clubs/${clubId}/news`, {
      title: 'Recap',
      mediaIds: [a, b],
    });
    const postId = created.body.postId;

    // PRD/06 rule 7: an edit that does not mention photos keeps them, in order.
    await as(owner, 'PATCH', `/news/${postId}`, { title: 'Recap, corrected' });
    expect((await as(owner, 'GET', `/news/${postId}`)).body.post.mediaIds).toEqual([a, b]);

    await as(owner, 'PATCH', `/news/${postId}`, { mediaIds: [b] });
    expect((await as(owner, 'GET', `/news/${postId}`)).body.post.mediaIds).toEqual([b]);
  });
});

describe('tags and search', () => {
  it('takes tags out of the body, lowercased and deduplicated', async () => {
    const owner = await signUp('Owner');
    const { clubId } = await createClubAs(owner);

    const created = await as(owner, 'POST', `/clubs/${clubId}/news`, {
      body: 'Six miles. #longRun #bingRC #longrun',
    });
    const read = await as(owner, 'GET', `/news/${created.body.postId}`);
    expect(read.body.post.tags.sort()).toEqual(['bingrc', 'longrun']);
  });

  it('gives them back in the order they were written, not alphabetically', async () => {
    const owner = await signUp('Owner');
    const { clubId } = await createClubAs(owner);

    // Written in reverse alphabetical order, so an `ORDER BY tag` read cannot accidentally pass.
    // This is the defect that shipped and was caught on a device: the extractor kept written
    // order and the read threw it away, so the chips disagreed with the sentence above them.
    const created = await as(owner, 'POST', `/clubs/${clubId}/news`, {
      body: 'Six miles. #zulu #alpha #mike',
    });
    const read = await as(owner, 'GET', `/news/${created.body.postId}`);
    expect(read.body.post.tags).toEqual(['zulu', 'alpha', 'mike']);
  });

  it('renumbers positions on an edit rather than colliding with the old ones', async () => {
    const owner = await signUp('Owner');
    const { clubId } = await createClubAs(owner);

    const created = await as(owner, 'POST', `/clubs/${clubId}/news`, { body: '#a #b #c' });
    const postId = created.body.postId;

    // Fewer tags, different words, same positions being reused - which is where a unique
    // (post_id, ordinal) goes wrong if the old rows are not cleared first.
    expect((await as(owner, 'PATCH', `/news/${postId}`, { body: '#d #e' })).status).toBe(200);
    expect((await as(owner, 'GET', `/news/${postId}`)).body.post.tags).toEqual(['d', 'e']);
  });

  it('re-derives tags when the body is edited, so none outlive their sentence', async () => {
    const owner = await signUp('Owner');
    const { clubId } = await createClubAs(owner);

    const created = await as(owner, 'POST', `/clubs/${clubId}/news`, { body: 'go #longrun' });
    const postId = created.body.postId;
    expect((await as(owner, 'GET', `/news/${postId}`)).body.post.tags).toEqual(['longrun']);

    await as(owner, 'PATCH', `/news/${postId}`, { body: 'go #trackday' });
    expect((await as(owner, 'GET', `/news/${postId}`)).body.post.tags).toEqual(['trackday']);
  });

  it('searches titles by substring and tags by prefix', async () => {
    const owner = await signUp('Owner');
    const { clubId } = await createClubAs(owner);

    await as(owner, 'POST', `/clubs/${clubId}/news`, { title: 'Evening Run in Binghamton' });
    await as(owner, 'POST', `/clubs/${clubId}/news`, { title: 'Kit order', body: '#longrun' });
    await as(owner, 'POST', `/clubs/${clubId}/news`, { title: 'Nothing to do with it' });

    const byTitle = await as(owner, 'GET', `/clubs/${clubId}/news?q=Binghamton`);
    expect(byTitle.body.posts.map((p: any) => p.title)).toEqual(['Evening Run in Binghamton']);

    // Half-typed, which is the state a search box spends most of its life in.
    const byPartialTag = await as(owner, 'GET', `/clubs/${clubId}/news?q=long`);
    expect(byPartialTag.body.posts.map((p: any) => p.title)).toEqual(['Kit order']);

    // The character the member can see on the chip.
    const byHashTag = await as(owner, 'GET', `/clubs/${clubId}/news?q=%23longrun`);
    expect(byHashTag.body.posts.map((p: any) => p.title)).toEqual(['Kit order']);
  });

  it('treats a wildcard as a character rather than a wildcard', async () => {
    const owner = await signUp('Owner');
    const { clubId } = await createClubAs(owner);
    await as(owner, 'POST', `/clubs/${clubId}/news`, { title: 'Plain title' });

    // Unescaped, `%` matches everything and the box silently stops filtering.
    const result = await as(owner, 'GET', `/clubs/${clubId}/news?q=%25`);
    expect(result.body.posts).toEqual([]);
  });

  it('never searches across clubs', async () => {
    const owner = await signUp('Owner');
    const first = await createClubAs(owner);
    const second = await createClubAs(owner);

    await as(owner, 'POST', `/clubs/${first.clubId}/news`, { title: 'Shared word here' });
    await as(owner, 'POST', `/clubs/${second.clubId}/news`, { title: 'Shared word too' });

    const result = await as(owner, 'GET', `/clubs/${first.clubId}/news?q=Shared`);
    expect(result.body.posts).toHaveLength(1);
  });
});

describe('naming people', () => {
  it('offers this club members, and refuses somebody who may not post', async () => {
    const owner = await signUp('Owner');
    const member = await signUp('Member');
    const outsider = await signUp('Outsider');
    const { clubId } = await createClubAs(owner);
    await join(clubId, member);

    const candidates = await as(owner, 'GET', `/clubs/${clubId}/news/member-candidates`);
    expect(candidates.status).toBe(200);
    expect(candidates.body.candidates.map((c: any) => c.name)).toEqual(['Member']);

    // Non-disclosing: an empty list would leak the roster by exclusion.
    expect((await as(member, 'GET', `/clubs/${clubId}/news/member-candidates`)).status).toBe(404);
    expect((await as(outsider, 'GET', `/clubs/${clubId}/news/member-candidates`)).status).toBe(404);
  });

  it('stores the named people with their faces', async () => {
    const owner = await signUp('Owner');
    const molly = await signUp('Molly');
    const { clubId } = await createClubAs(owner);
    await join(clubId, molly);

    const created = await as(owner, 'POST', `/clubs/${clubId}/news`, {
      title: 'Recap',
      peopleIds: [molly.userId],
    });
    expect(created.status).toBe(201);

    const read = await as(owner, 'GET', `/news/${created.body.postId}`);
    expect(read.body.post.people).toEqual([
      { userId: molly.userId, name: 'Molly', image: null },
    ]);
  });

  it('refuses to name somebody who is not in this club', async () => {
    const owner = await signUp('Owner');
    const outsider = await signUp('Outsider');
    const { clubId } = await createClubAs(owner);

    const created = await as(owner, 'POST', `/clubs/${clubId}/news`, {
      title: 'Recap',
      peopleIds: [outsider.userId],
    });
    expect(created.status).toBe(400);
  });

  it('keeps a name after that person leaves the club', async () => {
    const owner = await signUp('Owner');
    const molly = await signUp('Molly');
    const { clubId } = await createClubAs(owner);
    await join(clubId, molly);

    const created = await as(owner, 'POST', `/clubs/${clubId}/news`, {
      title: 'Recap',
      peopleIds: [molly.userId],
    });
    await h.db.execute(
      sql`DELETE FROM club_memberships WHERE club_id = ${clubId}::uuid AND user_id = ${molly.userId}::uuid`,
    );

    // A post is a record of something that happened (ADR-0040).
    const read = await as(owner, 'GET', `/news/${created.body.postId}`);
    expect(read.body.post.people.map((p: any) => p.name)).toEqual(['Molly']);
  });
});

describe('being named buzzes once and is told twice', () => {
  it('writes both rows to a named member and pushes them only the specific one', async () => {
    const owner = await signUp('Owner');
    const molly = await signUp('Molly');
    const sam = await signUp('Sam');
    const { clubId } = await createClubAs(owner);
    await join(clubId, molly);
    await join(clubId, sam);
    await registerDevice(molly);
    await registerDevice(sam);

    await as(owner, 'POST', `/clubs/${clubId}/news`, {
      title: 'Evening Run',
      peopleIds: [molly.userId],
    });
    await drainAndDeliver();

    // Both rows: one says the club was told something, the other says she was named in it.
    expect(await notificationTypesFor(molly.userId)).toEqual([
      'news_post_created',
      'news_post_tagged',
    ]);
    // Sam was not named, so he gets the generic row only.
    expect(await notificationTypesFor(sam.userId)).toEqual(['news_post_created']);

    // One phone, one message, ONE buzz - the defect 7508471 fixed for announcements.
    const mollyPushes = push.sent.filter((m) => m.token.includes(molly.userId.slice(0, 12)));
    expect(mollyPushes).toHaveLength(1);
    expect(mollyPushes[0]?.body).toContain('named you in a post');

    const samPushes = push.sent.filter((m) => m.token.includes(sam.userId.slice(0, 12)));
    expect(samPushes).toHaveLength(1);
    expect(samPushes[0]?.body).toContain('posted club news');
  });

  it('never notifies the author for naming themselves', async () => {
    const owner = await signUp('Owner');
    const { clubId } = await createClubAs(owner);
    await registerDevice(owner);

    await as(owner, 'POST', `/clubs/${clubId}/news`, {
      title: 'Solo run',
      peopleIds: [owner.userId],
    });
    await drainAndDeliver();

    expect(await notificationTypesFor(owner.userId)).toEqual([]);
    expect(push.sent).toHaveLength(0);
  });

  it('tells somebody newly named by an edit, and nobody who was already there', async () => {
    const owner = await signUp('Owner');
    const molly = await signUp('Molly');
    const sam = await signUp('Sam');
    const { clubId } = await createClubAs(owner);
    await join(clubId, molly);
    await join(clubId, sam);

    const created = await as(owner, 'POST', `/clubs/${clubId}/news`, {
      title: 'Recap',
      peopleIds: [molly.userId],
    });
    await drainAndDeliver();
    await h.db.execute(sql`TRUNCATE notifications, push_deliveries RESTART IDENTITY CASCADE`);

    await as(owner, 'PATCH', `/news/${created.body.postId}`, {
      peopleIds: [molly.userId, sam.userId],
    });
    await drainAndDeliver();

    // Only the difference has learned anything. Molly was already on the post.
    expect(await notificationTypesFor(sam.userId)).toEqual(['news_post_tagged']);
    expect(await notificationTypesFor(molly.userId)).toEqual([]);
  });

  it('says nothing at all for an edit that names nobody new', async () => {
    const owner = await signUp('Owner');
    const molly = await signUp('Molly');
    const { clubId } = await createClubAs(owner);
    await join(clubId, molly);

    const created = await as(owner, 'POST', `/clubs/${clubId}/news`, {
      title: 'Recap',
      peopleIds: [molly.userId],
    });
    await drainAndDeliver();
    await h.db.execute(sql`TRUNCATE notifications, push_deliveries RESTART IDENTITY CASCADE`);

    // A fixed typo, and removing a name, are both silences (PRD/06 rule 6).
    await as(owner, 'PATCH', `/news/${created.body.postId}`, { title: 'Recap, corrected' });
    await as(owner, 'PATCH', `/news/${created.body.postId}`, { peopleIds: [] });
    await drainAndDeliver();

    expect(await notificationTypesFor(molly.userId)).toEqual([]);
  });
});
