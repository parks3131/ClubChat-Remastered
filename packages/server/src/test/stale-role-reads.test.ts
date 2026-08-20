/**
 * What a command does when the row it authorized against moves underneath it.
 *
 * Every command in `domain/membership.ts` reads the current role with `roleOf`, decides from
 * it, and then writes. The read is its own statement on its own snapshot, so between the read
 * and the write another request can commit a different role - and a write with no predicate on
 * the value it was authorized against will happily apply a decision that is no longer true.
 *
 * > **The one-owner unique index does not catch this.** `club_memberships_one_owner` is a
 * > partial UNIQUE index, so it forbids TWO owners. ZERO owners satisfies it perfectly, and an
 * > ownerless club has no recovery path - nobody can transfer, delete or promote out of it.
 *
 * These tests hold a real second transaction open on a second connection so the interleaving
 * is exact rather than hopeful: the command under test does its read, the gate transaction
 * commits the change it did not see, and only then does the command reach its write. Nothing
 * here sleeps waiting for a race to happen to land.
 *
 * The same shape lives in `domain/races.ts` around the car-group Incharge, which must be a
 * current member of the group it is in charge of. The last two tests cover it, for the same
 * reason and by the same method.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createClub } from '../domain/create-club.ts';
import { addMember, changeRole, leaveClub, transferOwnership } from '../domain/membership.ts';
import {
  addRaceMember,
  assignToCarGroup,
  createCarGroup,
  createRace,
  leaveCarGroup,
  setCarGroupIncharge,
} from '../domain/races.ts';
import { loadAccessContext } from '../policy/context.ts';
import { carGroupMembers, carGroups, clubMemberships, users } from '../db/schema.ts';
import { startTestDb, type TestDb } from './harness.ts';

let h: TestDb;

beforeAll(async () => {
  h = await startTestDb();
});
afterAll(async () => {
  await h?.stop();
});

const ctxFor = (userId: string) => loadAccessContext(h.db, userId);

async function makeUser(name: string): Promise<string> {
  const id = crypto.randomUUID();
  await h.db.insert(users).values({
    id,
    name,
    email: `${name}-${id.slice(0, 8)}@test.invalid`,
  });
  return id;
}

/** A club with an owner and one plain member, which is the smallest fixture every test needs. */
async function setup() {
  const ownerId = await makeUser('Owner');
  const memberId = await makeUser('Member');
  const club = await createClub(h.db, { name: 'Hillside Running Club', creatorId: ownerId });
  await addMember(h.db, await ctxFor(ownerId), club.clubId, memberId);
  return { ...club, ownerId, memberId };
}

/**
 * A second connection holding an uncommitted transaction.
 *
 * This is the concurrent request. It has to be a real second connection: a transaction on the
 * same one would serialize with the command under test and there would be no race to observe.
 */
async function openGate() {
  const client = await h.pool.connect();
  let done = false;
  await client.query('BEGIN');
  return {
    run: (text: string, values: unknown[] = []) => client.query(text, values),
    commit: async () => {
      if (done) return;
      done = true;
      await client.query('COMMIT');
      client.release();
    },
    abandon: async () => {
      if (done) return;
      done = true;
      try {
        await client.query('ROLLBACK');
      } catch {
        // Already gone. Releasing the connection is the only part that still matters.
      }
      client.release();
    },
  };
}

/**
 * Wait until the command under test is parked on a row lock, or has finished without needing one.
 *
 * Both outcomes are legitimate and which one happens is the difference between the defect and
 * the fix, so this waits for either rather than asserting one. What it must never do is return
 * early: the whole interleaving depends on the command having reached its write before the gate
 * commits. Polling `pg_stat_activity` is what makes that observable instead of a sleep.
 */
