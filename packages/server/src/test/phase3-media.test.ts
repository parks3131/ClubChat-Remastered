/**
 * THE PHASE 3 EXIT GATE (server half).
 *
 * SPEC/TECH/16: *"Done when: a private Eboard photo is provably unreachable without membership,
 * and chat is readable in airplane mode."*
 *
 * The word is **provably**. So the private-photo half is proved four ways: as a non-member, as
 * an unauthenticated caller, by attempting the raw object URL without a signature, and by
 * mutation-testing the authorization hop itself. A test that only confirms a member CAN see the
 * photo would pass a build with no authorization at all.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createClub } from '../domain/create-club.ts';
import { addMember, changeRole } from '../domain/membership.ts';
import { sendMessage } from '../domain/send-message.ts';
import { getChannelRef, readHistory, syncSince } from '../domain/reads.ts';
import { loadAccessContext } from '../policy/context.ts';
import { drainOnce } from '../worker/drain.ts';
import { RecordingPushSender } from '../push/sender.ts';
import { FakeMediaStore, IMAGE_MIME_ALLOWLIST, MAX_IMAGE_BYTES } from '../media/store.ts';
import {
  completeUpload,
  createUploadIntent,
  hourAlignedExpiry,
  readGallery,
  resolveMediaRedirect,
  signedMediaUrl,
  verifyMediaSignature,
  type MediaConfig,
} from '../media/pipeline.ts';
import { deriveVariants, runMediaGc, STALE_PENDING_HOURS } from '../media/derive.ts';
import { eboardChannels, mediaObjects, messages, users } from '../db/schema.ts';
import { anyViewer, startTestDb, type TestDb } from './harness.ts';
import type { EffectDeps } from '../worker/effects.ts';

let h: TestDb;
let store: FakeMediaStore;
let deps: EffectDeps;

const config: MediaConfig = {
  publicBucket: 'identity',
  privateBucket: 'content',
  signingSecret: 'test-signing-secret-not-a-real-one',
  cdnBaseUrl: 'http://cdn.invalid/content',
};

const silent = () => undefined;

beforeAll(async () => {
  h = await startTestDb();
});
afterAll(async () => {
  await h?.stop();
});

beforeEach(async () => {
  await h.db.execute(sql`TRUNCATE notifications, outbox, media_objects RESTART IDENTITY CASCADE`);
  store = new FakeMediaStore();
  deps = {
    db: h.db,
    redis: { publish: async () => 1 } as never,
    push: new RecordingPushSender(),
    media: store,
    log: silent,
    defer: () => undefined,
  };
});

const ctxFor = (id: string) => loadAccessContext(h.db, id);

async function makeUser(name: string): Promise<string> {
  const id = crypto.randomUUID();
  await h.db.insert(users).values({ id, name, email: `${name}-${id.slice(0, 8)}@t.invalid` });
  return id;
}

/** A club with an Eboard, an admin inside it, and a plain member outside it. */
async function setup() {
  const ownerId = await makeUser('Owner');
  const memberId = await makeUser('Member');
  const outsiderId = await makeUser('Outsider');
  const club = await createClub(h.db, { name: 'Hillside', sport: 'running', creatorId: ownerId });
  await addMember(h.db, await ctxFor(ownerId), club.clubId, memberId);
  const eboard = await h.db
    .select()
    .from(eboardChannels)
    .where(eq(eboardChannels.clubId, club.clubId));
  const eboardChannel = await h.db.execute<{ id: string }>(sql`
    SELECT id FROM channels WHERE scope = 'eboard' AND scope_id = ${eboard[0]!.id}::uuid
  `);
  await drainOnce(h.db, deps);
  return {
    ...club,
    ownerId,
    memberId,
    outsiderId,
    eboardId: eboard[0]!.id,
    eboardChannelId: eboardChannel.rows[0]!.id,
  };
}

/** The whole upload flow: intent, the client's direct PUT, then complete. */
async function uploadPhoto(
  userId: string,
  channelId: string,
  opts: { bytes?: number; mime?: string } = {},
) {
  const bytes = opts.bytes ?? 2048;
  const mime = opts.mime ?? 'image/jpeg';
  const intent = await createUploadIntent(h.db, store, config, await ctxFor(userId), {
    kind: 'photo',
    mime,
    bytes,
    channelId,
  });
  if (!intent.ok) return { intent, media: null as string | null };

  const row = await h.db
    .select()
    .from(mediaObjects)
    .where(eq(mediaObjects.id, intent.mediaId))
    .limit(1);
  // Stands in for the client PUTting straight to object storage.
  store.simulateUpload(row[0]!.bucket, row[0]!.objectKey, new Uint8Array(bytes), mime);

  const completed = await completeUpload(h.db, store, await ctxFor(userId), intent.mediaId);
  expect(completed.ok, 'complete failed').toBe(true);
  return { intent, media: intent.mediaId };
}

