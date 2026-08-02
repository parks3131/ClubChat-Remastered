/**
 * The media pipeline: intent, verification, and the signed-URL scheme.
 *
 * The download half is the interesting part, and it exists to fix a specific measured failure
 * recorded as roadmap debt 7:
 *
 * > A signed URL minted per fetch changes its query string every time, and the query string is
 * > part of every cache key - so every layer misses, and N viewers means N origin downloads.
 *
 * The fix is to make the URL **byte-identical for every viewer in a time window**, by aligning
 * the signature's expiry to the top of the hour instead of to "now plus an hour". One CDN cache
 * entry then serves all 300 members of a club rather than 300 origin fetches.
 *
 * Authorization does not move to the CDN. It happens at the `/media/:id` hop, on **every**
 * request, using the same membership predicate that protects the message the object is attached
 * to - so a private Eboard photo is never reachable by a guessable URL.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { mediaObjects, outbox } from '../db/schema.ts';
import type { AccessContext } from '../policy/context.ts';
import { canPostInChannel, isChannelMember, type ChannelRef } from '../policy/predicates.ts';
import { getChannelRef } from '../domain/reads.ts';
import {
  DOCUMENT_MIME_ALLOWLIST,
  IMAGE_MIME_ALLOWLIST,
  MAX_DOCUMENT_BYTES,
  MAX_IMAGE_BYTES,
  type MediaStore,
} from './store.ts';

export type Refusal = {
  ok: false;
  code: 'forbidden' | 'not_found' | 'mime_not_allowed' | 'too_large' | 'not_uploaded' | 'mismatch';
};
export type Result<T> = ({ ok: true } & T) | Refusal;

export type MediaConfig = {
  publicBucket: string;
  privateBucket: string;
  signingSecret: string;
  cdnBaseUrl: string;
  /** See `MEDIA_URL_MODE` in config. Defaults to the production shape. */
  urlMode?: 'cdn' | 'presign';
};

export type MediaKind = 'photo' | 'document' | 'avatar';

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/**
 * Issue an upload intent.
 *
 * Three things happen before a URL is handed out, and all three were absent in v1:
 *
 *  1. **The scope is authorized with the same predicate that protects the messages.** An
 *     upload aimed at a channel you cannot post in is refused here, not discovered later.
 *  2. **The MIME type is checked against an allowlist.**
 *  3. **The declared size is checked against a cap.**
 *
 * The row is created `pending`. It becomes `ready` only at `completeUpload`, which re-verifies
 * both size and type against what actually arrived - a presigned URL cannot police bytes the
 * client chose to send anyway.
 */
export async function createUploadIntent(
  db: Db,
  store: MediaStore,
  config: MediaConfig,
  ctx: AccessContext,
  input: {
    kind: MediaKind;
    mime: string;
    bytes: number;
    /** Required for photo and document: the channel whose access rules govern the object. */
    channelId?: string | undefined;
    documentName?: string | undefined;
  },
): Promise<
  Result<{
    mediaId: string;
    uploadUrl: string;
    headers: Record<string, string>;
    maxBytes: number;
    expiresInSeconds: number;
  }>
> {
  const isDocument = input.kind === 'document';
  const allowlist = isDocument ? DOCUMENT_MIME_ALLOWLIST : IMAGE_MIME_ALLOWLIST;
  const maxBytes = isDocument ? MAX_DOCUMENT_BYTES : MAX_IMAGE_BYTES;

  if (!allowlist.includes(input.mime)) return { ok: false, code: 'mime_not_allowed' };
  if (input.bytes <= 0 || input.bytes > maxBytes) return { ok: false, code: 'too_large' };

  let channel: ChannelRef | null = null;
  let bucket = config.publicBucket;

  if (input.kind === 'avatar') {
    // Identity media is public. Nothing to authorize beyond being signed in - you may
    // replace your own avatar, and the object carries no private content.
    bucket = config.publicBucket;
  } else {
    if (!input.channelId) return { ok: false, code: 'not_found' };
    channel = await getChannelRef(db, input.channelId);
    // `canPostInChannel`, not `isChannelMember`: an upload exists in order to be sent, so the
    // gate has to be the send's gate. The two were the same predicate until DMs arrived, and
    // reading is now the weaker of the pair - a blocked participant can still read the
    // conversation, and letting them presign an upload they can never attach would leave
    // pending objects for the GC and imply a send that will be refused.
    if (!channel || !canPostInChannel(ctx, channel)) return { ok: false, code: 'not_found' };
    bucket = config.privateBucket;
  }

  // Random key rather than anything derived from the filename or the uploader. A guessable
  // key would make the private bucket's contents enumerable if the signature were ever
  // weakened, and the key is not a place to be clever.
  const objectKey = `${input.kind}/${new Date().toISOString().slice(0, 7)}/${randomUUID()}`;

  const rows = await db
    .insert(mediaObjects)
    .values({
      ownerType: input.kind === 'avatar' ? 'user_avatar' : 'message',
      ownerId: null,
      clubId: channel?.clubId ?? null,
      channelId: channel?.id ?? null,
      uploaderId: ctx.userId,
      bucket,
      objectKey,
      mime: input.mime,
      bytes: input.bytes,
      status: 'pending',
      documentName: input.documentName ?? null,
    })
    .returning({ id: mediaObjects.id });

  const media = rows[0];
  if (!media) throw new Error('media insert returned no row');

  const presigned = await store.presignUpload({ bucket, objectKey, mime: input.mime, maxBytes });

  return {
    ok: true,
    mediaId: media.id,
    uploadUrl: presigned.url,
    headers: presigned.headers,
    maxBytes,
    expiresInSeconds: presigned.expiresInSeconds,
  };
}

