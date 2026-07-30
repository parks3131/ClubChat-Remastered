/**
 * Direct messages, and member blocking.
 *
 * A DM is the fourth channel scope rather than a separate feature, so the chat routes serve
 * it unchanged (ADR-0009). What lives here is only what has no club-scoped counterpart:
 * opening a thread, finding somebody to open one with, and the block list.
 *
 * Mute is deliberately NOT here - it is per-conversation in every scope, so it sits with the
 * channel routes.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  blockMember,
  listBlocks,
  listDmThreads,
  openDm,
  searchDmCandidates,
  unblockMember,
} from '../../domain/dm.ts';
import type { AppDeps } from '../plumbing.ts';

export function registerDmRoutes(app: FastifyInstance, deps: AppDeps): void {
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
  app.get('/dm/candidates', async (request, reply) => {
    const query = CandidateQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_query' });
    return {
      candidates: await searchDmCandidates(deps.db, request.access!, {
        query: query.data.q,
        limit: query.data.limit,
      }),
    };
  });

  app.get('/dm/threads', async (request) => ({
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
  app.post('/dm/threads', async (request, reply) => {
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

  app.get('/blocks', async (request) => ({
    // Their own blocks only. "Who has blocked you" is never returned.
    blocks: await listBlocks(deps.db, request.access!),
  }));

  const BlockBody = z.object({ userId: z.string().uuid() });

  app.post('/blocks', async (request, reply) => {
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

  app.delete<{ Params: { uid: string } }>('/blocks/:uid', async (request, reply) => {
    const result = await unblockMember(deps.db, request.access!, request.params.uid);
    if (!result.ok) return reply.code(400).send({ error: 'invalid_body' });
    return result;
  });
}
