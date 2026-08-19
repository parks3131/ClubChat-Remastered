/**
 * `GET /polls?ids=`, `GET /events?ids=` and `GET /media/urls?ids=` - the batch reads a screen
 * draws itself from.
 *
 * These exist for speed: a club chat holding 26 poll cards and 10 event cards issued 36 requests
 * to draw itself, one per card, because there was no way to ask for more than one. Measured on
 * the dev trace on 2026-08-18.
 *
 * **Speed is not the thing this file is guarding.** A batch read is the classic place to leak,
 * because the obvious implementation is one query with an `IN` clause and a predicate written a
 * second time - and the second copy is the one that forgets that a race poll is invisible to a
 * club admin with no roster row. So the route calls `readPoll` and `readEvent` once per id,
 * exactly as the single-item routes do, and every test below asks the same question twice: once
 * of the single route and once of the batch, and demands the same answer.
 *
 * If these two ever disagree, the batch is the one that is wrong.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../api/app.ts';
import { createAuth, type Auth } from '../auth.ts';
import type { Config } from '../config.ts';
import { eq } from 'drizzle-orm';
import { clubMemberships, mediaObjects } from '../db/schema.ts';
import { FakeMediaStore } from '../media/store.ts';
import { silentMonitor } from '../monitoring.ts';
import { MAX_BATCH_IDS } from '../api/plumbing.ts';
import { allowAll } from './fake-limiter.ts';
import { startTestDb, type TestDb } from './harness.ts';

let h: TestDb;
let app: FastifyInstance;
let auth: Auth;
/** Held rather than inlined, so the media helper below can stand in for the client's PUT. */
let store: FakeMediaStore;

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

async function createClubAs(actor: Actor): Promise<{ clubId: string; mainChannelId: string }> {
  const created = await as(actor, 'POST', '/clubs', {
    name: `Club ${crypto.randomUUID().slice(0, 6)}`,
  });
  expect(created.status).toBe(201);
  return { clubId: created.body.clubId, mainChannelId: created.body.mainChannelId };
}

async function join(clubId: string, actor: Actor, role: 'member' | 'admin' = 'member') {
  await h.db.insert(clubMemberships).values({ clubId, userId: actor.userId, role });
}

const TWO_OPTIONS = { question: 'Which day?', options: ['Saturday', 'Sunday'] };

const makePoll = async (actor: Actor, clubId: string): Promise<string> => {
  const created = await as(actor, 'POST', `/clubs/${clubId}/polls`, TWO_OPTIONS);
  expect(created.status).toBe(201);
  return created.body.pollId;
};

const makeEvent = async (actor: Actor, clubId: string, title: string): Promise<string> => {
  const created = await as(actor, 'POST', `/clubs/${clubId}/events`, {
    type: 'practice' as const,
    title,
    startsAt: '2027-04-01T17:00:00.000Z',
  });
  expect(created.status).toBe(201);
  return created.body.eventId;
};

/** A 64px image, encoded once. Small enough to be fast, real enough for the pipeline to probe. */
let encodedJpeg: Buffer | null = null;
async function jpegBytes(): Promise<Buffer> {
  if (encodedJpeg) return encodedJpeg;
  const sharp = (await import('sharp')).default;
  encodedJpeg = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#3355aa' } })
    .jpeg()
    .toBuffer();
  return encodedJpeg;
}

/** Upload a photo the way a client does: intent, PUT to storage, complete. */
async function makePhoto(actor: Actor, channelId: string): Promise<string> {
  const bytes = await jpegBytes();
  const intent = await as(actor, 'POST', '/media/upload-intent', {
    kind: 'photo',
    mime: 'image/jpeg',
    bytes: bytes.byteLength,
    channelId,
  });
  expect(intent.status).toBe(201);
  const mediaId: string = intent.body.mediaId;

  const row = await h.db.select().from(mediaObjects).where(eq(mediaObjects.id, mediaId)).limit(1);
  // Stands in for the client PUTting straight to object storage.
  store.simulateUpload(row[0]!.bucket, row[0]!.objectKey, new Uint8Array(bytes), 'image/jpeg');

  const done = await as(actor, 'POST', `/media/${mediaId}/complete`, {});
  expect(done.status).toBe(200);
  return mediaId;
}