/**
 * Confirm an upload.
 *
 * **HEADs the object and verifies size and type actually match what was declared.** That
 * verification is the whole point of this endpoint existing rather than the client simply
 * sending the message: a presigned PUT constrains where the bytes go and what Content-Type
 * header rides along, and constrains nothing about how many bytes there are.
 *
 * Only on success does the row become `ready` and the derivation event get written - so a
 * message can never reference an object that was declared and never arrived.
 */
export async function completeUpload(
  db: Db,
  store: MediaStore,
  ctx: AccessContext,
  mediaId: string,
): Promise<Result<{ mediaId: string; bytes: number }>> {
  const rows = await db.select().from(mediaObjects).where(eq(mediaObjects.id, mediaId)).limit(1);
  const media = rows[0];
  if (!media) return { ok: false, code: 'not_found' };
  // Only the uploader completes their own upload. Anyone else doing it would be confirming
  // bytes they did not send.
  if (media.uploaderId !== ctx.userId) return { ok: false, code: 'forbidden' };

  // Idempotent: completing twice is a no-op, which matters because a flaky network makes the
  // client retry this exactly as readily as it retries a send.
  if (media.status === 'ready') return { ok: true, mediaId, bytes: media.bytes };

  const head = await store.head({ bucket: media.bucket, objectKey: media.objectKey });
  if (!head.exists) return { ok: false, code: 'not_uploaded' };

  // The declared size is a claim. This is the fact.
  const allowlist =
    media.ownerType === 'message' && DOCUMENT_MIME_ALLOWLIST.includes(media.mime)
      ? DOCUMENT_MIME_ALLOWLIST
      : IMAGE_MIME_ALLOWLIST;
  const maxBytes = allowlist === DOCUMENT_MIME_ALLOWLIST ? MAX_DOCUMENT_BYTES : MAX_IMAGE_BYTES;

  if (head.bytes > maxBytes) return { ok: false, code: 'too_large' };
  // A tolerance would be a hole. The client declared a number; if the object is a different
  // size, the declaration was wrong and the upload is not what was authorized.
  if (head.bytes !== media.bytes) return { ok: false, code: 'mismatch' };
  if (head.mime !== null && head.mime !== media.mime) return { ok: false, code: 'mismatch' };

  await db.transaction(async (tx) => {
    await tx
      .update(mediaObjects)
      .set({ status: 'ready', completedAt: new Date() })
      .where(eq(mediaObjects.id, mediaId));

    // Derivation is an effect, not part of the request. Uploading should not wait on
    // thumbnailing, and the sequence-allocating transaction must never contain I/O.
    await tx.insert(outbox).values({
      partitionKey: media.channelId ?? media.uploaderId,
      eventType: 'media.uploaded',
      payload: { mediaId, bucket: media.bucket, objectKey: media.objectKey, mime: media.mime },
    });
  });

  return { ok: true, mediaId, bytes: head.bytes };
}

// ---------------------------------------------------------------------------
// Download: authorization, then an hour-aligned signature
// ---------------------------------------------------------------------------

/**
 * Round a timestamp up to the top of the next hour, then add an hour.
 *
 * > **This is the entire fix for debt item 7.**
 * >
 * > `now + 1 hour` produces a different `exp` on every single request, so the query string
 * > differs per viewer, so the CDN cache key differs per viewer, so nothing is ever a hit. A
 * > 300-member club looking at one photo becomes 300 origin fetches.
 * >
 * > Aligning to the hour makes every viewer inside the same window receive the *byte-identical*
 * > URL. One cache entry serves all of them. The extra hour is headroom so a URL issued at
 * > 10:59 does not expire sixty seconds later.
 */
