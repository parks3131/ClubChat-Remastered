/**
 * Thumbnail derivation, and the nightly storage GC.
 *
 * Both are worker jobs. Derivation is event-driven off `media.uploaded`; the GC is
 * timer-driven because there is no data change to hang it on - an object nobody ever finished
 * uploading generates no event announcing that fact.
 */

import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { mediaObjects } from '../db/schema.ts';
import { DECODE_OPTIONS } from './probe.ts';
import type { MediaStore } from './store.ts';

/**
 * The three derived sizes.
 *
 * `display` is what the full-screen photo viewer renders, `bubble` is what a photo in a
 * conversation renders, and `thumb` is what a gallery grid renders. v1 served full-resolution
 * originals to all of them, which is roadmap debt: a phone camera photo is several megabytes and
 * a grid of forty of them is a hundred megabytes of transfer to draw postage stamps.
 *
 * **`bubble` exists because `display` is about five times bigger than a chat bubble can show.**
 * `apps/mobile/src/photo-size.ts` draws a photo in a conversation at most 240pt wide and 320pt
 * tall, so the most a bubble can ever use on a 3x screen is 720x960 device pixels. Chat asks for
 * `display`, and a 1600x2105 image costs roughly 13MB of memory once decoded against roughly
 * 3.4MB at 800 - which is why iOS evicts these between visits and fetches them again. The client
 * still asks for `display` as of 2026-08-27: this half derives and serves the smaller size, and
 * `apps/mobile` asking for it is a separate change.
 *
 * 800 rather than the 720 strictly needed, because a width is baked into stored objects
 * and re-deriving is a decision with a cost: the headroom covers a wider bubble later without a
 * second backfill. `thumb` at 400 cannot serve the slot instead; it is visibly soft at 720.
 *
 * **`display` stays at 1600 and must.** It is the full-screen viewer's size, and the viewer is
 * the surface where the extra pixels are the point rather than waste.
 */
export const VARIANTS = {
  thumb: 400,
  bubble: 800,
  display: 1600,
} as const;

/** A size the worker derives and stores as an object of its own. */
export type DerivedVariant = keyof typeof VARIANTS;

/**
 * What a caller may ask `GET /media/:id`, `/media/:id/url` and `/media/urls` for.
 *
 * `original` is not derived: it is the bytes the member uploaded. The photo viewer's
 * save-to-Photos is its one caller, because a derived variant is WebP and Photos will not take
 * one - see `apps/mobile/src/photo-viewer.tsx`.
 */
export type RequestedVariant = 'original' | DerivedVariant;

/**
 * What to serve when the variant asked for was never derived, in order of preference.
 *
 * **Derivation happens once, at upload, so every photo already stored predates every variant
 * added after it.** That is not the "the worker has not run yet" case, which lasts seconds - it
 * is permanent until somebody backfills, and it covers every row in the database on the day a
 * size is added. A request for one of those must not fail and must not hand back a URL for an
 * object that is not there: the CDN would refuse a key it has no bytes for, and the member would
 * see a broken picture rather than a heavy one.
 *
 * So every chain ends by falling through to the original, which always exists, and `bubble`
 * prefers `display` on the way there for the same reason `bubble` exists at all. An original is
 * a multi-megabyte camera file; a 1600px WebP is merely larger than it needs to be. A photo
 * uploaded before `bubble` existed therefore degrades to exactly what it rendered as the day
 * before, rather than to something worse.
 *
 * **This table is the vocabulary, not a copy of it.** `REQUESTABLE_VARIANTS` below is its keys,
 * so a size added to `VARIANTS` without an entry here is a type error rather than a variant that
 * quietly cannot be asked for.
 */
export const VARIANT_FALLBACKS: Record<RequestedVariant, readonly DerivedVariant[]> = {
  original: [],
  thumb: ['thumb'],
  bubble: ['bubble', 'display'],
  display: ['display'],
};

/**
 * The same list as a value, for the route's query validator.
 *
 * Derived from the table above rather than written out a second time. `Object.keys` answers
 * `string[]`, so the assertion is what carries the literal types across - and it is safe in the
 * one direction that matters, because `Record<RequestedVariant, ...>` already refuses both a
 * missing key and an unknown one.
 */
export const REQUESTABLE_VARIANTS = Object.keys(VARIANT_FALLBACKS) as [
  RequestedVariant,
  ...RequestedVariant[],
];

/**
 * Which stored object a request for `requested` should actually read.
 *
 * Lives here beside the table rather than at the call site in `media/pipeline.ts`, so the read
 * side and the write side of the variant vocabulary cannot drift apart - the single most reliable
 * way to end up signing a URL for bytes nobody ever wrote.
 */
