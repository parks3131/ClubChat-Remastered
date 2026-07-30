/**
 * Polls, in all three scopes.
 *
 * **The scope is in the path and never in the body.** A poll's audience is decided entirely by
 * `(scope, scopeId)`, and the club that owns that scope is a fact about the data rather than an
 * argument - so it is resolved server-side by `resolvePollScope`. A body carrying both would let
 * a caller pair a race they are merely on the roster of with a club they happen to administer
 * and satisfy a two-part authorization check that was meant to be one question. See
 * `resolvePollScope`.
 *
 * The three creation routes therefore differ only in which scope they name, and the read, vote
 * and management routes are scope-agnostic because a poll id already carries its scope.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  MAX_OPTIONS,
  MIN_OPTIONS,
  createPoll,
  deletePoll,
  listPolls,
  readPoll,
  resolvePollScope,
  setPollClosed,
  toggleVote,
} from '../../domain/polls.ts';
import { refusalStatus, type AppDeps } from '../plumbing.ts';

const CreatePollBody = z.object({
  question: z.string().min(1).max(500),
  options: z.array(z.string().min(1).max(200)).min(MIN_OPTIONS).max(MAX_OPTIONS),
  allowMultiple: z.boolean().optional(),
  isPrivate: z.boolean().optional(),
  /**
   * A duration, not an absolute time, and deliberately.
   *
   * "One week" chosen at 9am must become a deadline computed from that moment. Letting the
   * client send an absolute `closesAt` would put clock skew between the two devices of the
   * same member into a value the server then treats as authoritative.
   */
  closesInMinutes: z.number().int().positive().max(525_600).nullish(),
});

export function registerPollRoutes(app: FastifyInstance, deps: AppDeps): void {
  /**
   * One creation handler, three routes.
   *
   * Written once and bound three times rather than copied, because the only difference is the
   * scope literal - and a copy is where the race branch would eventually stop matching the
   * club one (failure mode 9).
   */
  type ScopedRequest = FastifyRequest<{ Params: { id: string } }>;

  const createIn =
    (scope: 'club' | 'race' | 'eboard') =>
    async function create(request: ScopedRequest, reply: FastifyReply) {
      const body = CreatePollBody.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: 'invalid_body', issues: body.error.issues });
      }

      const resolved = await resolvePollScope(deps.db, scope, request.params.id);
      // A scope that does not exist and one the caller cannot reach answer identically.
      if (!resolved) return reply.code(404).send({ error: 'not_found' });

      const result = await createPoll(deps.db, request.access!, {
        clubId: resolved.clubId,
        scope,
        scopeId: request.params.id,
        ...body.data,
      });
      if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
      return reply.code(201).send(result);
    };

  const listIn =
    (scope: 'club' | 'race' | 'eboard') =>
    async function list(request: ScopedRequest, reply: FastifyReply) {
      const resolved = await resolvePollScope(deps.db, scope, request.params.id);
      if (!resolved) return reply.code(404).send({ error: 'not_found' });

      // `listPolls` answers with an empty list rather than a refusal for a scope the caller
      // cannot reach, which is the right shape for a list and is why there is no status
      // mapping here.
      return {
        polls: await listPolls(deps.db, request.access!, {
          scope,
          scopeId: request.params.id,
          clubId: resolved.clubId,
        }),
      };
    };

  app.post<{ Params: { id: string } }>('/clubs/:id/polls', createIn('club'));
  app.post<{ Params: { id: string } }>('/races/:id/polls', createIn('race'));
  app.post<{ Params: { id: string } }>('/eboards/:id/polls', createIn('eboard'));

  app.get<{ Params: { id: string } }>('/clubs/:id/polls', listIn('club'));
  app.get<{ Params: { id: string } }>('/races/:id/polls', listIn('race'));
  app.get<{ Params: { id: string } }>('/eboards/:id/polls', listIn('eboard'));

  /**
   * One poll, as this viewer.
   *
   * Counts are public on every poll including private ones; voter identity is gated; and a
   * voter always sees their own vote either way. All three live in `readPoll`, which is why
   * this route has no privacy logic of its own.
   */
  app.get<{ Params: { id: string } }>('/polls/:id', async (request, reply) => {
    const result = await readPoll(deps.db, request.access!, request.params.id);
    if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
    return result;
  });

  /**
   * Vote, change a vote, or withdraw one - one gesture, one route.
   *
   * Addressed by **option** rather than by poll plus a body, because the option already
   * identifies its poll. A `/polls/:id/votes` route taking `{ optionId }` would accept a pair
   * that disagreed, and the only sane thing to do with a disagreement is what this route makes
   * impossible.
   *
   * Opening the voter list casts nothing: that is the read above, and this is the only writer.
   */
  app.post<{ Params: { id: string } }>('/poll-options/:id/vote', async (request, reply) => {
    const result = await toggleVote(deps.db, request.access!, request.params.id);
    if (!result.ok) {
      // 409 for `closed`, so a client can say "this poll has closed" rather than showing the
      // same failure it shows for a poll that was never visible.
      return reply.code(refusalStatus(result.code)).send({ error: result.code });
    }
    return result;
  });

  const ClosedBody = z.object({ closed: z.boolean() });

  /**
   * 403 for a refusal on management, 404 for everything else.
   *
   * The shared `refusalStatus` collapses `forbidden` into 404 so that a refusal cannot confirm
   * what it refused. That reasoning does not apply here: both handlers check `canAccessPoll`
   * **before** `canManagePoll`, so a `forbidden` provably reached somebody who can already read
   * the poll, and hiding it from them tells them nothing they do not know. It does cost
   * something - a client cannot say "only the creator can close this" if the answer is
   * indistinguishable from a poll that was deleted. Same judgement as the reactions route.
   */
  const managementStatus = (code: string): number =>
    code === 'forbidden' ? 403 : refusalStatus(code);

  /**
   * Close or reopen. **The creator only, in every scope**, including a club poll created by
   * another admin - so the refusal here is a `creatorId` comparison and never a role check.
   * Reopening preserves every vote.
   */
  app.post<{ Params: { id: string } }>('/polls/:id/closed', async (request, reply) => {
    const body = ClosedBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });

    const result = await setPollClosed(
      deps.db,
      request.access!,
      request.params.id,
      body.data.closed,
    );
    if (!result.ok) return reply.code(managementStatus(result.code)).send({ error: result.code });
    return result;
  });

  app.delete<{ Params: { id: string } }>('/polls/:id', async (request, reply) => {
    const result = await deletePoll(deps.db, request.access!, request.params.id);
    if (!result.ok) return reply.code(managementStatus(result.code)).send({ error: result.code });
    return result;
  });
}