beforeAll(async () => {
  h = await startTestDb();
  auth = createAuth(h.db, {
    secret: 'test-secret-not-a-real-one',
    baseURL: config.BETTER_AUTH_URL,
  });
  store = new FakeMediaStore();
  app = buildApp({
    db: h.db,
    auth,
    config,
    mediaStore: store,
    monitor: silentMonitor(),
    limiter: allowAll(),
  });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close().catch(() => undefined);
  await h?.stop().catch(() => undefined);
});

describe('GET /polls?ids=', () => {
  it('returns the same poll the single route does, for several at once', async () => {
    const owner = await signUp('BatchOwner');
    const { clubId } = await createClubAs(owner);
    const ids = [await makePoll(owner, clubId), await makePoll(owner, clubId)];

    const batch = await as(owner, 'GET', `/polls?ids=${ids.join(',')}`);
    expect(batch.status).toBe(200);
    expect(batch.body.polls).toHaveLength(2);

    // The shape has to be identical, or a card drawn from the batch differs from the same card
    // drawn from the single route - which is the bug this whole change must not introduce.
    for (const id of ids) {
      const single = await as(owner, 'GET', `/polls/${id}`);
      const fromBatch = batch.body.polls.find((p: { id: string }) => p.id === id);
      expect(fromBatch).toEqual(single.body.poll);
    }
  });

  it('omits a race poll from a club admin with no roster row, exactly as the single route refuses it', async () => {
    const owner = await signUp('BatchRaceOwner');
    const admin = await signUp('BatchRaceAdmin');
    const { clubId } = await createClubAs(owner);
    await join(clubId, admin, 'admin');

    const race = await as(owner, 'POST', `/clubs/${clubId}/races`, {
      name: 'Batch race',
      raceDate: '2027-09-09',
    });
    const racePoll = (await as(owner, 'POST', `/races/${race.body.raceId}/polls`, TWO_OPTIONS)).body
      .pollId;
    const clubPoll = await makePoll(owner, clubId);

    // The checklist line, restated at the single route.
    expect((await as(admin, 'GET', `/polls/${racePoll}`)).status).toBe(404);

    // And the batch must not be the way around it. Asking for both gets exactly the one they
    // may read, with no hint that the other exists.
    const batch = await as(admin, 'GET', `/polls?ids=${racePoll},${clubPoll}`);
    expect(batch.status).toBe(200);
    expect(batch.body.polls.map((p: { id: string }) => p.id)).toEqual([clubPoll]);
    expect(JSON.stringify(batch.body)).not.toContain(racePoll);
  });

  it('lets one dead id fail alone rather than taking the rest with it', async () => {
    const owner = await signUp('BatchDeadOwner');
    const { clubId } = await createClubAs(owner);
    const alive = await makePoll(owner, clubId);
    const gone = await makePoll(owner, clubId);
    expect((await as(owner, 'DELETE', `/polls/${gone}`)).status).toBe(200);

    // A card in old chat history naming a deleted poll is the ordinary case, not an error case.
    const batch = await as(owner, 'GET', `/polls?ids=${gone},${alive}`);
    expect(batch.status).toBe(200);
    expect(batch.body.polls.map((p: { id: string }) => p.id)).toEqual([alive]);
  });

  it('collapses a repeated id rather than reading it twice', async () => {
    const owner = await signUp('BatchDupOwner');
    const { clubId } = await createClubAs(owner);
    const id = await makePoll(owner, clubId);

    const batch = await as(owner, 'GET', `/polls?ids=${id},${id},${id}`);
    expect(batch.body.polls).toHaveLength(1);
  });

  it('refuses a malformed id rather than quietly skipping it', async () => {
    const owner = await signUp('BatchBadOwner');
    const { clubId } = await createClubAs(owner);
    const good = await makePoll(owner, clubId);

    // Skipping would answer 200 with a response that does not mention the id, which is
    // indistinguishable from an id the caller may not read - so a client bug would hide behind
    // a success. That is the defect `/sync` spent months in.
    const bad = await as(owner, 'GET', `/polls?ids=${good},not-a-uuid`);
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('bad_id');
  });

  it('refuses an empty list and an oversized one', async () => {
    const owner = await signUp('BatchLimitOwner');

    expect((await as(owner, 'GET', '/polls?ids=')).status).toBe(400);
    expect((await as(owner, 'GET', '/polls')).body.error).toBe('no_ids');

    const many = Array.from({ length: MAX_BATCH_IDS + 1 }, () => crypto.randomUUID()).join(',');
    const over = await as(owner, 'GET', `/polls?ids=${many}`);
    expect(over.status).toBe(400);
    expect(over.body.error).toBe('too_many_ids');
  });

  it('refuses an unauthenticated caller, like every other route', async () => {
    const response = await app.inject({ method: 'GET', url: `/polls?ids=${crypto.randomUUID()}` });
    expect(response.statusCode).toBe(401);
  });
});

