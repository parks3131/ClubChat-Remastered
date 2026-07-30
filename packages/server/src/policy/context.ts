/**
 * The access context.
 *
 * Loaded ONCE per request, in ONE query, then handed to pure predicate functions.
 * That shape is the whole point of ADR-0002: the v1 build expressed authorization as
 * row-level predicates evaluated inside queries, which produced a recursion trap (a
 * read rule calling a helper that re-queried its own table), a create-and-read-back
 * trap, and an inability to express column-level authority. Functions over a
 * pre-loaded context cannot recurse into a policy, and a handler that authorized a
 * write may obviously return what it wrote.
 */

import { sql } from 'drizzle-orm';
import type { ClubRole } from '@clubchat/shared';
import type { Db } from '../db/client.ts';

export type AccessContext = {
  readonly userId: string;
  /** Club id -> this user's role in it. Absent means not a member. */
  readonly clubRole: ReadonlyMap<string, ClubRole>;
  /** Eboard ids this user is a member of. */
  readonly eboardMember: ReadonlySet<string>;
  /**
   * Race ids this user holds a roster row for.
   *
   * Phase 0 has no races table, so this is always empty and every race predicate
   * denies. That is the safe direction and no race channel can exist yet. Phase 2
   * populates it. The predicates are written against the set rather than against a
   * club-admin check on purpose: race membership is the SOLE source of truth for
   * race access, and substituting an admin check was wrong in five separate places
   * in v1.
   */
  readonly raceRoster: ReadonlySet<string>;
  /**
   * DM threads this user participates in, and users blocked in either direction.
   * Phase 3.5 populates both. Empty here, so DM predicates deny.
   */
  readonly dmThreads: ReadonlySet<string>;
  readonly blockedEither: ReadonlySet<string>;
};

type MembershipRow = { kind: string; id: string; role: string | null };

/**
 * Load everything the predicates need for one user, in one round trip.
 *
 * Note the explicit `::text` casts on the literals and on the NULL. Engineering
 * pitfall 6: a bare literal inside a UNION audience query aborts the whole statement
 * on type-inference grounds, and that broke race announcements twice in v1. The cast
 * is cheap and the failure it prevents is total.
 */
export async function loadAccessContext(db: Db, userId: string): Promise<AccessContext> {
  const rows = await db.execute<MembershipRow>(sql`
    SELECT 'club'::text AS kind, club_id AS id, role::text AS role
      FROM club_memberships
     WHERE user_id = ${userId}
    UNION ALL
    SELECT 'eboard'::text AS kind, eboard_id AS id, NULL::text AS role
      FROM eboard_memberships
     WHERE user_id = ${userId}
    UNION ALL
    SELECT 'race'::text AS kind, race_id AS id, NULL::text AS role
      FROM race_memberships
     WHERE user_id = ${userId}
  `);

  const clubRole = new Map<string, ClubRole>();
  const eboardMember = new Set<string>();
  const raceRoster = new Set<string>();

  for (const row of rows.rows) {
    if (row.kind === 'club' && row.role !== null) {
      clubRole.set(row.id, row.role as ClubRole);
    } else if (row.kind === 'eboard') {
      eboardMember.add(row.id);
    } else if (row.kind === 'race') {
      raceRoster.add(row.id);
    }
  }

  return {
    userId,
    clubRole,
    eboardMember,
    raceRoster,
    // Phase 3.5 populates both. Empty means every DM predicate denies, which is the safe
    // direction while no DM can exist.
    dmThreads: new Set(),
    blockedEither: new Set(),
  };
}

/** Build a context directly. For tests and for the permission matrix suite. */
export function accessContextOf(init: {
  userId: string;
  clubRole?: Iterable<readonly [string, ClubRole]>;
  eboardMember?: Iterable<string>;
  raceRoster?: Iterable<string>;
  dmThreads?: Iterable<string>;
  blockedEither?: Iterable<string>;
}): AccessContext {
  return {
    userId: init.userId,
    clubRole: new Map(init.clubRole ?? []),
    eboardMember: new Set(init.eboardMember ?? []),
    raceRoster: new Set(init.raceRoster ?? []),
    dmThreads: new Set(init.dmThreads ?? []),
    blockedEither: new Set(init.blockedEither ?? []),
  };
}
