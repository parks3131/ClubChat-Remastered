/**
 * Poll commands.
 *
 * One poll concept with a club/race/eboard scope, repeating the channel abstraction's trick.
 *
 * The two rules worth reading before changing anything here:
 *
 *  1. **Closed-ness is evaluated at READ time**, as `closed_at IS NOT NULL OR closes_at <
 *     now()`. A passed deadline must read as closed everywhere without anyone having closed
 *     it, so there is no `is_closed` column and **no job that closes polls**.
 *  2. **Only the creator can close, reopen or delete** - in every scope, including a club poll
 *     created by another admin. That is a `creatorId` comparison, never a role check.
 */

import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { outbox, pollOptions, pollVotes, polls } from '../db/schema.ts';
import type { AccessContext } from '../policy/context.ts';
import {
  canAccessPoll,
  canCreatePoll,
  canManagePoll,
  canSeePollVoters,
  type PollRef,
} from '../policy/predicates.ts';

export type Refusal = {
  ok: false;
  code: 'forbidden' | 'not_found' | 'closed' | 'invalid';
};
export type Result<T> = ({ ok: true } & T) | Refusal;

export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 10;

async function pollRef(db: Db, pollId: string): Promise<(PollRef & { closed: boolean }) | null> {
  const rows = await db.execute<{
    id: string;
    club_id: string;
    scope: string;
    scope_id: string;
    creator_id: string;
    is_private: boolean;
    closed: boolean;
  }>(sql`
    SELECT id, club_id, scope, scope_id, creator_id, is_private,
           -- Evaluated here, on every read. A passed deadline reads as closed with nobody
           -- having closed it, which is why no column stores this.
           (closed_at IS NOT NULL OR (closes_at IS NOT NULL AND closes_at < now())) AS closed
      FROM polls WHERE id = ${pollId}
  `);
  const row = rows.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    clubId: row.club_id,
    scope: row.scope as PollRef['scope'],
    scopeId: row.scope_id,
    creatorId: row.creator_id,
    isPrivate: row.is_private,
    closed: row.closed,
  };
}

/**
 * Create a poll.
 *
 * Between 2 and 10 options. Editing a question or its options after creation is out of scope
 * because it would invalidate votes already cast, so this is the only place they are set.
 *
 * A deadline is optional and is computed from the moment of creation, which is why the caller
 * passes a duration rather than an absolute time - "1 week" typed at 9am should not become a
 * deadline the server computed from some other instant.
 */
export async function createPoll(
  db: Db,
  ctx: AccessContext,
  input: {
    clubId: string;
    scope: 'club' | 'race' | 'eboard';
    scopeId: string;
    question: string;
    options: readonly string[];
    allowMultiple?: boolean;
    isPrivate?: boolean;
    closesInMinutes?: number | null;
  },
): Promise<Result<{ pollId: string }>> {
  if (!canCreatePoll(ctx, input)) return { ok: false, code: 'forbidden' };
  if (input.options.length < MIN_OPTIONS || input.options.length > MAX_OPTIONS) {
    return { ok: false, code: 'invalid' };
  }

  return db.transaction(async (tx) => {
    const rows = await tx
      .insert(polls)
      .values({
        clubId: input.clubId,
        scope: input.scope,
        scopeId: input.scopeId,
        creatorId: ctx.userId,
        question: input.question,
        allowMultiple: input.allowMultiple ?? false,
        isPrivate: input.isPrivate ?? false,
        closesAt:
          input.closesInMinutes != null
            ? new Date(Date.now() + input.closesInMinutes * 60_000)
            : null,
      })
      .returning();
    const poll = rows[0];
    if (!poll) throw new Error('poll insert returned no row');

    await tx.insert(pollOptions).values(
      input.options.map((label, index) => ({
        pollId: poll.id,
        label,
        position: index + 1,
      })),
    );

    await tx.insert(outbox).values({
      partitionKey: input.clubId,
      eventType: 'poll.created',
      payload: {
        clubId: input.clubId,
        pollId: poll.id,
        question: poll.question,
        scope: input.scope,
        scopeId: input.scopeId,
        actorId: ctx.userId,
      },
    });

    return { ok: true as const, pollId: poll.id };
  });
}

/**
 * Vote, or change a vote, or withdraw one.
 *
 * Three behaviours in one command, because they are three outcomes of the same gesture:
 *
 *  - Tapping an option you have not chosen **casts** a vote.
 *  - Tapping the option you already chose **withdraws** it.
 *  - On a single-choice poll, tapping a different option **moves** the vote rather than
 *    adding a second. The database guarantees the moving part - a partial unique index makes
 *    a second concurrent vote impossible - so this deletes the old row explicitly rather than
 *    relying on an upsert that would race.
 *
 * `voteCount` on the option is maintained in the same transaction, because **counts are
 * public while voter identity is gated**: a count cannot be derived from rows the viewer is
 * forbidden to read.
 */
