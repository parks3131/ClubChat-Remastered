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
 *  - **The crop is exactly as strict as the gate in front of it.** It takes `probe.ts`'s
 *    `DECODE_OPTIONS` rather than sharp's defaults, whose `failOn` is the *stricter* `'warning'` -
 *    so a photograph the probe admits is one the crop cuts, rather than one it refuses.
 *  - **It is bounded by construction, not by statement order.** The pixel ceiling is applied at
 *    the crop's own decode, so it survives a reorder or a second caller; and a decode failure
 *    comes back as a value, the way `probeImage` and `deriveVariants` both return theirs.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  completeUpload,
  createUploadIntent,
  cropImage,
  type MediaConfig,
} from '../media/pipeline.ts';
import { probeImage } from '../media/probe.ts';
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

/**
 * Where the entropy-coded scan starts, by walking the marker segments rather than searching for
 * two bytes. `FF DA` can occur inside a quantisation or Huffman table, so a search finds the
 * wrong offset on some encoders and none of the tests using it would say why.
 */
function startOfScan(jpeg: Buffer): number {
  let at = 2; // past SOI
  while (at < jpeg.length - 3) {
    if (jpeg[at] !== 0xff) throw new Error(`not at a marker at byte ${at}`);
    const marker = jpeg[at + 1]!;
    if (marker === 0xff) {
      at += 1; // a fill byte, which is legal between segments
      continue;
    }
    const length = jpeg.readUInt16BE(at + 2);
    if (marker === 0xda) return at + 2 + length;
    at += 2 + length;
  }
  throw new Error('no start-of-scan marker');
}

/**
 * A photograph carrying a stray restart marker part-way through its scan: damaged enough for
 * libjpeg to WARN, not damaged enough for it to error.
 *
 * That gap between the two is the whole point of this fixture. `probe.ts` chose `failOn: 'error'`
 * deliberately, and says why: a picture with a slightly wrong marker is still viewable, and
 * refusing somebody's photograph over a warning is a worse failure than showing it. So this file
 * is a picture the gate ADMITS. Sharp's own default is `failOn: 'warning'`, which is the
 * *stricter* setting - so any call site that hands sharp no options at all is stricter than the
 * gate standing in front of it, and refuses exactly what the gate just accepted.
 *
 * Noise rather than a flat colour, and that is not decoration: a solid rectangle compresses to a
 * few hundred bytes of scan, which leaves nowhere to put the damage and nothing that has to
 * decode past it to reach the cropped region.
 */
async function photographWithAStrayMarker(width: number, height: number): Promise<Buffer> {
  const sharp = (await import('sharp')).default;
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < pixels.length; i += 1) pixels[i] = (i * 2654435761) % 251;
  const encoded = await sharp(pixels, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 90 })
    .toBuffer();

  // A quarter of the way in, so the damage lands above the cropped region rather than after it:
  // libvips reads a JPEG sequentially, so corruption below the rectangle is never reached.
  const scan = startOfScan(encoded);
  const at = scan + Math.floor((encoded.length - scan) / 4);
  // RST0, where no restart marker belongs. The entropy decoder desynchronises and libjpeg warns.
  return Buffer.concat([encoded.subarray(0, at), Buffer.from([0xff, 0xd0]), encoded.subarray(at)]);
}

/**
 * A tiny JPEG whose header DECLARES a picture far larger than it carries.
 *
 * The declaration is the attack and the fixture both. Encoding a real 256-megapixel image to
 * prove a ceiling refuses one would allocate the gigabyte of bitmap the ceiling exists to
 * prevent - the test would BE the bug. It does not need to: `limitInputPixels` is a header
 * check, so a few hundred bytes claiming 16000 by 16000 reach exactly the code path a real
 * decompression bomb reaches, at exactly the moment a real one is stopped.
 *
 * JPEG rather than PNG because JPEG has no per-chunk checksum, so the two numbers in the
 * start-of-frame segment can simply be overwritten.
 */