export function variantObjectKey(
  media: { objectKey: string; variants: unknown },
  requested: RequestedVariant,
): string {
  const variants = (media.variants ?? {}) as Record<string, string>;
  for (const candidate of VARIANT_FALLBACKS[requested]) {
    const key = variants[candidate];
    if (key) return key;
  }
  return media.objectKey;
}

export type DeriveResult = {
  derived: string[];
  skipped: boolean;
  /**
   * The bytes do not decode, and no number of retries will change that.
   *
   * Reported rather than thrown, and that distinction is the point: see the comment on the
   * catch below.
   */
  undecodable: boolean;
};

/**
 * Derive thumbnails for an uploaded image.
 *
 * Idempotent: an object that already has its variants is skipped, so redelivery costs a read
 * rather than re-encoding. Documents are skipped entirely - there is nothing to resize.
 *
 * `sharp` is imported lazily, and it is worth being accurate about what that buys. It carries
 * native binaries and mapping libvips is not free - but `media/pipeline.ts` imports sharp at
 * module scope and `api/routes/media.ts` imports pipeline, so **the api maps libvips at boot
 * regardless of this line.** The role the laziness genuinely spares is the **gateway**, which
 * reaches no media module and so never loads sharp at all. For this process, the worker, it only
 * defers the cost to the first derivation rather than avoiding it, which for the process whose
 * job is deriving is the first photo anybody uploads.
 */
export async function deriveVariants(
  db: Db,
  store: MediaStore,
  mediaId: string,
): Promise<DeriveResult> {
  const rows = await db.select().from(mediaObjects).where(eq(mediaObjects.id, mediaId)).limit(1);
  const media = rows[0];
  if (!media) return { derived: [], skipped: true, undecodable: false };
  if (!media.mime.startsWith('image/')) return { derived: [], skipped: true, undecodable: false };

  /*
   * Skipped only when EVERY variant is present, asked of `VARIANTS` rather than of two names
   * written out here.
   *
   * That is what makes adding a size a backfill rather than a migration: a row derived by an
   * older worker is missing exactly the new key, so it stops being skipped, the loop below
   * derives the one it lacks, and the two it already has cost nothing. The version this replaces
   * named `thumb` and `display` literally, so a third size would have been skipped on every row
   * ever stored and the backfill would have reported success having done nothing.
   */
  const existing = (media.variants ?? {}) as Record<string, string>;
  if (Object.keys(VARIANTS).every((name) => existing[name])) {
    return { derived: [], skipped: true, undecodable: false };
  }
  // Already known not to decode. The object key is immutable, so the bytes behind it cannot
  // have improved since - redelivery should cost nothing rather than another fetch and another
  // doomed decode.
  if (media.deriveError !== null) return { derived: [], skipped: true, undecodable: true };

  const original = await store.get({ bucket: media.bucket, objectKey: media.objectKey });
  const sharp = (await import('sharp')).default;

  const variants: Record<string, string> = { ...existing };
  const derived: string[] = [];

  for (const [name, width] of Object.entries(VARIANTS)) {
    if (variants[name]) continue;

    let resized: Buffer;
    try {
      resized = await sharp(original, DECODE_OPTIONS)
        /*
         * **Apply the camera's orientation before anything else, or the photo ships sideways.**
         *
         * A phone writes a portrait photograph as landscape pixels plus an EXIF tag saying to
         * turn it. Sharp does not honour that tag unless asked, and the WebP written below
         * carries no metadata - so the tag was being dropped and the pixels left in sensor
         * order, permanently. Measured: a 400x300 original tagged orientation 6 derived as
         * 200x150 with no orientation at all, where it should be 200x267.
         *
         * Before `resize`, because `width` means the width of the picture as somebody sees it.
         * Rotating afterwards would size the wrong edge.
         */
        .rotate()
        // `withoutEnlargement` so a small original is not upscaled into a larger file than it
        // started as, which would make the "thumbnail" bigger than the photo.
        .resize({ width, withoutEnlargement: true })
        // 70 for a `thumb`, which is a postage stamp in a grid, and 82 for anything drawn at
        // something like its real size. `bubble` is drawn at its real size, so it takes 82 with
        // `display` rather than the grid's number.
        .webp({ quality: name === 'thumb' ? 70 : 82 })
        .toBuffer();
    } catch (error) {
      /*
       * **Recorded and returned, never thrown.**
       *
       * Throwing here is what parked outbox row 49 for four days. The retry-and-park path is
       * built for a transient fault, and it is right for one - but bytes that do not decode
       * are a permanent fact, so the whole budget produces identical failures and then an
       * alarm that can never clear. `retention.ts` deliberately never prunes a parked row, so
       * every corrupt upload would pin `parked > 0` on for the life of the database and drown
       * the signal it exists to carry: that an effect never ran.
       *
       * A corrupt upload is not that. It is bad input, it is user-reachable, and the honest
       * response is to record the fact on the object and let the event complete.
       *
       * Deliberately scoped to the decode alone. `store.put` below is outside it, because a
       * storage write that fails IS transient and must keep its retries.
       */
      const reason = error instanceof Error ? error.message : String(error);
      await db.update(mediaObjects).set({ deriveError: reason }).where(eq(mediaObjects.id, mediaId));
      return { derived, skipped: false, undecodable: true };
    }

    const key = `${media.objectKey}.${name}.webp`;
    await store.put({
      bucket: media.bucket,
      objectKey: key,
      body: new Uint8Array(resized),
      mime: 'image/webp',
    });
    variants[name] = key;
    derived.push(name);
  }

  await db
    .update(mediaObjects)
    .set({ variants, deriveError: null })
    .where(eq(mediaObjects.id, mediaId));
  return { derived, skipped: false, undecodable: false };
}

