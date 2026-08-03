/**
 * Membership commands.
 *
 * Every write here is atomic, re-checks the actor's authority in its own body, and emits
 * its outbox event in the same transaction as the rows it changes. "Multi-step flows are
 * atomic and re-check authorization themselves" is a stated requirement rather than a
 * style: approving a join request updates the request AND creates the membership, and a
 * partial application of that pair leaves a club with a decided request and no member.
 *
 * Authority comes from the policy module. Nothing here re-derives a predicate.
 */

import { and, eq, sql } from 'drizzle-orm';
import type { ClubRole, JoinPolicy } from '@clubchat/shared';
import type { Db } from '../db/client.ts';
import { isUniqueViolation } from '../db/errors.ts';
import { isoUtc } from '../db/sql-helpers.ts';
import {
  clubJoinRequests,
  clubMemberships,
  clubs,
  eboardChannels,
  eboardMemberships,
  outbox,
} from '../db/schema.ts';
import type { AccessContext } from '../policy/context.ts';
import {
  canChangeRole,
  canDeleteClub,
  canLeaveClub,
  canManageJoinRequests,
  canRemoveMember,
  canRotateInviteToken,
  canTransferOwnership,
  isClubAdmin,
  isClubMember,
} from '../policy/predicates.ts';
import { mintInviteToken } from './create-club.ts';

export type Refusal = {
  ok: false;
  code: 'forbidden' | 'not_found' | 'already_member' | 'already_pending' | 'invalid';
};
export type Ok<T> = { ok: true } & T;
export type Result<T> = Ok<T> | Refusal;

/** The Eboard id for a club, if it has one. Every club does. */
async function eboardIdFor(db: Db, clubId: string): Promise<string | null> {
  const rows = await db
    .select({ id: eboardChannels.id })
    .from(eboardChannels)
    .where(eq(eboardChannels.clubId, clubId))
    .limit(1);
  return rows[0]?.id ?? null;
}

async function roleOf(db: Db, clubId: string, userId: string): Promise<ClubRole | null> {
  const rows = await db
    .select({ role: clubMemberships.role })
    .from(clubMemberships)
    .where(and(eq(clubMemberships.clubId, clubId), eq(clubMemberships.userId, userId)))
    .limit(1);
  return (rows[0]?.role as ClubRole) ?? null;
}

// ---------------------------------------------------------------------------
// Joining
// ---------------------------------------------------------------------------

export type JoinOutcome = { status: 'joined' | 'requested'; role?: ClubRole };

/**
 * Join a club by finding it in search.
 *
 * The policy decides: `open` admits immediately, `request` files a pending row for an admin
 * to decide. Note that this is the SEARCH path - the invite link is a separate command that
 * joins instantly regardless of policy, because a link is a private side channel and is
 * deliberately independent of the public path.
 */
export async function joinClub(
  db: Db,
  userId: string,
  clubId: string,
): Promise<Result<JoinOutcome>> {
  const club = await db.select().from(clubs).where(eq(clubs.id, clubId)).limit(1);
  const found = club[0];
  if (!found) return { ok: false, code: 'not_found' };

  if ((await roleOf(db, clubId, userId)) !== null) {
    return { ok: false, code: 'already_member' };
  }

  if ((found.joinPolicy as JoinPolicy) === 'open') {
    return admit(db, { clubId, userId, actorId: null, via: 'open' });
  }

  try {
    const rows = await db
      .insert(clubJoinRequests)
      .values({ clubId, userId })
      .returning({ id: clubJoinRequests.id });
    const request = rows[0];
    if (!request) return { ok: false, code: 'invalid' };

    await db.insert(outbox).values({
      partitionKey: clubId,
      eventType: 'club.join_requested',
      payload: { clubId, userId, requestId: request.id },
    });

    return { ok: true, status: 'requested' };
  } catch (error) {
    /*
     * ONLY the one-pending partial index. Re-requesting while a decision is outstanding is a
     * no-op rather than an error - the UI shows "Requested" either way.
     *
     * > **This caught everything**, so a lost connection or a broken constraint was reported to
     * > the caller as "you have already asked" - a plausible, wrong answer that no monitor could
     * > see, because nothing failed as far as the API was concerned. Anything that is not the
     * > duplicate now propagates and becomes a 500 the error handler reports.
     */
    if (isUniqueViolation(error)) return { ok: false, code: 'already_pending' };
    throw error;
  }
}

