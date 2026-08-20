/**
 * Media: the upload handshake, the authorized download hop, and the gallery.
 *
 * The authorization hop is the point of this group. A signed URL grants fetchability of
 * bytes whose key is already unguessable; it does not grant access. Access is decided
 * here, on every request, by the same membership predicate that protects the message.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  completeUpload,
  createUploadIntent,
  hourAlignedExpiry,
  readGallery,
  resolveMediaRedirect,
  resolveMediaRedirects,
} from '../../media/pipeline.ts';
import { MediaStoreError } from '../../media/store.ts';
import { mediaConfigOf, parseIdList, type AppDeps } from '../plumbing.ts';

export function registerMediaRoutes(app: FastifyInstance, deps: AppDeps): void {
  const media = mediaConfigOf(deps.config);

  const IntentBody = z.object({
    kind: z.enum(['photo', 'document', 'avatar']),
    mime: z.string().min(1).max(200),
    bytes: z.number().int().positive(),
    channelId: z.string().uuid().optional(),
    documentName: z.string().max(400).optional(),
  });

  app.post('/media/upload-intent', async (request, reply) => {
    const body = IntentBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });

    const result = await createUploadIntent(
      deps.db,
      deps.mediaStore,
      media,
      request.access!,
      body.data,
    );
    if (!result.ok) {
      // 413 for a size refusal and 415 for a type refusal, so a client can tell the user
      // which limit they hit rather than showing one generic failure.
      const status =
        result.code === 'too_large' ? 413 : result.code === 'mime_not_allowed' ? 415 : 404;
      return reply.code(status).send({ error: result.code });
    }
    return reply.code(201).send(result);
  });

  /**
   * The region of the picture to keep, when the sender cropped it.
   *
   * Optional, and strict about what it accepts: pixel indices are non-negative integers and a
   * crop of nothing is not a crop. The rectangle is re-checked against the picture's real
   * dimensions inside `completeUpload` - this only rules out a payload that could not describe a
   * region of anything.
   */
  const CompleteBody = z
    .object({
      crop: z
        .object({
          originX: z.number().int().nonnegative(),
          originY: z.number().int().nonnegative(),
          width: z.number().int().positive(),
          height: z.number().int().positive(),
        })
        .optional(),
    })
    .strict();

  app.post<{ Params: { id: string } }>('/media/:id/complete', async (request, reply) => {
    const body = CompleteBody.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });

    /*
     * The one call site of `completeUpload`, and the one place a storage fault has to be told
     * apart from a member who changed their mind.
     *
     * > `store.head` used to answer `{ exists: false }` for a 403, a DNS failure and a timeout as
     * > readily as for a real 404, and this route turned every one of them into `not_uploaded` -
     * > which per SPEC/TECH/07 tells the client to finish the upload and retry. A rotated R2
     * > secret typed with one character wrong therefore looked exactly like members abandoning
     * > uploads, and nothing was reported, so the only evidence was a graph.
     *
     * Caught here rather than left to the app-wide error handler for two reasons: 503 says "ours,
     * try later" where a 500 says nothing, and the report gets its own `where`, so an outage does
     * not group into the same issue as every other route that happened to throw.
     */
    let result: Awaited<ReturnType<typeof completeUpload>>;
    try {
      result = await completeUpload(
        deps.db,
        deps.mediaStore,
        request.access!,
        request.params.id,
        body.data.crop,
      );
    } catch (error) {
      if (!(error instanceof MediaStoreError)) throw error;
      deps.monitor.capture(error, 'api.media.complete', {
        mediaId: request.params.id,
        operation: error.operation,
      });
      return reply.code(503).send({ error: 'storage_unavailable' });
    }
    if (!result.ok) {
      // 422 for bytes that arrived intact and are not an image: the request was well formed and
      // the object is the problem, which is a different thing for a client to say than either
      // "too big" or "that is not what you told us you were sending".
      const status =
        result.code === 'too_large'
          ? 413
          : result.code === 'mismatch'
            ? 409
            : result.code === 'undecodable'
              ? 422
              // A rectangle that does not fit the picture is the caller's arithmetic, not a
              // missing object - so 422 with the rest of the content-is-wrong family.
              : result.code === 'bad_crop'
                ? 422
                : 404;
      return reply.code(status).send({ error: result.code });
    }
    return result;
  });

  const VariantQuery = z.object({
    variant: z.enum(['original', 'display', 'thumb']).optional(),
  });

  /**
   * The authorized download hop.
   *
   * Authorization happens HERE, on every request, with the same membership predicate that
   * protects the message. The signed URL it redirects to grants fetchability of bytes whose
   * key is already unguessable - it does not grant access, which is why this hop cannot be
   * skipped or cached publicly.
   */
  app.get<{ Params: { id: string } }>('/media/:id', async (request, reply) => {
    const query = VariantQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_query' });

    const result = await resolveMediaRedirect(
      deps.db,
      deps.mediaStore,
      media,
      request.access!,
      request.params.id,
      { variant: query.data.variant },
    );
    // Nothing back for an object that does not exist OR that this member cannot reach.
    // Distinguishing the two would confirm the object exists.
    if (!result.ok) return reply.code(404).send({ error: 'not_found' });

    return reply.header('cache-control', result.cacheControl).redirect(result.url, 302);
  });

  /**
   * The same authorized hop, answering with JSON instead of a redirect.
   *
   * > **A 302 behind an `Authorization` header is unusable as an image source on the web.**
   * > `<img src>` sends no custom headers, and react-native-web renders every `Image` as an
   * > `<img>` - so the native path (`Image` with `{uri, headers}`, which follows the redirect
   * > itself) has no web equivalent. Without this route, media is unreachable on the surface
   * > this project develops and tests on.
   *
   * It grants nothing the redirect does not: same function, same predicate, evaluated on every
   * request. What the client gets back is the same hour-aligned signed URL, which is
   * **byte-identical for every viewer inside the window** - so resolving once and rendering
   * from the result is exactly the CDN-cacheable path the alignment was designed for, rather
   * than a way around it.
   *
   * The alternative - a token in the query string - is not available: credentials never go in
   * a URL, and the signature deliberately grants fetchability of an unguessable key rather
   * than access.
   */
  app.get<{ Params: { id: string } }>('/media/:id/url', async (request, reply) => {
    const query = VariantQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_query' });

    const result = await resolveMediaRedirect(
      deps.db,
      deps.mediaStore,
      media,
      request.access!,
      request.params.id,
      { variant: query.data.variant },
    );
    if (!result.ok) return reply.code(404).send({ error: 'not_found' });

    /*
     * `no-store`, unlike the redirect above, and the difference is deliberate.
     *
     * The redirect is consumed by an `<img src>` that hits it on every render, so caching it
     * privately for ten minutes is what stops a re-render re-authorizing. This route is
     * consumed by a client that **already memoizes** the resolved URL for the life of its
     * hour-aligned window, so an HTTP cache in front of it saves nothing and costs something:
     * a member who loses access would keep resolving successfully for up to ten more minutes.
     *
     * Found by a smoke test where a stale cached response outlived a change in signing mode,
     * which is the same staleness wearing a less serious hat.
     */
    return reply.header('cache-control', 'no-store').send({
      url: result.url,
      // So a client can drop its memo when the window rolls rather than holding a dead URL.
      expiresAt: new Date(hourAlignedExpiry(Date.now()) * 1000).toISOString(),
      // So a client saving or sharing the file can name it correctly - the key has no extension.
      mime: result.mime,
      /*
       * So a client can reserve the right space BEFORE the bytes arrive.
       *
       * Null for anything uploaded before these were recorded, and for a document. A client
       * that gets null measures the image itself, which is what every client did until now.
       */
      width: result.width,
      height: result.height,
    });
  });

  const BatchQuery = z.object({
    variant: z.enum(['original', 'display', 'thumb']).optional(),
  });

  /**
   * Many signed URLs, in one request.
   *
   * > **One request per picture was the largest remaining item in the backend-cleaning mission.**
   * > A measured window on the device spent 50 of its 110 requests - 45% of all traffic - on 34
   * > picture links, fetched one at a time. Nothing was duplicated and nothing was slow; it was
   * > simply not batched. See TECH/18 3.1.
   *
   * **Authorization is `resolveMediaRedirect` called once per id - the same function the
   * single-item route calls.** Not one query with an `IN` clause and the membership predicate
   * written a second time: the second copy is always the one that forgets that a race photo is
   * invisible to a club admin with no roster row. This is 2.7's rule, and the reason the loop
   * below looks naive on purpose.
   *
   * An id the caller may not read, or one that no longer exists, is **omitted** rather than an
   * error, so one dead thumbnail in old history fails alone instead of blanking the other
   * thirty-three. A **malformed** id is a 400, because skipping it would answer 200 with a
   * response that simply does not mention it - a client bug hiding behind a success.
   *
   * `variant` applies to the whole batch. A caller wanting two variants of the same picture
   * sends two requests, which is what the client's grouping does and is still far fewer than
   * one per picture.
   *
   * `no-store` for the same reason the single route has it: the client memoizes these until the
   * hour-aligned expiry the response carries, so an HTTP cache in front saves nothing and would
   * let a member who lost access keep resolving successfully.
   */
  app.get('/media/urls', async (request, reply) => {
    const query = BatchQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_query' });

    const parsed = parseIdList((request.query as { ids?: unknown }).ids);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });

    /*
     * One resolve for the whole list, authorized per id inside.
     *
     * This looped `resolveMediaRedirect` when the route shipped, which was two database round
     * trips per picture - the row, then the channel that owns it - so a gallery of 34 was about
     * 68 statements in one request. `isChannelMember` still decides every id on its own; only
     * the fetching is shared. TECH/18 3.5.
     */
    const resolved = await resolveMediaRedirects(
      deps.db,
      deps.mediaStore,
      media,
      request.access!,
      parsed.ids,
      { variant: query.data.variant },
    );

    // Built from the ids ASKED FOR, so the answer keeps their order and an absent one is simply
    // skipped rather than appearing as a hole.
    const urls = parsed.ids.flatMap((id) => {
      const one = resolved.get(id);
      return one
        ? [{ id, url: one.url, mime: one.mime, width: one.width, height: one.height }]
        : [];
    });

    return reply.header('cache-control', 'no-store').send({
      urls,
      // One expiry for the batch: every URL in it is signed to the same hour-aligned boundary,
      // which is the property that makes them byte-identical for every viewer in the window.
      expiresAt: new Date(hourAlignedExpiry(Date.now()) * 1000).toISOString(),
    });
  });

  const GalleryQuery = z.object({
    before: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
  });

  app.get<{ Params: { id: string } }>('/channels/:id/gallery', async (request, reply) => {
    const query = GalleryQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_query' });
    const result = await readGallery(deps.db, request.access!, request.params.id, query.data);
    if (!result.ok) return reply.code(404).send({ error: 'not_found' });
    return result;
  });
}