// ---------------------------------------------------------------------------
// The nightly GC
// ---------------------------------------------------------------------------

/** How long an incomplete upload is given before it is considered abandoned. */
export const STALE_PENDING_HOURS = 24;

export type GcResult = {
  orphanedRemoved: number;
  stalePendingRemoved: number;
};

/**
 * Remove objects nothing points at any more.
 *
 * Roadmap debt 8: **v1 deleted nothing from object storage, ever.** Deleting a message, post,
 * club, race or account left the bytes behind indefinitely.
 *
 * Two categories, and the second is easy to forget:
 *
 *  1. **Orphaned** - the owning row is gone. Cascades take the database rows; only this takes
 *     the bytes.
 *  2. **Stale pending** - an upload that was authorized and never completed. There is no event
 *     announcing that a client gave up, so these accumulate silently, each with bytes behind
 *     it, and only a timer finds them.
 *
 * Idempotent, and deliberately conservative: it never removes an object whose owner still
 * exists, and it removes storage bytes BEFORE the row, so a crash in between leaves a row
 * pointing at nothing (harmless, retried) rather than bytes nothing points at (invisible).
 */
export async function runMediaGc(
  db: Db,
  store: MediaStore,
  log: (message: string, extra?: unknown) => void,
): Promise<GcResult> {
  const result: GcResult = { orphanedRemoved: 0, stalePendingRemoved: 0 };

  // --- 1. Ready objects whose owning message is gone ---
  //
  // A soft-deleted message keeps its media: the tombstone stays in history and the photo may
  // still legitimately appear in the gallery of a conversation nobody deleted. Only a message
  // row that no longer EXISTS orphans its object.
  const orphaned = await db.execute<{ id: string; bucket: string; object_key: string }>(sql`
    SELECT mo.id, mo.bucket, mo.object_key
      FROM media_objects mo
     WHERE mo.status = 'ready'
       AND mo.owner_type = 'message'
       AND mo.owner_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = mo.owner_id)
     LIMIT 500
  `);

  for (const row of orphaned.rows) {
    await removeObjectAndVariants(db, store, row.id, row.bucket, row.object_key);
    result.orphanedRemoved += 1;
  }

  // --- 2. Uploads that were authorized and never completed ---
  const stale = await db.execute<{ id: string; bucket: string; object_key: string }>(sql`
    SELECT id, bucket, object_key
      FROM media_objects
     WHERE status = 'pending'
       AND created_at < now() - (${STALE_PENDING_HOURS} * interval '1 hour')
     LIMIT 500
  `);

  for (const row of stale.rows) {
    await removeObjectAndVariants(db, store, row.id, row.bucket, row.object_key);
    result.stalePendingRemoved += 1;
  }

  if (result.orphanedRemoved > 0 || result.stalePendingRemoved > 0) {
    log('media gc removed objects', result);
  }
  return result;
}

/**
 * Remove an object, its derived variants, and then its row.
 *
 * Bytes first, row last. A crash in between leaves a database row pointing at storage that is
 * already gone, which the next pass cleans up harmlessly - whereas the other order leaves bytes
 * with no row referencing them, which nothing will ever find again.
 */
async function removeObjectAndVariants(
  db: Db,
  store: MediaStore,
  mediaId: string,
  bucket: string,
  objectKey: string,
): Promise<void> {
  const rows = await db
    .select({ variants: mediaObjects.variants })
    .from(mediaObjects)
    .where(eq(mediaObjects.id, mediaId))
    .limit(1);
  const variants = (rows[0]?.variants ?? {}) as Record<string, string>;

  for (const key of [objectKey, ...Object.values(variants)]) {
    // Tolerated: an already-absent object means a previous pass got this far and crashed.
    await store.remove({ bucket, objectKey: key }).catch(() => undefined);
  }

  await db.delete(mediaObjects).where(eq(mediaObjects.id, mediaId));
}
