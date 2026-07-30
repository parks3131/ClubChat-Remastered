/**
 * Race commands.
 *
 * A race is a mini-club nested one level inside a club, so almost everything here is the
 * club shape again: a roster, join requests, a channel from the shared abstraction. What is
 * genuinely different is the authority boundary - a club admin manages every race and does
 * not thereby gain access to one - and that lives in the policy module, not here.
 */

import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import {
  carGroupMembers,
  carGroups,
  channels,
  outbox,
  raceJoinRequests,
  raceMemberships,
  racePins,
  races,
} from '../db/schema.ts';
import type { AccessContext } from '../policy/context.ts';
import {
  canBeInCarGroup,
  canManageCarGroups,
  canManageRace,
  canPinRace,
  canRequestRaceAccess,
  canSeeRace,
  isClubAdmin,
  isRaceMember,
  type RaceRef,
} from '../policy/predicates.ts';

export type Refusal = {
  ok: false;
  code: 'forbidden' | 'not_found' | 'already_member' | 'already_pending' | 'invalid';
};
export type Result<T> = ({ ok: true } & T) | Refusal;

async function raceRef(db: Db, raceId: string): Promise<RaceRef | null> {
  const rows = await db
    .select({ id: races.id, clubId: races.clubId })
    .from(races)
    .where(eq(races.id, raceId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Create a race.
 *
 * **A name and a date only.** No start time, no capacity, no structured results - those are
 * open questions, not omissions. A club admin creates it from the club's Races list.
 *
 * > **The channel is created BEFORE the creator's roster row.** That ordering is the v1
 * > lesson restated: creating the membership first meant the first system message had no
 * > channel to land in and was silently swallowed. It no longer matters mechanically, since
 * > effects run post-commit rather than as triggers, but the ordering is kept because it is
 * > the one that cannot be wrong.
 */
export async function createRace(
  db: Db,
  ctx: AccessContext,
  input: { clubId: string; name: string; raceDate: string },
): Promise<Result<{ raceId: string; channelId: string }>> {
  if (!isClubAdmin(ctx, input.clubId)) return { ok: false, code: 'forbidden' };

  return db.transaction(async (tx) => {
    const raceRows = await tx
      .insert(races)
      .values({ clubId: input.clubId, name: input.name, raceDate: input.raceDate })
      .returning();
    const race = raceRows[0];
    if (!race) throw new Error('race insert returned no row');

    // The channel first.
    const channelRows = await tx
      .insert(channels)
      .values({ clubId: input.clubId, scope: 'race', scopeId: race.id })
      .returning();
    const channel = channelRows[0];
    if (!channel) throw new Error('race channel insert returned no row');

    // Then the creator's roster row. The creator is an admin, so they are a manager
    // already - this gives them the ACCESS that management does not confer.
    await tx.insert(raceMemberships).values({ raceId: race.id, userId: ctx.userId });

    await tx.insert(outbox).values({
      partitionKey: input.clubId,
      eventType: 'race.created',
      payload: {
        clubId: input.clubId,
        raceId: race.id,
        raceName: race.name,
        channelId: channel.id,
        actorId: ctx.userId,
      },
    });

    return { ok: true as const, raceId: race.id, channelId: channel.id };
  });
}

/**
 * Request race access.
 *
 * **Access is always by request. There is no open race policy** - a race roster is travel
 * logistics, and an open one would fill with people who are not going.
 */
export async function requestRaceAccess(
  db: Db,
  ctx: AccessContext,
  raceId: string,
): Promise<Result<{ status: 'requested' }>> {
  const race = await raceRef(db, raceId);
  if (!race || !canSeeRace(ctx, race)) return { ok: false, code: 'not_found' };
  if (!canRequestRaceAccess(ctx, race)) return { ok: false, code: 'already_member' };

  try {
    const rows = await db
      .insert(raceJoinRequests)
      .values({ raceId, userId: ctx.userId })
      .returning({ id: raceJoinRequests.id });
    if (!rows[0]) return { ok: false, code: 'invalid' };

    await db.insert(outbox).values({
      partitionKey: race.clubId,
      eventType: 'race.join_requested',
      payload: { clubId: race.clubId, raceId, userId: ctx.userId },
    });
    return { ok: true, status: 'requested' };
  } catch {
    return { ok: false, code: 'already_pending' };
  }
}

/** Approve or deny. Any club admin - a manager need not be on the roster to decide. */
export async function decideRaceRequest(
  db: Db,
  ctx: AccessContext,
  requestId: string,
  approve: boolean,
): Promise<Result<{ decided: boolean }>> {
  const rows = await db
    .select()
    .from(raceJoinRequests)
    .where(eq(raceJoinRequests.id, requestId))
    .limit(1);
  const request = rows[0];
  if (!request) return { ok: false, code: 'not_found' };

  const race = await raceRef(db, request.raceId);
  if (!race || !canManageRace(ctx, race)) return { ok: false, code: 'forbidden' };

  const decided = await db.transaction(async (tx) => {
    // Conditional on still being pending, so two managers deciding produce one outcome.
    const updated = await tx.execute<{ id: string }>(sql`
      UPDATE race_join_requests
         SET status = ${approve ? 'approved' : 'denied'},
             decided_by = ${ctx.userId}, decided_at = now()
       WHERE id = ${requestId} AND status = 'pending'
      RETURNING id
    `);
    if (updated.rows.length === 0) return false;

    if (approve) {
      await tx
        .insert(raceMemberships)
        .values({ raceId: request.raceId, userId: request.userId })
        .onConflictDoNothing();
    }

    await tx.insert(outbox).values({
      partitionKey: race.clubId,
      eventType: 'race.membership_decided',
      payload: {
        clubId: race.clubId,
        raceId: request.raceId,
        userId: request.userId,
        actorId: ctx.userId,
        approved: approve,
      },
    });
    return true;
  });

  return { ok: true, decided };
}

/** Add someone to the roster directly. Manager only. */
export async function addRaceMember(
  db: Db,
  ctx: AccessContext,
  raceId: string,
  userId: string,
): Promise<Result<{ added: boolean }>> {
  const race = await raceRef(db, raceId);
  if (!race) return { ok: false, code: 'not_found' };
  if (!canManageRace(ctx, race)) return { ok: false, code: 'forbidden' };

  const added = await db.transaction(async (tx) => {
    const rows = await tx
      .insert(raceMemberships)
      .values({ raceId, userId })
      .onConflictDoNothing()
      .returning();
    if (rows.length === 0) return false;

    await tx.insert(outbox).values({
      partitionKey: race.clubId,
      eventType: 'race.membership_decided',
      payload: {
        clubId: race.clubId,
        raceId,
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
 * Leave a race, or be removed from one.
 *
 * **Leaving also removes the person from their car group** - which is where the Incharge rule
 * bites, so this shares `departCarGroup` with the explicit car-group commands rather than
 * reimplementing it.
 */
export async function removeRaceMember(
  db: Db,
  ctx: AccessContext,
  raceId: string,
  userId: string,
): Promise<Result<{ removed: true }>> {
  const race = await raceRef(db, raceId);
  if (!race) return { ok: false, code: 'not_found' };

  const isSelf = userId === ctx.userId;
  // Leaving is a member's own business; removing somebody else is a manager's.
  if (!isSelf && !canManageRace(ctx, race)) return { ok: false, code: 'forbidden' };
  if (isSelf && !isRaceMember(ctx, race)) return { ok: false, code: 'not_found' };

  await db.transaction(async (tx) => {
    await departCarGroup(tx, { raceId, userId, clubId: race.clubId, actorId: ctx.userId });

    await tx
      .delete(raceMemberships)
      .where(and(eq(raceMemberships.raceId, raceId), eq(raceMemberships.userId, userId)));

    await tx
      .delete(raceJoinRequests)
      .where(
        and(
          eq(raceJoinRequests.raceId, raceId),
          eq(raceJoinRequests.userId, userId),
          eq(raceJoinRequests.status, 'pending'),
        ),
      );

    await tx.insert(outbox).values({
      partitionKey: race.clubId,
      eventType: 'race.member_departed',
      payload: { clubId: race.clubId, raceId, userId, actorId: isSelf ? null : ctx.userId },
    });
  });

  return { ok: true, removed: true };
}

/**
 * Meet Information: five fields, edited together as one form.
 *
 * **Any manager can edit all five** - not restricted to whoever created the race. Written as
 * one update because the product treats them as atomic; a per-field endpoint would invite the
 * partial saves the single-form design exists to avoid.
 */
export async function updateMeetInformation(
  db: Db,
  ctx: AccessContext,
  raceId: string,
  fields: {
    meetDescription?: string | null;
    meetLocationUrl?: string | null;
    meetHotelUrl?: string | null;
    meetPhotosUrl?: string | null;
    meetResultsUrl?: string | null;
  },
): Promise<Result<{ updated: true }>> {
  const race = await raceRef(db, raceId);
  if (!race) return { ok: false, code: 'not_found' };
  if (!canManageRace(ctx, race)) return { ok: false, code: 'forbidden' };

  await db
    .update(races)
    .set({
      meetDescription: fields.meetDescription ?? null,
      meetLocationUrl: fields.meetLocationUrl ?? null,
      meetHotelUrl: fields.meetHotelUrl ?? null,
      meetPhotosUrl: fields.meetPhotosUrl ?? null,
      meetResultsUrl: fields.meetResultsUrl ?? null,
    })
    .where(eq(races.id, raceId));

  return { ok: true, updated: true };
}

/**
 * Pin a race to your own hub. Or unpin it.
 *
 * **Personal.** Each member pins for themselves and it affects nobody else's hub. Club-wide
 * admin pins were built in v1 and then corrected, so this is deliberately not admin-gated:
 * any member can pin any race they can see.
 */
export async function setRacePin(
  db: Db,
  ctx: AccessContext,
  raceId: string,
  pinned: boolean,
): Promise<Result<{ pinned: boolean }>> {
  const race = await raceRef(db, raceId);
  if (!race || !canPinRace(ctx, race)) return { ok: false, code: 'not_found' };

  if (pinned) {
    await db
      .insert(racePins)
      .values({ raceId, userId: ctx.userId })
      .onConflictDoNothing();
  } else {
    await db
      .delete(racePins)
      .where(and(eq(racePins.raceId, raceId), eq(racePins.userId, ctx.userId)));
  }
  return { ok: true, pinned };
}

export async function deleteRace(
  db: Db,
  ctx: AccessContext,
  raceId: string,
): Promise<Result<{ deleted: true; channelIds: string[] }>> {
  const race = await raceRef(db, raceId);
  if (!race) return { ok: false, code: 'not_found' };
  if (!canManageRace(ctx, race)) return { ok: false, code: 'forbidden' };

  // Captured before the delete: afterwards there is nothing to tell the gateways about.
  const channelRows = await db.execute<{ id: string }>(
    sql`SELECT id FROM channels WHERE scope = 'race' AND scope_id = ${raceId}`,
  );
  const memberRows = await db.execute<{ user_id: string }>(
    sql`SELECT user_id FROM race_memberships WHERE race_id = ${raceId}`,
  );
  const channelIds = channelRows.rows.map((r) => r.id);

  await db.transaction(async (tx) => {
    await tx.insert(outbox).values({
      partitionKey: race.clubId,
      eventType: 'race.deleted',
      payload: {
        clubId: race.clubId,
        raceId,
        channelIds,
        memberIds: memberRows.rows.map((r) => r.user_id),
        actorId: ctx.userId,
      },
    });
    await tx.delete(races).where(eq(races.id, raceId));
  });

  return { ok: true, deleted: true, channelIds };
}

// ---------------------------------------------------------------------------
// Car groups
// ---------------------------------------------------------------------------

/**
 * Create a car group.
 *
 * **Auto-numbered on creation** - "Group 1", "Group 2" - with no naming prompt, because
 * naming eight cars is friction. The number is the next unused one for this race, taken
 * under a lock on the race row so two managers creating simultaneously cannot both claim it.
 */
export async function createCarGroup(
  db: Db,
  ctx: AccessContext,
  raceId: string,
): Promise<Result<{ groupId: string; number: number }>> {
  const race = await raceRef(db, raceId);
  if (!race) return { ok: false, code: 'not_found' };
  if (!canManageCarGroups(ctx, race)) return { ok: false, code: 'forbidden' };

  return db.transaction(async (tx) => {
    // Lock the race row so the number below is allocated exactly once. Without it, two
    // managers hitting Add simultaneously would both compute the same next number and one
    // would hit the unique index - a correct outcome, but a confusing error for a click that
    // should simply work.
    await tx.execute(sql`SELECT id FROM races WHERE id = ${raceId} FOR UPDATE`);

    const next = await tx.execute<{ next: number }>(
      sql`SELECT COALESCE(MAX(number), 0) + 1 AS next FROM car_groups WHERE race_id = ${raceId}`,
    );
    const number = Number(next.rows[0]?.next ?? 1);

    const rows = await tx.insert(carGroups).values({ raceId, number }).returning();
    const group = rows[0];
    if (!group) throw new Error('car group insert returned no row');

    return { ok: true as const, groupId: group.id, number };
  });
}

/**
 * Assign someone to a car group.
 *
 * **Only people with real race access can be added** - so an admin who manages the groups but
 * holds no roster row cannot be put in a car. The database also enforces one group per person
 * per race, so this check is about giving a clear refusal rather than about safety.
 */
export async function assignToCarGroup(
  db: Db,
  ctx: AccessContext,
  groupId: string,
  userId: string,
): Promise<Result<{ assigned: true }>> {
  const group = await db.select().from(carGroups).where(eq(carGroups.id, groupId)).limit(1);
  const found = group[0];
  if (!found) return { ok: false, code: 'not_found' };

  const race = await raceRef(db, found.raceId);
  if (!race) return { ok: false, code: 'not_found' };
  if (!canManageCarGroups(ctx, race)) return { ok: false, code: 'forbidden' };

  // The target needs race access, which is a roster row and nothing else.
  const onRoster = await db
    .select()
    .from(raceMemberships)
    .where(and(eq(raceMemberships.raceId, found.raceId), eq(raceMemberships.userId, userId)))
    .limit(1);
  if (onRoster.length === 0) return { ok: false, code: 'forbidden' };

  try {
    await db
      .insert(carGroupMembers)
      .values({ carGroupId: groupId, raceId: found.raceId, userId })
      .onConflictDoNothing();
  } catch {
    // Hit the one-per-race unique index: already in a different group for this race.
    return { ok: false, code: 'already_member' };
  }
  return { ok: true, assigned: true };
}

/**
 * Set or clear a group's Incharge.
 *
 * The Incharge **must be a current member of that group**. Naming somebody who is not in the
 * car is not a mild inconsistency - it is the one person everyone will call when the car does
 * not show up.
 */
export async function setCarGroupIncharge(
  db: Db,
  ctx: AccessContext,
  groupId: string,
  userId: string | null,
): Promise<Result<{ inchargeUserId: string | null }>> {
  const group = await db.select().from(carGroups).where(eq(carGroups.id, groupId)).limit(1);
  const found = group[0];
  if (!found) return { ok: false, code: 'not_found' };

  const race = await raceRef(db, found.raceId);
  if (!race) return { ok: false, code: 'not_found' };
  if (!canManageCarGroups(ctx, race)) return { ok: false, code: 'forbidden' };

  if (userId !== null) {
    const inGroup = await db
      .select()
      .from(carGroupMembers)
      .where(and(eq(carGroupMembers.carGroupId, groupId), eq(carGroupMembers.userId, userId)))
      .limit(1);
    if (inGroup.length === 0) return { ok: false, code: 'invalid' };
  }

  await db.update(carGroups).set({ inchargeUserId: userId }).where(eq(carGroups.id, groupId));
  return { ok: true, inchargeUserId: userId };
}

/** Leave, or be removed from, a car group without leaving the race. */
export async function leaveCarGroup(
  db: Db,
  ctx: AccessContext,
  raceId: string,
  userId: string,
): Promise<Result<{ left: true }>> {
  const race = await raceRef(db, raceId);
  if (!race) return { ok: false, code: 'not_found' };

  const isSelf = userId === ctx.userId;
  if (!isSelf && !canManageCarGroups(ctx, race)) return { ok: false, code: 'forbidden' };
  if (isSelf && !canBeInCarGroup(ctx, race)) return { ok: false, code: 'not_found' };

  await db.transaction(async (tx) => {
    await departCarGroup(tx, { raceId, userId, clubId: race.clubId, actorId: ctx.userId });
  });
  return { ok: true, left: true };
}

/**
 * Remove someone from whatever car group they are in for this race.
 *
 * > **If the departing member was the Incharge, the Incharge is cleared and every club admin
 * > is notified that the group needs a new one. The rest of the group is untouched.**
 * >
 * > **A plain member leaving is a non-event** - no notification at all. That asymmetry is the
 * > point: a car losing its driver is a logistics problem somebody has to solve, and a car
 * > losing a passenger is not.
 *
 * Takes a transaction so it composes with leaving the race, which must be atomic with it.
 */
async function departCarGroup(
  tx: Parameters<Parameters<Db['transaction']>[0]>[0],
  input: { raceId: string; userId: string; clubId: string; actorId: string | null },
): Promise<void> {
  const membership = await tx
    .select()
    .from(carGroupMembers)
    .where(
      and(eq(carGroupMembers.raceId, input.raceId), eq(carGroupMembers.userId, input.userId)),
    )
    .limit(1);
  const found = membership[0];
  if (!found) return;

  const group = await tx
    .select()
    .from(carGroups)
    .where(eq(carGroups.id, found.carGroupId))
    .limit(1);
  const wasIncharge = group[0]?.inchargeUserId === input.userId;

  await tx
    .delete(carGroupMembers)
    .where(
      and(
        eq(carGroupMembers.carGroupId, found.carGroupId),
        eq(carGroupMembers.userId, input.userId),
      ),
    );

  if (wasIncharge) {
    // Cleared, and the group persists with nobody in charge until an admin names one. The
    // group is NOT dissolved and the other members are NOT moved.
    await tx
      .update(carGroups)
      .set({ inchargeUserId: null })
      .where(eq(carGroups.id, found.carGroupId));

    await tx.insert(outbox).values({
      partitionKey: input.clubId,
      eventType: 'race.incharge_left',
      payload: {
        clubId: input.clubId,
        raceId: input.raceId,
        groupId: found.carGroupId,
        groupNumber: group[0]?.number ?? 0,
        userId: input.userId,
      },
    });
  }
  // No event otherwise. A plain member leaving their car is deliberately silent.
}
