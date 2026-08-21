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

import { randomUUID } from 'node:crypto';
import {
  hourAlignedExpiry,
  hourAlignedSigningWindow,
  signedMediaUrl as signedMediaUrlShared,
  verifyMediaSignature as verifyMediaSignatureShared,
} from '@clubchat/shared/media-signing';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { channels, mediaObjects, outbox } from '../db/schema.ts';
import { clearedFloor, type AccessContext } from '../policy/context.ts';
import { canPostInChannel, isChannelMember, type ChannelRef } from '../policy/predicates.ts';
import { getChannelRef } from '../domain/reads.ts';
import sharp from 'sharp';
import { probeImage } from './probe.ts';
import {
  DOCUMENT_MIME_ALLOWLIST,
  IMAGE_MIME_ALLOWLIST,
  MAX_DOCUMENT_BYTES,
  MAX_IMAGE_BYTES,
  type MediaStore,
} from './store.ts';

export type Refusal = {
  ok: false;
  code:
    | 'forbidden'
    | 'not_found'
    | 'mime_not_allowed'
    | 'too_large'
    | 'not_uploaded'
    | 'mismatch'
    /** The bytes arrived intact by every declared measure and still are not an image. */
    | 'undecodable'
    /**
     * The crop rectangle does not fit inside the picture it was measured against.
     *
     * Its own code rather than folded into `mismatch`, which is about the bytes disagreeing with
     * what was declared. This is a caller whose idea of the source's dimensions is wrong, and the
     * only honest answer is to refuse rather than to cut a region nobody chose.
     */
    | 'bad_crop';
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
/**
 * A region of the uploaded picture to keep, in the source image's own pixels.
 *
 * Chosen on the phone by dragging a frame and applied here - see the note at the crop itself for
 * why the cutting is server-side. All four are integers because they are pixel indices; a
 * fractional origin is a client that did its arithmetic in display points.
 */
export type CropRegion = {
  originX: number;
  originY: number;
  width: number;
  height: number;
};

export async function completeUpload(
  db: Db,
  store: MediaStore,
  ctx: AccessContext,
  mediaId: string,
  /** Absent for the great majority: a photo sent as it was chosen, and every document. */
  crop?: CropRegion | undefined,
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

  /*
   * The last thing a HEAD cannot tell you: whether the bytes are an image at all.
   *
   * > Size and type both matched for the 97-byte PNG in `probe.ts`, and it was still two bytes
   * > short of a file. Every check above passed it.
   *
   * **This reads the object, which is the one place the server touches file bytes.** The
   * module header says it does not, and that rule is about never proxying an upload - the
   * client PUTs directly and the interface has deliberately no method taking a buffer. This is
   * the other half of the same job: the function exists to verify afterwards that what arrived
   * matches what was declared, and "is an image" is the declaration nothing else checks.
   *
   * It costs one object read and one full decode per image upload, on a path that is already
   * a round trip to storage. Paid here because the alternative is worse: a member posts a
   * photo, the send succeeds, and what appears in the conversation is a permanently broken
   * image with no error anywhere the member can see.
   */
  /*
   * How large the picture is, taken from the decode that was already happening.
   *
   * Null for a document, and null for an image whose header would not give them up - both of
   * which a client already handles, because it handled every row that predates the columns.
   */
  let dimensions: { width: number | null; height: number | null } = { width: null, height: null };

  /** What the object ends up being, which a crop changes and nothing else does. */
  let storedBytes = head.bytes;

  if (media.mime.startsWith('image/')) {
    const bytes = await store.get({ bucket: media.bucket, objectKey: media.objectKey });
    const probe = await probeImage(bytes);
    // Left `pending`, so the GC reclaims the bytes after `STALE_PENDING_HOURS` exactly as it
    // does for an upload the client abandoned. Nothing references the row: `ready` is what a
    // message may be attached to.
    if (!probe.ok) return { ok: false, code: 'undecodable' };
    dimensions = { width: probe.width, height: probe.height };

    /*
     * The crop, applied HERE and nowhere else.
     *
     * > **The phone chooses the rectangle; the server cuts the pixels.** Doing it on the device
     * > needs a native image module, and that is what took the app down twice on 2026-08-15 - a
     * > native import is resolved at bundle load, so it reaches every phone the moment Metro
     * > serves it while the binaries carrying it are hours behind. This path needs no new
     * > dependency at all: the bytes are already read and already decoded two lines above,
     * > because `completeUpload` has always had to prove an upload is really an image.
     *
     * Sited after the probe rather than before it, which is the ordering that matters: the crop
     * is applied to something already known to be a decodable image, and a rectangle that lies
     * about its bounds is refused by the probe's own dimensions rather than by `sharp` throwing.
     *
     * The cropped bytes REPLACE the original. The member chose this picture, so there is nothing
     * to keep the discarded edges for - and keeping them would mean the gallery, the thumbnail
     * and the download hop each having to know which version they meant.
     */
    if (crop) {
      const fits =
        probe.width !== null &&
        probe.height !== null &&
        crop.originX + crop.width <= probe.width &&
        crop.originY + crop.height <= probe.height;
      // A rectangle outside the picture is a client that measured against something else. Refused
      // rather than clamped: silently cropping a different region than was chosen is worse than
      // saying no, and the client can only have got here by disagreeing about the source.
      if (!fits) return { ok: false, code: 'bad_crop' };

      const cropped = await sharp(Buffer.from(bytes))
        /*
         * Before `extract`, and this is the trap the derive path already records: a photo from a
         * phone carries its rotation in EXIF, so the pixels are sideways until something applies
         * it. Extracting first would cut a rectangle out of the UNROTATED pixels - the wrong
         * region entirely, and wrong by ninety degrees rather than by a little.
         */
        .rotate()
        .extract({
          left: crop.originX,
          top: crop.originY,
          width: crop.width,
          height: crop.height,
        })
        .toBuffer();

      await store.put({
        bucket: media.bucket,
        objectKey: media.objectKey,
        body: new Uint8Array(cropped),
        mime: media.mime,
      });

      storedBytes = cropped.length;
      dimensions = { width: crop.width, height: crop.height };
    }
  }

  await db.transaction(async (tx) => {
    await tx
      .update(mediaObjects)
      // `bytes` is re-stated because a crop changed the object. Left alone it would keep the
      // uploaded size, and the row is what the message's own size field is read from.
      .set({ status: 'ready', completedAt: new Date(), bytes: storedBytes, ...dimensions })
      .where(eq(mediaObjects.id, mediaId));

    // Derivation is an effect, not part of the request. Uploading should not wait on
    // thumbnailing, and the sequence-allocating transaction must never contain I/O.
    await tx.insert(outbox).values({
      partitionKey: media.channelId ?? media.uploaderId,
      eventType: 'media.uploaded',
      payload: { mediaId, bucket: media.bucket, objectKey: media.objectKey, mime: media.mime },
    });
  });

  return { ok: true, mediaId, bytes: storedBytes };
}

// ---------------------------------------------------------------------------
// Download: authorization, then an hour-aligned signature
// ---------------------------------------------------------------------------

/**
 * The hour-aligned expiry, the signature, and the URL they build.
 *
 * All three moved to `@clubchat/shared/media-signing` when a Cloudflare Worker became a second
 * implementation of the same check. Two implementations of one HMAC is the shape of a bug that
 * presents as "every photo is broken" with both sides looking correct in isolation.
 *
 * Re-exported and wrapped here so every existing caller keeps the shape it had: these wrappers
 * take `MediaConfig` and default the clock, where the shared functions take the secret alone and
 * require an explicit `nowMs` because an edge has no business defaulting a clock.
 *
 * **Signing is async now**, because `crypto.subtle` is and it is the only hash `workerd` has.
 * That is the entire ripple of the move.
 */
export { hourAlignedExpiry, hourAlignedSigningWindow };

/** Build the signed CDN URL for an object. Deterministic within the hour window. */
export function signedMediaUrl(
  config: MediaConfig,
  objectKey: string,
  nowMs = Date.now(),
): Promise<string> {
  return signedMediaUrlShared(config, objectKey, nowMs);
}

/**
 * Verify a signature, for a test standing in for the edge.
 *
 * Nothing in this process validates a signature it minted; the Worker imports the shared function
 * directly. This exists so the server suite can pin the contract the Worker depends on.
 */
export function verifyMediaSignature(
  config: MediaConfig,
  objectKey: string,
  exp: number,
  sig: string,
  nowMs = Date.now(),
): Promise<boolean> {
  return verifyMediaSignatureShared(config.signingSecret, objectKey, exp, sig, nowMs);
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
  /**
   * The picture's displayed size in pixels, or null where it was never recorded.
   *
   * Post-EXIF, per `displayDimensions` - these describe what a viewer sees, not what the file's
   * header says, and the two differ for every portrait photograph taken on a phone.
   */
  width: number | null;
  height: number | null;
};

/**
 * Resolve many pictures at once. **The batch route's read, and the single route's too.**
 *
 * > **`GET /media/urls?ids=` was N+1 underneath, the same as the poll route in 2.16.** Two
 * > statements per picture - the media row, then the channel that owns it, for the membership
 * > check - so a gallery of 34 pictures was about 68 round trips inside one request that looked
 * > perfectly healthy on the wire. Found by inspection after 2.15 gave us a way to see it, and
 * > measured properly here. TECH/18 3.5.
 *
 * **The membership check still runs once per picture.** `isChannelMember` is a pure function
 * over a preloaded context, so per-id authorization never cost anything - what cost something
 * was fetching each picture's row and each owning channel separately. Both are now gathered with
 * one query each, and the predicate still decides every id on its own.
 *
 * Two statements regardless of how many pictures are asked for, and one when none of them belong
 * to a channel. Signing is local work, not a round trip, so it stays per picture.
 *
 * A picture that does not exist, is not `ready`, or belongs to a channel this caller is not in
 * is simply **absent** from the map - `not_found` and `forbidden` stay indistinguishable, which
 * is the property the single route was written to hold.
 */
export async function resolveMediaRedirects(
  db: Db,
  store: MediaStore,
  config: MediaConfig,
  ctx: AccessContext,
  mediaIds: string[],
  opts: { variant?: 'original' | 'display' | 'thumb' | undefined; nowMs?: number } = {},
): Promise<Map<string, MediaRedirect>> {
  const resolved = new Map<string, MediaRedirect>();
  if (mediaIds.length === 0) return resolved;

  const rows = await db
    .select()
    .from(mediaObjects)
    .where(
      and(
        sql`${mediaObjects.id} = ANY(${sql.param(mediaIds)}::uuid[])`,
        eq(mediaObjects.status, 'ready'),
      ),
    );
  if (rows.length === 0) return resolved;

  /*
   * Every owning channel, in one query rather than one per picture.
   *
   * A conversation's gallery is dozens of pictures in ONE channel, so this is usually a single
   * row however many were asked for - which is the whole shape of the defect: the same channel
   * was being read again for every photo in it.
   */
  const channelIds = [...new Set(rows.map((row) => row.channelId).filter((id) => id !== null))];
  const channelsById = new Map<string, ChannelRef>();
  if (channelIds.length > 0) {
    const found = await db
      .select()
      .from(channels)
      .where(sql`${channels.id} = ANY(${sql.param(channelIds)}::uuid[])`);
    for (const row of found) {
      channelsById.set(row.id, {
        id: row.id,
        scope: row.scope as ChannelRef['scope'],
        clubId: row.clubId,
        scopeId: row.scopeId,
      });
    }
  }

  const nowMs = opts.nowMs ?? Date.now();
  const requested = opts.variant ?? 'original';

  for (const media of rows) {
    // Decided per picture, on the same predicate the single read used. A second copy of this
    // rule expressed as a WHERE clause is the one that would forget a scope.
    if (media.channelId !== null) {
      const channel = channelsById.get(media.channelId);
      if (!channel || !isChannelMember(ctx, channel)) continue;
    }
    // An avatar has no channel and is public content; being signed in is the whole check.

    const variants = (media.variants ?? {}) as Record<string, string>;
    // Fall back to the original when a derived variant does not exist yet - the worker may not
    // have run, and a missing thumbnail must degrade to a slower image rather than a broken one.
    const objectKey =
      requested === 'original' ? media.objectKey : (variants[requested] ?? media.objectKey);
    // Derived variants are WebP (see `derive.ts`); the original is whatever was uploaded. Read off
    // the SAME branch the key was, so the two can never describe different bytes.
    const mime = objectKey === media.objectKey ? media.mime : 'image/webp';

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
        : await signedMediaUrl(config, objectKey, nowMs);

    resolved.set(media.id, {
      url,
      mime,
      /*
       * The shape of the picture, so a client can lay out the space before the bytes arrive.
       *
       * **The same numbers for every variant, and that is correct rather than sloppy.** A
       * thumbnail is the display image resized by width, so it has the same aspect - and aspect
       * is the only thing a caller uses these for.
       *
       * Null for anything uploaded before the columns existed, which every caller already
       * handles.
       */
      width: media.width,
      height: media.height,
      cacheControl: 'private, max-age=600',
    });
  }

  return resolved;
}

/**
 * Resolve `/media/:id` to a redirect, authorizing first.
 *
 * The authorization is the same membership predicate that protects the message, evaluated on
 * **every** request. Nothing about the signed URL grants access - it grants *fetchability of
 * bytes whose key is already unguessable*, which is a different thing, and is why this hop
 * cannot be skipped or cached publicly.
 *
 * Delegates to `resolveMediaRedirects` rather than keeping its own body, so the redirect hop and
 * the batch route can never authorize differently - the same reason `readPoll` delegates in 2.16.
 */
export async function resolveMediaRedirect(
  db: Db,
  store: MediaStore,
  config: MediaConfig,
  ctx: AccessContext,
  mediaId: string,
  opts: { variant?: 'original' | 'display' | 'thumb' | undefined; nowMs?: number } = {},
): Promise<Result<MediaRedirect>> {
  const resolved = await resolveMediaRedirects(db, store, config, ctx, [mediaId], opts);
  const one = resolved.get(mediaId);
  // 'not_found' rather than 'forbidden' for a missing object AND for an unauthorized one:
  // telling somebody an object exists but is not theirs is itself a disclosure.
  if (!one) return { ok: false, code: 'not_found' };
  return { ok: true, ...one };
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
       -- The viewer's own clear floor, the same one every other message read applies. A
       -- gallery is the easiest of the six to forget and the most obviously wrong to leave
       -- out: clearing a conversation and still finding its photographs one tap away would
       -- make the whole action read as broken.
       AND m.seq > ${clearedFloor(ctx, channelId)}
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