/**
 * Join by invite link.
 *
 * **Joins instantly regardless of join policy.** The link is a private side channel,
 * deliberately independent of the public search path: an admin who shares it has already
 * made the decision that the `request` policy exists to capture. Idempotent - opening the
 * same link twice is a no-op, not an error.
 */
export async function redeemInvite(
  db: Db,
  userId: string,
  token: string,
): Promise<Result<JoinOutcome & { clubId: string }>> {
  const rows = await db.select().from(clubs).where(eq(clubs.inviteToken, token)).limit(1);
  const club = rows[0];
  if (!club) return { ok: false, code: 'not_found' };

  const existing = await roleOf(db, club.id, userId);
  if (existing !== null) {
    // The second attempt is a no-op, not an error.
    return { ok: true, status: 'joined', role: existing, clubId: club.id };
  }

  const result = await admit(db, { clubId: club.id, userId, actorId: null, via: 'link' });
  if (!result.ok) return result;
  return { ...result, clubId: club.id };
}

/**
 * Create the membership rows and emit the event.
 *
 * Shared by every path into a club, so "what happens when someone joins" exists once.
 */
async function admit(
  db: Db,
  input: {
    clubId: string;
    userId: string;
    actorId: string | null;
    via: 'open' | 'link' | 'added' | 'approved';
  },
): Promise<Result<JoinOutcome>> {
  await db.transaction(async (tx) => {
    await tx
      .insert(clubMemberships)
      .values({ clubId: input.clubId, userId: input.userId, role: 'member' })
      .onConflictDoNothing();

    await tx.insert(outbox).values({
      partitionKey: input.clubId,
      eventType: 'club.member_joined',
      payload: {
        clubId: input.clubId,
        userId: input.userId,
        actorId: input.actorId,
        via: input.via,
      },
    });
  });

  return { ok: true, status: 'joined', role: 'member' };
}

// ---------------------------------------------------------------------------
// Deciding requests
// ---------------------------------------------------------------------------

/**
 * Approve or deny a pending request.
 *
 * **Idempotent by construction.** Two admins hitting Approve on the same request must
 * produce one membership, one notification and one recorded decider - so the update is
 * conditional on the row still being `pending`, and a second caller finds nothing to
 * update and stops. Doing this with a read-then-write instead would let both pass the read.
 */
export async function decideJoinRequest(
  db: Db,
  ctx: AccessContext,
  requestId: string,
  approve: boolean,
): Promise<Result<{ decided: boolean }>> {
  const rows = await db
    .select()
    .from(clubJoinRequests)
    .where(eq(clubJoinRequests.id, requestId))
    .limit(1);
  const request = rows[0];
  if (!request) return { ok: false, code: 'not_found' };

  // Re-checked here, in the command's own body, rather than trusted from whatever gate the
  // caller passed through.
  if (!canManageJoinRequests(ctx, request.clubId)) return { ok: false, code: 'forbidden' };

  const decided = await db.transaction(async (tx) => {
    const updated = await tx.execute<{ id: string }>(sql`
      UPDATE club_join_requests
         SET status = ${approve ? 'approved' : 'denied'},
             decided_by = ${ctx.userId},
             decided_at = now()
       WHERE id = ${requestId}
         AND status = 'pending'
      RETURNING id
    `);

    // Somebody else already decided it. Not an error - the outcome the caller wanted is
    // already true - but nothing further should happen.
    if (updated.rows.length === 0) return false;

    if (approve) {
      await tx
        .insert(clubMemberships)
        .values({ clubId: request.clubId, userId: request.userId, role: 'member' })
        .onConflictDoNothing();
    }

    await tx.insert(outbox).values({
      partitionKey: request.clubId,
      eventType: 'club.join_decided',
      payload: {
        clubId: request.clubId,
        userId: request.userId,
        actorId: ctx.userId,
        approved: approve,
      },
    });

    return true;
  });

  return { ok: true, decided };
}

/**
 * Add someone directly, without a request.
 *
 * A search over users rather than an invitation the recipient must accept.
 */