export function hourAlignedExpiry(nowMs: number): number {
  const HOUR = 3_600_000;
  const ceilToHour = Math.ceil(nowMs / HOUR) * HOUR;
  return Math.floor((ceilToHour + HOUR) / 1000);
}

/**
 * The same hour-aligned window, expressed for a store-signed URL.
 *
 * `signingDate` is the **floor** of the current hour rather than the expiry, for two reasons: a
 * signature dated in the future is not yet valid, and the floor is the value every caller inside
 * the window agrees on. `expiresIn` then carries the distance from that floor to the aligned
 * expiry, so the resulting URL is byte-identical for everyone in the window - the same property
 * the CDN scheme gets from `exp` alone.
 */
export function hourAlignedSigningWindow(nowMs: number): {
  signingDateMs: number;
  expiresInSeconds: number;
} {
  const HOUR = 3_600_000;
  const floor = Math.floor(nowMs / HOUR) * HOUR;
  const expiryMs = hourAlignedExpiry(nowMs) * 1000;
  return { signingDateMs: floor, expiresInSeconds: Math.round((expiryMs - floor) / 1000) };
}

function sign(secret: string, objectKey: string, exp: number): string {
  return createHmac('sha256', secret).update(`${objectKey}:${exp}`).digest('base64url');
}

/** Build the signed CDN URL for an object. Deterministic within the hour window. */
export function signedMediaUrl(
  config: MediaConfig,
  objectKey: string,
  nowMs = Date.now(),
): string {
  const exp = hourAlignedExpiry(nowMs);
  const sig = sign(config.signingSecret, objectKey, exp);
  return `${config.cdnBaseUrl}/${objectKey}?exp=${exp}&sig=${sig}`;
}

/**
 * Verify a signature. For the CDN edge, or for a test standing in for it.
 *
 * Compared with `timingSafeEqual`, because a byte-by-byte comparison that returns early leaks
 * how much of a guessed signature was correct.
 */