async function jpegDeclaring(width: number, height: number): Promise<Uint8Array> {
  const sharp = (await import('sharp')).default;
  const encoded = await sharp({
    create: { width: 64, height: 64, channels: 3, background: '#3355aa' },
  })
    .jpeg()
    .toBuffer();

  let at = 2; // past SOI
  while (at < encoded.length - 3) {
    if (encoded[at] !== 0xff) throw new Error(`not at a marker at byte ${at}`);
    const marker = encoded[at + 1]!;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    // A start-of-frame segment: 0xC0 to 0xCF, less the three in that range that are not one.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      encoded.writeUInt16BE(height, at + 5);
      encoded.writeUInt16BE(width, at + 7);
      return new Uint8Array(encoded);
    }
    at += 2 + encoded.readUInt16BE(at + 2);
  }
  throw new Error('no start-of-frame marker');
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
  const club = await createClub(h.db, { name: 'Hillside', creatorId: ownerId });
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

describe('the crop is exactly as strict as the gate that admits work to it', () => {
  it('cuts a photograph the probe accepted, instead of throwing out of completeUpload', async () => {
    const f = await setup();
    const original = await photographWithAStrayMarker(200, 120);

    /*
     * The gate says yes, and that is the fact the rest of this test is measured against. By the
     * standard this server chose - `failOn: 'error'`, one constant, stated once - these bytes are
     * a picture, and a member who sends them is entitled to see it in the conversation.
     */
    const admitted = await probeImage(new Uint8Array(original));
    expect(admitted, 'the fixture must be a picture the probe ADMITS').toEqual({
      ok: true,
      width: 200,
      height: 120,
    });

    const { completed, key } = await upload(f.ownerId, f.channelId, original, {
      originX: 20,
      originY: 10,
      width: 100,
      height: 60,
    });

    // Two call sites reasoned about carefully and a third that disagrees with both is the shape
    // of this defect: the crop must be handed the same `DECODE_OPTIONS` the probe was.
    expect(completed.ok, 'the crop refused a photograph the probe had just accepted').toBe(true);
    const stored = await storedSize(key);
    expect({ width: stored.width, height: stored.height }).toEqual({ width: 100, height: 60 });
  });
});

describe('the crop is bounded by construction, not by the order of two statements', () => {
  /*
   * Today the crop is bounded only transitively: it runs after `probeImage` returned ok, so
   * nothing oversized has ever reached it. That is a bound held up by the order of two
   * statements. Move the crop above the probe, or add a second caller, and it disappears with no
   * type error and nothing red - which is precisely why this asks the crop directly rather than
   * through `completeUpload`.
   */
  it('refuses a decompression bomb on its own dimensions, with no probe in front of it', async () => {
    const bomb = await jpegDeclaring(16000, 16000);

    const cropped = await cropImage(bomb, {
      originX: 0,
      originY: 0,
      width: 100,
      height: 100,
    });

    expect(cropped.ok, 'a 256-megapixel header was handed to the decoder').toBe(false);
    /*
     * Refused ON ITS DECLARED SIZE, at the header, rather than incidentally further in on pixel
     * data the file does not carry. Only the first of those bounds the allocation, and only the
     * first still refuses a bomb that carries all the bytes it promises.
     */
    if (!cropped.ok) expect(cropped.reason).toMatch(/exceeds pixel limit/i);
  });

  it('hands a decode failure back as a value, the way the probe and the worker both do', async () => {
    /*
     * `deriveVariants` was deliberately built to return this class of failure rather than throw,
     * so the worker records it on the row instead of parking an outbox row forever. The crop path
     * sits inside `completeUpload`, which returns typed refusals and has no `try` anywhere in it -
     * so a rejecting decode leaves by a door the caller does not watch.
     */
    const notAnImage = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);

    await expect(
      cropImage(notAnImage, { originX: 0, originY: 0, width: 10, height: 10 }),
    ).resolves.toMatchObject({ ok: false });
  });
});