describe('GET /events?ids=', () => {
  it('returns the same event the single route does, for several at once', async () => {
    const owner = await signUp('BatchEventOwner');
    const { clubId } = await createClubAs(owner);
    const ids = [await makeEvent(owner, clubId, 'One'), await makeEvent(owner, clubId, 'Two')];

    const batch = await as(owner, 'GET', `/events?ids=${ids.join(',')}`);
    expect(batch.status).toBe(200);
    expect(batch.body.events).toHaveLength(2);

    for (const id of ids) {
      const single = await as(owner, 'GET', `/events/${id}`);
      const fromBatch = batch.body.events.find((e: { id: string }) => e.id === id);
      expect(fromBatch).toEqual(single.body.event);
    }
  });

  it('omits an event belonging to a club the caller is not in', async () => {
    const owner = await signUp('BatchEventInsider');
    const outsider = await signUp('BatchEventOutsider');
    const { clubId } = await createClubAs(owner);
    const theirs = await makeEvent(owner, clubId, 'Members only');

    const { clubId: ownClub } = await createClubAs(outsider);
    const mine = await makeEvent(outsider, ownClub, 'Mine');

    expect((await as(outsider, 'GET', `/events/${theirs}`)).status).toBe(404);

    const batch = await as(outsider, 'GET', `/events?ids=${theirs},${mine}`);
    expect(batch.status).toBe(200);
    expect(batch.body.events.map((e: { id: string }) => e.id)).toEqual([mine]);
  });

  it('lets one deleted event fail alone', async () => {
    const owner = await signUp('BatchEventDead');
    const { clubId } = await createClubAs(owner);
    const alive = await makeEvent(owner, clubId, 'Alive');
    const gone = await makeEvent(owner, clubId, 'Gone');
    expect((await as(owner, 'DELETE', `/events/${gone}`)).status).toBe(200);

    const batch = await as(owner, 'GET', `/events?ids=${gone},${alive}`);
    expect(batch.body.events.map((e: { id: string }) => e.id)).toEqual([alive]);
  });
});

/**
 * `GET /media/urls?ids=`, added 2026-08-19.
 *
 * The reason it exists is speed - a measured window on the device spent 45% of its requests
 * resolving picture links one at a time - but the reason this block exists is the same as the
 * two above: the batch must refuse exactly what the single route refuses. A signed URL is the
 * one thing in this API that is useful after the request that produced it, so a batch that
 * leaks one has leaked bytes rather than merely a row.
 */
