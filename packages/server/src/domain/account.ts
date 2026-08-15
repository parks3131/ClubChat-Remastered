/**
 * The account itself: the profile, and deletion.
 *
 * Both write columns that have existed since Phase 0 and that nothing has ever written.
 * `anonymized_at` and `signin_blocked_at` were only ever *read* - and one of those reads was
 * broken for four phases, which is its own story in HISTORY.md.
 *
 * The reason identity lives in our own Postgres rather than in a hosted auth service is exactly
 * this function: **deletion is anonymise-and-block in ONE transaction** rather than a two-system
 * dance where the profile is scrubbed and the credential outlives it, or vice versa. See
 * ADR-0011.
 */

import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { isoUtc, muteInForce } from '../db/sql-helpers.ts';
import { outbox, users } from '../db/schema.ts';
import type { AccessContext } from '../policy/context.ts';
import type { ClubRole } from '@clubchat/shared';
import {
  canBanFromClub,
  canLiftClubBan,
  canRemoveMember,
  canReportUser,
  canViewProfile,
  dmThreadWith,
} from '../policy/predicates.ts';
import { accessibleChannelPredicate } from './channel-access.ts';

export type Refusal = {
  ok: false;
  code: 'forbidden' | 'not_found' | 'invalid' | 'owns_clubs';
};
export type Result<T> = ({ ok: true } & T) | Refusal;

export type Profile = {
  userId: string;
  name: string;
  image: string | null;
  bio: string | null;
  city: string | null;
  school: string | null;
  /** Date only, never a timestamp: a birthday is a day. */
  dob: string | null;
  createdAt: string;
};

/** What another member may see. Deliberately a narrower type than the owner's own view. */
export type PublicProfile = Omit<Profile, 'dob'>;

/**
 * What the viewer may do to this person **in a particular club**.
 *
 * Returned only when the caller names a club, because banning is a club-scoped authority and a
 * profile card is not: the same person is bannable by you in one club and untouchable in another.
 * Answered here rather than by the screen for the same reason the roster's flags are - the ban
 * ladder is asymmetric with the removal ladder, and a client restating either would be a second
 * definition of a rule that has exactly one.
 */
export type ProfileClubActions = {
  clubId: string;
  canRemove: boolean;
  canBan: boolean;
  /** Whether this person is currently barred, so the card can offer Unban instead. */
  banned: boolean;
  canLiftBan: boolean;
};

/**
 * The conversation the viewer already holds with this person, if there is one.
 *
 * > **Present only when a thread ALREADY exists, and that is the load-bearing part.** Mute and
 * > Delete chat act on a conversation, and `openDm` creates one - so a card that resolved the
 * > channel by asking to open it would bring a conversation into being as a side effect of
 * > muting it. The card can only offer what this block answers, and this block never creates
 * > anything.
 *
 * Absent, therefore, on a roster row you have never messaged, on your own card, and wherever the
 * pair is ineligible. `DESIGN/10` rule 5 then does the rest: a menu with nothing in it is no menu
 * at all, rather than a "..." that opens onto two controls over nothing.
 */
export type ProfileDmActions = {
  channelId: string;
  /** So the card can say Unmute without a second read, and without guessing. */
  muted: boolean;
};

/**
 * Read a profile.
 *
 * > **`dob` is withheld from everybody but its owner**, and that is the whole reason this
 * > returns two different shapes. Clubs are small and often include minors; PRD/03 lists the
 * > date of birth as a profile field and public profiles as an explicitly rejected alternative.
 * > Nothing in the product needs to show one member another's birthday.
 *
 * Email is absent from both shapes: it is auth-only and is never shown to another member.
 *
 * An anonymised account is `not_found`. Their messages stay in history unattributed, so the
 * conversation is intact, and there is no profile left to open.
 */
/**
 * Who the caller is: their id, their email, and the clubs they belong to.
 *
 * **The one place an email is returned.** `readProfile` deliberately never carries it, in either
 * its own-profile or public shape - a roster read that carried one would hand every club member a
 * mailing list, and "own profile only" is the kind of rule somebody relaxes by accident later.
 * Keeping it on the authenticated identity read means there is no profile shape it can leak from,
 * which is a structural guarantee rather than a remembered condition.
 */
