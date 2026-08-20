/**
 * What `/media/:id/complete` says when object storage is the thing that is broken.
 *
 * > **The failure this exists to make impossible: a rotated R2 secret that looks like members
 * > abandoning uploads.** `store.head` used to catch everything and return `{ exists: false }`,
 * > so a real 404, a 403 from a mistyped credential, a DNS failure and a timeout were one value.
 * > `completeUpload` answered all four with `not_uploaded`, which per
 * > `SPEC/TECH/07-media-pipeline.md` tells the client to finish the upload and try again. The
 * > client then re-PUT bytes that were already in the bucket, was refused identically, and gave
 * > up - and nothing reached the monitor, so the only signal an operator had was a graph of
 * > uploads that started and never completed. That is indistinguishable from members changing
 * > their minds, which is a thing members genuinely do.
 *
 * Two assertions, and the second is the one that was missing entirely: the caller is told this is
 * ours to fix rather than theirs, AND somebody is told at all.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { buildApp } from '../api/app.ts';
import { createAuth, type Auth } from '../auth.ts';
import type { Config } from '../config.ts';
import { mediaObjects } from '../db/schema.ts';
import { FakeMediaStore, MediaStoreError } from '../media/store.ts';
import type { Monitor } from '../monitoring.ts';
import { allowAll } from './fake-limiter.ts';
import { startTestDb, type TestDb } from './harness.ts';

let h: TestDb;
let auth: Auth;
let app: FastifyInstance;
let store: FakeMediaStore;
let captured: Array<{ where: string; context: Record<string, unknown> | undefined }>;

const config = {
  LOG_LEVEL: 'silent',
  CLIENT_ORIGIN: 'http://localhost:8081',
  BETTER_AUTH_URL: 'http://localhost:3000',
  S3_BUCKET_PUBLIC: 'identity',
  S3_BUCKET_PRIVATE: 'content',
  MEDIA_SIGNING_SECRET: 'test-signing-secret-not-real',
  MEDIA_CDN_BASE_URL: 'http://cdn.invalid/content',
  MEDIA_URL_MODE: 'cdn',
} as unknown as Config;

/** A monitor that records rather than sends, so the assertion is about what was reported. */
function spyMonitor(): Monitor {
  return {
    capture(_error, where, context) {
      captured.push({ where, context });
    },
    async flush() {},
  };
}

type Actor = { userId: string; token: string };

async function signUp(name: string): Promise<Actor> {
  const email = `${name}-${crypto.randomUUID().slice(0, 8)}@test.invalid`;
  const result = await auth.api.signUpEmail({
    body: { name, email, password: 'correct-horse-battery-staple' },
  });
  const token = (result as { token?: string }).token;
  if (!token) throw new Error('sign-up returned no session token');
  return { userId: result.user.id, token };
}

async function createClub(actor: Actor) {
  const created = await post(actor, '/clubs', {
    name: `Club ${crypto.randomUUID().slice(0, 6)}`,
  });
  expect(created.status).toBe(201);
  return created;
}

async function post(actor: Actor, url: string, payload: object) {
  const response = await app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${actor.token}` },
    payload,
  });
  return {
    status: response.statusCode,
    body: response.body.length > 0 ? (JSON.parse(response.body) as Record<string, unknown>) : null,
  };
}

/**
 * An upload the client believes it has finished.
 *
 * Inserted directly rather than driven through `/media/upload-intent`: what is under test is the
 * verification hop, and the intent hop has its own coverage in `phase3-media.test.ts`.
 */
async function pendingUpload(actor: Actor, clubId: string, channelId: string): Promise<string> {
  const id = crypto.randomUUID();
  await h.db.insert(mediaObjects).values({
    id,
    ownerType: 'message',
    clubId,
    channelId,
    uploaderId: actor.userId,
    bucket: 'content',
    objectKey: `photos/${id}`,
    mime: 'image/jpeg',
    bytes: 2048,
    status: 'pending',
  });
  return id;
}

beforeAll(async () => {
  h = await startTestDb();
  auth = createAuth(h.db, {
    secret: 'test-secret-not-a-real-one',
    baseURL: config.BETTER_AUTH_URL,
  });
}, 120_000);

afterAll(async () => {
  await app?.close().catch(() => undefined);
  await h?.stop().catch(() => undefined);
});

beforeEach(async () => {
  await h.db.execute(sql`TRUNCATE media_objects RESTART IDENTITY CASCADE`);
  captured = [];
  store = new FakeMediaStore();
  await app?.close().catch(() => undefined);
  app = buildApp({
    db: h.db,
    auth,
    config,
    mediaStore: store,
    monitor: spyMonitor(),
    limiter: allowAll(),
  });
  await app.ready();
});

describe('completing an upload while object storage is unreachable', () => {
  it('answers 503, not the 404 that tells the client to upload it all over again', async () => {
    const uploader = await signUp('uploader');
    const club = await createClub(uploader);
    const mediaId = await pendingUpload(
      uploader,
      String(club.body!['clubId']),
      String(club.body!['mainChannelId']),
    );

    // The exact shape of a credential rotated with one character wrong: the store answers, and
    // what it answers is "no".
    store.failWith = new MediaStoreError(
      'head',
      { bucket: 'content', objectKey: `photos/${mediaId}` },
      Object.assign(new Error('Access Denied'), { name: 'AccessDenied' }),
    );

    const completed = await post(uploader, `/media/${mediaId}/complete`, {});

    expect(completed.status).toBe(503);
    expect(completed.body).toEqual({ error: 'storage_unavailable' });
  });

  it('reports it, which is the only way anyone learns the credential is wrong', async () => {
    const uploader = await signUp('uploader');
    const club = await createClub(uploader);
    const mediaId = await pendingUpload(
      uploader,
      String(club.body!['clubId']),
      String(club.body!['mainChannelId']),
    );
    store.failWith = new MediaStoreError(
      'head',
      { bucket: 'content', objectKey: `photos/${mediaId}` },
      Object.assign(new Error('Access Denied'), { name: 'AccessDenied' }),
    );

    await post(uploader, `/media/${mediaId}/complete`, {});

    expect(captured).toHaveLength(1);
    // Its own `where`, not the generic `api.request`: "storage is refusing us" and "some route
    // threw" group into the same issue otherwise, and the first one is an outage.
    expect(captured[0]?.where).toBe('api.media.complete');
    expect(captured[0]?.context).toMatchObject({ mediaId, operation: 'head' });
  });

  it('still answers not_uploaded when the object genuinely is not there', async () => {
    // The other half of the distinction, and the reason the first two cannot simply be a 503 for
    // every failed head: a client that really did abandon its PUT must still be told to retry it.
    const uploader = await signUp('uploader');
    const club = await createClub(uploader);
    const mediaId = await pendingUpload(
      uploader,
      String(club.body!['clubId']),
      String(club.body!['mainChannelId']),
    );

    const completed = await post(uploader, `/media/${mediaId}/complete`, {});

    expect(completed.status).toBe(404);
    expect(completed.body).toEqual({ error: 'not_uploaded' });
    expect(captured).toHaveLength(0);
  });
});