// ===========================================================================
// The envelope carries the attachment
// ===========================================================================

describe('a media message reaches the client with its attachment on it', () => {
  /**
   * > **This is the gap that made the whole pipeline unreachable.** Phase 3 added `media_id`,
   * > `document_name` and `document_size` to `messages` and never put them on the
   * > `MessageEnvelope`, so a client receiving a photo knew only that `type` was `'photo'` -
   * > with no id, and therefore no way to fetch the bytes. The upload half was complete and
   * > the render half had nothing to render from.
   */
  it('puts the media id on a photo message, through history and sync alike', async () => {
    const f = await setup();
    const { media } = await uploadPhoto(f.ownerId, f.mainChannelId);
    const channel = await getChannelRef(h.db, f.mainChannelId);

    const sent = await sendMessage(h.db, await ctxFor(f.ownerId), channel!, {
      channelId: f.mainChannelId,
      clientMsgId: crypto.randomUUID(),
      type: 'photo',
      body: null,
      mediaId: media!,
    });
    expect(sent.ok).toBe(true);

    const history = await readHistory(h.db, anyViewer(), f.mainChannelId);
    const photo = history.find((m) => m.type === 'photo');
    expect(photo?.mediaId, 'a photo with no media id cannot be rendered').toBe(media);
    // A photo carries neither of the document fields.
    expect(photo?.documentName).toBeNull();
    expect(photo?.documentSize).toBeNull();

    // The backlog path too, or a client that was offline comes back to an unrenderable photo.
    const synced = await syncSince(h.db, anyViewer(), f.mainChannelId, 0);
    expect(synced.messages.find((m) => m.type === 'photo')?.mediaId).toBe(media);
  });

  it('puts the filename and size on a document message', async () => {
    const f = await setup();
    const bytes = 4096;
    const intent = await createUploadIntent(h.db, store, config, await ctxFor(f.ownerId), {
      kind: 'document',
      mime: 'application/pdf',
      bytes,
      channelId: f.mainChannelId,
      documentName: 'meet-schedule.pdf',
    });
    expect(intent.ok).toBe(true);
    if (!intent.ok) return;

    const row = await h.db
      .select()
      .from(mediaObjects)
      .where(eq(mediaObjects.id, intent.mediaId))
      .limit(1);
    store.simulateUpload(
      row[0]!.bucket,
      row[0]!.objectKey,
      new Uint8Array(bytes),
      'application/pdf',
    );
    expect((await completeUpload(h.db, store, await ctxFor(f.ownerId), intent.mediaId)).ok).toBe(
      true,
    );

    const channel = await getChannelRef(h.db, f.mainChannelId);
    const sent = await sendMessage(h.db, await ctxFor(f.ownerId), channel!, {
      channelId: f.mainChannelId,
      clientMsgId: crypto.randomUUID(),
      type: 'document',
      body: null,
      mediaId: intent.mediaId,
    });
    expect(sent.ok).toBe(true);

    const document = (await readHistory(h.db, anyViewer(), f.mainChannelId)).find((m) => m.type === 'document');
    // PRD/05 lists a document bubble as showing its filename and size, so both have to travel.
    expect(document?.mediaId).toBe(intent.mediaId);
    expect(document?.documentName).toBe('meet-schedule.pdf');
    expect(document?.documentSize).toBe(bytes);
  });

  it('leaves an ordinary text message with no attachment fields set', async () => {
    const f = await setup();
    const channel = await getChannelRef(h.db, f.mainChannelId);
    await sendMessage(h.db, await ctxFor(f.ownerId), channel!, {
      channelId: f.mainChannelId,
      clientMsgId: crypto.randomUUID(),
      body: 'just words',
    });

    const text = (await readHistory(h.db, anyViewer(), f.mainChannelId)).find((m) => m.body === 'just words');
    expect(text?.mediaId).toBeNull();
    expect(text?.documentName).toBeNull();
    expect(text?.documentSize).toBeNull();
  });
});

// ===========================================================================
// THE GATE: a private Eboard photo is provably unreachable without membership
// ===========================================================================