export async function readIdentity(
  db: Db,
  ctx: AccessContext,
): Promise<{
  userId: string;
  email: string;
  clubs: Array<{ clubId: string; role: string }>;
  /**
   * Whether this account may read the DM report queue.
   *
   * Reported here so the client can offer the entry point at all - it is the one capability the
   * flag grants, and a queue nobody can navigate to is what it had instead. Read from the access
   * context rather than the user row, because the context already loaded it and there is one
   * definition of what the flag means.
   *
   * Not a role and not a tier above Owner: it buys exactly this and nothing anywhere else.
   */
  isPlatformModerator: boolean;
}> {
  const rows = await db.execute<{ email: string }>(sql`
    SELECT email FROM users WHERE id = ${ctx.userId}
  `);

  return {
    userId: ctx.userId,
    email: rows.rows[0]?.email ?? '',
    clubs: [...ctx.clubRole.entries()].map(([clubId, role]) => ({ clubId, role })),
    isPlatformModerator: ctx.isPlatformModerator,
  };
}

export async function readProfile(
  db: Db,
  ctx: AccessContext,
  userId: string,
  opts: { clubId?: string | undefined } = {},
): Promise<
  Result<{
    profile: Profile | PublicProfile;
    club?: ProfileClubActions;
    /** Absent when the pair has no thread. See `ProfileDmActions`. */
    dm?: ProfileDmActions;
    /** Whether to offer Report on this card. `DESIGN/10` rule 4: the server's answer, never a role. */
    canReport: boolean;
  }>
> {
  const rows = await db.execute<{
    id: string;
    full_name: string;
    image: string | null;
    bio: string | null;
    city: string | null;
    school: string | null;
    dob: string | null;
    created_at: string;
    club_ids: string[] | null;
  }>(sql`
    SELECT id::text AS id,
           full_name,
           image,
           bio,
           city,
           school,
           dob::text AS dob,
           ${isoUtc('created_at')} AS created_at,
           -- Loaded so the visibility predicate stays a pure function: "do we share a club" is
           -- a join, and a predicate may not run one. Same reason, and the same shape, as
           -- loadCandidate in the DM module. (No backtick in this comment: it would end the
           -- template string, which is a trap channel-access.ts records having fallen into.)
           ARRAY(
             SELECT cm.club_id::text FROM club_memberships cm WHERE cm.user_id = users.id
           ) AS club_ids
      FROM users
     WHERE id = ${userId}
       AND anonymized_at IS NULL
  `);

  const row = rows.rows[0];
  if (!row) return { ok: false, code: 'not_found' };

  /*
   * Who may see this card.
   *
   * `not_found` rather than `forbidden`, matching every other refusal in the API: somebody with
   * no standing must not learn that an account exists, and a 403 would tell them. It also means
   * a caller cannot use this route to test whether a given uuid is a real member.
   */
  if (!canViewProfile(ctx, { userId: row.id, clubIds: row.club_ids ?? [] })) {
    return { ok: false, code: 'not_found' };
  }

  const base = {
    userId: row.id,
    name: row.full_name,
    image: row.image,
    bio: row.bio,
    city: row.city,
    school: row.school,
    createdAt: row.created_at,
  };

  const profile = userId === ctx.userId ? { ...base, dob: row.dob } : base;

  const subject = { userId: row.id, clubIds: row.club_ids ?? [] };
  const canReport = canReportUser(ctx, subject);

  /*
   * The conversation, if there already is one.
   *
   * The thread comes from the access context, which loaded every one of this caller's threads at
   * authentication - so "do we have a conversation" costs no query at all. Only the mute state
   * needs a row, and only when a thread exists, which is the uncommon case on a roster.
   *
   * **Nothing here opens a conversation**, and that is the rule rather than an optimisation. See
   * `ProfileDmActions`.
   */
  const thread = userId === ctx.userId ? undefined : dmThreadWith(ctx, userId);
  let dm: ProfileDmActions | undefined;
  if (thread !== undefined) {
    const found = await db.execute<{ channel_id: string; muted: boolean }>(sql`
      SELECT c.id::text AS channel_id,
             (m.channel_id IS NOT NULL) AS muted
        FROM channels c
        -- A lapsed muted_until is not a mute, through the one definition of that. Written out by
        -- hand it would have been the seventh copy - see muteInForce.
        LEFT JOIN channel_mutes m ON m.channel_id = c.id
                                 AND m.user_id = ${ctx.userId}
                                 AND ${muteInForce('m')}
       WHERE c.scope = 'dm' AND c.scope_id = ${thread.conversationId}
    `);
    const channel = found.rows[0];
    if (channel) dm = { channelId: channel.channel_id, muted: channel.muted === true };
  }

  if (opts.clubId === undefined) return { ok: true, profile, canReport, ...(dm ? { dm } : {}) };

  /*
   * Club-scoped actions, when the caller says which club they are looking from.
   *
   * Absent rather than all-false when no club is named, so a screen that forgets to pass one
   * renders no controls instead of the wrong ones.
   */
  const membership = await db.execute<{ role: string }>(sql`
    SELECT role::text AS role FROM club_memberships
     WHERE club_id = ${opts.clubId} AND user_id = ${userId}
  `);
  const banned = await db.execute<{ user_id: string }>(sql`
    SELECT user_id::text AS user_id FROM club_bans
     WHERE club_id = ${opts.clubId} AND user_id = ${userId}
  `);

  const role = membership.rows[0]?.role as ClubRole | undefined;

  return {
    ok: true,
    profile,
    canReport,
    ...(dm ? { dm } : {}),
    club: {
      clubId: opts.clubId,
      canRemove:
        role === undefined
          ? false
          : canRemoveMember(ctx, opts.clubId, { role, userId: row.id }),
      canBan: canBanFromClub(ctx, opts.clubId, { role, userId: row.id }),
      banned: banned.rows.length > 0,
      canLiftBan: canLiftClubBan(ctx, opts.clubId),
    },
  };
}

