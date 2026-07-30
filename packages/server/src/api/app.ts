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
import { isChannelMember } from '../policy/predicates.ts';

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
};

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

        const lastReadSeq = await advanceReadCursor(
          deps.db,
          request.userId!,
          request.params.id,
          body.data.upToSeq,
        );
        return { channelId: request.params.id, lastReadSeq };
      },
    );

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