export function verifyMediaSignature(
  config: MediaConfig,
  objectKey: string,
  exp: number,
  sig: string,
  nowMs = Date.now(),
): boolean {
  if (!Number.isFinite(exp) || exp * 1000 < nowMs) return false;
  const expected = sign(config.signingSecret, objectKey, exp);
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export type MediaRedirect = {
  url: string;
  /**
   * Cached briefly and PRIVATELY.
   *
   * `private` matters: this response is the result of an authorization decision for one member,
   * so a shared cache holding it would serve that decision to somebody else. `max-age=600` lets
   * one client re-render an image repeatedly without re-authorizing every time.
   */
  cacheControl: string;
  /**
   * What the bytes at that URL actually are.
   *
   * **Object keys carry no extension** (`message/2026-08/<uuid>`), so a client that saves or
   * shares a photo has nothing to name the file from. A `.jpg` guess is wrong for the HEIC an
   * iPhone uploads and for the WebP a derived variant is, and iOS decides what it is holding
   * from the extension. So the type travels with the URL rather than being inferred from it.
   */
  mime: string;
};

/**
 * Resolve `/media/:id` to a redirect, authorizing first.
 *
 * The authorization is the same membership predicate that protects the message, evaluated on
 * **every** request. Nothing about the signed URL grants access - it grants *fetchability of
 * bytes whose key is already unguessable*, which is a different thing, and is why this hop
 * cannot be skipped or cached publicly.
 */
export async function resolveMediaRedirect(
  db: Db,
  store: MediaStore,
  config: MediaConfig,
  ctx: AccessContext,
  mediaId: string,
  opts: { variant?: 'original' | 'display' | 'thumb' | undefined; nowMs?: number } = {},
): Promise<Result<MediaRedirect>> {
  const rows = await db
    .select()
    .from(mediaObjects)
    .where(and(eq(mediaObjects.id, mediaId), eq(mediaObjects.status, 'ready')))
    .limit(1);
  const media = rows[0];
  // 'not_found' rather than 'forbidden' for a missing object AND for an unauthorized one:
  // telling somebody an object exists but is not theirs is itself a disclosure.
  if (!media) return { ok: false, code: 'not_found' };

  if (media.channelId !== null) {
    const channel = await getChannelRef(db, media.channelId);
    if (!channel || !isChannelMember(ctx, channel)) return { ok: false, code: 'not_found' };
  }
  // An avatar has no channel and is public content; being signed in is the whole check.

  const variants = (media.variants ?? {}) as Record<string, string>;
  const requested = opts.variant ?? 'original';
  // Fall back to the original when a derived variant does not exist yet - the worker may not
  // have run, and a missing thumbnail must degrade to a slower image rather than a broken one.
  const objectKey = requested === 'original' ? media.objectKey : (variants[requested] ?? media.objectKey);
  // Derived variants are WebP (see `derive.ts`); the original is whatever was uploaded. Read off
  // the SAME branch the key was, so the two can never describe different bytes.
  const mime = objectKey === media.objectKey ? media.mime : 'image/webp';

  const nowMs = opts.nowMs ?? Date.now();
  // Whoever is going to serve the bytes has to be the one whose signature they carry.
  const url =
    config.urlMode === 'presign'
      ? await (async () => {
          const window = hourAlignedSigningWindow(nowMs);
          return store.presignDownload({
            bucket: media.bucket,
            objectKey,
            signingDateMs: window.signingDateMs,
            expiresInSeconds: window.expiresInSeconds,
          });
        })()
      : signedMediaUrl(config, objectKey, nowMs);

  return { ok: true, url, mime, cacheControl: 'private, max-age=600' };
}

// ---------------------------------------------------------------------------
// Galleries
// ---------------------------------------------------------------------------

export type GalleryEntry = {
  mediaId: string;
  seq: number;
  /** The stable, permanent URL a client renders from. Not a signed one. */
  url: string;
  thumbUrl: string;
  createdAt: string;
  /**
   * Who posted it.
   *
   * The grid does not draw this; the full-screen viewer does, and it is the same header the
   * viewer shows when it is opened from chat - a face, a name and a date over the photograph.
   * Null where the account has been deleted, exactly as a message's own sender is.
   */
  senderId: string;
  senderName: string | null;
  senderImage: string | null;
};

/**
 * Every photo ever posted in a conversation, newest first.
 *
 * **Adds no new authorization** - it inherits the chat's own access rules, which is why the
 * only check here is channel membership. A photo enters a gallery only by being posted in
 * chat; there is no separate upload path.
 *
 * Paginated, unlike v1, which signed a channel's entire photo history in one unbounded call.
 * And the clients render from `/media/:id`, a **stable** URL, so there is nothing to sign in
 * batches and no per-device memoization to get wrong.
 */
export async function readGallery(
  db: Db,
  ctx: AccessContext,
  channelId: string,
  opts: { before?: number | undefined; limit?: number | undefined } = {},
): Promise<Result<{ entries: GalleryEntry[]; nextCursor: number | null }>> {
  const channel = await getChannelRef(db, channelId);
  if (!channel || !isChannelMember(ctx, channel)) return { ok: false, code: 'not_found' };

  const limit = Math.min(opts.limit ?? 60, 200);
  const before = opts.before ?? null;

  const rows = await db.execute<{
    media_id: string;
    seq: number;
    created_at: string;
    sender_id: string;
    full_name: string | null;
    image: string | null;
  }>(sql`
    SELECT m.media_id,
           m.seq,
           m.created_at::text AS created_at,
           m.sender_id::text AS sender_id,
           -- An anonymized account keeps its row so history stays attributed, and the viewer
           -- draws "Deleted member" from the null rather than inventing a name here.
           CASE WHEN u.anonymized_at IS NULL THEN u.full_name END AS full_name,
           CASE WHEN u.anonymized_at IS NULL THEN u.image END AS image
      FROM messages m
      JOIN media_objects mo ON mo.id = m.media_id
      JOIN users u ON u.id = m.sender_id
     WHERE m.channel_id = ${channelId}
       AND m.media_id IS NOT NULL
       AND m.deleted_at IS NULL
       AND mo.status = 'ready'
       -- Photos only. A document is an attachment, not something a photo grid should show.
       AND mo.mime LIKE 'image/%'
       ${before !== null ? sql`AND m.seq < ${before}` : sql``}
     ORDER BY m.seq DESC
     LIMIT ${limit + 1}
  `);

  const hasMore = rows.rows.length > limit;
  const page = rows.rows.slice(0, limit);

  return {
    ok: true,
    entries: page.map((row) => ({
      mediaId: row.media_id,
      seq: row.seq,
      // Stable and permanent. Image cache keys are stable by construction, which is what
      // removes the memoization gymnastics v1 needed.
      url: `/media/${row.media_id}`,
      thumbUrl: `/media/${row.media_id}?variant=thumb`,
      createdAt: new Date(row.created_at).toISOString(),
      senderId: row.sender_id,
      senderName: row.full_name,
      senderImage: row.image,
    })),
    nextCursor: hasMore ? (page[page.length - 1]?.seq ?? null) : null,
  };
}
