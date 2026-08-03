/**
 * The Eboard space: its roster, and the rejoin path.
 *
 * Membership is normally not managed at all - it tracks the admin tier automatically, because
 * promotion auto-joins and demotion auto-removes (PRD/10 rule 2), and that logic lives in
 * `membership.ts` where the role changes happen. Nothing here duplicates it.
 *
 * What lives here is the exception: an admin who deliberately **left** the space. They are
 * still admin-tier, so no promotion will re-add them, and only existing members may add anybody
 * (rule 5) - so they need a request, and had nowhere to file one until Phase 3.75a.
 *
 * The authority model is the opposite of a race's in the one way that matters here: for a race,
 * management authority sits outside the roster; for the Eboard, **only people already inside
 * decide who else gets in**. An admin outside the space approving their own way in would defeat
 * the privacy boundary, which is why every predicate below is `isEboardMember` and never
 * `isClubAdmin`.
 */

import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { isUniqueViolation } from '../db/errors.ts';
import { isoUtc } from '../db/sql-helpers.ts';
import { eboardChannels, eboardJoinRequests, eboardMemberships, outbox } from '../db/schema.ts';
import type { AccessContext } from '../policy/context.ts';
import {
  canApproveEboardRequest,
  canRemoveFromEboard,
  canRequestEboardAccess,
  isClubAdmin,
  isEboardMember,
} from '../policy/predicates.ts';

export type Refusal = {
  ok: false;
  code: 'forbidden' | 'not_found' | 'already_member' | 'already_pending' | 'invalid';
};
export type Result<T> = ({ ok: true } & T) | Refusal;

type EboardRef = { id: string; clubId: string };

async function eboardRef(db: Db, eboardId: string): Promise<EboardRef | null> {
  const rows = await db.execute<{ id: string; club_id: string }>(
    sql`SELECT id::text AS id, club_id::text AS club_id FROM eboard_channels WHERE id = ${eboardId}`,
  );
  const row = rows.rows[0];
  return row ? { id: row.id, clubId: row.club_id } : null;
}

/**
 * Ask to rejoin.
 *
 * Refused for somebody who is not admin-tier in the parent club, and the refusal is
 * `not_found`: **only club admins can see the space exists** (rule 4), so an ordinary member
 * must not be able to learn otherwise by filing a request against it.
 */
export async function requestEboardAccess(
  db: Db,
  ctx: AccessContext,
  eboardId: string,
): Promise<Result<{ status: 'requested' }>> {
  const eboard = await eboardRef(db, eboardId);
  // Two different refusals collapsed into one answer on purpose: not admin-tier, and no such
  // space, are indistinguishable to the caller.
  if (!eboard || !isClubAdmin(ctx, eboard.clubId)) return { ok: false, code: 'not_found' };
  if (!canRequestEboardAccess(ctx, eboard.id)) return { ok: false, code: 'already_member' };

  try {
    const rows = await db
      .insert(eboardJoinRequests)
      .values({ eboardId, userId: ctx.userId })
      .returning({ id: eboardJoinRequests.id });
    if (!rows[0]) return { ok: false, code: 'invalid' };

    await db.insert(outbox).values({
      partitionKey: eboard.clubId,
      eventType: 'eboard.join_requested',
      payload: { clubId: eboard.clubId, eboardId, userId: ctx.userId },
    });
    return { ok: true, status: 'requested' };
  } catch (error) {
    // The pending partial unique index, and nothing else - see `requestToJoinClub` for why a
    // bare catch here answered "already pending" to failures that were not that.
    if (isUniqueViolation(error)) return { ok: false, code: 'already_pending' };
    throw error;
  }
}

/**
 * Approve or deny. **Existing members of the space only.**
 *
 * Not "any club admin", which is the trap this space's model exists to avoid: an admin outside
 * the space who could approve would approve themselves in.
 */