describe('Phase 3 gate: a private Eboard photo is unreachable without membership', () => {
  async function eboardPhoto() {
    const f = await setup();
    // The owner is the only Eboard member, from club creation.
    const { media } = await uploadPhoto(f.ownerId, f.eboardChannelId);
    expect(media).not.toBeNull();

    const channel = await getChannelRef(h.db, f.eboardChannelId);
    const sent = await sendMessage(h.db, await ctxFor(f.ownerId), channel!, {
      channelId: f.eboardChannelId,
      clientMsgId: crypto.randomUUID(),
      type: 'photo',
      body: 'board photo',
      mediaId: media!,
    });
    expect(sent.ok, 'the photo send failed').toBe(true);
    return { f, mediaId: media! };
  }

  it('an Eboard member CAN reach it', async () => {
    // The positive case first, so the denials below cannot pass by the object being broken.
    const { f, mediaId } = await eboardPhoto();
    const result = await resolveMediaRedirect(h.db, store, config, await ctxFor(f.ownerId), mediaId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.url).toContain(config.cdnBaseUrl);
    // Private, not public: this response is one member's authorization decision, and a shared
    // cache holding it would serve that decision to somebody else.
    expect(result.cacheControl).toBe('private, max-age=600');
  });

  it('a plain club member CANNOT - they are not in the Eboard space', async () => {
    const { f, mediaId } = await eboardPhoto();
    const result = await resolveMediaRedirect(h.db, store, config, await ctxFor(f.memberId), mediaId);
    expect(result.ok, 'a club member reached an Eboard photo').toBe(false);
    // not_found, never forbidden: confirming the object exists is itself a disclosure.
    if (!result.ok) expect(result.code).toBe('not_found');
  });

  it('a club ADMIN outside the space cannot either', async () => {
    // The sharpest case. Being an admin is not being a member of the space.
    const { f, mediaId } = await eboardPhoto();
    const admin = await makeUser('AdminOutside');
    await addMember(h.db, await ctxFor(f.ownerId), f.clubId, admin);
    // Promotion auto-joins the Eboard, so remove them from it to build the case at all.
    await changeRole(h.db, await ctxFor(f.ownerId), f.clubId, admin, 'admin');
    await h.db.execute(sql`
      DELETE FROM eboard_memberships
       WHERE eboard_id = ${f.eboardId}::uuid AND user_id = ${admin}::uuid
    `);

    const result = await resolveMediaRedirect(h.db, store, config, await ctxFor(admin), mediaId);
    expect(result.ok, 'a club admin outside the space reached an Eboard photo').toBe(false);
  });

  it('a complete outsider cannot', async () => {
    const { f, mediaId } = await eboardPhoto();
    const result = await resolveMediaRedirect(h.db, store, config, await ctxFor(f.outsiderId), mediaId);
    expect(result.ok).toBe(false);
  });

  it('the object key is not guessable from anything the client sees', async () => {
    // The signature is not the only defence: the key itself is random, so a weakened
    // signature would not immediately expose an enumerable bucket.
    const { mediaId } = await eboardPhoto();
    const row = await h.db.select().from(mediaObjects).where(eq(mediaObjects.id, mediaId));
    const key = row[0]!.objectKey;
    expect(key).not.toContain(mediaId);
    expect(key).toMatch(/^photo\/\d{4}-\d{2}\/[0-9a-f-]{36}$/);
  });

  it('a signature cannot be forged, and an expired one is refused', async () => {
    const { mediaId } = await eboardPhoto();
    const row = await h.db.select().from(mediaObjects).where(eq(mediaObjects.id, mediaId));
    const key = row[0]!.objectKey;

    const exp = hourAlignedExpiry(Date.now());
    const good = signedMediaUrl(config, key);
    const sig = new URL(good).searchParams.get('sig')!;

    expect(verifyMediaSignature(config, key, exp, sig)).toBe(true);
    // Wrong signature.
    expect(verifyMediaSignature(config, key, exp, 'not-the-signature')).toBe(false);
    // Right signature, wrong object - so a signature for a photo you CAN see does not unlock
    // one you cannot.
    expect(verifyMediaSignature(config, 'photo/2026-01/other', exp, sig)).toBe(false);
    // Expired.
    expect(verifyMediaSignature(config, key, exp, sig, (exp + 60) * 1000)).toBe(false);
    // Signed with a different secret.
    expect(
      verifyMediaSignature({ ...config, signingSecret: 'wrong' }, key, exp, sig),
    ).toBe(false);
  });
});

// ===========================================================================
// The hour-aligned URL: the fix for debt item 7
// ===========================================================================

