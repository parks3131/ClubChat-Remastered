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

/**
 * One direct-message thread, from the viewer's side.
 *
 * `sharesClub` is resolved here rather than at the predicate, because "do these two people
 * still share a club" is a join and a predicate must stay a pure function. It is also NOT
 * stored on the conversation: club membership changes constantly, so a stored copy would need
 * a job to maintain and would be wrong between runs. See ADR-0016.
 */
export type DmThread = {
  readonly conversationId: string;
  /** The person on the other side. There are exactly two participants, ever. */
  readonly otherUserId: string;
  /**
   * Still share at least one club, so the thread is writable.
   *
   * False means read-only, not gone: history stays readable, which is what PRD/14 rule 3
   * requires and is consistent with a message never being hard-deleted.
   */
  readonly sharesClub: boolean;
};

export type AccessContext = {
  readonly userId: string;
  /**
   * This user's own display name.
   *
   * Carried so a client can attribute its OWN messages without asking. The alternative was
   * putting the name on every send acknowledgement, which repeats a string that cannot change
   * mid-connection once per message; handing it over once at auth costs one field.
   *
   * Null only if the row vanished between authentication and this read.
   */
  readonly displayName: string | null;
  /**
   * Their avatar's media id, carried for the same reason as the name beside it and null when
   * they have not set one. See the note on `display_image` in the query below.
   */
  readonly displayImage: string | null;
  /** Club id -> this user's role in it. Absent means not a member. */
  readonly clubRole: ReadonlyMap<string, ClubRole>;
  /** Eboard ids this user is a member of. */
  readonly eboardMember: ReadonlySet<string>;
  /**
   * Race ids this user holds a roster row for.
   *
   * The predicates are written against the set rather than against a club-admin check
   * on purpose: race membership is the SOLE source of truth for race access, and
   * substituting an admin check was wrong in five separate places in v1.
   */
  readonly raceRoster: ReadonlySet<string>;
  /**
   * Conversation id -> that thread's state. `has()` is participation; `get()` carries the
   * peer and whether the thread is still writable.
   */
  readonly dmThreads: ReadonlyMap<string, DmThread>;
  /**
   * Users blocked in EITHER direction - blocked by this user, or blocking them.
   *
   * Deliberately symmetric. A block is stored one-directionally (`blocker -> blocked`) but
   * evaluated both ways: neither party can message the other and neither appears in the
   * other's DM search. A one-directional read would let the blocked user keep opening the
   * thread and sending into a void, which is worse for them than a clean refusal.
   */
  readonly blockedEither: ReadonlySet<string>;
  /**
   * Gates the DM report queue, and nothing else.
   *
   * Not a role in any club and not a tier above Owner: it grants exactly one capability,
   * reading reports raised in conversations that have no admin party to them.
   */
  readonly isPlatformModerator: boolean;
  /**
   * Sign-in has been blocked - a deleted account, or one an operator has shut off.
   *
   * > **Loaded here, from our own table, rather than read off the session user.** Blocking
   * > does not invalidate an already-issued token, so every request has to re-ask. Both
   * > entry points used to ask better-auth's session object for `signinBlockedAt`, which it
   * > does not return unless the column is declared in `additionalFields` - so the check
   * > read `undefined` on every request and the revocation path never fired at all. The
   * > column is ours; the answer comes from us.
   */
  readonly signinBlocked: boolean;
};

type ContextRow = {
  kind: string;
  id: string;
  detail: string | null;
  flag: boolean | null;
};

/**
 * Load everything the predicates need for one user, in one round trip.
 *
 * Note the explicit `::text` casts on every id and on both NULLs. Two separate reasons, and
 * both are load-bearing:
 *
 *  1. Engineering pitfall 6: a bare literal inside a UNION audience query aborts the whole
 *     statement on type-inference grounds, and that broke race announcements twice in v1.
 *  2. **The branches must agree on column types.** The membership branches select `uuid`
 *     columns while the dm branch selects a `CASE` expression; Postgres will not implicitly
 *     match `uuid` against `text` across a UNION, so leaving one uncast fails the entire
 *     statement rather than that branch. Found by running it, not by reading it.
 */