export async function decideEboardRequest(
  db: Db,
  ctx: AccessContext,
  requestId: string,
  approve: boolean,
): Promise<Result<{ decided: boolean }>> {
  const rows = await db
    .select()
    .from(eboardJoinRequests)
    .where(eq(eboardJoinRequests.id, requestId))
    .limit(1);
  const request = rows[0];
  if (!request) return { ok: false, code: 'not_found' };

  const eboard = await eboardRef(db, request.eboardId);
  if (!eboard) return { ok: false, code: 'not_found' };
  if (!canApproveEboardRequest(ctx, eboard.id)) return { ok: false, code: 'not_found' };

  const decided = await db.transaction(async (tx) => {
    // Conditional on still being pending, so two members deciding produce one outcome - the
    // same shape as the club and race decision paths.
    const updated = await tx.execute<{ id: string }>(sql`
      UPDATE eboard_join_requests
         SET status = ${approve ? 'approved' : 'denied'},
             decided_by = ${ctx.userId}, decided_at = now()
       WHERE id = ${requestId} AND status = 'pending'
      RETURNING id
    `);
    if (updated.rows.length === 0) return false;

    if (approve) {
      await tx
        .insert(eboardMemberships)
        .values({ eboardId: request.eboardId, userId: request.userId })
        .onConflictDoNothing({
          target: [eboardMemberships.eboardId, eboardMemberships.userId],
        });
    }

    await tx.insert(outbox).values({
      partitionKey: eboard.clubId,
      eventType: 'eboard.membership_decided',
      payload: {
        clubId: eboard.clubId,
        eboardId: request.eboardId,
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
 * Add an admin directly. Existing members only.
 *
 * The target must already be admin-tier in the club: this space is for the admin tier, and
 * adding a plain member would put somebody in it whom a later demotion could not remove -
 * demotion removes on the way down from admin, and they never were one.
 */
export async function addEboardMember(
  db: Db,
  ctx: AccessContext,
  eboardId: string,
  userId: string,
): Promise<Result<{ added: boolean }>> {
  const eboard = await eboardRef(db, eboardId);
  if (!eboard) return { ok: false, code: 'not_found' };
  if (!canApproveEboardRequest(ctx, eboard.id)) return { ok: false, code: 'not_found' };

  const targetRole = await db.execute<{ role: string }>(sql`
    SELECT role::text AS role FROM club_memberships
     WHERE club_id = ${eboard.clubId} AND user_id = ${userId}
  `);
  const role = targetRole.rows[0]?.role;
  if (role !== 'owner' && role !== 'admin') return { ok: false, code: 'forbidden' };

  const added = await db.transaction(async (tx) => {
    const rows = await tx
      .insert(eboardMemberships)
      .values({ eboardId, userId })
      .onConflictDoNothing({
        target: [eboardMemberships.eboardId, eboardMemberships.userId],
      })
      .returning();
    if (rows.length === 0) return false;

    await tx
      .delete(eboardJoinRequests)
      .where(
        sql`eboard_id = ${eboardId} AND user_id = ${userId} AND status = 'pending'`,
      );

    await tx.insert(outbox).values({
      partitionKey: eboard.clubId,
      eventType: 'eboard.membership_decided',
      payload: {
        clubId: eboard.clubId,
        eboardId,
        userId,
        actorId: ctx.userId,
        approved: true,
        added: true,
      },
    });
    return true;
  });

  return { ok: true, added };
}

/**
 * Leave, or be removed.
 *
 * **Any member may leave; removing somebody else is the club Owner only** (rule 11) - the
 * strictest removal rule in the product, because this is its highest-trust space and mutual
 * removal between admins was explicitly rejected.
 */
export async function removeEboardMember(
  db: Db,
  ctx: AccessContext,
  eboardId: string,
  userId: string,
): Promise<Result<{ removed: true }>> {
  const eboard = await eboardRef(db, eboardId);
  if (!eboard) return { ok: false, code: 'not_found' };

  const isSelf = userId === ctx.userId;
  if (isSelf) {
    if (!isEboardMember(ctx, eboard.id)) return { ok: false, code: 'not_found' };
  } else if (!canRemoveFromEboard(ctx, eboard)) {
    return { ok: false, code: 'forbidden' };
  }

  await db.transaction(async (tx) => {
    await tx.execute(
      sql`DELETE FROM eboard_memberships WHERE eboard_id = ${eboardId} AND user_id = ${userId}`,
    );
    await tx.insert(outbox).values({
      partitionKey: eboard.clubId,
      eventType: 'eboard.member_departed',
      payload: {
        clubId: eboard.clubId,
        eboardId,
        userId,
        actorId: isSelf ? null : ctx.userId,
      },
    });
  });

  return { ok: true, removed: true };
}

/**
 * The space's own identity: what it is called, what it says about itself, and its picture.
 *
 * **Members only, not club admins** - the same boundary as every other write in this file. An
 * admin who is not inside the space cannot rename it or change its face from the outside, for
 * the reason rule 5 gives about adding people: authority over the club is not authority
 * *inside* the space.
 *
 * Absent leaves a field alone; `null` clears it. The pencil sends a name and a description, the
 * avatar tap sends only a picture, and neither may erase what the other owns.
 */
export async function updateEboard(
  db: Db,
  ctx: AccessContext,
  eboardId: string,
  fields: {
    name?: string | undefined;
    description?: string | null | undefined;
    image?: string | null | undefined;
  },
): Promise<Result<{ updated: true }>> {
  const eboard = await eboardRef(db, eboardId);
  // `not_found` rather than `forbidden` for a non-admin, because rule 4 says an ordinary
  // member must not learn the space exists - including by the shape of a refusal.
  if (!eboard || !isClubAdmin(ctx, eboard.clubId)) return { ok: false, code: 'not_found' };
  if (!isEboardMember(ctx, eboard.id)) return { ok: false, code: 'forbidden' };

  const patch: Record<string, unknown> = {};
  if (fields.name !== undefined) {
    const name = fields.name.trim();
    if (name.length === 0) return { ok: false, code: 'invalid' };
    patch['name'] = name;
  }
  if (fields.description !== undefined) patch['description'] = fields.description;
  if (fields.image !== undefined) patch['image'] = fields.image;
  if (Object.keys(patch).length === 0) return { ok: true, updated: true };

  await db.update(eboardChannels).set(patch).where(eq(eboardChannels.id, eboardId));
  return { ok: true, updated: true };
}

export type EboardRosterEntry = {
  userId: string;
  name: string;
  image: string | null;
  /** The club role that keeps them here. Owner or admin, always. */
  role: string;
  joinedAt: string;
};

export type EboardRequestEntry = {
  requestId: string;
  userId: string;
  name: string;
  /** Their picture, on the same terms as a roster entry's - the queue draws the same person. */
  image: string | null;
  requestedAt: string;
};

export type EboardDetail = {
  id: string;
  clubId: string;
  name: string;
  description: string | null;
  /** The space's picture, or null for the initial fallback every avatar in the product uses. */
  image: string | null;
  memberCount: number;
  channelId: string | null;
  viewer: {
    /** Inside the space. Everything below the space boundary needs this, not admin status. */
    isMember: boolean;
    /** Admin-tier in the club, which is what makes the space visible at all. */
    isClubAdmin: boolean;
    isOwner: boolean;
    requestPending: boolean;
  };
};

/**
 * The space itself.
 *
 * Serves both states the screen map names: the landing screen for a club admin who is not a
 * member, and the space proper for one who is. `channelId` is withheld from a non-member, the
 * same way a race withholds its chat from somebody with no roster row.
 *
 * Refused outright for an ordinary club member: rule 4 says they have no visibility that the
 * space exists at all.
 */
export async function readEboard(
  db: Db,
  ctx: AccessContext,
  eboardId: string,
): Promise<Result<{ eboard: EboardDetail }>> {
  const rows = await db.execute<{
    id: string;
    club_id: string;
    name: string;
    description: string | null;
    image: string | null;
    member_count: string;
    channel_id: string | null;
    request_pending: boolean;
  }>(sql`
    SELECT eb.id::text AS id,
           eb.club_id::text AS club_id,
           eb.name,
           eb.description,
           eb.image,
           (SELECT count(*) FROM eboard_memberships m WHERE m.eboard_id = eb.id) AS member_count,
           ch.id::text AS channel_id,
           EXISTS (
             SELECT 1 FROM eboard_join_requests jr
              WHERE jr.eboard_id = eb.id AND jr.user_id = ${ctx.userId}
                AND jr.status = 'pending'
           ) AS request_pending
      FROM eboard_channels eb
      LEFT JOIN channels ch ON ch.scope = 'eboard' AND ch.scope_id = eb.id
     WHERE eb.id = ${eboardId}
  `);

  const row = rows.rows[0];
  if (!row) return { ok: false, code: 'not_found' };
  if (!isClubAdmin(ctx, row.club_id)) return { ok: false, code: 'not_found' };

  const isMember = isEboardMember(ctx, row.id);

  return {
    ok: true,
    eboard: {
      id: row.id,
      clubId: row.club_id,
      name: row.name,
      description: row.description,
      image: row.image,
      memberCount: Number(row.member_count),
      channelId: isMember ? row.channel_id : null,
      viewer: {
        isMember,
        isClubAdmin: true,
        isOwner: ctx.clubRole.get(row.club_id) === 'owner',
        requestPending: row.request_pending,
      },
    },
  };
}

/**
 * The roster, and - for a member - who is waiting to rejoin.
 *
 * Members only, unlike a race roster: a race lets a manager outside the roster read it because
 * managing it is their job, and here there is no such outside role.
 */
export async function readEboardRoster(
  db: Db,
  ctx: AccessContext,
  eboardId: string,
): Promise<
  Result<{ members: EboardRosterEntry[]; pendingRequests: EboardRequestEntry[] }>
> {
  const eboard = await eboardRef(db, eboardId);
  if (!eboard || !isEboardMember(ctx, eboard.id)) return { ok: false, code: 'not_found' };

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
           COALESCE(cm.role::text, 'admin') AS role,
           ${isoUtc('em.joined_at')} AS joined_at
      FROM eboard_memberships em
      JOIN users u ON u.id = em.user_id
      LEFT JOIN club_memberships cm
             ON cm.user_id = em.user_id AND cm.club_id = ${eboard.clubId}
     WHERE em.eboard_id = ${eboardId}
     ORDER BY CASE COALESCE(cm.role::text, 'admin') WHEN 'owner' THEN 0 ELSE 1 END,
              u.full_name
  `);

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
      FROM eboard_join_requests jr
      JOIN users u ON u.id = jr.user_id
     WHERE jr.eboard_id = ${eboardId} AND jr.status = 'pending'
     ORDER BY jr.created_at
  `);

  return {
    ok: true,
    members: memberRows.rows.map((row) => ({
      userId: row.user_id,
      name: row.full_name,
      image: row.image,
      role: row.role,
      joinedAt: row.joined_at,
    })),
    // Not nullable here, unlike the race roster: reaching this read at all means membership,
    // and every member may see the queue.
    pendingRequests: requestRows.rows.map((row) => ({
      requestId: row.id,
      userId: row.user_id,
      name: row.full_name,
      image: row.image,
      requestedAt: row.created_at,
    })),
  };
}