export async function toggleVote(
  db: Db,
  ctx: AccessContext,
  optionId: string,
): Promise<Result<{ action: 'cast' | 'withdrawn' | 'moved' }>> {
  const optionRows = await db
    .select()
    .from(pollOptions)
    .where(eq(pollOptions.id, optionId))
    .limit(1);
  const option = optionRows[0];
  if (!option) return { ok: false, code: 'not_found' };

  const poll = await pollRef(db, option.pollId);
  if (!poll) return { ok: false, code: 'not_found' };
  if (!canAccessPoll(ctx, poll)) return { ok: false, code: 'not_found' };
  // A closed poll cannot be voted in, whether it was closed by hand or by its deadline.
  if (poll.closed) return { ok: false, code: 'closed' };

  const allowMultiple = await db
    .select({ allowMultiple: polls.allowMultiple })
    .from(polls)
    .where(eq(polls.id, poll.id))
    .limit(1);
  const multi = allowMultiple[0]?.allowMultiple ?? false;

  return db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(pollVotes)
      .where(and(eq(pollVotes.optionId, optionId), eq(pollVotes.userId, ctx.userId)))
      .limit(1);

    if (existing.length > 0) {
      await tx
        .delete(pollVotes)
        .where(and(eq(pollVotes.optionId, optionId), eq(pollVotes.userId, ctx.userId)));
      await tx.execute(
        sql`UPDATE poll_options SET vote_count = GREATEST(vote_count - 1, 0) WHERE id = ${optionId}`,
      );
      return { ok: true as const, action: 'withdrawn' as const };
    }

    let moved = false;
    if (!multi) {
      // Single choice: clear any other vote first, so the gesture MOVES rather than being
      // refused by the unique index.
      const prior = await tx
        .select({ optionId: pollVotes.optionId })
        .from(pollVotes)
        .where(and(eq(pollVotes.pollId, poll.id), eq(pollVotes.userId, ctx.userId)));

      if (prior.length > 0) {
        moved = true;
        await tx
          .delete(pollVotes)
          .where(and(eq(pollVotes.pollId, poll.id), eq(pollVotes.userId, ctx.userId)));
        for (const row of prior) {
          await tx.execute(
            sql`UPDATE poll_options SET vote_count = GREATEST(vote_count - 1, 0)
                 WHERE id = ${row.optionId}`,
          );
        }
      }
    }

    await tx.insert(pollVotes).values({
      pollId: poll.id,
      optionId,
      userId: ctx.userId,
      allowMultiple: multi,
    });
    await tx.execute(
      sql`UPDATE poll_options SET vote_count = vote_count + 1 WHERE id = ${optionId}`,
    );

    return { ok: true as const, action: moved ? ('moved' as const) : ('cast' as const) };
  });
}

export type PollView = {
  id: string;
  question: string;
  scope: 'club' | 'race' | 'eboard';
  allowMultiple: boolean;
  isPrivate: boolean;
  closed: boolean;
  closesAt: string | null;
  isCreator: boolean;
  options: Array<{
    id: string;
    label: string;
    position: number;
    /** Always present. Counts are public on every poll, including private ones. */
    voteCount: number;
    /** The viewer's own vote. Always visible to them, whatever the privacy setting. */
    votedByMe: boolean;
    /** Null when the viewer may not see identities. Absent is different from empty. */
    voters: Array<{ userId: string; name: string }> | null;
  }>;
};

/**
 * Read a poll as a specific viewer.
 *
 * The privacy rule is subtle enough to be worth stating: **counts are always public, identity
 * is gated, and a voter always sees their own vote either way.** So `voteCount` is
 * unconditional, `voters` is null when the viewer may not see it, and `votedByMe` is computed
 * from the viewer's own rows rather than by scanning a list they may not be allowed to read.
 */