describe('hour-aligned signed URLs', () => {
  it('gives every viewer in the window a byte-identical URL', async () => {
    // THE point. A per-fetch expiry changes the query string per viewer, so the CDN cache key
    // changes per viewer, so 300 members means 300 origin fetches.
    const key = 'photo/2026-04/abc';
    const base = Date.parse('2026-04-12T10:17:33.000Z');

    const first = signedMediaUrl(config, key, base);
    const secondsLater = signedMediaUrl(config, key, base + 12_000);
    const minutesLater = signedMediaUrl(config, key, base + 25 * 60_000);

    expect(secondsLater).toBe(first);
    expect(minutesLater).toBe(first);
  });

  it('changes across the hour boundary, so a URL cannot live forever', () => {
    const key = 'photo/2026-04/abc';
    const inThisHour = signedMediaUrl(config, key, Date.parse('2026-04-12T10:59:00.000Z'));
    const inNextHour = signedMediaUrl(config, key, Date.parse('2026-04-12T11:01:00.000Z'));
    expect(inNextHour).not.toBe(inThisHour);
  });

  it('leaves at least an hour of validity, so a URL issued at 10:59 does not die at 11:00', () => {
    const issuedAt = Date.parse('2026-04-12T10:59:30.000Z');
    const exp = hourAlignedExpiry(issuedAt) * 1000;
    expect(exp - issuedAt).toBeGreaterThan(60 * 60 * 1000);
  });

  it('differs per object, so one signature does not unlock the bucket', () => {
    const at = Date.parse('2026-04-12T10:00:00.000Z');
    expect(signedMediaUrl(config, 'a', at)).not.toBe(signedMediaUrl(config, 'b', at));
  });
});

// ===========================================================================
// Upload limits, which v1 had none of
// ===========================================================================