/**
 * Edit your own profile. **Self only, including for an Owner.**
 *
 * There is no `actorId`-versus-`targetId` pair to compare, and that is the point: the function
 * takes no target at all, so "nobody can edit another member's profile" is not a check that
 * could be forgotten - it is unrepresentable. PRD/03 rule 5.
 *
 * Email is absent on purpose. It is an auth credential rather than a profile field, and changing
 * one belongs to the auth flow that can re-verify it.
 */
export async function updateOwnProfile(
  db: Db,
  ctx: AccessContext,
  fields: {
    name?: string | undefined;
    bio?: string | null | undefined;
    city?: string | null | undefined;
    school?: string | null | undefined;
    dob?: string | null | undefined;
    image?: string | null | undefined;
  },
): Promise<Result<{ profile: Profile }>> {
  const patch: Record<string, unknown> = {};
  if (fields.name !== undefined) {
    const name = fields.name.trim();
    // A member with no name is unrenderable in every roster and every chat bubble, and the
    // letter-initial avatar placeholder has nothing to take its initial from.
    if (name.length === 0) return { ok: false, code: 'invalid' };
    patch.name = name;
  }
  if (fields.bio !== undefined) patch.bio = fields.bio;
  if (fields.city !== undefined) patch.city = fields.city;
  if (fields.school !== undefined) patch.school = fields.school;
  if (fields.dob !== undefined) patch.dob = fields.dob;
  if (fields.image !== undefined) patch.image = fields.image;

  if (Object.keys(patch).length > 0) {
    patch.updatedAt = new Date();
    await db.update(users).set(patch).where(eq(users.id, ctx.userId));
  }

  const reread = await readProfile(db, ctx, ctx.userId);
  if (!reread.ok) return reread;
  // Own profile, so the read returned the full shape.
  return { ok: true, profile: reread.profile as Profile };
}

/**
 * Delete your own account: anonymise, and block future sign-in.
 *
 * > **One transaction, and this is the argument for self-hosted auth.** The profile is scrubbed
 * > and the credential is blocked together; there is no window in which one has happened and the
 * > other has not.
 *
 * What it deliberately does NOT do is remove content. Their messages stay where they are,
 * unattributed - domain invariant 10 - because a message vanishing mid-conversation tears a hole
 * in every thread it was part of, and the same reasoning that makes a chat delete a tombstone
 * makes an account deletion an anonymisation.
 *
 * Sessions are deleted as well as blocked. The block is what makes an existing token useless on
 * the next request, since `isSessionUsable` re-asks every time; deleting the rows is so a
 * long-lived session is not left sitting in the table looking valid.
 */