async function reachedTheDatabase(settled: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (settled()) return;
    const waiting = await h.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n
        FROM pg_stat_activity
       WHERE datname = current_database()
         AND wait_event_type = 'Lock'
         AND pid <> pg_backend_pid()
    `);
    if (Number(waiting.rows[0]?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the command under test neither blocked on a lock nor completed');
}

/** Every owner row in the club. The invariant is that this has exactly one entry, always. */
async function ownersOf(clubId: string): Promise<string[]> {
  const rows = await h.db
    .select({ userId: clubMemberships.userId })
    .from(clubMemberships)
    .where(and(eq(clubMemberships.clubId, clubId), eq(clubMemberships.role, 'owner')));
  return rows.map((row) => row.userId);
}

const roleOf = async (clubId: string, userId: string) => {
  const rows = await h.db
    .select({ role: clubMemberships.role })
    .from(clubMemberships)
    .where(and(eq(clubMemberships.clubId, clubId), eq(clubMemberships.userId, userId)));
  return rows[0]?.role ?? null;
};

describe('a club always has exactly one owner', () => {
  it('refuses a role change whose target became the owner after it read', async () => {
    // The interleaving in full: the Owner promotes a member to admin and transfers ownership
    // to that same member at almost the same moment. Both read them as a plain member. The
    // transfer commits first, so the member is now the Owner and the Owner is now an admin -
    // and the role change then writes `admin` over the row it read as a member.
    const f = await setup();
    const ctx = await ctxFor(f.ownerId);

    const gate = await openGate();
    try {
      // The two statements a transfer issues, in the order it issues them. Demote before
      // promote, because the one-owner index is checked per statement.
      await gate.run(
        `UPDATE club_memberships SET role = 'admin' WHERE club_id = $1 AND user_id = $2`,
        [f.clubId, f.ownerId],
      );
      await gate.run(
        `UPDATE club_memberships SET role = 'owner' WHERE club_id = $1 AND user_id = $2`,
        [f.clubId, f.memberId],
      );

      let settled = false;
      const pending = changeRole(h.db, ctx, f.clubId, f.memberId, 'admin').finally(() => {
        settled = true;
      });

      // Its read of the role runs on its own snapshot and sees `member`, because the gate has
      // not committed. Its write then parks on the row lock the gate holds.
      await reachedTheDatabase(() => settled);
      await gate.commit();

      const result = await pending;
      expect(await ownersOf(f.clubId), 'the club lost its owner').toEqual([f.memberId]);
      expect(result.ok, 'a stale role change reported success').toBe(false);
      expect(!result.ok && result.code).toBe('conflict');
    } finally {
      await gate.abandon();
    }
  });

  it('refuses a transfer whose target left the club after it read', async () => {
    // The mirror image, and it needs no second owner to go wrong: the transfer demotes itself
    // first and then promotes a row that is no longer there, so the club ends with an admin
    // where its Owner was and nobody holding the role.
    const f = await setup();
    const ctx = await ctxFor(f.ownerId);

    const gate = await openGate();
    try {
      await gate.run(`DELETE FROM club_memberships WHERE club_id = $1 AND user_id = $2`, [
        f.clubId,
        f.memberId,
      ]);

      let settled = false;
      const pending = transferOwnership(h.db, ctx, f.clubId, f.memberId).finally(() => {
        settled = true;
      });

      await reachedTheDatabase(() => settled);
      await gate.commit();

      const result = await pending;
      expect(await ownersOf(f.clubId), 'the club lost its owner').toEqual([f.ownerId]);
      expect(result.ok, 'a transfer to a departed member reported success').toBe(false);
      expect(await roleOf(f.clubId, f.ownerId), 'the previous owner was demoted anyway').toBe(
        'owner',
      );
    } finally {
      await gate.abandon();
    }
  });

  it('refuses to let somebody leave who became the owner after they asked', async () => {
    // Leaving reads nothing at all - it decides from the access context loaded when the
    // request arrived - so the row it deletes can be the Owner's by the time it gets there.
    // An owner leaving is exactly what `canLeaveClub` forbids.
    const f = await setup();
    const ctx = await ctxFor(f.memberId);

    const gate = await openGate();
    try {
      await gate.run(
        `UPDATE club_memberships SET role = 'admin' WHERE club_id = $1 AND user_id = $2`,
        [f.clubId, f.ownerId],
      );
      await gate.run(
        `UPDATE club_memberships SET role = 'owner' WHERE club_id = $1 AND user_id = $2`,
        [f.clubId, f.memberId],
      );

      let settled = false;
      const pending = leaveClub(h.db, ctx, f.clubId).finally(() => {
        settled = true;
      });

      await reachedTheDatabase(() => settled);
      await gate.commit();

      const result = await pending;
      expect(await ownersOf(f.clubId), 'the club lost its owner').toEqual([f.memberId]);
      expect(result.ok, 'the new owner was allowed to leave').toBe(false);
    } finally {
      await gate.abandon();
    }
  });
});

describe('a car group Incharge is a member of that car group', () => {
  async function raceWithGroup() {
    const f = await setup();
    const race = await createRace(h.db, await ctxFor(f.ownerId), {
      clubId: f.clubId,
      name: 'Spring Half',
      raceDate: '2026-04-12',
    });
    if (!race.ok) throw new Error('race creation failed');
    await addRaceMember(h.db, await ctxFor(f.ownerId), race.raceId, f.memberId);
    const group = await createCarGroup(h.db, await ctxFor(f.ownerId), race.raceId);
    if (!group.ok) throw new Error('group creation failed');
    await assignToCarGroup(h.db, await ctxFor(f.ownerId), group.groupId, f.memberId);
    return { f, race, groupId: group.groupId };
  }

  const inchargeOf = async (groupId: string) => {
    const rows = await h.db
      .select({ inchargeUserId: carGroups.inchargeUserId })
      .from(carGroups)
      .where(eq(carGroups.id, groupId));
    return rows[0]?.inchargeUserId ?? null;
  };

  it('refuses to name an Incharge who left the group after the check', async () => {
    // Naming somebody who is not in the car is the one failure this rule exists to prevent:
    // they are the person everyone calls when the car does not show up.
    const { f, groupId } = await raceWithGroup();
    const ctx = await ctxFor(f.ownerId);

    const gate = await openGate();
    try {
      await gate.run(`DELETE FROM car_group_members WHERE car_group_id = $1 AND user_id = $2`, [
        groupId,
        f.memberId,
      ]);

      let settled = false;
      const pending = setCarGroupIncharge(h.db, ctx, groupId, f.memberId).finally(() => {
        settled = true;
      });

      await reachedTheDatabase(() => settled);
      await gate.commit();

      const result = await pending;
      expect(await inchargeOf(groupId), 'a departed member was left in charge of the car').toBe(
        null,
      );
      expect(result.ok).toBe(false);
    } finally {
      await gate.abandon();
    }
  });

  it('does not clear an Incharge named after a departure read the group', async () => {
    // The departure decides whether to clear the Incharge from a value it read earlier in its
    // own transaction. An admin naming a replacement in that window is silently undone, and
    // the club is told the group needs an Incharge it already has.
    const { f, race, groupId } = await raceWithGroup();
    const replacement = await makeUser('Replacement');
    await addMember(h.db, await ctxFor(f.ownerId), f.clubId, replacement);
    await addRaceMember(h.db, await ctxFor(f.ownerId), race.raceId, replacement);
    await assignToCarGroup(h.db, await ctxFor(f.ownerId), groupId, replacement);
    await setCarGroupIncharge(h.db, await ctxFor(f.ownerId), groupId, f.memberId);

    const gate = await openGate();
    try {
      // An admin names the replacement while the first Incharge is on their way out.
      await gate.run(`UPDATE car_groups SET incharge_user_id = $1 WHERE id = $2`, [
        replacement,
        groupId,
      ]);

      let settled = false;
      const pending = leaveCarGroup(
        h.db,
        await ctxFor(f.memberId),
        race.raceId,
        f.memberId,
      ).finally(() => {
        settled = true;
      });

      await reachedTheDatabase(() => settled);
      await gate.commit();

      await pending;
      expect(await inchargeOf(groupId), 'the replacement Incharge was cleared').toBe(replacement);
      const stillThere = await h.db
        .select()
        .from(carGroupMembers)
        .where(
          and(eq(carGroupMembers.carGroupId, groupId), eq(carGroupMembers.userId, f.memberId)),
        );
      expect(stillThere, 'the departing member is still in the group').toHaveLength(0);
    } finally {
      await gate.abandon();
    }
  });
});
