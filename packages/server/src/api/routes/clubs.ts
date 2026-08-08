/**
 * Clubs and membership.
 *
 * Every refusal here goes through `refusalStatus`, which answers 404 for both "forbidden"
 * and "not found". A member who has no business with a club must not learn whether it
 * exists, and a distinguishable 403 would tell them.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { JoinPolicy } from '@clubchat/shared';
import { createClub } from '../../domain/create-club.ts';
import {
  addMember,
  banFromClub,
  changeRole,
  decideJoinRequest,
  deleteClub,
  joinClub,
  leaveClub,
  liftClubBan,
  listClubBans,
  readClub,
  readClubRoster,
  rotateInviteToken,
  redeemInvite,
  removeMember,
  setJoinPolicy,
  updateClub,
  transferOwnership,
} from '../../domain/membership.ts';
import { searchMemberCandidates } from '../../domain/member-candidates.ts';
import { listClubsForUser } from '../../domain/reads.ts';
import { markRosterSeen } from '../../domain/inbox.ts';
import { isClubAdmin } from '../../policy/predicates.ts';
import { refusalStatus, type AppDeps } from '../plumbing.ts';

export function registerClubRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get('/clubs', async (request) => ({
    clubs: await listClubsForUser(deps.db, request.userId!),
  }));

  const CreateClubBody = z.object({
    name: z.string().min(1).max(120),
    sport: z.string().min(1).max(60),
    description: z.string().max(2_000).nullish(),
    joinPolicy: JoinPolicy.default('open'),
  });

  app.post('/clubs', async (request, reply) => {
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

  app.get<{ Params: { id: string } }>('/clubs/:id', async (request, reply) => {
    const result = await readClub(deps.db, request.access!, request.params.id);
    if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
    return result;
  });

  app.get<{ Params: { id: string } }>('/clubs/:id/members', async (request, reply) => {
    const result = await readClubRoster(deps.db, request.access!, request.params.id);
    if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
    return result;
  });

  app.post<{ Params: { id: string } }>('/clubs/:id/join', async (request, reply) => {
    const result = await joinClub(deps.db, request.userId!, request.params.id);
    if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
    return result;
  });

  app.post<{ Params: { token: string } }>('/invites/:token/redeem', async (request, reply) => {
    const result = await redeemInvite(deps.db, request.userId!, request.params.token);
    if (!result.ok) {
      // A revoked or malformed link gets a plain "no longer valid", never a hint about
      // which clubs exist.
      return reply.code(404).send({ error: 'invite_invalid' });
    }
    return result;
  });

  app.post<{ Params: { id: string } }>('/join-requests/:id/approve', async (request, reply) => {
    const result = await decideJoinRequest(deps.db, request.access!, request.params.id, true);
    if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
    return result;
  });

  app.post<{ Params: { id: string } }>('/join-requests/:id/deny', async (request, reply) => {
    const result = await decideJoinRequest(deps.db, request.access!, request.params.id, false);
    if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
    return result;
  });

  /*
   * Who this club could add.
   *
   * Sits beside the add rather than under `/users`, because the answer is entirely a fact about
   * this club: who is eligible, and who is already in. Authorized by the same predicate the add
   * uses, so a member who cannot add cannot enumerate the roster by exclusion either.
   */
  app.get<{ Params: { id: string }; Querystring: { q?: string } }>(
    '/clubs/:id/member-candidates',
    async (request, reply) => {
      const result = await searchMemberCandidates(
        deps.db,
        request.access!,
        { kind: 'club', clubId: request.params.id },
        { query: request.query.q },
      );
      if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
      return result;
    },
  );

  const AddMemberBody = z.object({ userId: z.string().uuid() });
  app.post<{ Params: { id: string } }>('/clubs/:id/members', async (request, reply) => {
    const body = AddMemberBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const result = await addMember(deps.db, request.access!, request.params.id, body.data.userId);
    if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
    return result;
  });

  const RoleBody = z.object({ role: z.enum(['admin', 'member']) });
  app.patch<{ Params: { id: string; uid: string } }>(
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

  app.delete<{ Params: { id: string; uid: string } }>(
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

  /*
   * Bans: three routes, and the shape of them is the decision.
   *
   * `POST /clubs/:id/bans` imposes and `DELETE /clubs/:id/bans/:uid` lifts, which look symmetric
   * and are not - any admin may call the second, while the first follows the removal ladder and
   * restricts banning an admin to the Owner. That asymmetry is deliberate and is the whole
   * safeguard against a rogue admin (ADR-0021): a wrongful ban must be cheaper to reverse than to
   * impose.
   *
   * Separate from `DELETE /clubs/:id/members/:uid` rather than a flag on it. A ban is a removal
   * that sticks, and folding the two into one route taking `{ ban: true }` would make the heavier
   * act reachable by editing a payload - the same argument that keeps `setPinned` and
   * `softDeleteMessage` two routes instead of one PATCH over a message.
   */
  const BanBody = z.object({ userId: z.string().uuid() });

  app.post<{ Params: { id: string } }>('/clubs/:id/bans', async (request, reply) => {
    const body = BanBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });

    const result = await banFromClub(
      deps.db,
      request.access!,
      request.params.id,
      body.data.userId,
    );
    if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
    return reply.code(201).send(result);
  });

  app.delete<{ Params: { id: string; uid: string } }>(
    '/clubs/:id/bans/:uid',
    async (request, reply) => {
      const result = await liftClubBan(
        deps.db,
        request.access!,
        request.params.id,
        request.params.uid,
      );
      if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
      return result;
    },
  );

  /** The list every admin can read, which is what makes the attribution a check rather than a log. */
  app.get<{ Params: { id: string } }>('/clubs/:id/bans', async (request, reply) => {
    const result = await listClubBans(deps.db, request.access!, request.params.id);
    if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
    return result;
  });

  app.post<{ Params: { id: string } }>('/clubs/:id/leave', async (request, reply) => {
    const result = await leaveClub(deps.db, request.access!, request.params.id);
    if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
    return result;
  });

  const TransferBody = z.object({ toUserId: z.string().uuid() });
  app.post<{ Params: { id: string } }>(
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
  /*
   * Edit the club.
   *
   * One request from the form's point of view, two handlers underneath, and that split is
   * deliberate: switching the policy to `open` auto-approves every pending request, which is a
   * membership effect that belongs in one transaction with the policy change rather than mixed
   * into an identity update. The route applies the identity fields first and the policy second,
   * so a rejected policy change cannot leave a half-renamed club.
   */
  const EditClubBody = z.object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(2_000).nullish(),
    image: z.string().uuid().nullish(),
    joinPolicy: JoinPolicy.optional(),
  });

  app.patch<{ Params: { id: string } }>('/clubs/:id', async (request, reply) => {
    const body = EditClubBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });

    const { joinPolicy, ...identity } = body.data;

    if (identity.name !== undefined || identity.description !== undefined || identity.image !== undefined) {
      const updated = await updateClub(deps.db, request.access!, request.params.id, identity);
      if (!updated.ok) {
        return reply.code(refusalStatus(updated.code)).send({ error: updated.code });
      }
    }

    if (joinPolicy !== undefined) {
      const result = await setJoinPolicy(deps.db, request.access!, request.params.id, joinPolicy);
      if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
      return result;
    }

    return { ok: true, autoApproved: 0 };
  });

  app.delete<{ Params: { id: string } }>('/clubs/:id', async (request, reply) => {
    const result = await deleteClub(deps.db, request.access!, request.params.id);
    if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
    return { deleted: true };
  });

  /**
   * Rotate the invite token, invalidating every outstanding link at once.
   *
   * That total invalidation is the feature, not a caveat: the link is the ONLY invite mechanism
   * since ADR-0010 removed the typed code, so a leaked one has no alternative to fall back on
   * and rotation is the sole remedy. A rotation that left the old link working would be theatre.
   *
   * The new token comes back in the response, because the caller is an admin who is entitled to
   * it and has just asked for a link to share.
   */
  app.post<{ Params: { id: string } }>('/clubs/:id/invite-token/rotate', async (request, reply) => {
    const result = await rotateInviteToken(deps.db, request.access!, request.params.id);
    if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
    return result;
  });

  /**
   * Opening a club's member roster.
   *
   * The only thing that clears that club's pending join-request rows. Gated on admin,
   * since only the admin tier sees those requests in the first place.
   */
  app.post<{ Params: { id: string } }>('/clubs/:id/members/seen', async (request, reply) => {
    if (!isClubAdmin(request.access!, request.params.id)) {
      return reply.code(404).send({ error: 'not_found' });
    }
    return markRosterSeen(deps.db, request.userId!, {
      kind: 'club',
      clubId: request.params.id,
    });
  });
}
