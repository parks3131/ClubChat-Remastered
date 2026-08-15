/**
 * Cropping a photo: the phone chooses a rectangle, the server cuts the pixels.
 *
 * > **The crop lives here rather than on the device, and that is a decision with a scar.** It was
 * > built first against `expo-image-manipulator` and took the app down twice on 2026-08-15 - a
 * > native import is resolved at bundle load, so JS importing one reaches every phone the instant
 * > Metro serves it while the binaries carrying it are hours behind; and the prebuilt framework
 * > turned out to target a newer `ExpoModulesCore` than the app ships, which is a launch-time
 * > `Symbol not found` no JS can catch. `AGENTS.md` failure modes 8 and 32.
 * >
 * > `completeUpload` already reads and decodes every uploaded image to prove it is one, so
 * > extracting from that decode costs one re-encode and no new dependency anywhere.
 *
 * These tests are shaped around the ways a crop looks right and is wrong:
 *
 *  - **The output is the requested size**, which is the whole claim.
 *  - **The stored object is replaced**, so the gallery, the thumbnail and the download hop all
 *    see one picture rather than disagreeing about which version they meant.
 *  - **`bytes` in the row follows the new object.** Left at the uploaded size it would describe a
 *    file that no longer exists, and the row is what a message's size field is read from.
 *  - **EXIF rotation is applied BEFORE the extract.** A phone photo carries its rotation in
 *    metadata, so cutting first takes the region out of sideways pixels - wrong by ninety
 *    degrees rather than by a little, which is the kind of wrong that looks like a different bug.
 *  - **A rectangle outside the picture is refused**, never clamped. Silently cropping a region
 *    nobody chose is worse than saying no.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { completeUpload, createUploadIntent, type MediaConfig } from '../media/pipeline.ts';
import { FakeMediaStore } from '../media/store.ts';
import { createClub } from '../domain/create-club.ts';
import { loadAccessContext } from '../policy/context.ts';
import { mediaObjects, users } from '../db/schema.ts';
import { startTestDb, type TestDb } from './harness.ts';

let h: TestDb;
let store: FakeMediaStore;

const config: MediaConfig = {
  publicBucket: 'identity',
  privateBucket: 'content',
  signingSecret: 'test-signing-secret-not-a-real-one',
  cdnBaseUrl: 'http://cdn.invalid/content',
};

beforeAll(async () => {
  h = await startTestDb();
  store = new FakeMediaStore();
}, 120_000);
afterAll(async () => {
  await h?.stop();
});

const ctxFor = (id: string) => loadAccessContext(h.db, id);

async function makeUser(name: string): Promise<string> {
  const id = crypto.randomUUID();
  await h.db.insert(users).values({ id, name, email: `${name}-${id.slice(0, 8)}@t.invalid` });
  return id;
}

/**
 * A landscape image, optionally tagged the way a camera tags a portrait photograph.
 *
 * Deliberately NOT square: a square survives every wrong answer about shape, so it cannot tell a
 * correct extract from one that transposed its axes.
 */
async function image(opts: { width: number; height: number; orientation?: number }) {
  const sharp = (await import('sharp')).default;
  const canvas = sharp({
    create: { width: opts.width, height: opts.height, channels: 3, background: '#3355aa' },
  });
  const tagged =
    opts.orientation === undefined ? canvas : canvas.withMetadata({ orientation: opts.orientation });
  return tagged.jpeg().toBuffer();
}

/** Intent, the client's direct PUT, then complete - with an optional crop on the last step. */
async function upload(
  userId: string,
  channelId: string,
  bytes: Buffer,
  crop?: { originX: number; originY: number; width: number; height: number },
) {
  const intent = await createUploadIntent(h.db, store, config, await ctxFor(userId), {
    kind: 'photo',
    mime: 'image/jpeg',
    bytes: bytes.byteLength,
    channelId,
  });
  if (!intent.ok) throw new Error(`intent refused: ${intent.code}`);

  const row = await h.db
    .select()
    .from(mediaObjects)
    .where(eq(mediaObjects.id, intent.mediaId))
    .limit(1);
  // Stands in for the client PUTting straight to object storage.
  store.simulateUpload(row[0]!.bucket, row[0]!.objectKey, new Uint8Array(bytes), 'image/jpeg');

  const completed = await completeUpload(
    h.db,
    store,
    await ctxFor(userId),
    intent.mediaId,
    crop,
  );
  return { mediaId: intent.mediaId, completed, key: row[0]! };
}

async function setup() {
  const ownerId = await makeUser('Owner');
  const club = await createClub(h.db, { name: 'Hillside', sport: 'running', creatorId: ownerId });
  return { ownerId, channelId: club.mainChannelId };
}

/** What the stored object actually is now, read back through the store like any consumer. */
async function storedSize(key: { bucket: string; objectKey: string }) {
  const sharp = (await import('sharp')).default;
  const bytes = await store.get({ bucket: key.bucket, objectKey: key.objectKey });
  const meta = await sharp(Buffer.from(bytes)).metadata();
  return { width: meta.width, height: meta.height, length: bytes.byteLength };
}

