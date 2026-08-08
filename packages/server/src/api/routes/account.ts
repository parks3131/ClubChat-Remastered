/**
 * The signed-in account: who am I, my profile, another member's profile card, deletion.
 *
 * `GET /me` predates this group and stays in `app.ts` beside the session hook, because it is a
 * report on the access context rather than a read of the user row.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  deleteOwnAccount,
  readProfile,
  updateOwnProfile,
} from '../../domain/account.ts';
import { searchClubs } from '../../domain/membership.ts';
import { refusalStatus, type AppDeps } from '../plumbing.ts';

export function registerAccountRoutes(app: FastifyInstance, deps: AppDeps): void {
  /**
   * Another member's profile card, or your own.
   *
   * One route for both, because the difference is a field rather than a screen: `readProfile`
   * returns `dob` only to its owner. Withholding it in the response rather than in the UI is the
   * point - clubs are small and often include minors, and nothing needs to show one member
   * another's birthday.
   */
  const ProfileQuery = z.object({ clubId: z.string().uuid().optional() });

  app.get<{ Params: { id: string } }>('/users/:id', async (request, reply) => {
    /*
     * `?clubId=` asks the club-scoped question as well: what may I do to this person HERE.
     *
     * Optional, because a profile is not a club-scoped object - the same person is bannable by
     * you in one club and untouchable in another. Answered on this read rather than by a second
     * request, so the screen reached from a roster draws its controls from the server's answer
     * instead of restating a ladder that has exactly one definition.
     */
    const query = ProfileQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_query' });

    const result = await readProfile(deps.db, request.access!, request.params.id, {
      clubId: query.data.clubId,
    });
    if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
    return result;
  });

  const ProfileBody = z.object({
    name: z.string().min(1).max(200).optional(),
    bio: z.string().max(2_000).nullish(),
    city: z.string().max(200).nullish(),
    school: z.string().max(200).nullish(),
    // A calendar day. Sending a timestamp here is the negative-offset bug waiting to happen.
    dob: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
      .nullish(),
    /** An avatar already uploaded and completed through the media pipeline. */
    image: z.string().max(2_000).nullish(),
  });

  /**
   * Edit your own profile.
   *
   * **There is no `PATCH /users/:id`, and that is the enforcement.** A self-only rule expressed
   * as "compare the target to the caller" is a check that can be forgotten; expressed as a route
   * with no target at all, editing somebody else has no way to be requested. PRD/03 rule 5
   * includes the Owner in "nobody".
   */
  app.patch('/me/profile', async (request, reply) => {
    const body = ProfileBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: body.error.issues });
    }

    const result = await updateOwnProfile(deps.db, request.access!, body.data);
    if (!result.ok) {
      return reply
        .code(result.code === 'invalid' ? 400 : refusalStatus(result.code))
        .send({ error: result.code });
    }
    return result;
  });

  /**
   * Delete your own account: anonymise the profile, block future sign-in, leave the content.
   *
   * `DELETE /me` rather than a `/me/delete` action, and again with no target parameter: the only
   * account this route can delete is the caller's.
   *
   * 409 for `owns_clubs`, which is the one refusal that is not about authority - a club Owner has
   * to transfer or delete each club first, because an ownerless club has no recovery path. The
   * client is expected to turn that into "hand these over first", so it stays self-service.
   */
  app.delete('/me', async (request, reply) => {
    const result = await deleteOwnAccount(deps.db, request.access!);
    if (!result.ok) {
      return reply
        .code(result.code === 'owns_clubs' ? 409 : refusalStatus(result.code))
        .send({ error: result.code });
    }
    return result;
  });

  const SearchQuery = z.object({
    q: z.string().max(200),
    limit: z.coerce.number().int().positive().max(25).optional(),
  });

  /**
   * Find a club to join.
   *
   * Lives with the account routes rather than the club routes on purpose: every other
   * `/clubs/...` route is for somebody already inside one, and this is the only one written for
   * somebody outside. Grouping it with them would put a non-member read in a file whose reader
   * is entitled to assume membership.
   */
  app.get('/clubs/search', async (request, reply) => {
    const query = SearchQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_query' });

    return {
      clubs: await searchClubs(deps.db, request.access!, {
        query: query.data.q,
        limit: query.data.limit,
      }),
    };
  });
}
