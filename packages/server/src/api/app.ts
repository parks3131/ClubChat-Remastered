/**
 * The API. Every command and every query.
 *
 * The guarantee, unchanged from v1 and the reason the application server exists:
 *
 * > Every read and every write is access-checked on the server, not in the UI.
 * > Client-side gates are UX, never enforcement. A member who types a URL for a race
 * > chat, an Eboard poll, or another club's roster gets NOTHING back.
 *
 * What changed is where it is enforced: a policy module of pure functions over a
 * loaded access context, rather than row-level predicates evaluated inside queries.
 */

import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import fastifyCors from '@fastify/cors';
import { fromNodeHeaders } from 'better-auth/node';
import { z } from 'zod';
import { JoinPolicy } from '@clubchat/shared';
import type { Auth } from '../auth.ts';
import type { Config } from '../config.ts';
import type { Db } from '../db/client.ts';
import { createClub } from '../domain/create-club.ts';
import {
  advanceReadCursor,
  getChannelRef,
  listAccessibleChannels,
  listClubsForUser,
  readHistory,
  syncSince,
} from '../domain/reads.ts';
import { loadAccessContext, type AccessContext } from '../policy/context.ts';
import { isChannelMember, isClubAdmin } from '../policy/predicates.ts';
import { badgeCount, markInboxRead, markRosterSeen, openChat, readInbox } from '../domain/inbox.ts';
import { registerDevice } from '../push/dispatch.ts';
import type { MediaStore } from '../media/store.ts';
import {
  completeUpload,
  createUploadIntent,
  hourAlignedExpiry,
  readGallery,
  resolveMediaRedirect,
  type MediaConfig,
} from '../media/pipeline.ts';
import {
  addMember,
  changeRole,
  decideJoinRequest,
  deleteClub,
  joinClub,
  leaveClub,
  redeemInvite,
  removeMember,
  setJoinPolicy,
  transferOwnership,
} from '../domain/membership.ts';
import {
  blockMember,
  listBlocks,
  listDmThreads,
  muteChannel,
  openDm,
  readChannelMeta,
  searchDmCandidates,
  unblockMember,
  unmuteChannel,
} from '../domain/dm.ts';
import {
  dismissReport,
  listChannelReports,
  listDmReportQueue,
  listModerationReads,
  readReportedContext,
  reportMessage,
} from '../domain/moderation.ts';
import { readReactions, toggleReaction } from '../domain/reactions.ts';
import { Platform, ReactionEmoji } from '@clubchat/shared';

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
    access?: AccessContext;
  }
}

export type AppDeps = {
  db: Db;
  auth: Auth;
  config: Config;
  /** Injected so tests can use the in-memory fake and production uses S3. */
  mediaStore: MediaStore;
};