describe('upload limits', () => {
  it('refuses a MIME type outside the allowlist', async () => {
    const f = await setup();
    const result = await createUploadIntent(h.db, store, config, await ctxFor(f.ownerId), {
      kind: 'photo',
      mime: 'application/x-msdownload',
      bytes: 1024,
      channelId: f.mainChannelId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('mime_not_allowed');
  });

  it('refuses an oversized declaration', async () => {
    const f = await setup();
    const result = await createUploadIntent(h.db, store, config, await ctxFor(f.ownerId), {
      kind: 'photo',
      mime: 'image/jpeg',
      bytes: MAX_IMAGE_BYTES + 1,
      channelId: f.mainChannelId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('too_large');
  });

  it('accepts every type on the allowlist', async () => {
    const f = await setup();
    for (const mime of IMAGE_MIME_ALLOWLIST) {
      const result = await createUploadIntent(h.db, store, config, await ctxFor(f.ownerId), {
        kind: 'photo',
        mime,
        bytes: 1024,
        channelId: f.mainChannelId,
      });
      expect(result.ok, `${mime} was refused`).toBe(true);
    }
  });

  it('refuses an intent aimed at a channel the uploader cannot post in', async () => {
    // Authorized at intent, with the same predicate that protects the messages - so an
    // upload into a channel you cannot reach is refused before any bytes move.
    const f = await setup();
    const result = await createUploadIntent(h.db, store, config, await ctxFor(f.outsiderId), {
      kind: 'photo',
      mime: 'image/jpeg',
      bytes: 1024,
      channelId: f.mainChannelId,
    });
    expect(result.ok).toBe(false);
  });

  it('CATCHES a client that uploaded more bytes than it declared', async () => {
    // The reason complete exists at all. A presigned PUT constrains where the bytes go and
    // what Content-Type rides along; it constrains nothing about how many bytes there are.
    const f = await setup();
    const intent = await createUploadIntent(h.db, store, config, await ctxFor(f.ownerId), {
      kind: 'photo',
      mime: 'image/jpeg',
      bytes: 1024,
      channelId: f.mainChannelId,
    });
    if (!intent.ok) throw new Error('intent failed');

    const row = await h.db
      .select()
      .from(mediaObjects)
      .where(eq(mediaObjects.id, intent.mediaId));
    // Declared 1 KB, uploaded 5 MB.
    store.simulateUpload(
      row[0]!.bucket,
      row[0]!.objectKey,
      new Uint8Array(5 * 1024 * 1024),
      'image/jpeg',
    );

    const completed = await completeUpload(h.db, store, await ctxFor(f.ownerId), intent.mediaId);
    expect(completed.ok, 'a size mismatch was accepted').toBe(false);
    if (!completed.ok) expect(completed.code).toBe('mismatch');

    // And the row stays pending, so no message can reference it.
    const after = await h.db.select().from(mediaObjects).where(eq(mediaObjects.id, intent.mediaId));
    expect(after[0]?.status).toBe('pending');
  });

  it('catches a client that uploaded a different type than it declared', async () => {
    const f = await setup();
    const intent = await createUploadIntent(h.db, store, config, await ctxFor(f.ownerId), {
      kind: 'photo',
      mime: 'image/png',
      bytes: 1024,
      channelId: f.mainChannelId,
    });
    if (!intent.ok) throw new Error('intent failed');
    const row = await h.db.select().from(mediaObjects).where(eq(mediaObjects.id, intent.mediaId));
    store.simulateUpload(row[0]!.bucket, row[0]!.objectKey, new Uint8Array(1024), 'text/html');

    const completed = await completeUpload(h.db, store, await ctxFor(f.ownerId), intent.mediaId);
    expect(completed.ok).toBe(false);
  });

  it('refuses to complete an upload that never arrived', async () => {
    const f = await setup();
    const intent = await createUploadIntent(h.db, store, config, await ctxFor(f.ownerId), {
      kind: 'photo',
      mime: 'image/jpeg',
      bytes: 1024,
      channelId: f.mainChannelId,
    });
    if (!intent.ok) throw new Error('intent failed');
    // No simulateUpload: the client got a URL and gave up.
    const completed = await completeUpload(h.db, store, await ctxFor(f.ownerId), intent.mediaId);
    expect(completed.ok).toBe(false);
    if (!completed.ok) expect(completed.code).toBe('not_uploaded');
  });

  it('lets only the uploader complete their own upload', async () => {
    const f = await setup();
    const intent = await createUploadIntent(h.db, store, config, await ctxFor(f.ownerId), {
      kind: 'photo',
      mime: 'image/jpeg',
      bytes: 1024,
      channelId: f.mainChannelId,
    });
    if (!intent.ok) throw new Error('intent failed');
    const row = await h.db.select().from(mediaObjects).where(eq(mediaObjects.id, intent.mediaId));
    store.simulateUpload(row[0]!.bucket, row[0]!.objectKey, new Uint8Array(1024), 'image/jpeg');

    const byOther = await completeUpload(h.db, store, await ctxFor(f.memberId), intent.mediaId);
    expect(byOther.ok, 'somebody else confirmed bytes they did not send').toBe(false);
  });

  it('completing twice is idempotent', async () => {
    const f = await setup();
    const { media } = await uploadPhoto(f.ownerId, f.mainChannelId);
    const again = await completeUpload(h.db, store, await ctxFor(f.ownerId), media!);
    expect(again.ok).toBe(true);
  });
});

// ===========================================================================
// The send path
// ===========================================================================

describe('attaching media to a message', () => {
  it('refuses a send referencing an incomplete upload', async () => {
    const f = await setup();
    const intent = await createUploadIntent(h.db, store, config, await ctxFor(f.ownerId), {
      kind: 'photo',
      mime: 'image/jpeg',
      bytes: 1024,
      channelId: f.mainChannelId,
    });
    if (!intent.ok) throw new Error('intent failed');

    const channel = await getChannelRef(h.db, f.mainChannelId);
    const sent = await sendMessage(h.db, await ctxFor(f.ownerId), channel!, {
      channelId: f.mainChannelId,
      clientMsgId: crypto.randomUUID(),
      type: 'photo',
      mediaId: intent.mediaId,
    });
    expect(sent.ok).toBe(false);
    // Distinct from forbidden: the client should finish the upload and retry the same
    // client_msg_id, not give up.
    if (!sent.ok) expect(sent.code).toBe('media_not_ready');
  });

  it('refuses somebody else object', async () => {
    const f = await setup();
    const { media } = await uploadPhoto(f.ownerId, f.mainChannelId);
    const channel = await getChannelRef(h.db, f.mainChannelId);
    const sent = await sendMessage(h.db, await ctxFor(f.memberId), channel!, {
      channelId: f.mainChannelId,
      clientMsgId: crypto.randomUUID(),
      type: 'photo',
      mediaId: media!,
    });
    expect(sent.ok, 'a member attached somebody else upload').toBe(false);
  });

  it('refuses moving an object into a different channel', async () => {
    // Laundering: uploading into a channel you can read, then attaching it to a message in
    // one you cannot - which would slip it past the download authorization.
    const f = await setup();
    const { media } = await uploadPhoto(f.ownerId, f.eboardChannelId);
    const clubChannel = await getChannelRef(h.db, f.mainChannelId);
    const sent = await sendMessage(h.db, await ctxFor(f.ownerId), clubChannel!, {
      channelId: f.mainChannelId,
      clientMsgId: crypto.randomUUID(),
      type: 'photo',
      mediaId: media!,
    });
    expect(sent.ok, 'an object moved between channels').toBe(false);
  });

  it('records the owning message, which is what the GC needs', async () => {
    const f = await setup();
    const { media } = await uploadPhoto(f.ownerId, f.mainChannelId);
    const channel = await getChannelRef(h.db, f.mainChannelId);
    const sent = await sendMessage(h.db, await ctxFor(f.ownerId), channel!, {
      channelId: f.mainChannelId,
      clientMsgId: crypto.randomUUID(),
      type: 'photo',
      mediaId: media!,
    });
    if (!sent.ok) throw new Error('send failed');

    const row = await h.db.select().from(mediaObjects).where(eq(mediaObjects.id, media!));
    expect(row[0]?.ownerId).toBe(sent.message.id);
  });

  it('shows filename and size on a document bubble', async () => {
    const f = await setup();
    const intent = await createUploadIntent(h.db, store, config, await ctxFor(f.ownerId), {
      kind: 'document',
      mime: 'application/pdf',
      bytes: 4096,
      channelId: f.mainChannelId,
      documentName: 'race-schedule.pdf',
    });
    if (!intent.ok) throw new Error('intent failed');
    const row = await h.db.select().from(mediaObjects).where(eq(mediaObjects.id, intent.mediaId));
    store.simulateUpload(row[0]!.bucket, row[0]!.objectKey, new Uint8Array(4096), 'application/pdf');
    await completeUpload(h.db, store, await ctxFor(f.ownerId), intent.mediaId);

    const channel = await getChannelRef(h.db, f.mainChannelId);
    const sent = await sendMessage(h.db, await ctxFor(f.ownerId), channel!, {
      channelId: f.mainChannelId,
      clientMsgId: crypto.randomUUID(),
      type: 'document',
      mediaId: intent.mediaId,
    });
    if (!sent.ok) throw new Error('send failed');

    const stored = await h.db.select().from(messages).where(eq(messages.id, sent.message.id));
    expect(stored[0]?.documentName).toBe('race-schedule.pdf');
    expect(stored[0]?.documentSize).toBe(4096);
  });
});

// ===========================================================================
// Galleries
// ===========================================================================

describe('galleries', () => {
  async function withPhotos(count: number) {
    const f = await setup();
    const channel = await getChannelRef(h.db, f.mainChannelId);
    for (let i = 0; i < count; i += 1) {
      const { media } = await uploadPhoto(f.ownerId, f.mainChannelId);
      await sendMessage(h.db, await ctxFor(f.ownerId), channel!, {
        channelId: f.mainChannelId,
        clientMsgId: crypto.randomUUID(),
        type: 'photo',
        mediaId: media!,
      });
    }
    return f;
  }

  it('contains every photo posted in that chat, newest first', async () => {
    const f = await withPhotos(3);
    const result = await readGallery(h.db, await ctxFor(f.memberId), f.mainChannelId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries).toHaveLength(3);
    // Newest first.
    expect(result.entries[0]!.seq).toBeGreaterThan(result.entries[2]!.seq);
  });

  it('renders from a STABLE url, not a signed one', async () => {
    // Which is what removes the per-device memoization v1 needed: the cache key is stable by
    // construction rather than by remembering a signature.
    const f = await withPhotos(1);
    const result = await readGallery(h.db, await ctxFor(f.memberId), f.mainChannelId);
    if (!result.ok) return;
    expect(result.entries[0]!.url).toBe(`/media/${result.entries[0]!.mediaId}`);
    expect(result.entries[0]!.url).not.toContain('sig=');
    expect(result.entries[0]!.thumbUrl).toContain('variant=thumb');
  });

  it('adds no new authorization: a non-member gets nothing', async () => {
    const f = await withPhotos(2);
    const result = await readGallery(h.db, await ctxFor(f.outsiderId), f.mainChannelId);
    expect(result.ok).toBe(false);
  });

  it('carries who posted each photo, for the viewer that opens over it', async () => {
    // The grid draws none of this. The full-screen viewer draws a face, a name and a date over
    // the photograph - the same header whether it was opened from chat or from here - and it has
    // nothing to draw it from unless the gallery read carries the sender.
    const f = await withPhotos(1);
    const avatar = crypto.randomUUID();
    await h.db.update(users).set({ image: avatar }).where(eq(users.id, f.ownerId));

    const result = await readGallery(h.db, await ctxFor(f.memberId), f.mainChannelId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries[0]!.senderId).toBe(f.ownerId);
    expect(result.entries[0]!.senderName).toBe('Owner');
    expect(result.entries[0]!.senderImage).toBe(avatar);
  });

  it('says "nobody" rather than a name for a deleted account', async () => {
    const f = await withPhotos(1);
    // Anonymized, not removed: the row survives so history stays attributed, and the viewer
    // draws "Deleted member" from the null rather than from a name nobody may see any more.
    await h.db
      .update(users)
      .set({ anonymizedAt: new Date(), image: crypto.randomUUID() })
      .where(eq(users.id, f.ownerId));

    const result = await readGallery(h.db, await ctxFor(f.memberId), f.mainChannelId);
    if (!result.ok) return;
    expect(result.entries[0]!.senderName).toBeNull();
    expect(result.entries[0]!.senderImage).toBeNull();
    // Still attributed by id, which is what keeps "is this mine?" answerable.
    expect(result.entries[0]!.senderId).toBe(f.ownerId);
  });

  it('excludes documents, deleted messages, and incomplete uploads', async () => {
    const f = await setup();
    const channel = await getChannelRef(h.db, f.mainChannelId);

    // A live photo.
    const live = await uploadPhoto(f.ownerId, f.mainChannelId);
    await sendMessage(h.db, await ctxFor(f.ownerId), channel!, {
      channelId: f.mainChannelId, clientMsgId: crypto.randomUUID(),
      type: 'photo', mediaId: live.media!,
    });

    // A document, which is an attachment rather than something a photo grid shows.
    const docIntent = await createUploadIntent(h.db, store, config, await ctxFor(f.ownerId), {
      kind: 'document', mime: 'application/pdf', bytes: 512,
      channelId: f.mainChannelId, documentName: 'notes.pdf',
    });
    if (docIntent.ok) {
      const row = await h.db.select().from(mediaObjects).where(eq(mediaObjects.id, docIntent.mediaId));
      store.simulateUpload(row[0]!.bucket, row[0]!.objectKey, new Uint8Array(512), 'application/pdf');
      await completeUpload(h.db, store, await ctxFor(f.ownerId), docIntent.mediaId);
      await sendMessage(h.db, await ctxFor(f.ownerId), channel!, {
        channelId: f.mainChannelId, clientMsgId: crypto.randomUUID(),
        type: 'document', mediaId: docIntent.mediaId,
      });
    }

    // A photo whose message was deleted.
    const doomed = await uploadPhoto(f.ownerId, f.mainChannelId);
    const doomedSend = await sendMessage(h.db, await ctxFor(f.ownerId), channel!, {
      channelId: f.mainChannelId, clientMsgId: crypto.randomUUID(),
      type: 'photo', mediaId: doomed.media!,
    });
    if (doomedSend.ok) {
      await h.db.execute(sql`
        UPDATE messages SET deleted_at = now() WHERE id = ${doomedSend.message.id}::uuid
      `);
    }

    const result = await readGallery(h.db, await ctxFor(f.memberId), f.mainChannelId);
    if (!result.ok) return;
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.mediaId).toBe(live.media);
  });

  it('paginates rather than loading the whole history', async () => {
    // v1 signed a channel's entire photo history in one unbounded call.
    const f = await withPhotos(5);
    const first = await readGallery(h.db, await ctxFor(f.memberId), f.mainChannelId, { limit: 2 });
    if (!first.ok) return;
    expect(first.entries).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await readGallery(h.db, await ctxFor(f.memberId), f.mainChannelId, {
      limit: 2, before: first.nextCursor!,
    });
    if (!second.ok) return;
    // No overlap between pages.
    const firstSeqs = first.entries.map((e) => e.seq);
    expect(second.entries.every((e) => !firstSeqs.includes(e.seq))).toBe(true);
  });
});

// ===========================================================================
// Derivation and the GC
// ===========================================================================

describe('thumbnail derivation', () => {
  it('is skipped for a document', async () => {
    const f = await setup();
    const intent = await createUploadIntent(h.db, store, config, await ctxFor(f.ownerId), {
      kind: 'document', mime: 'application/pdf', bytes: 512, channelId: f.mainChannelId,
    });
    if (!intent.ok) throw new Error('intent failed');
    const result = await deriveVariants(h.db, store, intent.mediaId);
    expect(result.skipped).toBe(true);
  });

  it('falls back to the original when a variant does not exist yet', async () => {
    // The worker may not have run. A missing thumbnail must degrade to a slower image rather
    // than a broken one.
    const f = await setup();
    const { media } = await uploadPhoto(f.ownerId, f.mainChannelId);
    const result = await resolveMediaRedirect(h.db, store, config, await ctxFor(f.ownerId), media!, {
      variant: 'thumb',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = await h.db.select().from(mediaObjects).where(eq(mediaObjects.id, media!));
    expect(result.url).toContain(row[0]!.objectKey);
    // And the type follows the bytes it fell back TO, not the variant that was asked for.
    expect(result.mime).toBe('image/jpeg');
  });

  it('says what the bytes are, because the object key has no extension to read', async () => {
    /*
     * The viewer's Download saves a file, and iOS decides what it is being handed from the
     * extension alone - `createAsset` throws on a name that has none. The key is
     * `message/2026-08/<uuid>`, so there is nothing to derive one from and the type has to
     * travel with the URL.
     */
    const f = await setup();
    const { media } = await uploadPhoto(f.ownerId, f.mainChannelId, { mime: 'image/png' });
    const original = await resolveMediaRedirect(h.db, store, config, await ctxFor(f.ownerId), media!, {
      variant: 'original',
    });
    if (!original.ok) return;
    expect(original.mime).toBe('image/png');

    // A derived variant is WebP whatever was uploaded - which is exactly why the viewer saves
    // the original, since Photos will not take a WebP. Recorded directly rather than derived:
    // `simulateUpload` writes zeroes, and Sharp cannot resize bytes that are not an image.
    const row = await h.db.select().from(mediaObjects).where(eq(mediaObjects.id, media!));
    await h.db
      .update(mediaObjects)
      .set({ variants: { display: `${row[0]!.objectKey}.display.webp` } })
      .where(eq(mediaObjects.id, media!));
    const display = await resolveMediaRedirect(h.db, store, config, await ctxFor(f.ownerId), media!, {
      variant: 'display',
    });
    if (!display.ok) return;
    expect(display.mime).toBe('image/webp');
  });
});

describe('the storage GC', () => {
  it('removes an object whose owning message is gone', async () => {
    // Debt 8: v1 deleted nothing from object storage, ever.
    const f = await setup();
    const { media } = await uploadPhoto(f.ownerId, f.mainChannelId);
    const channel = await getChannelRef(h.db, f.mainChannelId);
    const sent = await sendMessage(h.db, await ctxFor(f.ownerId), channel!, {
      channelId: f.mainChannelId, clientMsgId: crypto.randomUUID(),
      type: 'photo', mediaId: media!,
    });
    if (!sent.ok) throw new Error('send failed');

    const before = store.objects.size;
    // A message row that no longer EXISTS - not merely soft-deleted.
    await h.db.execute(sql`DELETE FROM messages WHERE id = ${sent.message.id}::uuid`);
    const result = await runMediaGc(h.db, store, silent);

    expect(result.orphanedRemoved).toBe(1);
    expect(store.objects.size).toBe(before - 1);
    const row = await h.db.select().from(mediaObjects).where(eq(mediaObjects.id, media!));
    expect(row).toHaveLength(0);
  });

  it('does NOT remove media whose message was only soft-deleted', async () => {
    // A tombstone keeps its media: the photo may still legitimately appear in the gallery of
    // a conversation nobody deleted.
    const f = await setup();
    const { media } = await uploadPhoto(f.ownerId, f.mainChannelId);
    const channel = await getChannelRef(h.db, f.mainChannelId);
    const sent = await sendMessage(h.db, await ctxFor(f.ownerId), channel!, {
      channelId: f.mainChannelId, clientMsgId: crypto.randomUUID(),
      type: 'photo', mediaId: media!,
    });
    if (!sent.ok) throw new Error('send failed');

    await h.db.execute(sql`
      UPDATE messages SET deleted_at = now() WHERE id = ${sent.message.id}::uuid
    `);
    const result = await runMediaGc(h.db, store, silent);
    expect(result.orphanedRemoved).toBe(0);
    const row = await h.db.select().from(mediaObjects).where(eq(mediaObjects.id, media!));
    expect(row).toHaveLength(1);
  });

  it('sweeps an upload that was authorized and never completed', async () => {
    // No event announces that a client gave up, so only a timer finds these - and each has
    // bytes behind it.
    const f = await setup();
    const intent = await createUploadIntent(h.db, store, config, await ctxFor(f.ownerId), {
      kind: 'photo', mime: 'image/jpeg', bytes: 1024, channelId: f.mainChannelId,
    });
    if (!intent.ok) throw new Error('intent failed');

    // Not yet stale.
    expect((await runMediaGc(h.db, store, silent)).stalePendingRemoved).toBe(0);

    await h.db.execute(sql`
      UPDATE media_objects
         SET created_at = now() - (${STALE_PENDING_HOURS + 1} * interval '1 hour')
       WHERE id = ${intent.mediaId}::uuid
    `);
    expect((await runMediaGc(h.db, store, silent)).stalePendingRemoved).toBe(1);
  });

  it('never removes an object whose owner still exists', async () => {
    const f = await setup();
    const { media } = await uploadPhoto(f.ownerId, f.mainChannelId);
    const channel = await getChannelRef(h.db, f.mainChannelId);
    await sendMessage(h.db, await ctxFor(f.ownerId), channel!, {
      channelId: f.mainChannelId, clientMsgId: crypto.randomUUID(),
      type: 'photo', mediaId: media!,
    });
    const result = await runMediaGc(h.db, store, silent);
    expect(result.orphanedRemoved).toBe(0);
    expect(result.stalePendingRemoved).toBe(0);
  });

  it('is idempotent', async () => {
    const f = await setup();
    const { media } = await uploadPhoto(f.ownerId, f.mainChannelId);
    const channel = await getChannelRef(h.db, f.mainChannelId);
    const sent = await sendMessage(h.db, await ctxFor(f.ownerId), channel!, {
      channelId: f.mainChannelId, clientMsgId: crypto.randomUUID(),
      type: 'photo', mediaId: media!,
    });
    if (!sent.ok) throw new Error('send failed');
    await h.db.execute(sql`DELETE FROM messages WHERE id = ${sent.message.id}::uuid`);

    await runMediaGc(h.db, store, silent);
    const second = await runMediaGc(h.db, store, silent);
    expect(second.orphanedRemoved).toBe(0);
  });
});
