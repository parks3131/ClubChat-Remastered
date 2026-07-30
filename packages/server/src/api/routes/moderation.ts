/**
 * Reporting, the per-space Reports tab, and the platform moderation queue.
 *
 * Grouped by where a report *goes* rather than by which path it starts from, because the
 * routing rule is the whole point: a club report reaches that club's admins, and a DM report
 * reaches a platform moderator and no club admin ever (PRD/14 rule 7).
 */

import type { FastifyInstance } from 'fastify';
import {
  dismissReport,
  listChannelReports,
  listDmReportQueue,
  listModerationReads,
  readReportedContext,
  reportMessage,
} from '../../domain/moderation.ts';
import { getChannelRef } from '../../domain/reads.ts';
import { authorizeChannel, type AppDeps } from '../plumbing.ts';

export function registerModerationRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.post<{ Params: { id: string; seq: string } }>(
    '/channels/:id/messages/:seq/report',
    async (request, reply) => {
      const seq = Number(request.params.seq);
      if (!Number.isInteger(seq) || seq <= 0) {
        return reply.code(400).send({ error: 'invalid_seq' });
      }

      const guard = await authorizeChannel(deps, request, request.params.id);
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
  app.get<{ Params: { id: string } }>('/channels/:id/reports', async (request, reply) => {
    const channel = await getChannelRef(deps.db, request.params.id);
    if (!channel) return reply.code(404).send({ error: 'not_found' });

    const result = await listChannelReports(deps.db, request.access!, channel, {
      includeDismissed: (request.query as { all?: string }).all === 'true',
    });
    if (!result.ok) return reply.code(404).send({ error: 'not_found' });
    return result;
  });

  /**
   * The DM report queue. Platform moderators only, and metadata only.
   *
   * A club admin gets 404 here even for a conversation between two of their own members:
   * **no club admin ever sees the contents of a DM** (PRD/14 rule 7).
   */
  app.get('/moderation/dm-reports', async (request, reply) => {
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
  app.get<{ Params: { id: string } }>(
    '/moderation/reports/:id/context',
    async (request, reply) => {
      const result = await readReportedContext(deps.db, request.access!, request.params.id);
      if (!result.ok) return reply.code(404).send({ error: 'not_found' });
      return result;
    },
  );

  /** A moderator's own audit trail. */
  app.get('/moderation/reads', async (request, reply) => {
    const result = await listModerationReads(deps.db, request.access!);
    if (!result.ok) return reply.code(404).send({ error: 'not_found' });
    return result;
  });

  app.post<{ Params: { id: string } }>(
    '/moderation/reports/:id/dismiss',
    async (request, reply) => {
      const result = await dismissReport(deps.db, request.access!, request.params.id);
      if (!result.ok) return reply.code(404).send({ error: 'not_found' });
      return result;
    },
  );
}