export async function readPoll(
  db: Db,
  ctx: AccessContext,
  pollId: string,
): Promise<Result<{ poll: PollView }>> {
  const ref = await pollRef(db, pollId);
  if (!ref) return { ok: false, code: 'not_found' };
  // A race poll is invisible to an admin without a roster row, including by direct URL.
  if (!canAccessPoll(ctx, ref)) return { ok: false, code: 'not_found' };

  const meta = await db.select().from(polls).where(eq(polls.id, pollId)).limit(1);
  const poll = meta[0];
  if (!poll) return { ok: false, code: 'not_found' };

  const options = await db
    .select()
    .from(pollOptions)
    .where(eq(pollOptions.pollId, pollId))
    .orderBy(pollOptions.position);

  const myVotes = await db
    .select({ optionId: pollVotes.optionId })
    .from(pollVotes)
    .where(and(eq(pollVotes.pollId, pollId), eq(pollVotes.userId, ctx.userId)));
  const mine = new Set(myVotes.map((v) => v.optionId));

  const showVoters = canSeePollVoters(ctx, ref);
  const voterRows = showVoters
    ? await db.execute<{ option_id: string; user_id: string; name: string }>(sql`
        SELECT pv.option_id, pv.user_id, u.full_name AS name
          FROM poll_votes pv JOIN users u ON u.id = pv.user_id
         WHERE pv.poll_id = ${pollId}
      `)
    : null;

  const votersByOption = new Map<string, Array<{ userId: string; name: string }>>();
  for (const row of voterRows?.rows ?? []) {
    const list = votersByOption.get(row.option_id) ?? [];
    list.push({ userId: row.user_id, name: row.name });
    votersByOption.set(row.option_id, list);
  }

  return {
    ok: true,
    poll: {
      id: poll.id,
      question: poll.question,
      scope: poll.scope as PollView['scope'],
      allowMultiple: poll.allowMultiple,
      isPrivate: poll.isPrivate,
      closed: ref.closed,
      closesAt: poll.closesAt?.toISOString() ?? null,
      isCreator: poll.creatorId === ctx.userId,
      options: options.map((option) => ({
        id: option.id,
        label: option.label,
        position: option.position,
        voteCount: option.voteCount,
        votedByMe: mine.has(option.id),
        voters: showVoters ? (votersByOption.get(option.id) ?? []) : null,
      })),
    },
  };
}

/**
 * Close, reopen or delete. **The creator only.**
 *
 * Reopening preserves existing votes - it clears `closed_at` and nothing else. An admin who
 * did not create the poll cannot do any of this, which is deliberate even though it means a
 * poll whose creator has left the club can no longer be closed by hand. That is a recorded
 * open question, not an oversight; its deadline still closes it.
 */
export async function setPollClosed(
  db: Db,
  ctx: AccessContext,
  pollId: string,
  closed: boolean,
): Promise<Result<{ closed: boolean }>> {
  const ref = await pollRef(db, pollId);
  if (!ref) return { ok: false, code: 'not_found' };
  if (!canAccessPoll(ctx, ref)) return { ok: false, code: 'not_found' };
  if (!canManagePoll(ctx, ref)) return { ok: false, code: 'forbidden' };

  await db
    .update(polls)
    .set({ closedAt: closed ? new Date() : null })
    .where(eq(polls.id, pollId));

  return { ok: true, closed };
}

export async function deletePoll(
  db: Db,
  ctx: AccessContext,
  pollId: string,
): Promise<Result<{ deleted: true }>> {
  const ref = await pollRef(db, pollId);
  if (!ref) return { ok: false, code: 'not_found' };
  if (!canAccessPoll(ctx, ref)) return { ok: false, code: 'not_found' };
  if (!canManagePoll(ctx, ref)) return { ok: false, code: 'forbidden' };

  await db.transaction(async (tx) => {
    // Deleting the poll removes its chat card, rather than leaving a dead link behind.
    await tx.insert(outbox).values({
      partitionKey: ref.clubId,
      eventType: 'poll.deleted',
      payload: { clubId: ref.clubId, pollId, actorId: ctx.userId },
    });
    await tx.delete(polls).where(eq(polls.id, pollId));
  });

  return { ok: true, deleted: true };
}

/** Polls the viewer can access in a scope, plus the ones they have voted in. */
export async function listPolls(
  db: Db,
  ctx: AccessContext,
  // clubId is required, not optional: the club branch of canAccessPoll checks membership
  // against it, so passing a placeholder would deny every club poll silently.
  scope: { scope: 'club' | 'race' | 'eboard'; scopeId: string; clubId: string },
): Promise<Array<{ id: string; question: string; closed: boolean; votedByMe: boolean }>> {
  // Checked ONCE, before the query, because access to a poll depends only on its scope -
  // every poll in one scope is visible to exactly the same people. Filtering row by row
  // afterwards would run the same predicate N times for the same answer.
  const reachable = canAccessPoll(ctx, {
    id: '',
    clubId: scope.clubId,
    scope: scope.scope,
    scopeId: scope.scopeId,
    creatorId: '',
    isPrivate: false,
  });
  if (!reachable) return [];

  const rows = await db.execute<{
    id: string;
    question: string;
    closed: boolean;
    voted: boolean;
  }>(sql`
    SELECT p.id, p.question,
           (p.closed_at IS NOT NULL OR (p.closes_at IS NOT NULL AND p.closes_at < now())) AS closed,
           EXISTS (SELECT 1 FROM poll_votes v
                    WHERE v.poll_id = p.id AND v.user_id = ${ctx.userId}) AS voted
      FROM polls p
     WHERE p.scope = ${scope.scope} AND p.scope_id = ${scope.scopeId}
     ORDER BY p.created_at DESC
  `);

  return rows.rows.map((row) => ({
    id: row.id,
    question: row.question,
    closed: row.closed,
    votedByMe: row.voted,
  }));
}