export async function deleteOwnAccount(
  db: Db,
  ctx: AccessContext,
): Promise<Result<{ deleted: true; blockedBy?: string[] }>> {
  /*
   * A club Owner has to hand the club over first, and this is a real collision between two
   * rules rather than a cautious choice.
   *
   * PRD/03 rule 11 makes deletion unconditional and self-service. PRD/04 says the Owner's Leave
   * action is not even rendered, because transfer is the only path out - and domain invariant 1
   * requires exactly one Owner per club, always, "because an ownerless club has NO recovery
   * path". Deleting an Owner's memberships would produce precisely that: the partial unique
   * index enforces *at most* one owner, so nothing would stop it.
   *
   * Of the three available outcomes - leave the club ownerless, delete other people's club out
   * from under them, or refuse until the owner acts - only the third preserves both the
   * invariant and the other members' club. So deletion refuses and NAMES the clubs, which keeps
   * it self-service: the client can offer transfer-or-delete for each one and come back.
   *
   * Recorded as an open product question in PRD/17. If the answer turns out to be "promote the
   * longest-serving admin automatically", it belongs here.
   */
  const owned = await db.execute<{ id: string; name: string }>(sql`
    SELECT c.id::text AS id, c.name
      FROM club_memberships cm
      JOIN clubs c ON c.id = cm.club_id
     WHERE cm.user_id = ${ctx.userId} AND cm.role = 'owner'
     ORDER BY c.name
  `);
  if (owned.rows.length > 0) {
    return { ok: false, code: 'owns_clubs' };
  }

  /*
   * Every channel this account can currently reach, captured BEFORE the memberships go.
   *
   * > **Deleting the rows is not enough, and this was missing entirely until 2026-08-08.** A
   * > channel subscription is authorized once, at subscribe time, and never rechecked per
   * > message - so a live socket outlives the membership that justified it. Every other removal
   * > path in the product already knows this and publishes a revocation: club departure, club
   * > deletion, race removal, Eboard demotion and Eboard departure. Account deletion wrote no
   * > outbox event at all, so it published nothing, and a member who deleted their account kept
   * > receiving their old club's conversation in real time for as long as they left the app
   * > open. Proved by watching a message posted after `DELETE /me` arrive on the deleted
   * > account's socket.
   *
   * Read through `accessibleChannelPredicate` rather than a hand-written join, because "which
   * channels can this person reach" has exactly one definition and this is the sixth caller of
   * it. Writing a seventh copy here is the mistake that hid race chat for a whole phase.
   */
  const reachable = await db.execute<{ id: string }>(sql`
    SELECT c.id::text AS id FROM channels c WHERE ${accessibleChannelPredicate(ctx.userId)}
  `);
  const channelIds = reachable.rows.map((row) => row.id);

  await db.transaction(async (tx) => {
    /*
     * The revocation goes through the outbox, not straight to Redis, and that is ADR-0006's
     * argument rather than a preference: the event commits in the same transaction as the
     * deletion, so a process that dies between the two cannot leave an account deleted with its
     * sockets still attached. An immediate publish has exactly that window. It also puts account
     * lifecycle on the same mechanism as the five removal paths above rather than inventing a
     * sixth.
     *
     * Written BEFORE the deletes for the same reason `club.deleted` is: `outbox.partition_key`
     * carries no foreign key, deliberately, so an effect can outlive what it describes.
     */
    if (channelIds.length > 0) {
      await tx.insert(outbox).values({
        partitionKey: ctx.userId,
        eventType: 'account.deleted',
        payload: { userId: ctx.userId, channelIds },
      });
    }

    await tx.execute(sql`
      UPDATE users
         SET anonymized_at = now(),
             signin_blocked_at = now(),
             -- A name, because every roster and message bubble renders one. "Deleted member"
             -- rather than an empty string for the same reason a tombstone says something.
             full_name = 'Deleted member',
             -- The email is released rather than kept: it is UNIQUE, and holding it would stop
             -- the person ever signing up again with their own address. Made unique-but-dead by
             -- deriving it from the id, which is already unique.
             email = 'deleted+' || id::text || '@deleted.invalid',
             image = NULL,
             bio = NULL,
             city = NULL,
             school = NULL,
             dob = NULL
       WHERE id = ${ctx.userId}
    `);

    // Memberships go: a deleted account must not keep appearing on rosters, and leaving them
    // would keep it in every audience function and notification fan-out.
    await tx.execute(sql`DELETE FROM club_memberships WHERE user_id = ${ctx.userId}`);
    await tx.execute(sql`DELETE FROM eboard_memberships WHERE user_id = ${ctx.userId}`);
    await tx.execute(sql`DELETE FROM race_memberships WHERE user_id = ${ctx.userId}`);
    await tx.execute(sql`DELETE FROM car_group_members WHERE user_id = ${ctx.userId}`);
    await tx.execute(sql`DELETE FROM devices WHERE user_id = ${ctx.userId}`);
    await tx.execute(sql`DELETE FROM sessions WHERE user_id = ${ctx.userId}`);
    await tx.execute(sql`DELETE FROM accounts WHERE user_id = ${ctx.userId}`);
  });

  return { ok: true, deleted: true };
}