export async function loadAccessContext(db: Db, userId: string): Promise<AccessContext> {
  const rows = await db.execute<ContextRow>(sql`
    SELECT 'club'::text AS kind, club_id::text AS id, role::text AS detail,
           NULL::boolean AS flag
      FROM club_memberships
     WHERE user_id = ${userId}
    UNION ALL
    SELECT 'eboard'::text AS kind, eboard_id::text AS id, NULL::text AS detail,
           NULL::boolean AS flag
      FROM eboard_memberships
     WHERE user_id = ${userId}
    UNION ALL
    SELECT 'race'::text AS kind, race_id::text AS id, NULL::text AS detail,
           NULL::boolean AS flag
      FROM race_memberships
     WHERE user_id = ${userId}
    UNION ALL
    SELECT 'dm'::text AS kind,
           d.id::text AS id,
           (CASE WHEN d.user_a = ${userId} THEN d.user_b ELSE d.user_a END)::text AS detail,
           -- Writability, resolved per thread. EXISTS rather than a count: whether they
           -- share three clubs or one makes no difference to the answer.
           EXISTS (
             SELECT 1
               FROM club_memberships mine
               JOIN club_memberships theirs ON theirs.club_id = mine.club_id
              WHERE mine.user_id = ${userId}
                AND theirs.user_id =
                    CASE WHEN d.user_a = ${userId} THEN d.user_b ELSE d.user_a END
           ) AS flag
      FROM dm_conversations d
     WHERE d.user_a = ${userId} OR d.user_b = ${userId}
    UNION ALL
    -- Read in both directions and collapsed to "the other person", because every predicate
    -- that consults a block treats the two directions identically.
    SELECT 'block'::text AS kind,
           (CASE WHEN b.blocker_id = ${userId} THEN b.blocked_id ELSE b.blocker_id END)::text
             AS id,
           NULL::text AS detail,
           NULL::boolean AS flag
      FROM member_blocks b
     WHERE b.blocker_id = ${userId} OR b.blocked_id = ${userId}
    UNION ALL
    SELECT 'moderator'::text AS kind, u.id::text AS id, NULL::text AS detail,
           NULL::boolean AS flag
      FROM users u
     WHERE u.id = ${userId} AND u.is_platform_moderator
    UNION ALL
    -- A presence row, like 'moderator' above: it exists only when the flag is set, so the
    -- loop below reads the same way for both. This is the account-lifecycle half of the
    -- context; see signinBlocked on AccessContext for why it is loaded here at all.
    SELECT 'signin_blocked'::text AS kind, u.id::text AS id, NULL::text AS detail,
           NULL::boolean AS flag
      FROM users u
     WHERE u.id = ${userId} AND u.signin_blocked_at IS NOT NULL
    UNION ALL
    -- Unlike every branch above, this one is not a presence row: it always matches, and the
    -- name rides in the detail column. Loaded here because the context is already reading this
    -- row, so the alternative is a second round trip for one string that every caller which
    -- renders a name would then have to make on its own.
    SELECT 'display_name'::text AS kind, u.id::text AS id, u.full_name AS detail,
           NULL::boolean AS flag
      FROM users u
     WHERE u.id = ${userId}
    UNION ALL
    -- The picture, on the same terms and from the same row as the name above: a client that
    -- attributes its own acked message by name has to draw its face too, or its own bubble is
    -- the one avatar in the conversation that stays a letter until the next sync.
    SELECT 'display_image'::text AS kind, u.id::text AS id, u.image AS detail,
           NULL::boolean AS flag
      FROM users u
     WHERE u.id = ${userId} AND u.image IS NOT NULL
  `);

  const clubRole = new Map<string, ClubRole>();
  const eboardMember = new Set<string>();
  const raceRoster = new Set<string>();
  const dmThreads = new Map<string, DmThread>();
  const blockedEither = new Set<string>();
  let isPlatformModerator = false;
  let signinBlocked = false;
  let displayName: string | null = null;
  let displayImage: string | null = null;

  for (const row of rows.rows) {
    if (row.kind === 'club' && row.detail !== null) {
      clubRole.set(row.id, row.detail as ClubRole);
    } else if (row.kind === 'eboard') {
      eboardMember.add(row.id);
    } else if (row.kind === 'race') {
      raceRoster.add(row.id);
    } else if (row.kind === 'dm' && row.detail !== null) {
      dmThreads.set(row.id, {
        conversationId: row.id,
        otherUserId: row.detail,
        sharesClub: row.flag === true,
      });
    } else if (row.kind === 'block') {
      blockedEither.add(row.id);
    } else if (row.kind === 'moderator') {
      isPlatformModerator = true;
    } else if (row.kind === 'signin_blocked') {
      signinBlocked = true;
    } else if (row.kind === 'display_name') {
      displayName = row.detail;
    } else if (row.kind === 'display_image') {
      displayImage = row.detail;
    }
  }

  return {
    userId,
    displayName,
    displayImage,
    clubRole,
    eboardMember,
    raceRoster,
    dmThreads,
    blockedEither,
    isPlatformModerator,
    signinBlocked,
  };
}

/** Build a context directly. For tests and for the permission matrix suite. */
export function accessContextOf(init: {
  userId: string;
  clubRole?: Iterable<readonly [string, ClubRole]>;
  eboardMember?: Iterable<string>;
  raceRoster?: Iterable<string>;
  /**
   * Threads, given as the peer plus writability. Defaults `sharesClub` to true, because a
   * thread that exists at all was opened by two people who shared a club, and the read-only
   * case is the exception a test should have to state.
   */
  dmThreads?: Iterable<{ conversationId: string; otherUserId: string; sharesClub?: boolean }>;
  blockedEither?: Iterable<string>;
  isPlatformModerator?: boolean;
  signinBlocked?: boolean;
  displayName?: string | null;
  displayImage?: string | null;
}): AccessContext {
  const dmThreads = new Map<string, DmThread>();
  for (const thread of init.dmThreads ?? []) {
    dmThreads.set(thread.conversationId, {
      conversationId: thread.conversationId,
      otherUserId: thread.otherUserId,
      sharesClub: thread.sharesClub ?? true,
    });
  }

  return {
    userId: init.userId,
    displayName: init.displayName ?? null,
    displayImage: init.displayImage ?? null,
    clubRole: new Map(init.clubRole ?? []),
    eboardMember: new Set(init.eboardMember ?? []),
    raceRoster: new Set(init.raceRoster ?? []),
    dmThreads,
    blockedEither: new Set(init.blockedEither ?? []),
    isPlatformModerator: init.isPlatformModerator ?? false,
    signinBlocked: init.signinBlocked ?? false,
  };
}
