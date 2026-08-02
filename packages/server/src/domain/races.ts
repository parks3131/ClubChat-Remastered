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
import { isUniqueViolation } from '../db/errors.ts';
import { isoUtc } from '../db/sql-helpers.ts';
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
  canReadRaceRoster,
  canRequestRaceAccess,
  canSeeRace,
  canViewCarGroups,
  isClubAdmin,
  isClubMember,
  isRaceManager,
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
 * The race's own identity: what it is called, when it is, and its picture.
 *
 * > **Absent means "leave it alone" here, and that is the opposite of Meet Information below.**
 * > The two live one function apart and follow opposite rules on purpose. Meet Information is
 * > one form saved whole, so an omitted key means the field was emptied. This is three
 * > independent facts touched from two different controls - the pencil edits the name and the
 * > date, the avatar tap sends only a picture - so an omitted key here means "not my business",
 * > and treating it as a clear would have the avatar upload silently rename the race to ''.
 *
 * `null` still clears, which is how the picture is removed. Absent and null are different
 * instructions, which is the whole reason this takes `string | null | undefined` rather than
 * folding an empty string into "remove".
 *
 * Manager-tier, the same authority that edits Meet Information: a club admin manages every
 * race in the club without thereby being on its roster.
 */
export async function updateRace(
  db: Db,
  ctx: AccessContext,
  raceId: string,
  fields: {
    name?: string | undefined;
    raceDate?: string | undefined;
    image?: string | null | undefined;
  },
): Promise<Result<{ updated: true }>> {
  const race = await raceRef(db, raceId);
  if (!race) return { ok: false, code: 'not_found' };
  if (!canManageRace(ctx, race)) return { ok: false, code: 'forbidden' };

  const patch: Record<string, unknown> = {};
  if (fields.name !== undefined) {
    const name = fields.name.trim();
    // A race with no name is unreachable in every list that renders one, so this is refused
    // rather than stored and worked around at each render.
    if (name.length === 0) return { ok: false, code: 'invalid' };
    patch['name'] = name;
  }
  if (fields.raceDate !== undefined) {
    // A DATE column, and the column is what enforces the format - but a malformed string
    // reaches Postgres as a type error rather than a refusal, and a 500 is the wrong way to
    // tell somebody their date is wrong.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fields.raceDate)) return { ok: false, code: 'invalid' };
    patch['raceDate'] = fields.raceDate;
  }
  if (fields.image !== undefined) patch['image'] = fields.image;
  if (Object.keys(patch).length === 0) return { ok: true, updated: true };

  await db.update(races).set(patch).where(eq(races.id, raceId));
  return { ok: true, updated: true };
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
  // Every field is optional AND explicitly `undefined`-able, which under
  // `exactOptionalPropertyTypes` are two different things. The body treats both the same way -
  // `?? null`, clearing the field - because rule 10 makes the five atomic: a form that omits a
  // key is saying that field is now empty, not that it should keep its old value.
  fields: {
    meetDescription?: string | null | undefined;
    meetLocationUrl?: string | null | undefined;
    meetHotelUrl?: string | null | undefined;
    meetPhotosUrl?: string | null | undefined;
    meetResultsUrl?: string | null | undefined;
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

    /*
     * The channel, EXPLICITLY, in the same transaction.
     *
     * > **Nothing cascades here, and that is by design.** ADR-0014 has a channel reference its
     * > scope one way: `scope_id` is a plain uuid with no foreign key, precisely so one table can
     * > serve four different scopes. The cost is that deleting the scope deletes nothing else, and
     * > this is the one place that has to pay it - a club's channels go with a `club_id` FK, and a
     * > race's do not.
     *
     * Without this the race row vanished and its channel survived: unreferenced, unreachable, and
     * still holding every message in it. Nothing pointed at it, so nothing complained. The effect
     * handler's own comment says "its channel is gone" - it revokes the sockets, which is what
     * made the omission invisible from the client.
     *
     * Deleting the channel row is enough for everything under it: messages, read cursors, mutes,
     * moderation reads and media all cascade off `channel_id`.
     */
    await tx.delete(channels).where(and(eq(channels.scope, 'race'), eq(channels.scopeId, raceId)));
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
 * Delete a car group, whoever is still sitting in it.
 *
 * **Its members go back to being unassigned, and nothing else about them changes.** They keep
 * their roster row, their race access and their chat; a car is travel logistics, not membership.
 * The rows go with the composite foreign key's `ON DELETE CASCADE` rather than by hand here -
 * `car_group_members` points at `(id, race_id)`, so the group is the only thing this has to
 * delete.
 *
 * **No notification, and the contrast with `departCarGroup` is the reason to say so.** That one
 * tells every club admin when an Incharge walks away, because the group survives and needs a new
 * one. Here the group does not survive. "Group 2 needs a new Incharge" about a group that no
 * longer exists is worse than silence.
 *
 * **The remaining groups keep their numbers.** Deleting Group 2 of three leaves 1 and 3, and the
 * next group created is a new 2 - because `createCarGroup` takes `MAX(number) + 1`... which after
 * deleting the LAST group hands the number out again. Both are deliberate: a number is what
 * people say out loud to each other in a car park, so renumbering everybody else's car to close a
 * gap would move a person between labels without touching their row.
 */
export async function deleteCarGroup(
  db: Db,
  ctx: AccessContext,
  groupId: string,
): Promise<Result<{ deleted: true }>> {
  const group = await db.select().from(carGroups).where(eq(carGroups.id, groupId)).limit(1);
  const found = group[0];
  if (!found) return { ok: false, code: 'not_found' };

  const race = await raceRef(db, found.raceId);
  if (!race) return { ok: false, code: 'not_found' };
  if (!canManageCarGroups(ctx, race)) return { ok: false, code: 'forbidden' };

  await db.delete(carGroups).where(eq(carGroups.id, groupId));
  return { ok: true, deleted: true };
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
      /*
       * **Targeted at the primary key, and that is the whole behaviour of this call.**
       *
       * An untargeted `ON CONFLICT DO NOTHING` absorbs EVERY unique violation on the table,
       * including `car_group_members_one_per_race`. So assigning somebody who is already in a
       * different car silently did nothing and answered "assigned" - the invariant held, the
       * caller was told the opposite, and the `catch` below could never run because nothing
       * ever threw. Shipped in Phase 2 and found by the first test to try moving a person
       * between two cars.
       *
       * Targeted, the two outcomes separate the way they were always meant to: re-adding
       * somebody to the group they are already in is idempotent, and adding them to a second
       * group hits invariant 5 and raises.
       */
      .onConflictDoNothing({
        target: [carGroupMembers.carGroupId, carGroupMembers.userId],
      });
  } catch (error) {
    // Hit the one-per-race unique index: already in a different group for this race.
    // Checked through the cause chain, because Drizzle wraps the driver's error and a
    // bare `catch` would report any failure whatsoever as "already in a group".
    if (isUniqueViolation(error)) return { ok: false, code: 'already_member' };
    throw error;
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

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
//
// Phase 2 built the race commands and no race queries at all, which was invisible for two
// phases because a command handler and a query function look equally absent from a router
// that references neither. Every read below is gated by a predicate from the policy module,
// and none of them re-derives one - the whole point of the boundary is that a read is as
// authorized as a write.
//
// `db.execute` is used rather than the query builder wherever the shape needs viewer state
// joined per row, and every row type says `string` for a timestamp or a `count`, because
// `execute` skips Drizzle's coercion and hands back the driver's value (pitfall 7).

export type RaceListItem = {
  id: string;
  name: string;
  raceDate: string;
  /** The race's picture, or null for the initial fallback every avatar in the product uses. */
  image: string | null;
  /** This viewer's own pin. Personal, and never anybody else's (PRD/09 rules 21-22). */
  pinned: boolean;
  /** A roster row, which is the only proof of access. */
  hasAccess: boolean;
  /** Club-admin status: management authority, which is NOT access. */
  isManager: boolean;
  /** Shows "Requested - waiting on an admin to approve". A denied request can be re-filed,
   *  so only a pending one is reported. */
  requestPending: boolean;
  memberCount: number;
  /** Null unless this viewer can actually enter the chat, so a preview cannot navigate. */
  channelId: string | null;
};

/**
 * Every race in a club, with this viewer's own state per row.
 *
 * **Every club member can see every race** (rule 2), so the gate is club membership and the
 * per-race access question is answered as data rather than by filtering rows out. That is the
 * distinction the whole race design rests on: a member with no roster row still sees the race
 * exists, and gets a preview plus a request action rather than a 404.
 *
 * Ordering puts this viewer's pinned races first, then the most recent date - the club hub
 * shows a short preview of this list, and a pin exists precisely to control what appears in
 * it. The date direction is not specified by PRD/09; newest-first is chosen so a season's
 * upcoming races sit at the top rather than behind years of history.
 */
export async function listRaces(
  db: Db,
  ctx: AccessContext,
  clubId: string,
  opts: { query?: string | undefined; limit?: number | undefined } = {},
): Promise<Result<{ races: RaceListItem[] }>> {
  if (!isClubMember(ctx, clubId)) return { ok: false, code: 'not_found' };

  const limit = Math.min(opts.limit ?? 50, 200);
  const query = (opts.query ?? '').trim();

  const rows = await db.execute<{
    id: string;
    name: string;
    race_date: string;
    image: string | null;
    pinned: boolean;
    has_access: boolean;
    request_pending: boolean;
    member_count: string;
    channel_id: string | null;
  }>(sql`
    SELECT r.id::text AS id,
           r.name,
           r.race_date::text AS race_date,
           r.image,
           (rp.user_id IS NOT NULL) AS pinned,
           (rm.user_id IS NOT NULL) AS has_access,
           (jr.id IS NOT NULL) AS request_pending,
           (SELECT count(*) FROM race_memberships all_m WHERE all_m.race_id = r.id)
             AS member_count,
           ch.id::text AS channel_id
      FROM races r
      LEFT JOIN race_pins rp
             ON rp.race_id = r.id AND rp.user_id = ${ctx.userId}
      LEFT JOIN race_memberships rm
             ON rm.race_id = r.id AND rm.user_id = ${ctx.userId}
      LEFT JOIN race_join_requests jr
             ON jr.race_id = r.id AND jr.user_id = ${ctx.userId} AND jr.status = 'pending'
      LEFT JOIN channels ch
             ON ch.scope = 'race' AND ch.scope_id = r.id
     WHERE r.club_id = ${clubId}
       ${query.length > 0 ? sql`AND r.name ILIKE ${'%' + query + '%'}` : sql``}
     ORDER BY (rp.user_id IS NULL), r.race_date DESC, r.name
     LIMIT ${limit}
  `);

  return {
    ok: true,
    races: rows.rows.map((row) => ({
      id: row.id,
      name: row.name,
      raceDate: row.race_date,
      image: row.image,
      pinned: row.pinned,
      hasAccess: row.has_access,
      // Asked per row with the real race, rather than once with a fabricated ref. The answer
      // happens to be the same for every race in a club today, and a predicate that ignores a
      // field it is given is not a licence to pass it a lie.
      isManager: isRaceManager(ctx, { id: row.id, clubId }),
      requestPending: row.request_pending,
      memberCount: Number(row.member_count),
      // Withheld without access, so a preview screen has nothing to navigate with. The
      // channel is guarded independently; this only keeps the client honest.
      channelId: row.has_access ? row.channel_id : null,
    })),
  };
}

export type RaceDetail = {
  id: string;
  clubId: string;
  name: string;
  raceDate: string;
  image: string | null;
  meetDescription: string | null;
  meetLocationUrl: string | null;
  meetHotelUrl: string | null;
  meetPhotosUrl: string | null;
  meetResultsUrl: string | null;
  memberCount: number;
  viewer: {
    hasAccess: boolean;
    isManager: boolean;
    requestPending: boolean;
    pinned: boolean;
    channelId: string | null;
  };
};

/**
 * One race, with Meet Information.
 *
 * **Readable by any club member** (rule 13), because Meet Information is exactly what somebody
 * needs in order to decide whether to ask to go - hiding it would make the request-to-join
 * decision uninformed. So this single read serves all three states the screen map names: the
 * preview, the manager-without-a-roster-row hub, and a real member's race.
 *
 * Nothing member-only is in the response (rule 6). The roster and the car groups are separate
 * reads behind their own predicates, which is what keeps that promise structural rather than a
 * matter of remembering.
 */
export async function readRace(
  db: Db,
  ctx: AccessContext,
  raceId: string,
): Promise<Result<{ race: RaceDetail }>> {
  const race = await raceRef(db, raceId);
  if (!race || !canSeeRace(ctx, race)) return { ok: false, code: 'not_found' };

  const rows = await db.execute<{
    id: string;
    club_id: string;
    name: string;
    race_date: string;
    image: string | null;
    meet_description: string | null;
    meet_location_url: string | null;
    meet_hotel_url: string | null;
    meet_photos_url: string | null;
    meet_results_url: string | null;
    member_count: string;
    request_pending: boolean;
    pinned: boolean;
    channel_id: string | null;
  }>(sql`
    SELECT r.id::text AS id,
           r.club_id::text AS club_id,
           r.name,
           r.race_date::text AS race_date,
           r.image,
           r.meet_description,
           r.meet_location_url,
           r.meet_hotel_url,
           r.meet_photos_url,
           r.meet_results_url,
           (SELECT count(*) FROM race_memberships m WHERE m.race_id = r.id) AS member_count,
           (jr.id IS NOT NULL) AS request_pending,
           (rp.user_id IS NOT NULL) AS pinned,
           ch.id::text AS channel_id
      FROM races r
      LEFT JOIN race_join_requests jr
             ON jr.race_id = r.id AND jr.user_id = ${ctx.userId} AND jr.status = 'pending'
      LEFT JOIN race_pins rp
             ON rp.race_id = r.id AND rp.user_id = ${ctx.userId}
      LEFT JOIN channels ch
             ON ch.scope = 'race' AND ch.scope_id = r.id
     WHERE r.id = ${raceId}
  `);

  const row = rows.rows[0];
  if (!row) return { ok: false, code: 'not_found' };

  const hasAccess = isRaceMember(ctx, race);

  return {
    ok: true,
    race: {
      id: row.id,
      clubId: row.club_id,
      name: row.name,
      raceDate: row.race_date,
      image: row.image,
      meetDescription: row.meet_description,
      meetLocationUrl: row.meet_location_url,
      meetHotelUrl: row.meet_hotel_url,
      meetPhotosUrl: row.meet_photos_url,
      meetResultsUrl: row.meet_results_url,
      memberCount: Number(row.member_count),
      viewer: {
        hasAccess,
        isManager: isRaceManager(ctx, race),
        requestPending: row.request_pending,
        pinned: row.pinned,
        channelId: hasAccess ? row.channel_id : null,
      },
    },
  };
}

export type RaceRosterEntry = {
  userId: string;
  name: string;
  image: string | null;
  /** An admin of the parent club, so a manager of this race. */
  isManager: boolean;
  /** The group they are in for this race, or null. At most one, by invariant 5. */
  carGroupNumber: number | null;
};

export type RaceRequestEntry = {
  requestId: string;
  userId: string;
  name: string;
  /** Their picture, on the same terms as a roster entry's - the queue draws the same person. */
  image: string | null;
  requestedAt: string;
};

/**
 * The roster, and - for a manager only - who is waiting to get on it.
 *
 * Two audiences in one read, split by predicate rather than by endpoint: a race member sees
 * who is going, and a manager additionally sees the pending requests they are the one to
 * decide. `pendingRequests` is **null** rather than `[]` for a non-manager, so a client cannot
 * mistake "not allowed to see this" for "nobody is waiting".
 *
 * `carGroupNumber` rides along because rule 16 needs it: the add-to-group search must exclude
 * anyone already in a group for this race, and answering that from the roster read costs one
 * join rather than a second round trip that could disagree with this one.
 */
export async function readRaceRoster(
  db: Db,
  ctx: AccessContext,
  raceId: string,
): Promise<
  Result<{ members: RaceRosterEntry[]; pendingRequests: RaceRequestEntry[] | null }>
> {
  const race = await raceRef(db, raceId);
  if (!race || !canReadRaceRoster(ctx, race)) return { ok: false, code: 'not_found' };

  const memberRows = await db.execute<{
    user_id: string;
    full_name: string;
    image: string | null;
    is_manager: boolean;
    car_group_number: number | null;
  }>(sql`
    SELECT u.id::text AS user_id,
           u.full_name,
           u.image,
           -- The admin tier, which is owner OR admin. Asking for role = 'admin' here would
           -- silently exclude the Owner, which is the bug that shipped five times in v1.
           (cm.role IN ('owner', 'admin')) AS is_manager,
           cg.number AS car_group_number
      FROM race_memberships rm
      JOIN users u ON u.id = rm.user_id
      LEFT JOIN club_memberships cm
             ON cm.user_id = rm.user_id AND cm.club_id = ${race.clubId}
      LEFT JOIN car_group_members cgm
             ON cgm.race_id = rm.race_id AND cgm.user_id = rm.user_id
      LEFT JOIN car_groups cg ON cg.id = cgm.car_group_id
     WHERE rm.race_id = ${raceId}
     ORDER BY u.full_name
  `);

  const members: RaceRosterEntry[] = memberRows.rows.map((row) => ({
    userId: row.user_id,
    name: row.full_name,
    image: row.image,
    isManager: row.is_manager,
    carGroupNumber: row.car_group_number === null ? null : Number(row.car_group_number),
  }));

  if (!canManageRace(ctx, race)) return { ok: true, members, pendingRequests: null };

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
      FROM race_join_requests jr
      JOIN users u ON u.id = jr.user_id
     WHERE jr.race_id = ${raceId} AND jr.status = 'pending'
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

/** Somebody in a car, or waiting for a seat in one. Both halves of this read draw a face. */
export type CarGroupPerson = { userId: string; name: string; image: string | null };

export type CarGroupView = {
  id: string;
  number: number;
  inchargeUserId: string | null;
  members: Array<CarGroupPerson & { isIncharge: boolean }>;
};

/**
 * The car groups, with their members and Incharge tags.
 *
 * **Every race member can view these, read-only** (rule 20), so the gate is `canViewCarGroups`
 * - a roster row - and not the manage predicate. A manager with no roster row gets nothing
 * here, which is rule 5: they manage the roster, not the race.
 *
 * A group with a null `inchargeUserId` is a normal state, not a data error: the Incharge is
 * cleared automatically when its holder leaves and the group persists until an admin names a
 * new one (rule 18).
 */
export async function readCarGroups(
  db: Db,
  ctx: AccessContext,
  raceId: string,
): Promise<Result<{ groups: CarGroupView[]; unassigned: CarGroupPerson[] }>> {
  const race = await raceRef(db, raceId);
  if (!race || !canViewCarGroups(ctx, race)) return { ok: false, code: 'not_found' };

  const rows = await db.execute<{
    group_id: string;
    number: number;
    incharge_user_id: string | null;
    user_id: string | null;
    full_name: string | null;
    image: string | null;
  }>(sql`
    SELECT cg.id::text AS group_id,
           cg.number,
           cg.incharge_user_id::text AS incharge_user_id,
           u.id::text AS user_id,
           u.full_name,
           u.image
      FROM car_groups cg
      LEFT JOIN car_group_members cgm ON cgm.car_group_id = cg.id
      LEFT JOIN users u ON u.id = cgm.user_id
     WHERE cg.race_id = ${raceId}
     ORDER BY cg.number, u.full_name
  `);

  const groups = new Map<string, CarGroupView>();
  for (const row of rows.rows) {
    let group = groups.get(row.group_id);
    if (!group) {
      group = {
        id: row.group_id,
        number: Number(row.number),
        inchargeUserId: row.incharge_user_id,
        members: [],
      };
      groups.set(row.group_id, group);
    }
    // A LEFT JOIN over an empty group yields one row with a null user, which is a real
    // group with nobody in it rather than a member to render.
    if (row.user_id !== null) {
      group.members.push({
        userId: row.user_id,
        name: row.full_name ?? '',
        image: row.image,
        isIncharge: row.user_id === row.incharge_user_id,
      });
    }
  }

  // Who is on the roster and in no group - which is exactly rule 16's add-member search.
  const unassignedRows = await db.execute<{
    user_id: string;
    full_name: string;
    image: string | null;
  }>(sql`
    SELECT u.id::text AS user_id, u.full_name, u.image
      FROM race_memberships rm
      JOIN users u ON u.id = rm.user_id
     WHERE rm.race_id = ${raceId}
       AND NOT EXISTS (
         SELECT 1 FROM car_group_members cgm
          WHERE cgm.race_id = rm.race_id AND cgm.user_id = rm.user_id
       )
     ORDER BY u.full_name
  `);

  return {
    ok: true,
    groups: [...groups.values()],
    unassigned: unassignedRows.rows.map((row) => ({
      userId: row.user_id,
      name: row.full_name,
      image: row.image,
    })),
  };
}