/** Media settings, derived once from config rather than rebuilt per request. */
function mediaConfigOf(config: Config): MediaConfig {
  return {
    publicBucket: config.S3_BUCKET_PUBLIC,
    privateBucket: config.S3_BUCKET_PRIVATE,
    signingSecret: config.MEDIA_SIGNING_SECRET,
    cdnBaseUrl: config.MEDIA_CDN_BASE_URL,
    urlMode: config.MEDIA_URL_MODE,
  };
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: { level: deps.config.LOG_LEVEL },
  });

  app.register(fastifyCors, {
    origin: deps.config.CLIENT_ORIGIN,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  });

  // Mounted AFTER cors, which the better-auth Fastify integration requires for
  // header handling to work.
  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    async handler(request, reply) {
      const url = new URL(request.url, deps.config.BETTER_AUTH_URL);
      const req = new Request(url.toString(), {
        method: request.method,
        headers: fromNodeHeaders(request.raw.headers),
        ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      });
      const response = await deps.auth.handler(req);
      reply.status(response.status);
      response.headers.forEach((value, key) => reply.header(key, value));
      return reply.send(response.body ? await response.text() : null);
    },
  });

  app.get('/health', async () => ({ ok: true }));

  /**
   * Resolve the caller, then load their access context once for the request.
   *
   * The `signinBlockedAt` check is here rather than only at sign-in because blocking a
   * user does NOT invalidate an already-issued token. Without this, a deleted or
   * blocked account keeps working until its session expires.
   */
  async function authenticate(request: FastifyRequest): Promise<boolean> {
    const session = await deps.auth.api.getSession({
      headers: fromNodeHeaders(request.raw.headers),
    });
    if (!session?.user) return false;

    const blocked = (session.user as { signinBlockedAt?: unknown }).signinBlockedAt;
    if (blocked) return false;

    request.userId = session.user.id;
    request.access = await loadAccessContext(deps.db, session.user.id);
    return true;
  }

  // Everything below /api that is not the auth handler requires a session.
  app.register(async (protectedRoutes) => {
    protectedRoutes.addHook('preHandler', async (request, reply) => {
      if (!(await authenticate(request))) {
        return reply.code(401).send({ error: 'unauthenticated' });
      }
    });

    protectedRoutes.get('/me', async (request) => {
      const access = request.access!;
      return {
        userId: access.userId,
        clubs: [...access.clubRole.entries()].map(([clubId, role]) => ({ clubId, role })),
      };
    });

    protectedRoutes.get('/clubs', async (request) => ({
      clubs: await listClubsForUser(deps.db, request.userId!),
    }));

    const CreateClubBody = z.object({
      name: z.string().min(1).max(120),
      sport: z.string().min(1).max(60),
      description: z.string().max(2_000).nullish(),
      joinPolicy: JoinPolicy.default('open'),
    });

    protectedRoutes.post('/clubs', async (request, reply) => {
      const parsed = CreateClubBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
      }

      // Anyone signed in may create a club; they become its Owner. There is no
      // authorization gate beyond having an account.
      const result = await createClub(deps.db, {
        ...parsed.data,
        creatorId: request.userId!,
      });

      // Every mutation returns the created resource. Legal and trivial here, and the
      // direct counter-example to v1's create-and-read-back trap: this handler
      // authorized the write, so it may obviously return what it wrote.
      return reply.code(201).send(result);
    });

    protectedRoutes.get('/channels', async (request) => ({
      channels: await listAccessibleChannels(deps.db, request.userId!),
    }));

    /**
     * Guard a channel-scoped route.
     *
     * Scope access is decided ONCE, here at the boundary, and never re-derived per
     * route below it. Returns the channel so the caller does not load it twice.
     */
    async function authorizeChannel(request: FastifyRequest, channelId: string) {
      const channel = await getChannelRef(deps.db, channelId);
      if (!channel) return { ok: false as const, code: 404 };
      if (!isChannelMember(request.access!, channel)) {
        // 404 rather than 403: a member who types a URL for a channel they cannot
        // access gets nothing back, and "nothing back" includes not confirming the
        // channel exists.
        return { ok: false as const, code: 404 };
      }
      return { ok: true as const, channel };
    }

    const HistoryQuery = z.object({
      before: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().positive().max(200).optional(),
    });

    protectedRoutes.get<{ Params: { id: string } }>(
      '/channels/:id/messages',
      async (request, reply) => {
        const guard = await authorizeChannel(request, request.params.id);
        if (!guard.ok) return reply.code(guard.code).send({ error: 'not_found' });

        const query = HistoryQuery.safeParse(request.query);
        if (!query.success) return reply.code(400).send({ error: 'invalid_query' });

        const page = await readHistory(deps.db, request.params.id, query.data);
        return { messages: page };
      },
    );

    const ReadBody = z.object({ upToSeq: z.number().int().nonnegative() });

    protectedRoutes.post<{ Params: { id: string } }>(
      '/channels/:id/read',
      async (request, reply) => {
        const guard = await authorizeChannel(request, request.params.id);
        if (!guard.ok) return reply.code(guard.code).send({ error: 'not_found' });

        const body = ReadBody.safeParse(request.body);
        if (!body.success) return reply.code(400).send({ error: 'invalid_body' });

        // Through openChat rather than straight to the cursor: opening a chat with unread
        // messages must also record a "caught up on N messages" row, so the history of
        // having caught up survives once the live count is gone.
        const opened = await openChat(deps.db, request.userId!, request.params.id);
        // An explicit upToSeq below the head still advances only as far as asked, but the
        // common case - the client reporting the head it just rendered - is the same thing.
        if (body.data.upToSeq > opened.lastReadSeq) {
          await advanceReadCursor(deps.db, request.userId!, request.params.id, body.data.upToSeq);
        }
        return {
          channelId: request.params.id,
          lastReadSeq: Math.max(opened.lastReadSeq, body.data.upToSeq),
          caughtUp: opened.caughtUp,
        };
      },
    );

    // ---------------------------------------------------------------------
    // Membership
    // ---------------------------------------------------------------------

    /** Map a domain refusal onto a status code, in one place. */
    const refusalStatus = (code: string): number =>
      code === 'forbidden' || code === 'not_found'
        ? // 404 for both: a member who has no business with this club must not learn
          // whether it exists, and "forbidden" would tell them.
          404
        : 409;

    protectedRoutes.post<{ Params: { id: string } }>('/clubs/:id/join', async (request, reply) => {
      const result = await joinClub(deps.db, request.userId!, request.params.id);
      if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
      return result;
    });

    protectedRoutes.post<{ Params: { token: string } }>(
      '/invites/:token/redeem',
      async (request, reply) => {
        const result = await redeemInvite(deps.db, request.userId!, request.params.token);
        if (!result.ok) {
          // A revoked or malformed link gets a plain "no longer valid", never a hint about
          // which clubs exist.
          return reply.code(404).send({ error: 'invite_invalid' });
        }
        return result;
      },
    );

    protectedRoutes.post<{ Params: { id: string } }>(
      '/join-requests/:id/approve',
      async (request, reply) => {
        const result = await decideJoinRequest(deps.db, request.access!, request.params.id, true);
        if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
        return result;
      },
    );

    protectedRoutes.post<{ Params: { id: string } }>(
      '/join-requests/:id/deny',
      async (request, reply) => {
        const result = await decideJoinRequest(deps.db, request.access!, request.params.id, false);
        if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
        return result;
      },
    );

    const AddMemberBody = z.object({ userId: z.string().uuid() });
    protectedRoutes.post<{ Params: { id: string } }>(
      '/clubs/:id/members',
      async (request, reply) => {
        const body = AddMemberBody.safeParse(request.body);
        if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
        const result = await addMember(
          deps.db,
          request.access!,
          request.params.id,
          body.data.userId,
        );
        if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
        return result;
      },
    );

    const RoleBody = z.object({ role: z.enum(['admin', 'member']) });
    protectedRoutes.patch<{ Params: { id: string; uid: string } }>(
      '/clubs/:id/members/:uid/role',
      async (request, reply) => {
        const body = RoleBody.safeParse(request.body);
        if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
        const result = await changeRole(
          deps.db,
          request.access!,
          request.params.id,
          request.params.uid,
          body.data.role,
        );
        if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
        return result;
      },
    );

    protectedRoutes.delete<{ Params: { id: string; uid: string } }>(
      '/clubs/:id/members/:uid',
      async (request, reply) => {
        const result = await removeMember(
          deps.db,
          request.access!,
          request.params.id,
          request.params.uid,
        );
        if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
        return result;
      },
    );

    protectedRoutes.post<{ Params: { id: string } }>('/clubs/:id/leave', async (request, reply) => {
      const result = await leaveClub(deps.db, request.access!, request.params.id);
      if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
      return result;
    });

    const TransferBody = z.object({ toUserId: z.string().uuid() });
    protectedRoutes.post<{ Params: { id: string } }>(
      '/clubs/:id/transfer-ownership',
      async (request, reply) => {
        const body = TransferBody.safeParse(request.body);
        if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
        const result = await transferOwnership(
          deps.db,
          request.access!,
          request.params.id,
          body.data.toUserId,
        );
        if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
        return result;
      },
    );

    const PolicyBody = z.object({ joinPolicy: JoinPolicy });
    protectedRoutes.patch<{ Params: { id: string } }>('/clubs/:id', async (request, reply) => {
      const body = PolicyBody.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
      const result = await setJoinPolicy(
        deps.db,
        request.access!,
        request.params.id,
        body.data.joinPolicy,
      );
      if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
      return result;
    });

    protectedRoutes.delete<{ Params: { id: string } }>('/clubs/:id', async (request, reply) => {
      const result = await deleteClub(deps.db, request.access!, request.params.id);
      if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
      return { deleted: true };
    });

    // ---------------------------------------------------------------------
    // Media
    // ---------------------------------------------------------------------

    const media = mediaConfigOf(deps.config);

    const IntentBody = z.object({
      kind: z.enum(['photo', 'document', 'avatar']),
      mime: z.string().min(1).max(200),
      bytes: z.number().int().positive(),
      channelId: z.string().uuid().optional(),
      documentName: z.string().max(400).optional(),
    });

    protectedRoutes.post('/media/upload-intent', async (request, reply) => {
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

    protectedRoutes.post<{ Params: { id: string } }>(
      '/media/:id/complete',
      async (request, reply) => {
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
      },
    );

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
    protectedRoutes.get<{ Params: { id: string } }>('/media/:id', async (request, reply) => {
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

      return reply
        .header('cache-control', result.cacheControl)
        .redirect(result.url, 302);
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
    protectedRoutes.get<{ Params: { id: string } }>('/media/:id/url', async (request, reply) => {
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

    protectedRoutes.get<{ Params: { id: string } }>(
      '/channels/:id/gallery',
      async (request, reply) => {
        const query = GalleryQuery.safeParse(request.query);
        if (!query.success) return reply.code(400).send({ error: 'invalid_query' });
        const result = await readGallery(deps.db, request.access!, request.params.id, query.data);
        if (!result.ok) return reply.code(404).send({ error: 'not_found' });
        return result;
      },
    );

    // ---------------------------------------------------------------------
    // Direct messages
    // ---------------------------------------------------------------------

    /**
     * What to call this channel, and whether the composer is live.
     *
     * One endpoint for all four scopes rather than a DM-specific one, so the chat screen
     * stays a single implementation - PRD/05 rule 1, which DMs must not fork.
     */
    protectedRoutes.get<{ Params: { id: string } }>('/channels/:id', async (request, reply) => {
      const result = await readChannelMeta(deps.db, request.access!, request.params.id);
      if (!result.ok) return reply.code(404).send({ error: 'not_found' });
      return result;
    });

    const CandidateQuery = z.object({
      q: z.string().max(200).optional(),
      limit: z.coerce.number().int().positive().max(100).optional(),
    });

    /**
     * People this member may start a conversation with.
     *
     * A search over people they already share a club with, never a global user search
     * (PRD/14 rule 1). Blocked members are absent in both directions.
     */
    protectedRoutes.get('/dm/candidates', async (request, reply) => {
      const query = CandidateQuery.safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: 'invalid_query' });
      return {
        candidates: await searchDmCandidates(deps.db, request.access!, {
          query: query.data.q,
          limit: query.data.limit,
        }),
      };
    });

    protectedRoutes.get('/dm/threads', async (request) => ({
      threads: await listDmThreads(deps.db, request.access!),
    }));

    const OpenDmBody = z.object({ userId: z.string().uuid() });

    /**
     * Open, or re-open, a conversation.
     *
     * Idempotent - the same pair always gets the same thread, so the client can navigate
     * straight here without asking whether one exists. Returns 404 for a person who does not
     * exist, who shares no club, **or who has blocked the caller**, because a distinguishable
     * refusal would make the block detectable and rule 6 hides it everywhere else.
     */
    protectedRoutes.post('/dm/threads', async (request, reply) => {
      const body = OpenDmBody.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_body' });

      const result = await openDm(deps.db, request.access!, body.data.userId);
      if (!result.ok) {
        return reply
          .code(result.code === 'invalid' ? 400 : 404)
          .send({ error: result.code === 'invalid' ? 'invalid_body' : 'not_found' });
      }
      return reply.code(201).send(result);
    });

    // ---------------------------------------------------------------------
    // Blocking, and mute
    // ---------------------------------------------------------------------

    protectedRoutes.get('/blocks', async (request) => ({
      // Their own blocks only. "Who has blocked you" is never returned.
      blocks: await listBlocks(deps.db, request.access!),
    }));

    const BlockBody = z.object({ userId: z.string().uuid() });

    protectedRoutes.post('/blocks', async (request, reply) => {
      const body = BlockBody.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
      const result = await blockMember(deps.db, request.access!, body.data.userId);
      if (!result.ok) {
        return reply
          .code(result.code === 'invalid' ? 400 : 404)
          .send({ error: result.code === 'invalid' ? 'invalid_body' : 'not_found' });
      }
      return reply.code(201).send(result);
    });

    protectedRoutes.delete<{ Params: { uid: string } }>('/blocks/:uid', async (request, reply) => {
      const result = await unblockMember(deps.db, request.access!, request.params.uid);
      if (!result.ok) return reply.code(400).send({ error: 'invalid_body' });
      return result;
    });

    const MuteBody = z.object({
      /** Absent means indefinitely. The row's existence is the mute. */
      until: z.string().datetime().nullish(),
    });

    protectedRoutes.post<{ Params: { id: string } }>(
      '/channels/:id/mute',
      async (request, reply) => {
        const body = MuteBody.safeParse(request.body ?? {});
        if (!body.success) return reply.code(400).send({ error: 'invalid_body' });

        const guard = await authorizeChannel(request, request.params.id);
        if (!guard.ok) return reply.code(guard.code).send({ error: 'not_found' });

        const result = await muteChannel(
          deps.db,
          request.access!,
          guard.channel,
          body.data.until ? new Date(body.data.until) : null,
        );
        if (!result.ok) return reply.code(404).send({ error: 'not_found' });
        return result;
      },
    );

    protectedRoutes.delete<{ Params: { id: string } }>(
      '/channels/:id/mute',
      async (request, reply) => {
        const guard = await authorizeChannel(request, request.params.id);
        if (!guard.ok) return reply.code(guard.code).send({ error: 'not_found' });

        const result = await unmuteChannel(deps.db, request.access!, guard.channel);
        if (!result.ok) return reply.code(404).send({ error: 'not_found' });
        return result;
      },
    );

    // ---------------------------------------------------------------------
    // Reactions
    // ---------------------------------------------------------------------

    const ReactionBody = z.object({ emoji: ReactionEmoji });

    /**
     * Toggle a reaction.
     *
     * One endpoint for on and off, because "toggle" is the product behaviour and splitting it
     * into add and remove would put the decision of which to call in the client - where it is a
     * read-then-write across the network, and races with the other device the same member is
     * holding.
     *
     * `ReactionEmoji` here returns a clean 400 for an emoji outside the set. It is not the
     * enforcement: a check constraint on the column is, so no route and no second write path
     * can put arbitrary text in a column that renders directly into every client.
     */
    protectedRoutes.post<{ Params: { id: string; seq: string } }>(
      '/channels/:id/messages/:seq/reactions',
      async (request, reply) => {
        const seq = Number(request.params.seq);
        if (!Number.isInteger(seq) || seq <= 0) {
          return reply.code(400).send({ error: 'invalid_seq' });
        }

        const body = ReactionBody.safeParse(request.body);
        if (!body.success) return reply.code(400).send({ error: 'invalid_emoji' });

        const guard = await authorizeChannel(request, request.params.id);
        if (!guard.ok) return reply.code(guard.code).send({ error: 'not_found' });

        const result = await toggleReaction(
          deps.db,
          request.access!,
          guard.channel,
          seq,
          body.data.emoji,
        );
        if (!result.ok) {
          // 403 for a member who can read but not write here - a blocked DM participant. That
          // is a real distinction rather than a leak: they can already see the message.
          return reply.code(result.code === 'forbidden' ? 403 : 404).send({ error: result.code });
        }
        return result;
      },
    );

    /** Who reacted, for the who-reacted sheet. No gate beyond reading the channel. */
    protectedRoutes.get<{ Params: { id: string; seq: string } }>(
      '/channels/:id/messages/:seq/reactions',
      async (request, reply) => {
        const seq = Number(request.params.seq);
        if (!Number.isInteger(seq) || seq <= 0) {
          return reply.code(400).send({ error: 'invalid_seq' });
        }

        const guard = await authorizeChannel(request, request.params.id);
        if (!guard.ok) return reply.code(guard.code).send({ error: 'not_found' });

        const result = await readReactions(deps.db, guard.channel, seq);
        if (!result.ok) return reply.code(404).send({ error: 'not_found' });
        return result;
      },
    );

    // ---------------------------------------------------------------------
    // Reports, and the platform moderation queue
    // ---------------------------------------------------------------------

    protectedRoutes.post<{ Params: { id: string; seq: string } }>(
      '/channels/:id/messages/:seq/report',
      async (request, reply) => {
        const seq = Number(request.params.seq);
        if (!Number.isInteger(seq) || seq <= 0) {
          return reply.code(400).send({ error: 'invalid_seq' });
        }

        const guard = await authorizeChannel(request, request.params.id);
        if (!guard.ok) return reply.code(guard.code).send({ error: 'not_found' });

        const result = await reportMessage(deps.db, request.access!, guard.channel, seq);
        if (!result.ok) {
          return reply.code(result.code === 'forbidden' ? 403 : 404).send({ error: result.code });
        }
        return reply.code(201).send(result);
      },
    );

    /**
     * The Reports tab for one space.
     *
     * `not_found` for a dm channel even to a platform moderator: the queue is a separate
     * endpoint, so this one cannot become a way to read a private conversation by channel id.
     */
    protectedRoutes.get<{ Params: { id: string } }>(
      '/channels/:id/reports',
      async (request, reply) => {
        const channel = await getChannelRef(deps.db, request.params.id);
        if (!channel) return reply.code(404).send({ error: 'not_found' });

        const result = await listChannelReports(deps.db, request.access!, channel, {
          includeDismissed: (request.query as { all?: string }).all === 'true',
        });
        if (!result.ok) return reply.code(404).send({ error: 'not_found' });
        return result;
      },
    );

    /**
     * The DM report queue. Platform moderators only, and metadata only.
     *
     * A club admin gets 404 here even for a conversation between two of their own members:
     * **no club admin ever sees the contents of a DM** (PRD/14 rule 7).
     */
    protectedRoutes.get('/moderation/dm-reports', async (request, reply) => {
      const result = await listDmReportQueue(deps.db, request.access!, {
        includeDismissed: (request.query as { all?: string }).all === 'true',
      });
      if (!result.ok) return reply.code(404).send({ error: 'not_found' });
      return result;
    });

    /**
     * The reported message and its immediate context.
     *
     * The single, audit-logged door to DM content. The window is fixed by
     * `MODERATION_CONTEXT_RADIUS` and there is deliberately no parameter to widen it.
     */
    protectedRoutes.get<{ Params: { id: string } }>(
      '/moderation/reports/:id/context',
      async (request, reply) => {
        const result = await readReportedContext(deps.db, request.access!, request.params.id);
        if (!result.ok) return reply.code(404).send({ error: 'not_found' });
        return result;
      },
    );

    /** A moderator's own audit trail. */
    protectedRoutes.get('/moderation/reads', async (request, reply) => {
      const result = await listModerationReads(deps.db, request.access!);
      if (!result.ok) return reply.code(404).send({ error: 'not_found' });
      return result;
    });

    protectedRoutes.post<{ Params: { id: string } }>(
      '/moderation/reports/:id/dismiss',
      async (request, reply) => {
        const result = await dismissReport(deps.db, request.access!, request.params.id);
        if (!result.ok) return reply.code(404).send({ error: 'not_found' });
        return result;
      },
    );

    // ---------------------------------------------------------------------
    // The inbox
    // ---------------------------------------------------------------------

    const InboxQuery = z.object({
      cursor: z.string().optional(),
      limit: z.coerce.number().int().positive().max(100).optional(),
    });

    protectedRoutes.get('/notifications', async (request, reply) => {
      const query = InboxQuery.safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: 'invalid_query' });
      return readInbox(deps.db, request.userId!, query.data);
    });

    protectedRoutes.get('/notifications/badge', async (request) => ({
      count: await badgeCount(deps.db, request.userId!),
    }));

    /**
     * Opening the inbox.
     *
     * Clears the badge, but NOT chat-unread rows (only opening that chat does) and NOT
     * pending join requests (only opening the relevant roster does). See markInboxRead.
     */
    protectedRoutes.post('/notifications/read', async (request) => ({
      ...(await markInboxRead(deps.db, request.userId!)),
      badge: await badgeCount(deps.db, request.userId!),
    }));

    /**
     * Opening a club's member roster.
     *
     * The only thing that clears that club's pending join-request rows. Gated on admin,
     * since only the admin tier sees those requests in the first place.
     */
    protectedRoutes.post<{ Params: { id: string } }>(
      '/clubs/:id/members/seen',
      async (request, reply) => {
        if (!isClubAdmin(request.access!, request.params.id)) {
          return reply.code(404).send({ error: 'not_found' });
        }
        return markRosterSeen(deps.db, request.userId!, {
          kind: 'club',
          clubId: request.params.id,
        });
      },
    );

    // ---------------------------------------------------------------------
    // Devices
    // ---------------------------------------------------------------------

    const DeviceBody = z.object({
      pushToken: z.string().min(1).max(400),
      platform: Platform,
    });

    protectedRoutes.post('/devices', async (request, reply) => {
      const body = DeviceBody.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
      const device = await registerDevice(deps.db, {
        userId: request.userId!,
        ...body.data,
      });
      return reply.code(201).send(device);
    });

    /**
     * The reconnect and foreground path.
     *
     * `?channels[]={id}:{since_seq}`, repeated per channel. Each entry is authorized
     * independently and an unauthorized id is omitted from the response rather than
     * failing the whole call - a client holding a stale channel list (it was removed
     * from a club while offline) must still be able to sync the rest.
     */
    protectedRoutes.get('/sync', async (request, reply) => {
      const raw = (request.query as Record<string, unknown>)['channels[]'] ?? [];
      const entries = (Array.isArray(raw) ? raw : [raw]).map(String).filter(Boolean);
      if (entries.length === 0) return reply.code(400).send({ error: 'no_channels' });
      if (entries.length > 200) return reply.code(400).send({ error: 'too_many_channels' });

      const results: Array<{
        channelId: string;
        messages: unknown[];
        hasMore: boolean;
      }> = [];

      for (const entry of entries) {
        const separator = entry.lastIndexOf(':');
        if (separator <= 0) continue;
        const channelId = entry.slice(0, separator);
        const since = Number(entry.slice(separator + 1));
        if (!Number.isInteger(since) || since < 0) continue;

        const guard = await authorizeChannel(request, channelId);
        if (!guard.ok) continue;

        const page = await syncSince(deps.db, channelId, since);
        results.push({ channelId, messages: page.messages, hasMore: page.hasMore });
      }

      return { channels: results, serverTime: new Date().toISOString() };
    });
  });

  return app;
}
