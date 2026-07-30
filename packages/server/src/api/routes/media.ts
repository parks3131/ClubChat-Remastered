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
} from '../../media/pipeline.ts';
import { mediaConfigOf, type AppDeps } from '../plumbing.ts';

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

  app.post<{ Params: { id: string } }>('/media/:id/complete', async (request, reply) => {
    const result = await completeUpload(
      deps.db,
      deps.mediaStore,
      request.access!,
      request.params.id,
    );
    if (!result.ok) {
      const status = result.code === 'too_large' ? 413 : result.code === 'mismatch' ? 409 : 404;
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
