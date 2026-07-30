/**
 * Races, their rosters, Meet Information, and car groups.
 *
 * The authority-versus-access boundary is the whole story of this group, and it is worth
 * stating where the routes are since it is invisible from any single one of them: a club admin
 * manages every race in their club and thereby gains **no** access to one. So
 * `POST /races/:id/members` succeeds for a manager with no roster row, and
 * `GET /races/:id/car-groups` gives that same manager a 404. Both are correct. Substituting
 * one for the other was wrong in five separate places in v1, which is why every route below
 * names the predicate it wants instead of asking whether the caller is an admin.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { markRosterSeen } from '../../domain/inbox.ts';
import {
  addRaceMember,
  assignToCarGroup,
  createCarGroup,
  createRace,
  decideRaceRequest,
  deleteRace,
  leaveCarGroup,
  listRaces,
  readCarGroups,
  readRace,
  readRaceRoster,
  removeRaceMember,
  requestRaceAccess,
  setCarGroupIncharge,
  setRacePin,
  updateMeetInformation,
} from '../../domain/races.ts';
import { refusalStatus, type AppDeps } from '../plumbing.ts';

export function registerRaceRoutes(app: FastifyInstance, deps: AppDeps): void {
  // ---------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------

  const ListQuery = z.object({
    q: z.string().max(200).optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
  });

  app.get<{ Params: { id: string } }>('/clubs/:id/races', async (request, reply) => {
    const query = ListQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_query' });

    const result = await listRaces(deps.db, request.access!, request.params.id, {
      query: query.data.q,
      limit: query.data.limit,
    });
    if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
    return result;
  });

  /** The preview, the manager hub and a member's race are all this one read (PRD/09 rule 13). */
  app.get<{ Params: { id: string } }>('/races/:id', async (request, reply) => {
    const result = await readRace(deps.db, request.access!, request.params.id);
    if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
    return result;
  });

  app.get<{ Params: { id: string } }>('/races/:id/members', async (request, reply) => {
    const result = await readRaceRoster(deps.db, request.access!, request.params.id);
    if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
    return result;
  });

  app.get<{ Params: { id: string } }>('/races/:id/car-groups', async (request, reply) => {
    const result = await readCarGroups(deps.db, request.access!, request.params.id);
    if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
    return result;
  });

  /**
   * Opening the race roster, which clears that race's pending-request notifications.
   *
   * Gated on the same read the screen performs rather than on the manage predicate: whoever
   * may open the roster may clear the badge they just looked at. A member with no standing
   * gets 404 from the read above and never reaches this.
   */
  app.post<{ Params: { id: string } }>('/races/:id/members/seen', async (request, reply) => {
    const guard = await readRaceRoster(deps.db, request.access!, request.params.id);
    if (!guard.ok) return reply.code(404).send({ error: 'not_found' });
    return markRosterSeen(deps.db, request.userId!, {
      kind: 'race',
      raceId: request.params.id,
    });
  });

  // ---------------------------------------------------------------------
  // The race itself
  // ---------------------------------------------------------------------

  const CreateRaceBody = z.object({
    name: z.string().min(1).max(200),
    // A DATE, not a timestamp: a race has a day, not a time. Validated as `YYYY-MM-DD` and
    // passed through as a string, so it is never parsed into a Date and re-serialised - an
    // ISO date parsed as UTC midnight renders a day early in negative-offset zones.
    raceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD'),
  });

  app.post<{ Params: { id: string } }>('/clubs/:id/races', async (request, reply) => {
    const body = CreateRaceBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: body.error.issues });
    }
    const result = await createRace(deps.db, request.access!, {
      clubId: request.params.id,
      ...body.data,
    });
    if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
    return reply.code(201).send(result);
  });

  app.delete<{ Params: { id: string } }>('/races/:id', async (request, reply) => {
    const result = await deleteRace(deps.db, request.access!, request.params.id);
    if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
    return result;
  });

  /**
   * Meet Information: five fields, written as one form.
   *
   * `PATCH` by verb and a whole-form write by behaviour, deliberately. Every field is
   * `nullish` and an absent one is cleared, because PRD/09 rule 10 treats the five as atomic -
   * a per-field endpoint is what invites the partial saves the single-form design exists to
   * avoid. The domain handler does the same, so there is one story rather than two.
   */
  const MeetInfoBody = z.object({
    meetDescription: z.string().max(5_000).nullish(),
    meetLocationUrl: z.string().max(2_000).nullish(),
    meetHotelUrl: z.string().max(2_000).nullish(),
    meetPhotosUrl: z.string().max(2_000).nullish(),
    meetResultsUrl: z.string().max(2_000).nullish(),
  });

  app.patch<{ Params: { id: string } }>('/races/:id/meet-information', async (request, reply) => {
    const body = MeetInfoBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const result = await updateMeetInformation(
      deps.db,
      request.access!,
      request.params.id,
      body.data,
    );
    if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
    return result;
  });

  const PinBody = z.object({ pinned: z.boolean() });

  /** Personal. Any member may pin any race they can see; it affects nobody else's hub. */
  app.post<{ Params: { id: string } }>('/races/:id/pin', async (request, reply) => {
    const body = PinBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const result = await setRacePin(
      deps.db,
      request.access!,
      request.params.id,
      body.data.pinned,
    );
    if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
    return result;
  });

  // ---------------------------------------------------------------------
  // The roster
  // ---------------------------------------------------------------------

  /** Access is always by request - there is no open race policy. */
  app.post<{ Params: { id: string } }>('/races/:id/join-requests', async (request, reply) => {
    const result = await requestRaceAccess(deps.db, request.access!, request.params.id);
    if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
    return reply.code(201).send(result);
  });

  app.post<{ Params: { id: string } }>(
    '/race-join-requests/:id/approve',
    async (request, reply) => {
      const result = await decideRaceRequest(deps.db, request.access!, request.params.id, true);
      if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
      return result;
    },
  );

  app.post<{ Params: { id: string } }>('/race-join-requests/:id/deny', async (request, reply) => {
    const result = await decideRaceRequest(deps.db, request.access!, request.params.id, false);
    if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
    return result;
  });

  const AddRaceMemberBody = z.object({ userId: z.string().uuid() });

  app.post<{ Params: { id: string } }>('/races/:id/members', async (request, reply) => {
    const body = AddRaceMemberBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const result = await addRaceMember(
      deps.db,
      request.access!,
      request.params.id,
      body.data.userId,
    );
    if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
    return result;
  });

  /**
   * Leaving, and being removed, are the same route.
   *
   * The domain handler decides which one this is by comparing the target to the caller, and the
   * two have different predicates - leaving is a member's own business, removing somebody else
   * is a manager's. One route because they are one effect on the data, and splitting them would
   * put the choice of which to call in the client.
   */
  app.delete<{ Params: { id: string; uid: string } }>(
    '/races/:id/members/:uid',
    async (request, reply) => {
      const result = await removeRaceMember(
        deps.db,
        request.access!,
        request.params.id,
        request.params.uid,
      );
      if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
      return result;
    },
  );

  // ---------------------------------------------------------------------
  // Car groups
  // ---------------------------------------------------------------------

  /** Auto-numbered, with no name in the request: naming eight cars is friction. */
  app.post<{ Params: { id: string } }>('/races/:id/car-groups', async (request, reply) => {
    const result = await createCarGroup(deps.db, request.access!, request.params.id);
    if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
    return reply.code(201).send(result);
  });

  const AssignBody = z.object({ userId: z.string().uuid() });

  app.post<{ Params: { id: string } }>('/car-groups/:id/members', async (request, reply) => {
    const body = AssignBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const result = await assignToCarGroup(
      deps.db,
      request.access!,
      request.params.id,
      body.data.userId,
    );
    if (!result.ok) {
      // 409 for `already_member`: they are in a different group for this race, which is
      // invariant 5 refusing rather than an authorization answer.
      return reply.code(refusalStatus(result.code)).send({ error: result.code });
    }
    return result;
  });

  /** Null clears it. The Incharge must be a current member of that group. */
  const InchargeBody = z.object({ userId: z.string().uuid().nullable() });

  app.patch<{ Params: { id: string } }>('/car-groups/:id/incharge', async (request, reply) => {
    const body = InchargeBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const result = await setCarGroupIncharge(
      deps.db,
      request.access!,
      request.params.id,
      body.data.userId,
    );
    if (!result.ok) {
      // 409 for `invalid`: naming somebody who is not in the car is a state refusal, and the
      // one person everyone calls when the car does not show up is worth a distinct code.
      return reply.code(refusalStatus(result.code)).send({ error: result.code });
    }
    return result;
  });

  /**
   * Leave, or be removed from, a car group without leaving the race.
   *
   * Keyed by race rather than by group, because a person is in at most one group per race
   * (invariant 5) - so the race plus the person identifies the membership, and asking the
   * caller to also name the group would let them name the wrong one.
   */
  app.delete<{ Params: { id: string; uid: string } }>(
    '/races/:id/car-group-members/:uid',
    async (request, reply) => {
      const result = await leaveCarGroup(
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
