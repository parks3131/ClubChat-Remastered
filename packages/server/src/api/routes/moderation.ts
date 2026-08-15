/**
 * Reporting, the per-space Reports tab, and the two platform moderation queues.
 *
 * Grouped by where a report *goes* rather than by which path it starts from, because the
 * routing rule is the whole point: a club report reaches that club's admins, and a DM report
 * reaches a platform moderator and no club admin ever (PRD/14 rule 7).
 *
 * **`POST /users/:uid/report` lives here despite not carrying the prefix**, and that is the file
 * grouping earning its keep: a report about a person routes to platform moderators and to nobody
 * else (ADR-0035), so it belongs beside the queue that receives it rather than beside the profile
 * read that shares its path.
 */

import type { FastifyInstance } from 'fastify';
import {
  dismissReport,
  dismissUserReport,
  listChannelReports,
  listDmReportQueue,
  listModerationReads,
  listUserReportQueue,
  readReportedContext,
  removeReportedMessage,
  reportMessage,
  reportUser,
  setAccountSuspended,
} from '../../domain/moderation.ts';
import { getChannelRef } from '../../domain/reads.ts';
import { authorizeChannel, isUuid, type AppDeps } from '../plumbing.ts';

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
   * Report a **person**, from their member card.
   *
   * `POST /users/:uid/report` rather than anything under `/moderation`, because the caller is an
   * ordinary member and the path a member uses should name what they are acting on. The
   * `/moderation` prefix is for the reviewing half, which this is not.
   *
   * Every refusal is `not_found`, including "you may not report this person": a distinguishable
   * code would turn the route into a way to test whether a uuid is a real member, which is the
   * same reasoning `GET /users/:id` records.
   */
  app.post<{ Params: { uid: string } }>('/users/:uid/report', async (request, reply) => {
    if (!isUuid(request.params.uid)) return reply.code(404).send({ error: 'not_found' });

    const result = await reportUser(deps.db, request.access!, request.params.uid);
    if (!result.ok) return reply.code(404).send({ error: 'not_found' });
    return reply.code(201).send(result);
  });

  /**
   * The person report queue. Platform moderators only.
   *
   * Separate from `/moderation/dm-reports` rather than merged into it, because the two carry
   * different things and are worked differently: that one leads to an audited read of a
   * conversation, and this one has no conversation to read. One list mixing them would have to
   * explain per row which of those it is.
   */
  app.get('/moderation/user-reports', async (request, reply) => {
    const result = await listUserReportQueue(deps.db, request.access!, {
      includeDismissed: (request.query as { all?: string }).all === 'true',
    });
    if (!result.ok) return reply.code(404).send({ error: 'not_found' });
    return result;
  });

  /**
   * Close every open report about one person.
   *
   * Addressed by the SUBJECT, not by a report id, which is the same shape as dismissing a message
   * report by its message: the decision is about the account, and the reporters are evidence for
   * it rather than separate work items.
   */
  app.post<{ Params: { uid: string } }>(
    '/moderation/user-reports/:uid/dismiss',
    async (request, reply) => {
      if (!isUuid(request.params.uid)) return reply.code(404).send({ error: 'not_found' });

      const result = await dismissUserReport(deps.db, request.access!, request.params.uid);
      if (!result.ok) return reply.code(404).send({ error: 'not_found' });
      return result;
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

  /**
   * Remove a reported message. **The "removing the content" half of Apple's guideline 1.2.**
   *
   * A soft delete with a tombstone, like every other delete in the product, and addressed by the
   * REPORT rather than by the channel and seq - so this cannot become a way to delete a message
   * in a conversation nobody complained about.
   */
  app.post<{ Params: { id: string } }>(
    '/moderation/reports/:id/remove',
    async (request, reply) => {
      const result = await removeReportedMessage(deps.db, request.access!, request.params.id);
      if (!result.ok) return reply.code(404).send({ error: 'not_found' });
      return result;
    },
  );

  /**
   * Suspend an account, or lift a suspension. **The "ejecting the user" half of guideline 1.2.**
   *
   * A boolean body rather than two verbs, matching `POST /polls/:id/closed` and
   * `POST /races/:id/pin` - the state is being set, and the two directions carry deliberately
   * different authority, which the domain applies rather than the router.
   *
   * `messageId` is the report that prompted it, optional and recorded in the audit trail. It
   * stands in for the free-text reason ADR-0021 rejected: evidence rather than prose.
   */
  app.post<{ Params: { uid: string } }>(
    '/moderation/users/:uid/suspended',
    async (request, reply) => {
      const body = (request.body ?? {}) as { suspended?: unknown; messageId?: unknown };
      if (typeof body.suspended !== 'boolean') {
        return reply.code(400).send({ error: 'invalid_suspended' });
      }
      const messageId = typeof body.messageId === 'string' ? body.messageId : undefined;
      if (messageId !== undefined && !isUuid(messageId)) {
        return reply.code(400).send({ error: 'invalid_message_id' });
      }

      const result = await setAccountSuspended(
        deps.db,
        request.access!,
        request.params.uid,
        body.suspended,
        { messageId },
      );
      if (!result.ok) return reply.code(404).send({ error: 'not_found' });
      return result;
    },
  );
}
