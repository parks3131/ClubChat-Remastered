/**
 * The Eboard space.
 *
 * Read the domain module first: membership normally manages itself, because promotion auto-joins
 * and demotion auto-removes. These routes are the space's identity, its roster, and the rejoin
 * path for an admin who left - which had no table at all until Phase 3.75a.
 *
 * Note what is absent, deliberately. There is no "create" route: every club gets exactly one
 * space at club creation and nobody can make another. There is no delete route either - rule 12
 * allows it, and deleting a space whose chat, meetings and polls go with it is a destructive
 * operation whose confirmation flow belongs with the screen that offers it (Phase 3.75b).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  addEboardMembers,
  decideEboardRequest,
  readEboard,
  readEboardRoster,
  removeEboardMember,
  requestEboardAccess,
  updateEboard,
} from '../../domain/eboard.ts';
import { markRosterSeen } from '../../domain/inbox.ts';
import { searchMemberCandidates } from '../../domain/member-candidates.ts';
import { refusalStatus, type AppDeps } from '../plumbing.ts';

export function registerEboardRoutes(app: FastifyInstance, deps: AppDeps): void {
  /**
   * The space, for both of the states the screen map names: the landing screen for an admin who
   * is not a member, and the space proper for one who is. An ordinary club member gets 404,
   * because rule 4 gives them no visibility that it exists.
   */
  app.get<{ Params: { id: string } }>('/eboards/:id', async (request, reply) => {
    const result = await readEboard(deps.db, request.access!, request.params.id);
    if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
    return result;
  });

  /**
   * The space's identity: name, description, picture.
   *
   * Members only, which the domain enforces - a club admin outside the space reads it (that is
   * how they get the landing screen) and cannot rename it.
   */
  const EditEboardBody = z.object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().max(2_000).nullish(),
    image: z.string().uuid().nullish(),
  });

  app.patch<{ Params: { id: string } }>('/eboards/:id', async (request, reply) => {
    const body = EditEboardBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const result = await updateEboard(deps.db, request.access!, request.params.id, body.data);
    if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
    return result;
  });

  app.get<{ Params: { id: string } }>('/eboards/:id/members', async (request, reply) => {
    const result = await readEboardRoster(deps.db, request.access!, request.params.id);
    if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
    return result;
  });

  /** Opening the roster clears that space's pending-request notifications. */
  app.post<{ Params: { id: string } }>('/eboards/:id/members/seen', async (request, reply) => {
    const guard = await readEboardRoster(deps.db, request.access!, request.params.id);
    if (!guard.ok) return reply.code(404).send({ error: 'not_found' });
    return markRosterSeen(deps.db, request.userId!, {
      kind: 'eboard',
      eboardId: request.params.id,
    });
  });

  /** The path nobody uses in normal operation, and the only way back in for an admin who left. */
  app.post<{ Params: { id: string } }>('/eboards/:id/join-requests', async (request, reply) => {
    const result = await requestEboardAccess(deps.db, request.access!, request.params.id);
    if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
    return reply.code(201).send(result);
  });

  app.post<{ Params: { id: string } }>(
    '/eboard-join-requests/:id/approve',
    async (request, reply) => {
      const result = await decideEboardRequest(deps.db, request.access!, request.params.id, true);
      if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
      return result;
    },
  );

  app.post<{ Params: { id: string } }>(
    '/eboard-join-requests/:id/deny',
    async (request, reply) => {
      const result = await decideEboardRequest(deps.db, request.access!, request.params.id, false);
      if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
      return result;
    },
  );

  /**
   * Who this space could add.
   *
   * **Admin tier of the club only**, because `addEboardMembers` refuses anybody else - this
   * space is for the admin tier, and adding a plain member would put somebody in it whom a
   * later demotion could not remove. Offering them here would advertise a capability the
   * command refuses.
   *
   * `limit` is for the roster's picker, which lists the eligible admins to be scrolled rather
   * than waiting to be searched. The read caps it at 100 whatever is asked for.
   */
  const CandidateQuery = z.object({
    q: z.string().max(200).optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
  });

  app.get<{ Params: { id: string } }>('/eboards/:id/member-candidates', async (request, reply) => {
    const query = CandidateQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_query' });

    const result = await searchMemberCandidates(
      deps.db,
      request.access!,
      { kind: 'eboard', eboardId: request.params.id },
      { query: query.data.q, limit: query.data.limit },
    );
    if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
    return result;
  });

  /** A list, because the picker adds a whole selection in one act. */
  const AddMembersBody = z.object({ userIds: z.array(z.string().uuid()).min(1).max(100) });

  app.post<{ Params: { id: string } }>('/eboards/:id/members', async (request, reply) => {
    const body = AddMembersBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });

    const result = await addEboardMembers(
      deps.db,
      request.access!,
      request.params.id,
      body.data.userIds,
    );
    if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
    return result;
  });

  /**
   * Leave, or be removed.
   *
   * One route for both, decided by comparing the target to the caller - the same shape as the
   * race roster, and with the same reason: they are one effect on the data. The authorities
   * differ sharply, though. Leaving needs none; removing somebody else is the club **Owner**
   * only, which is the strictest removal rule in the product.
   */
  app.delete<{ Params: { id: string; uid: string } }>(
    '/eboards/:id/members/:uid',
    async (request, reply) => {
      const result = await removeEboardMember(
        deps.db,
        request.access!,
        request.params.id,
        request.params.uid,
      );
      if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
      return result;
    },
  );
}