export async function addMember(
  db: Db,
  ctx: AccessContext,
  clubId: string,
  userId: string,
): Promise<Result<JoinOutcome>> {
  if (!isClubAdmin(ctx, clubId)) return { ok: false, code: 'forbidden' };
  if ((await roleOf(db, clubId, userId)) !== null) return { ok: false, code: 'already_member' };
  return admit(db, { clubId, userId, actorId: ctx.userId, via: 'added' });
}

/**
 * Edit the club's identity: its name, description and picture.
 *
 * **Admin tier, and the same predicate every other club edit uses.** The join policy is NOT set
 * here even though the edit form shows it in the same panel - it has its own handler because
 * switching to `open` auto-approves every pending request, which is a membership effect rather
 * than an identity one and belongs in one transaction with the policy change.
 *
 * An absent field is left alone; an explicit null clears it. That distinction is why the type is
 * `null | undefined` rather than optional-with-null: "do not touch the description" and "remove
 * the description" are different instructions, and a form that sent an empty string for both
 * would make them the same.
 */
export async function updateClub(
  db: Db,
  ctx: AccessContext,
  clubId: string,
  fields: {
    name?: string | undefined;
    description?: string | null | undefined;
    image?: string | null | undefined;
  },
): Promise<Result<{ updated: true }>> {
  if (!isClubAdmin(ctx, clubId)) return { ok: false, code: 'forbidden' };

  const patch: Record<string, unknown> = {};
  if (fields.name !== undefined) patch['name'] = fields.name;
  if (fields.description !== undefined) patch['description'] = fields.description;
  if (fields.image !== undefined) patch['image'] = fields.image;
  if (Object.keys(patch).length === 0) return { ok: true, updated: true };

  await db.update(clubs).set(patch).where(eq(clubs.id, clubId));
  return { ok: true, updated: true };
}

/**
 * Flip the join policy.
 *
 * **Switching `request` to `open` auto-approves every pending request**, rather than
 * stranding people with no approval step left in the product. Done in one transaction with
 * the policy change, so there is no window in which the club is open and requests are still
 * waiting.
 */