describe('GET /media/urls?ids=', () => {
  it('returns the same url the single route does, for several at once', async () => {
    const owner = await signUp('BatchMediaOwner');
    const { mainChannelId } = await createClubAs(owner);
    const first = await makePhoto(owner, mainChannelId);
    const second = await makePhoto(owner, mainChannelId);

    const singles = await Promise.all(
      [first, second].map((id) => as(owner, 'GET', `/media/${id}/url?variant=thumb`)),
    );
    for (const one of singles) expect(one.status).toBe(200);

    const batch = await as(owner, 'GET', `/media/urls?ids=${first},${second}&variant=thumb`);
    expect(batch.status).toBe(200);

    const byId = new Map(
      batch.body.urls.map((u: { id: string; url: string }) => [u.id, u.url] as const),
    );
    expect(byId.get(first)).toBe(singles[0]!.body.url);
    expect(byId.get(second)).toBe(singles[1]!.body.url);
  });

  it('omits a picture from a club the caller is not in, exactly as the single route refuses it', async () => {
    const owner = await signUp('BatchMediaOwner2');
    const outsider = await signUp('BatchMediaOutsider');
    const { mainChannelId } = await createClubAs(owner);
    const theirs = await makePhoto(owner, mainChannelId);

    const ownClub = await createClubAs(outsider);
    const mine = await makePhoto(outsider, ownClub.mainChannelId);

    // The single route refuses it...
    expect((await as(outsider, 'GET', `/media/${theirs}/url`)).status).toBe(404);

    // ...and the batch must not hand back a signed URL for the same picture.
    const batch = await as(outsider, 'GET', `/media/urls?ids=${theirs},${mine}`);
    expect(batch.status).toBe(200);
    expect(batch.body.urls.map((u: { id: string }) => u.id)).toEqual([mine]);
    expect(JSON.stringify(batch.body)).not.toContain(theirs);
  });

  it('refuses a malformed id rather than quietly skipping it', async () => {
    const owner = await signUp('BatchMediaBadId');
    const { mainChannelId } = await createClubAs(owner);
    const good = await makePhoto(owner, mainChannelId);

    const batch = await as(owner, 'GET', `/media/urls?ids=${good},not-a-uuid`);
    expect(batch.status).toBe(400);
    expect(batch.body.error).toBe('bad_id');
  });

  it('collapses a repeated id rather than signing it twice', async () => {
    const owner = await signUp('BatchMediaDupe');
    const { mainChannelId } = await createClubAs(owner);
    const one = await makePhoto(owner, mainChannelId);

    const batch = await as(owner, 'GET', `/media/urls?ids=${one},${one},${one}`);
    expect(batch.body.urls.map((u: { id: string }) => u.id)).toEqual([one]);
  });

  it('refuses an empty list and an oversized one', async () => {
    const owner = await signUp('BatchMediaBounds');
    expect((await as(owner, 'GET', '/media/urls')).status).toBe(400);
    expect((await as(owner, 'GET', '/media/urls?ids=')).status).toBe(400);

    const tooMany = Array.from({ length: MAX_BATCH_IDS + 1 }, () => crypto.randomUUID()).join(',');
    const over = await as(owner, 'GET', `/media/urls?ids=${tooMany}`);
    expect(over.status).toBe(400);
    expect(over.body.error).toBe('too_many_ids');
  });

  it('refuses an unauthenticated caller, like every other route', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/media/urls?ids=${crypto.randomUUID()}`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('is not swallowed by GET /media/:id, which it sits beside', async () => {
    const owner = await signUp('BatchMediaRouting');
    // A static segment must win over the parametric one, or `urls` reads as a media id and this
    // answers 404 for a picture nobody asked for.
    const batch = await as(owner, 'GET', '/media/urls?ids=not-a-uuid');
    expect(batch.status).toBe(400);
    expect(batch.body.error).toBe('bad_id');
  });
});