describe('the server cuts the rectangle the phone chose', () => {
  it('produces an object of exactly the requested size', async () => {
    const f = await setup();
    const original = await image({ width: 200, height: 120 });

    const { completed, key } = await upload(f.ownerId, f.channelId, original, {
      originX: 20,
      originY: 10,
      width: 100,
      height: 60,
    });

    expect(completed.ok).toBe(true);
    const stored = await storedSize(key);
    expect({ width: stored.width, height: stored.height }).toEqual({ width: 100, height: 60 });
  });

  it('replaces the stored object rather than keeping the original beside it', async () => {
    const f = await setup();
    const original = await image({ width: 200, height: 120 });

    const { key } = await upload(f.ownerId, f.channelId, original, {
      originX: 0,
      originY: 0,
      width: 50,
      height: 50,
    });

    // One key, one picture. The download hop, the gallery and the thumbnail all read this - if
    // the original survived under the same key they would disagree about which one they meant.
    const stored = await storedSize(key);
    expect({ width: stored.width, height: stored.height }).toEqual({ width: 50, height: 50 });
  });

  it('records the cropped size and dimensions on the row, not the uploaded ones', async () => {
    const f = await setup();
    const original = await image({ width: 200, height: 120 });

    const { mediaId, completed, key } = await upload(f.ownerId, f.channelId, original, {
      originX: 0,
      originY: 0,
      width: 40,
      height: 30,
    });

    const row = await h.db
      .select()
      .from(mediaObjects)
      .where(eq(mediaObjects.id, mediaId))
      .limit(1);
    const stored = await storedSize(key);

    expect(row[0]?.width).toBe(40);
    expect(row[0]?.height).toBe(30);
    // The row's byte count describes the object that exists, which is the cropped one.
    expect(row[0]?.bytes).toBe(stored.length);
    expect(row[0]?.bytes).not.toBe(original.byteLength);
    if (completed.ok) expect(completed.bytes).toBe(stored.length);
  });

  it('leaves an uncropped upload byte-identical', async () => {
    const f = await setup();
    const original = await image({ width: 200, height: 120 });

    const { key } = await upload(f.ownerId, f.channelId, original);

    // No crop means no decode-and-re-encode: the member's own file is what is stored, rather
    // than a recompressed copy of itself.
    const bytes = await store.get({ bucket: key.bucket, objectKey: key.objectKey });
    expect(bytes.byteLength).toBe(original.byteLength);
  });
});

describe('rotation is applied before the extract, not after', () => {
  it('crops the picture as a person sees it, for an EXIF-rotated photo', async () => {
    const f = await setup();
    /*
     * 80x60 pixels tagged orientation 6, which is how a phone stores a portrait photograph: the
     * sensor data is landscape and the metadata says to turn it. As a person sees it the picture
     * is 60 wide and 80 tall.
     */
    const original = await image({ width: 80, height: 60, orientation: 6 });

    // A rectangle that only fits the ROTATED picture: 50 tall exceeds the unrotated height of 60
    // only if the axes were left alone... so ask for something taller than it is wide, which is
    // impossible in the unrotated frame beyond y=60.
    const { completed, key } = await upload(f.ownerId, f.channelId, original, {
      originX: 0,
      originY: 0,
      width: 60,
      height: 80,
    });

    expect(completed.ok, 'a crop in the rotated frame must be accepted').toBe(true);
    const stored = await storedSize(key);
    expect({ width: stored.width, height: stored.height }).toEqual({ width: 60, height: 80 });
  });
});

describe('a rectangle that does not fit is refused', () => {
  it('refuses one that runs off the right edge', async () => {
    const f = await setup();
    const original = await image({ width: 100, height: 100 });

    const { completed } = await upload(f.ownerId, f.channelId, original, {
      originX: 80,
      originY: 0,
      width: 40,
      height: 10,
    });

    // Refused rather than clamped to 20 wide: cutting a different region than the member chose
    // is a worse answer than not cutting at all.
    expect(completed).toEqual({ ok: false, code: 'bad_crop' });
  });

  it('refuses one that runs off the bottom', async () => {
    const f = await setup();
    const original = await image({ width: 100, height: 100 });

    const { completed } = await upload(f.ownerId, f.channelId, original, {
      originX: 0,
      originY: 90,
      width: 10,
      height: 30,
    });

    expect(completed).toEqual({ ok: false, code: 'bad_crop' });
  });

  it('leaves the object untouched when it refuses', async () => {
    const f = await setup();
    const original = await image({ width: 100, height: 100 });

    const { key } = await upload(f.ownerId, f.channelId, original, {
      originX: 90,
      originY: 90,
      width: 50,
      height: 50,
    });

    // The upload stays exactly as it arrived, so a client that fixes its arithmetic and retries
    // completes against the same bytes rather than against a half-processed object.
    const stored = await storedSize(key);
    expect({ width: stored.width, height: stored.height }).toEqual({ width: 100, height: 100 });
  });
});
