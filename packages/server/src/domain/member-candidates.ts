/**
 * Who can be added to a roster.
 *
 * The read behind the add-member search on all three roster screens. It exists because the three
 * `add` commands were reachable and unfindable at the same time: `POST /clubs/:id/members` takes a
 * user id, and nothing in the product could turn a name into one. That is failure mode 11 - both
 * ends complete, nothing joining them - and it is why this module ships with the screen rather
 * than after it.
 *
 * ---
 *
 * **Never a global user search.** The candidate pool is always people the caller can already see,
 * which is the same rule `searchDmCandidates` holds: a user directory searchable by anybody who
 * happens to be an admin somewhere is a privacy surface this product does not need. A stranger is
 * reached by sending them the invite link, which ADR-0010 already makes the only front door.
 *
 * The pool narrows further as the target narrows, and each narrowing is a real rule rather than a
 * convenience:
 *
 * | Target | Pool | Because |
 * |---|---|---|
 * | Club | anybody sharing a club with the caller | the widest thing the caller can already see |
 * | Race | members of that race's club | a race is a mini-club inside one club |
 * | Eboard | admin tier of that club | `addEboardMember` refuses anybody else anyway |
 *
 * **The Eboard row is the one that matters.** Offering a plain member there would produce a search
 * result that fails on tap - and worse, it would advertise a capability the command refuses, which
 * is how a UI teaches somebody that a rule is arbitrary rather than deliberate.
 *
 * ---
 *
 * **Authorization is the add's own predicate, reused, not a similar one.** A search that anybody
 * could run would leak a club's roster by exclusion: ask for every candidate, and whoever is
 * missing is a member. So each branch asks exactly the question its `add` asks, and a caller who
 * may not add gets `not_found` rather than an empty list - the same non-disclosing refusal the
 * rest of the surface uses.
 */

import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import type { AccessContext } from '../policy/context.ts';
import { canApproveEboardRequest, canManageRace, isClubAdmin } from '../policy/predicates.ts';
import { clubIdOfEboard, clubIdOfRace } from './scopes.ts';

export type MemberCandidate = {
  userId: string;
  name: string;
  /** Their picture. A search result draws the same person the roster it feeds will. */
  image: string | null;
};

export type CandidateTarget =
  | { kind: 'club'; clubId: string }
  | { kind: 'race'; raceId: string }
  | { kind: 'eboard'; eboardId: string };

export type Refusal = { ok: false; code: 'not_found' };
export type Result<T> = ({ ok: true } & T) | Refusal;

/** Bounded so a one-letter query cannot ask for every user the caller shares a club with. */
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export async function searchMemberCandidates(
  db: Db,
  ctx: AccessContext,
  target: CandidateTarget,
  opts: { query?: string | undefined; limit?: number | undefined } = {},
): Promise<Result<{ candidates: MemberCandidate[] }>> {
  const resolved = await resolve(db, ctx, target);
  if (!resolved) return { ok: false, code: 'not_found' };

  const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const query = (opts.query ?? '').trim();
  const blocked = [...ctx.blockedEither];

  const rows = await db.execute<{ id: string; full_name: string; image: string | null }>(sql`
    SELECT DISTINCT u.id::text AS id, u.full_name, u.image
      FROM users u
     WHERE u.id IN ${resolved.pool}
       AND u.id NOT IN ${resolved.already}
       AND u.id <> ${ctx.userId}
       -- A deleted account is not a candidate. Its row survives so history stays attributed as
       -- "Deleted member"; it is not somebody who can be added to anything.
       AND u.anonymized_at IS NULL
       ${query.length > 0 ? sql`AND u.full_name ILIKE ${'%' + query + '%'}` : sql``}
       -- Symmetric, as everywhere else: a blocked member is absent from the blocker's results and
       -- the blocker is absent from theirs. "No result, indistinguishable from no such member."
       ${blocked.length > 0 ? sql`AND u.id <> ALL(${sql.param(blocked)}::uuid[])` : sql``}
     ORDER BY u.full_name
     LIMIT ${limit}
  `);

  return {
    ok: true,
    candidates: rows.rows.map((row) => ({
      userId: row.id,
      name: row.full_name,
      image: row.image,
    })),
  };
}

/**
 * The pool and the exclusion for a target, or null if the caller may not search it.
 *
 * Both halves are subqueries rather than fetched id lists: a club with three hundred members
 * would otherwise round-trip three hundred ids in order to exclude them.
 */
async function resolve(
  db: Db,
  ctx: AccessContext,
  target: CandidateTarget,
): Promise<{ pool: SQL; already: SQL } | null> {
  switch (target.kind) {
    case 'club': {
      // The same predicate `addMember` asks.
      if (!isClubAdmin(ctx, target.clubId)) return null;
      return {
        pool: sql`(SELECT user_id FROM club_memberships
                    WHERE club_id IN (SELECT club_id FROM club_memberships
                                       WHERE user_id = ${ctx.userId}))`,
        already: sql`(SELECT user_id FROM club_memberships WHERE club_id = ${target.clubId})`,
      };
    }

    case 'race': {
      // The owning club is RESOLVED, never taken from the caller alongside the race id - a
      // two-part check cannot tell whether its two arguments describe the same thing.
      const clubId = await clubIdOfRace(db, target.raceId);
      if (clubId === null) return null;
      if (!canManageRace(ctx, { id: target.raceId, clubId })) return null;
      return {
        pool: sql`(SELECT user_id FROM club_memberships WHERE club_id = ${clubId})`,
        already: sql`(SELECT user_id FROM race_memberships WHERE race_id = ${target.raceId})`,
      };
    }

    case 'eboard': {
      const clubId = await clubIdOfEboard(db, target.eboardId);
      if (clubId === null) return null;
      if (!canApproveEboardRequest(ctx, target.eboardId)) return null;
      return {
        // Admin tier only, because `addEboardMember` refuses anybody else. Offering a plain
        // member here would be a search result that fails on tap.
        pool: sql`(SELECT user_id FROM club_memberships
                    WHERE club_id = ${clubId} AND role IN ('owner', 'admin'))`,
        already: sql`(SELECT user_id FROM eboard_memberships WHERE eboard_id = ${target.eboardId})`,
      };
    }
  }
}