export async function setJoinPolicy(
  db: Db,
  ctx: AccessContext,
  clubId: string,
  policy: JoinPolicy,
): Promise<Result<{ autoApproved: number }>> {
  if (!isClubAdmin(ctx, clubId)) return { ok: false, code: 'forbidden' };

  const autoApproved = await db.transaction(async (tx) => {
    await tx.update(clubs).set({ joinPolicy: policy }).where(eq(clubs.id, clubId));

    if (policy !== 'open') return 0;

    const approved = await tx.execute<{ user_id: string }>(sql`
      UPDATE club_join_requests
         SET status = 'approved', decided_by = ${ctx.userId}, decided_at = now()
       WHERE club_id = ${clubId} AND status = 'pending'
      RETURNING user_id
    `);

    for (const row of approved.rows) {
      await tx
        .insert(clubMemberships)
        .values({ clubId, userId: row.user_id, role: 'member' })
        .onConflictDoNothing();

      await tx.insert(outbox).values({
        partitionKey: clubId,
        eventType: 'club.join_decided',
        payload: { clubId, userId: row.user_id, actorId: ctx.userId, approved: true },
      });
    }

    return approved.rows.length;
  });

  return { ok: true, autoApproved };
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

/**
 * Promote a Member to Admin, or demote an Admin to Member.
 *
 * **Entering the admin tier auto-joins the Eboard space; leaving it auto-removes.** That is
 * the defining difference between Eboard and Race: for a race, authority and access are
 * separate, and for the Eboard they are the same thing. Done in the same transaction as the
 * role change, so the space can never drift out of sync with who is actually an admin -
 * which is exactly the v1 failure that made the space request-only in the first place.
 */
export async function changeRole(
  db: Db,
  ctx: AccessContext,
  clubId: string,
  userId: string,
  newRole: Extract<ClubRole, 'admin' | 'member'>,
): Promise<Result<{ role: ClubRole }>> {
  const current = await roleOf(db, clubId, userId);
  if (current === null) return { ok: false, code: 'not_found' };
  if (!canChangeRole(ctx, clubId, { role: current })) return { ok: false, code: 'forbidden' };
  // The Owner's role moves only through the transfer path.
  if (current === 'owner') return { ok: false, code: 'forbidden' };
  if (current === newRole) return { ok: true, role: current };

  const eboardId = await eboardIdFor(db, clubId);

  await db.transaction(async (tx) => {
    await tx
      .update(clubMemberships)
      .set({ role: newRole })
      .where(and(eq(clubMemberships.clubId, clubId), eq(clubMemberships.userId, userId)));

    if (eboardId) {
      if (newRole === 'admin') {
        await tx
          .insert(eboardMemberships)
          .values({ eboardId, userId })
          // Named, never bare. An untargeted clause claims that EVERY current and future unique
          // constraint on this table means "ignore this write" - failure mode 13, which cost a
          // silently-swallowed car-group invariant once already.
          .onConflictDoNothing({
            target: [eboardMemberships.eboardId, eboardMemberships.userId],
          });
      } else {
        await tx
          .delete(eboardMemberships)
          .where(and(eq(eboardMemberships.eboardId, eboardId), eq(eboardMemberships.userId, userId)));
      }
    }

    await tx.insert(outbox).values({
      partitionKey: clubId,
      eventType: 'club.role_changed',
      payload: { clubId, userId, actorId: ctx.userId, newRole, previousRole: current },
    });
  });

  return { ok: true, role: newRole };
}

/**
 * Transfer ownership.
 *
 * > **Demote before promote.** The one-owner constraint is checked per statement, so
 * > promoting first momentarily holds two owners and correctly fails. Proved against the
 * > live database in `db/constraint-proof.sql`, not merely remembered here.
 *
 * **An ownership transfer is a no-op for Eboard membership** - both parties stay
 * admin-tier - and it posts ONE system message, not two, which is why it emits its own
 * event type rather than two role changes.
 */
export async function transferOwnership(
  db: Db,
  ctx: AccessContext,
  clubId: string,
  toUserId: string,
): Promise<Result<{ previousOwnerId: string }>> {
  if (!canTransferOwnership(ctx, clubId)) return { ok: false, code: 'forbidden' };
  if (toUserId === ctx.userId) return { ok: false, code: 'invalid' };

  const target = await roleOf(db, clubId, toUserId);
  // Transferable to any CURRENT member, so someone outside the club cannot be handed it.
  if (target === null) return { ok: false, code: 'not_found' };

  const eboardId = await eboardIdFor(db, clubId);

  await db.transaction(async (tx) => {
    // Order is load-bearing. Demote first.
    await tx
      .update(clubMemberships)
      .set({ role: 'admin' })
      .where(and(eq(clubMemberships.clubId, clubId), eq(clubMemberships.userId, ctx.userId)));

    await tx
      .update(clubMemberships)
      .set({ role: 'owner' })
      .where(and(eq(clubMemberships.clubId, clubId), eq(clubMemberships.userId, toUserId)));

    // The new owner is admin-tier and so must be in the Eboard space. If they were a plain
    // member a moment ago, this is what puts them there.
    if (eboardId) {
      await tx
        .insert(eboardMemberships)
        .values({ eboardId, userId: toUserId })
        .onConflictDoNothing();
    }

    await tx.insert(outbox).values({
      partitionKey: clubId,
      eventType: 'club.ownership_transferred',
      payload: { clubId, fromUserId: ctx.userId, toUserId },
    });
  });

  return { ok: true, previousOwnerId: ctx.userId };
}

// ---------------------------------------------------------------------------
// Leaving and removal
// ---------------------------------------------------------------------------

/**
 * Remove someone from the club.
 *
 * Any admin may remove a plain Member; removing an Admin is **Owner-only**; the Owner can
 * never be removed at all. The asymmetry is deliberate - admins policing each other's role
 * is normal, ejecting each other is not - and it lives in `canRemoveMember`, not here.
 */
export async function removeMember(
  db: Db,
  ctx: AccessContext,
  clubId: string,
  userId: string,
): Promise<Result<{ removed: true }>> {
  const current = await roleOf(db, clubId, userId);
  if (current === null) return { ok: false, code: 'not_found' };
  if (!canRemoveMember(ctx, clubId, { role: current, userId })) {
    return { ok: false, code: 'forbidden' };
  }

  await cascadeOut(db, { clubId, userId, actorId: ctx.userId, reason: 'removed' });
  return { ok: true, removed: true };
}

/**
 * Leave a club.
 *
 * The Owner cannot leave their own club - an ownerless club has no recovery path, so
 * transfer is the only exit. Enforced here as well as hidden in the UI, because a hidden
 * button is UX and never enforcement.
 */
export async function leaveClub(
  db: Db,
  ctx: AccessContext,
  clubId: string,
): Promise<Result<{ left: true }>> {
  if (!isClubMember(ctx, clubId)) return { ok: false, code: 'not_found' };
  if (!canLeaveClub(ctx, clubId)) return { ok: false, code: 'forbidden' };

  await cascadeOut(db, { clubId, userId: ctx.userId, actorId: null, reason: 'left' });
  return { ok: true, left: true };
}

/**
 * The membership cascade.
 *
 * > **Removing someone from a club cleans up every dependent membership in the same
 * > action** - race rosters, car-group assignments, and Eboard membership for that club.
 * > **All** races, not just upcoming ones.
 *
 * Phase 2 adds the race deletes here as two more statements; the Eboard delete is the same
 * shape. What must not happen is a partial cascade, which is why this is one transaction
 * rather than a sequence of commands.
 *
 * The emitted event is also what triggers force-unsubscribe: deleting the row alone leaves
 * the departing member's socket receiving messages from a channel they no longer belong to,
 * and nothing reports it (ADR-0007).
 */
async function cascadeOut(
  db: Db,
  input: {
    clubId: string;
    userId: string;
    actorId: string | null;
    reason: 'removed' | 'left';
  },
): Promise<void> {
  const eboardId = await eboardIdFor(db, input.clubId);

  await db.transaction(async (tx) => {
    if (eboardId) {
      await tx
        .delete(eboardMemberships)
        .where(
          and(eq(eboardMemberships.eboardId, eboardId), eq(eboardMemberships.userId, input.userId)),
        );
    }

    // Every race in the club, not just upcoming ones. Car groups first, because the
    // Incharge check reads the group before the membership row is gone.
    //
    // The Incharge consequence is deliberately NOT raised here: leaving the club is a
    // bigger event than vacating a car seat, and firing a "group needs a new Incharge"
    // notification per affected group on top of "X left the club" would bury the thing
    // admins actually need to see. The groups are left without an Incharge, which the
    // car-groups screen shows plainly.
    await tx.execute(sql`
      DELETE FROM car_group_members
       WHERE user_id = ${input.userId}
         AND race_id IN (SELECT id FROM races WHERE club_id = ${input.clubId})
    `);

    await tx.execute(sql`
      UPDATE car_groups SET incharge_user_id = NULL
       WHERE incharge_user_id = ${input.userId}
         AND race_id IN (SELECT id FROM races WHERE club_id = ${input.clubId})
    `);

    await tx.execute(sql`
      DELETE FROM race_memberships
       WHERE user_id = ${input.userId}
         AND race_id IN (SELECT id FROM races WHERE club_id = ${input.clubId})
    `);

    await tx.execute(sql`
      DELETE FROM race_join_requests
       WHERE user_id = ${input.userId}
         AND status = 'pending'
         AND race_id IN (SELECT id FROM races WHERE club_id = ${input.clubId})
    `);

    await tx
      .delete(clubMemberships)
      .where(
        and(eq(clubMemberships.clubId, input.clubId), eq(clubMemberships.userId, input.userId)),
      );

    // Any outstanding request is resolved too, so the person is not left both out of the
    // club and holding a pending row that an admin will later be asked to decide.
    await tx
      .delete(clubJoinRequests)
      .where(
        and(
          eq(clubJoinRequests.clubId, input.clubId),
          eq(clubJoinRequests.userId, input.userId),
          eq(clubJoinRequests.status, 'pending'),
        ),
      );

    await tx.insert(outbox).values({
      partitionKey: input.clubId,
      eventType: input.reason === 'removed' ? 'club.member_removed' : 'club.member_left',
      payload: {
        clubId: input.clubId,
        userId: input.userId,
        actorId: input.actorId,
      },
    });
  });
}

/**
 * Delete a club. Owner only, and permanent.
 *
 * Chat history, members, the Eboard space, polls and posts all go with it, by database
 * cascade rather than by application code walking the tree - a hand-written cascade will
 * eventually miss a table that a foreign key cannot.
 *
 * **A cascade must not be blocked by a child-level permission rule**: deleting a club
 * really does remove the Owner's own membership row, even though nothing may delete that
 * row directly.
 */
export async function deleteClub(
  db: Db,
  ctx: AccessContext,
  clubId: string,
): Promise<Result<{ deleted: true; channelIds: string[] }>> {
  if (!canDeleteClub(ctx, clubId)) return { ok: false, code: 'forbidden' };

  // Collected BEFORE the delete: afterwards the channels are gone and there is nothing left
  // to tell the gateways to unsubscribe from.
  const channels = await db.execute<{ id: string }>(
    sql`SELECT id FROM channels WHERE club_id = ${clubId}`,
  );
  const members = await db.execute<{ user_id: string }>(
    sql`SELECT user_id FROM club_memberships WHERE club_id = ${clubId}`,
  );
  const channelIds = channels.rows.map((r) => r.id);

  await db.transaction(async (tx) => {
    // Written BEFORE the delete, because `outbox.partition_key` is a plain text column with
    // no foreign key - deliberately, so an effect can outlive the thing it describes.
    await tx.insert(outbox).values({
      partitionKey: clubId,
      eventType: 'club.deleted',
      payload: {
        clubId,
        channelIds,
        memberIds: members.rows.map((r) => r.user_id),
        actorId: ctx.userId,
      },
    });

    await tx.delete(clubs).where(eq(clubs.id, clubId));
  });

  return { ok: true, deleted: true, channelIds };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
//
// Phase 2 and Phase 1 between them built every club command and no club queries: the roster
// could be written to and never read, and the club itself had PATCH and DELETE with no GET.
// A route answering 404 because nothing was built is indistinguishable from one answering 404
// because the caller may not look, which is why these went in before the screens.

export type ClubRosterEntry = {
  userId: string;
  name: string;
  image: string | null;
  role: ClubRole;
  joinedAt: string;
};

export type ClubJoinRequestEntry = {
  requestId: string;
  userId: string;
  name: string;
  /** Their picture, on the same terms as a roster entry's - the queue draws the same person. */
  image: string | null;
  requestedAt: string;
};

/**
 * The roster, and - for an admin only - who is waiting to join.
 *
 * `pendingRequests` is **null** rather than `[]` for a plain member, so a client cannot read
 * "not allowed to see this" as "nobody is waiting". The same shape as the race roster, for the
 * same reason.
 *
 * Ordering is owner, then admins, then members, each alphabetically: the roster doubles as the
 * screen where authority is granted and removed, so who holds it belongs at the top rather than
 * wherever their name happens to sort.
 */
export async function readClubRoster(
  db: Db,
  ctx: AccessContext,
  clubId: string,
): Promise<Result<{ members: ClubRosterEntry[]; pendingRequests: ClubJoinRequestEntry[] | null }>> {
  if (!isClubMember(ctx, clubId)) return { ok: false, code: 'not_found' };

  const memberRows = await db.execute<{
    user_id: string;
    full_name: string;
    image: string | null;
    role: string;
    joined_at: string;
  }>(sql`
    SELECT u.id::text AS user_id,
           u.full_name,
           u.image,
           cm.role::text AS role,
           ${isoUtc('cm.joined_at')} AS joined_at
      FROM club_memberships cm
      JOIN users u ON u.id = cm.user_id
     WHERE cm.club_id = ${clubId}
     ORDER BY CASE cm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
              u.full_name
  `);

  const members: ClubRosterEntry[] = memberRows.rows.map((row) => ({
    userId: row.user_id,
    name: row.full_name,
    image: row.image,
    role: row.role as ClubRole,
    joinedAt: row.joined_at,
  }));

  // Who is waiting is decision-making data, and only the admin tier decides.
  if (!canManageJoinRequests(ctx, clubId)) {
    return { ok: true, members, pendingRequests: null };
  }

  const requestRows = await db.execute<{
    id: string;
    user_id: string;
    full_name: string;
    image: string | null;
    created_at: string;
  }>(sql`
    SELECT jr.id::text AS id,
           u.id::text AS user_id,
           u.full_name,
           u.image,
           ${isoUtc('jr.created_at')} AS created_at
      FROM club_join_requests jr
      JOIN users u ON u.id = jr.user_id
     WHERE jr.club_id = ${clubId} AND jr.status = 'pending'
     ORDER BY jr.created_at
  `);

  return {
    ok: true,
    members,
    pendingRequests: requestRows.rows.map((row) => ({
      requestId: row.id,
      userId: row.user_id,
      name: row.full_name,
      image: row.image,
      requestedAt: row.created_at,
    })),
  };
}

export type ClubDetail = {
  id: string;
  name: string;
  sport: string;
  description: string | null;
  /** The club's picture, as a media id. Null falls back to its initial. */
  image: string | null;
  joinPolicy: JoinPolicy;
  memberCount: number;
  createdAt: string;
  /** The club's main chat, so the hub can navigate without a second lookup. */
  channelId: string | null;
  /** The Eboard space, present for every club - but only named to somebody in it. */
  eboardId: string | null;
  /**
   * The Eboard's chat channel, on the same terms as the id above.
   *
   * So the hub can open the conversation directly rather than pushing a landing screen that
   * immediately redirects into it - two transitions for one tap, which is the difference
   * between how entering the Eboard felt and how entering club main chat felt.
   */
  eboardChannelId: string | null;
  viewer: {
    role: ClubRole;
    isAdmin: boolean;
    isOwner: boolean;
  };
  /**
   * The invite token, for the admin tier only.
   *
   * The link is now the ONLY invite mechanism (ADR-0010 removed the typed code), so the token
   * is the whole of a club's access control against anybody holding it. It is withheld from a
   * plain member here rather than hidden in the UI, because a hidden field is not withheld.
   */
  inviteToken: string | null;
};

/** One club, for the club hub and the club profile screen. Members only. */
export async function readClub(
  db: Db,
  ctx: AccessContext,
  clubId: string,
): Promise<Result<{ club: ClubDetail }>> {
  const role = ctx.clubRole.get(clubId);
  if (role === undefined) return { ok: false, code: 'not_found' };

  const rows = await db.execute<{
    id: string;
    name: string;
    sport: string;
    description: string | null;
    image: string | null;
    join_policy: string;
    invite_token: string;
    created_at: string;
    member_count: string;
    channel_id: string | null;
    eboard_id: string | null;
    eboard_channel_id: string | null;
  }>(sql`
    SELECT c.id::text AS id,
           c.name,
           c.sport,
           c.description,
           c.image,
           c.join_policy::text AS join_policy,
           c.invite_token,
           ${isoUtc('c.created_at')} AS created_at,
           (SELECT count(*) FROM club_memberships m WHERE m.club_id = c.id) AS member_count,
           ch.id::text AS channel_id,
           eb.id::text AS eboard_id,
           ebch.id::text AS eboard_channel_id
      FROM clubs c
      LEFT JOIN channels ch ON ch.scope = 'club' AND ch.scope_id = c.id
      LEFT JOIN eboard_channels eb ON eb.club_id = c.id
      -- The Eboard's CONVERSATION, so the hub can open it directly rather than pushing a
      -- landing screen that immediately redirects. See the note beside eboardChannelId below.
      LEFT JOIN channels ebch ON ebch.scope = 'eboard' AND ebch.scope_id = eb.id
     WHERE c.id = ${clubId}
  `);

  const row = rows.rows[0];
  if (!row) return { ok: false, code: 'not_found' };

  const isAdmin = isClubAdmin(ctx, clubId);

  return {
    ok: true,
    club: {
      id: row.id,
      name: row.name,
      sport: row.sport,
      description: row.description,
      image: row.image,
      joinPolicy: row.join_policy as JoinPolicy,
      memberCount: Number(row.member_count),
      createdAt: row.created_at,
      channelId: row.channel_id,
      // Named only to somebody actually in the space. An ordinary member has no visibility
      // of the Eboard at all, and returning its id here would be the one place that leaked.
      eboardId:
        row.eboard_id !== null && ctx.eboardMember.has(row.eboard_id) ? row.eboard_id : null,
      /**
       * The Eboard's chat channel, for a member of the space.
       *
       * > **So the hub can open the conversation directly, the way it already opens club main
       * > chat.** A member entering the space is taken straight to chat (PRD/10 rule 15), and
       * > routing that through the landing screen means one tap costs a push plus a replace -
       * > two transitions for one act, which reads as a stumble on the way in and cannot be
       * > tuned away, because the second transition is real.
       *
       * Gated exactly as `eboardId` is, and for the same reason: an ordinary member has no
       * visibility of the space at all, so this must not become the one field that leaks it.
       */
      eboardChannelId:
        row.eboard_id !== null && ctx.eboardMember.has(row.eboard_id)
          ? row.eboard_channel_id
          : null,
      viewer: {
        role,
        isAdmin,
        isOwner: role === 'owner',
      },
      inviteToken: isAdmin ? row.invite_token : null,
    },
  };
}

/**
 * Find a club to join.
 *
 * > **A safe projection, and only clubs the caller is NOT in.** Non-members must be able to
 * > find and join a club without being able to read anything inside it, so this returns the
 * > name, the sport, a member count and the caller's own request status - and nothing else. No
 * > description, no roster, no invite token, no channel id.
 *
 * Clubs the caller already belongs to are excluded rather than annotated. PRD/04's edge-case
 * table says a searched club they are in "shows membership rather than a Join button", and the
 * client already knows every club it belongs to from `GET /clubs` - so including them here would
 * duplicate that list into a second shape that could disagree with it.
 *
 * Limited to a handful of results by default. There is no paging: search is a way to find a
 * specific club by name, not a directory to browse.
 */
export async function searchClubs(
  db: Db,
  ctx: AccessContext,
  opts: { query: string; limit?: number | undefined },
): Promise<
  Array<{
    id: string;
    name: string;
    sport: string;
    memberCount: number;
    joinPolicy: JoinPolicy;
    requestPending: boolean;
  }>
> {
  const query = opts.query.trim();
  // An empty query returns nothing rather than every club. "No clubs found" is the right
  // answer to a question nobody asked, and a bare listing is the directory this is not.
  if (query.length === 0) return [];

  const limit = Math.min(opts.limit ?? 10, 25);

  const rows = await db.execute<{
    id: string;
    name: string;
    sport: string;
    member_count: string;
    join_policy: string;
    request_pending: boolean;
  }>(sql`
    SELECT c.id::text AS id,
           c.name,
           c.sport,
           (SELECT count(*) FROM club_memberships m WHERE m.club_id = c.id) AS member_count,
           c.join_policy::text AS join_policy,
           EXISTS (
             SELECT 1 FROM club_join_requests jr
              WHERE jr.club_id = c.id AND jr.user_id = ${ctx.userId} AND jr.status = 'pending'
           ) AS request_pending
      FROM clubs c
     WHERE c.name ILIKE ${'%' + query + '%'}
       AND NOT EXISTS (
         SELECT 1 FROM club_memberships mine
          WHERE mine.club_id = c.id AND mine.user_id = ${ctx.userId}
       )
     ORDER BY c.name
     LIMIT ${limit}
  `);

  return rows.rows.map((row) => ({
    id: row.id,
    name: row.name,
    sport: row.sport,
    memberCount: Number(row.member_count),
    joinPolicy: row.join_policy as JoinPolicy,
    requestPending: row.request_pending,
  }));
}

/**
 * Rotate the invite token, invalidating every outstanding link at once.
 *
 * > **A requirement rather than a nicety.** ADR-0010 removed the typed invite code, so the link
 * > is the *only* way into a club besides search - which means a leaked link has no alternative
 * > to fall back on and rotation is the sole remedy. PRD/17 promoted this from an open question
 * > on 2026-07-28 for exactly that reason, and the `invite_token_rotated_at` column has been
 * > sitting unwritten ever since.
 *
 * Invalidating every outstanding link is the correct and expected behaviour, not a side effect
 * to warn about: a rotation happens because a link got somewhere it should not have, and a
 * rotation that left the old one working would be theatre.
 */
export async function rotateInviteToken(
  db: Db,
  ctx: AccessContext,
  clubId: string,
): Promise<Result<{ inviteToken: string }>> {
  if (!canRotateInviteToken(ctx, clubId)) return { ok: false, code: 'not_found' };

  const token = mintInviteToken();
  const rows = await db
    .update(clubs)
    .set({ inviteToken: token, inviteTokenRotatedAt: new Date() })
    .where(eq(clubs.id, clubId))
    .returning({ inviteToken: clubs.inviteToken });

  const updated = rows[0];
  if (!updated) return { ok: false, code: 'not_found' };
  return { ok: true, inviteToken: updated.inviteToken };
}
