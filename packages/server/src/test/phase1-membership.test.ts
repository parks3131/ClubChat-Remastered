/**
 * Membership commands: the rules, the ordering, and the cascade.
 *
 * Several of these encode behaviour that was got wrong once and is easy to get wrong again -
 * the transfer ordering, the one-message-not-two rule, the auto-approve on policy flip, and
 * the cascade that must reach every dependent membership rather than the obvious one.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createClub } from '../domain/create-club.ts';
import {
  addMember,
  changeRole,
  decideJoinRequest,
  deleteClub,
  joinClub,
  leaveClub,
  redeemInvite,
  removeMember,
  setJoinPolicy,
  updateClub,
  transferOwnership,
} from '../domain/membership.ts';
import { renderNotification } from '@clubchat/shared';
import { loadAccessContext } from '../policy/context.ts';
import { drainOnce } from '../worker/drain.ts';
import { RecordingPushSender } from '../push/sender.ts';
import {
  clubJoinRequests,
  clubMemberships,
  clubs,
  eboardChannels,
  eboardMemberships,
  messages,
  users,
} from '../db/schema.ts';
import { startTestDb, type TestDb } from './harness.ts';
import type { EffectDeps } from '../worker/effects.ts';

let h: TestDb;
let deps: EffectDeps;
/** Revocations the worker published, captured instead of reaching Redis. */
let revocations: Array<{ channel: string; payload: string }>;

const silent = () => undefined;

beforeAll(async () => {
  h = await startTestDb();
});
afterAll(async () => {
  await h?.stop();
});

beforeEach(async () => {
  await h.db.execute(sql`TRUNCATE notifications, outbox RESTART IDENTITY CASCADE`);
  revocations = [];
  deps = {
    db: h.db,
    // A stub that records publishes. The revocation instruction is the effect under test,
    // and asserting it went out is the only way to check the ADR-0007 obligation is met.
    redis: {
      publish: async (channel: string, payload: string) => {
        revocations.push({ channel, payload });
        return 1;
      },
    } as never,
    push: new RecordingPushSender(),
    log: silent,
    defer: () => undefined,
  };
});

async function makeUser(name: string): Promise<string> {
  const id = crypto.randomUUID();
  await h.db.insert(users).values({
    id,
    name,
    email: `${name}-${id.slice(0, 8)}@test.invalid`,
  });
  return id;
}

async function setup(policy: 'open' | 'request' = 'open') {
  const ownerId = await makeUser('Owner');
  const club = await createClub(h.db, {
    name: 'Hillside Running Club',
    sport: 'running',
    joinPolicy: policy,
    creatorId: ownerId,
  });
  await drainOnce(h.db, deps);
  const eboard = await h.db
    .select()
    .from(eboardChannels)
    .where(eq(eboardChannels.clubId, club.clubId));
  return { ...club, ownerId, eboardId: eboard[0]!.id };
}

const ctxFor = (userId: string) => loadAccessContext(h.db, userId);

const roleOf = async (clubId: string, userId: string) => {
  const rows = await h.db
    .select({ role: clubMemberships.role })
    .from(clubMemberships)
    .where(and(eq(clubMemberships.clubId, clubId), eq(clubMemberships.userId, userId)));
  return rows[0]?.role ?? null;
};

const systemMessages = async (channelId: string) => {
  const rows = await h.db
    .select({ body: messages.body })
    .from(messages)
    .where(and(eq(messages.channelId, channelId), eq(messages.type, 'system')))
    .orderBy(messages.seq);
  return rows.map((r) => r.body ?? '');
};

describe('joining', () => {
  it('an open club admits immediately', async () => {
    const f = await setup('open');
    const joiner = await makeUser('Joiner');
    const result = await joinClub(h.db, joiner, f.clubId);
    expect(result.ok && result.status).toBe('joined');
    expect(await roleOf(f.clubId, joiner)).toBe('member');
  });

  it('a request club files a pending row and admits nobody', async () => {
    const f = await setup('request');
    const joiner = await makeUser('Hopeful');
    const result = await joinClub(h.db, joiner, f.clubId);
    expect(result.ok && result.status).toBe('requested');
    expect(await roleOf(f.clubId, joiner)).toBeNull();
  });

  it('re-requesting while pending is a no-op, not a duplicate', async () => {
    const f = await setup('request');
    const joiner = await makeUser('Persistent');
    await joinClub(h.db, joiner, f.clubId);
    const second = await joinClub(h.db, joiner, f.clubId);
    expect(second.ok).toBe(false);

    const rows = await h.db
      .select()
      .from(clubJoinRequests)
      .where(eq(clubJoinRequests.clubId, f.clubId));
    expect(rows).toHaveLength(1);
  });

  it('the invite link joins instantly even on a request club', async () => {
    // The link is a private side channel, deliberately independent of the public search
    // path: sharing it IS the decision the request policy exists to capture.
    const f = await setup('request');
    const joiner = await makeUser('Invited');
    const club = await h.db.select().from(clubs).where(eq(clubs.id, f.clubId));

    const result = await redeemInvite(h.db, joiner, club[0]!.inviteToken);
    expect(result.ok && result.status).toBe('joined');
    expect(await roleOf(f.clubId, joiner)).toBe('member');
  });

  it('opening the same invite link twice is a no-op, not an error', async () => {
    const f = await setup('open');
    const joiner = await makeUser('Twice');
    const club = await h.db.select().from(clubs).where(eq(clubs.id, f.clubId));
    await redeemInvite(h.db, joiner, club[0]!.inviteToken);
    const second = await redeemInvite(h.db, joiner, club[0]!.inviteToken);
    expect(second.ok, 'the second redemption errored').toBe(true);
  });

  it('an invalid token gets nothing back', async () => {
    await setup();
    const joiner = await makeUser('Stranger');
    const result = await redeemInvite(h.db, joiner, 'not-a-real-token');
    expect(result.ok).toBe(false);
  });

  it('posts a system message naming who added whom', async () => {
    const f = await setup();
    const added = await makeUser('Added');
    await addMember(h.db, await ctxFor(f.ownerId), f.clubId, added);
    await drainOnce(h.db, deps);

    const bodies = await systemMessages(f.mainChannelId);
    expect(bodies.some((b) => b.includes('Added') && b.includes('was added by Owner'))).toBe(true);
  });
});

describe('deciding requests', () => {
  it('approving creates exactly one membership even if two admins race', async () => {
    // Two admins hitting Approve must produce one membership, one notification, one decider.
    const f = await setup('request');
    const adminId = await makeUser('Admin');
    await h.db
      .insert(clubMemberships)
      .values({ clubId: f.clubId, userId: adminId, role: 'admin' });
    const joiner = await makeUser('Hopeful');
    await joinClub(h.db, joiner, f.clubId);
    const request = (
      await h.db.select().from(clubJoinRequests).where(eq(clubJoinRequests.userId, joiner))
    )[0]!;

    const [a, b] = await Promise.all([
      decideJoinRequest(h.db, await ctxFor(f.ownerId), request.id, true),
      decideJoinRequest(h.db, await ctxFor(adminId), request.id, true),
    ]);

    expect(a.ok && b.ok).toBe(true);
    // Exactly one of them actually decided it.
    const decidedCount = [a, b].filter((r) => r.ok && r.decided).length;
    expect(decidedCount, 'both callers believed they decided it').toBe(1);

    const memberships = await h.db
      .select()
      .from(clubMemberships)
      .where(and(eq(clubMemberships.clubId, f.clubId), eq(clubMemberships.userId, joiner)));
    expect(memberships).toHaveLength(1);
  });

  it('a denied request can be re-filed', async () => {
    // The partial unique index is scoped to `pending` precisely so a refusal is not
    // permanent. A plain UNIQUE would bar anyone ever turned down.
    const f = await setup('request');
    const joiner = await makeUser('Rejected');
    await joinClub(h.db, joiner, f.clubId);
    const request = (
      await h.db.select().from(clubJoinRequests).where(eq(clubJoinRequests.userId, joiner))
    )[0]!;
    await decideJoinRequest(h.db, await ctxFor(f.ownerId), request.id, false);

    const again = await joinClub(h.db, joiner, f.clubId);
    expect(again.ok && again.status).toBe('requested');
  });

  it('a plain member cannot decide a request', async () => {
    const f = await setup('request');
    const member = await makeUser('Member');
    await h.db
      .insert(clubMemberships)
      .values({ clubId: f.clubId, userId: member, role: 'member' });
    const joiner = await makeUser('Hopeful');
    await joinClub(h.db, joiner, f.clubId);
    const request = (
      await h.db.select().from(clubJoinRequests).where(eq(clubJoinRequests.userId, joiner))
    )[0]!;

    const result = await decideJoinRequest(h.db, await ctxFor(member), request.id, true);
    expect(result.ok).toBe(false);
  });
});

describe('the join policy flip', () => {
  it('switching request to open auto-approves everyone pending', async () => {
    // Otherwise they are stranded: no approval step is left in the product.
    const f = await setup('request');
    const a = await makeUser('WaitingA');
    const b = await makeUser('WaitingB');
    await joinClub(h.db, a, f.clubId);
    await joinClub(h.db, b, f.clubId);

    const result = await setJoinPolicy(h.db, await ctxFor(f.ownerId), f.clubId, 'open');
    expect(result.ok && result.autoApproved).toBe(2);
    expect(await roleOf(f.clubId, a)).toBe('member');
    expect(await roleOf(f.clubId, b)).toBe('member');
  });

  it('switching open to request strands nobody, because nobody was waiting', async () => {
    const f = await setup('open');
    const result = await setJoinPolicy(h.db, await ctxFor(f.ownerId), f.clubId, 'request');
    expect(result.ok && result.autoApproved).toBe(0);
  });
});

describe('roles', () => {
  it('promotion auto-joins the Eboard space and demotion auto-removes', async () => {
    // The defining difference from a Race: for the Eboard, authority and access are the same
    // thing. Keeping them in one transaction is what stops the space drifting out of sync
    // with who is actually an admin - the v1 failure that made it request-only.
    const f = await setup();
    const member = await makeUser('Riser');
    await addMember(h.db, await ctxFor(f.ownerId), f.clubId, member);

    const inEboard = async () =>
      (
        await h.db
          .select()
          .from(eboardMemberships)
          .where(
            and(
              eq(eboardMemberships.eboardId, f.eboardId),
              eq(eboardMemberships.userId, member),
            ),
          )
      ).length;

    expect(await inEboard()).toBe(0);
    await changeRole(h.db, await ctxFor(f.ownerId), f.clubId, member, 'admin');
    expect(await inEboard(), 'promotion did not auto-join the Eboard space').toBe(1);
    await changeRole(h.db, await ctxFor(f.ownerId), f.clubId, member, 'member');
    expect(await inEboard(), 'demotion did not auto-remove from the Eboard space').toBe(0);
  });

  it('refuses to change the Owner role through the role path', async () => {
    const f = await setup();
    const result = await changeRole(h.db, await ctxFor(f.ownerId), f.clubId, f.ownerId, 'admin');
    expect(result.ok).toBe(false);
  });

  it('announces a role change in chat, naming who did it', async () => {
    const f = await setup();
    const member = await makeUser('Promoted');
    await addMember(h.db, await ctxFor(f.ownerId), f.clubId, member);
    await changeRole(h.db, await ctxFor(f.ownerId), f.clubId, member, 'admin');
    await drainOnce(h.db, deps);

    // The actor is the half that used to be missing: "Promoted is now an admin" said what
    // happened and not who did it, which is what people ask about afterwards.
    const bodies = await systemMessages(f.mainChannelId);
    expect(bodies.some((b) => b.includes('promoted Promoted as admin'))).toBe(true);

    await changeRole(h.db, await ctxFor(f.ownerId), f.clubId, member, 'member');
    await drainOnce(h.db, deps);
    const afterDemotion = await systemMessages(f.mainChannelId);
    expect(afterDemotion.some((b) => b.includes('removed Promoted as admin'))).toBe(true);
  });

  it('lets an admin demote another admin but not remove them', async () => {
    // Admins policing each other's role is normal; ejecting each other is not.
    const f = await setup();
    const adminA = await makeUser('AdminA');
    const adminB = await makeUser('AdminB');
    for (const u of [adminA, adminB]) {
      await addMember(h.db, await ctxFor(f.ownerId), f.clubId, u);
      await changeRole(h.db, await ctxFor(f.ownerId), f.clubId, u, 'admin');
    }

    expect((await changeRole(h.db, await ctxFor(adminA), f.clubId, adminB, 'member')).ok).toBe(
      true,
    );
    // Re-promote, then attempt removal.
    await changeRole(h.db, await ctxFor(f.ownerId), f.clubId, adminB, 'admin');
    expect((await removeMember(h.db, await ctxFor(adminA), f.clubId, adminB)).ok).toBe(false);
    // The Owner can.
    expect((await removeMember(h.db, await ctxFor(f.ownerId), f.clubId, adminB)).ok).toBe(true);
  });
});

describe('ownership transfer', () => {
  it('leaves exactly one owner, with the previous owner an admin', async () => {
    const f = await setup();
    const successor = await makeUser('Successor');
    await addMember(h.db, await ctxFor(f.ownerId), f.clubId, successor);

    const result = await transferOwnership(h.db, await ctxFor(f.ownerId), f.clubId, successor);
    expect(result.ok).toBe(true);

    expect(await roleOf(f.clubId, successor)).toBe('owner');
    expect(await roleOf(f.clubId, f.ownerId)).toBe('admin');

    const owners = await h.db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM club_memberships
       WHERE club_id = ${f.clubId} AND role = 'owner'
    `);
    expect(Number(owners.rows[0]?.n)).toBe(1);
  });

  it('posts ONE system message, not two', async () => {
    // Mechanically it is two role changes. Socially it is one event, and posting both reads
    // as though something went wrong - which is why transfer has its own event type.
    const f = await setup();
    const successor = await makeUser('Successor');
    await addMember(h.db, await ctxFor(f.ownerId), f.clubId, successor);
    await drainOnce(h.db, deps);
    const before = (await systemMessages(f.mainChannelId)).length;

    await transferOwnership(h.db, await ctxFor(f.ownerId), f.clubId, successor);
    await drainOnce(h.db, deps);

    const after = await systemMessages(f.mainChannelId);
    expect(after.length - before, 'transfer posted more than one message').toBe(1);
    expect(after[after.length - 1]).toContain('transferred ownership');
  });

  it('cannot transfer to somebody outside the club', async () => {
    const f = await setup();
    const outsider = await makeUser('Outsider');
    const result = await transferOwnership(h.db, await ctxFor(f.ownerId), f.clubId, outsider);
    expect(result.ok).toBe(false);
  });

  it('is refused to a non-owner admin', async () => {
    const f = await setup();
    const admin = await makeUser('Admin');
    await addMember(h.db, await ctxFor(f.ownerId), f.clubId, admin);
    await changeRole(h.db, await ctxFor(f.ownerId), f.clubId, admin, 'admin');

    const result = await transferOwnership(h.db, await ctxFor(admin), f.clubId, f.ownerId);
    expect(result.ok).toBe(false);
  });
});

describe('leaving and the cascade', () => {
  it('refuses to let the Owner leave', async () => {
    // An ownerless club has no recovery path, so transfer is the only exit.
    const f = await setup();
    const result = await leaveClub(h.db, await ctxFor(f.ownerId), f.clubId);
    expect(result.ok).toBe(false);
  });

  it('cascades an admin out of the Eboard space when they leave', async () => {
    const f = await setup();
    const admin = await makeUser('Departing');
    await addMember(h.db, await ctxFor(f.ownerId), f.clubId, admin);
    await changeRole(h.db, await ctxFor(f.ownerId), f.clubId, admin, 'admin');

    await leaveClub(h.db, await ctxFor(admin), f.clubId);

    expect(await roleOf(f.clubId, admin)).toBeNull();
    const eboardRows = await h.db
      .select()
      .from(eboardMemberships)
      .where(
        and(eq(eboardMemberships.eboardId, f.eboardId), eq(eboardMemberships.userId, admin)),
      );
    expect(eboardRows, 'leaving did not cascade out of the Eboard space').toHaveLength(0);
  });

  it('force-unsubscribes a departing member sockets', async () => {
    // ADR-0007's obligation. Deleting the row alone leaves their socket receiving messages
    // from a club they are no longer in, silently, with nothing reporting it.
    const f = await setup();
    const member = await makeUser('Removed');
    await addMember(h.db, await ctxFor(f.ownerId), f.clubId, member);
    await drainOnce(h.db, deps);
    revocations = [];

    await removeMember(h.db, await ctxFor(f.ownerId), f.clubId, member);
    await drainOnce(h.db, deps);

    const revoked = revocations.filter((r) => r.channel === 'ctrl:revoke');
    expect(revoked, 'no revocation was published').toHaveLength(1);
    const payload = JSON.parse(revoked[0]!.payload) as {
      userId: string;
      channelIds: string[];
    };
    expect(payload.userId).toBe(member);
    // Every channel in the club, not only the main one: they lose the Eboard space too.
    expect(payload.channelIds.length).toBeGreaterThanOrEqual(2);
    expect(payload.channelIds).toContain(f.mainChannelId);
  });

  it('resolves an outstanding request when someone is removed', async () => {
    const f = await setup('request');
    const member = await makeUser('Churn');
    await addMember(h.db, await ctxFor(f.ownerId), f.clubId, member);
    await removeMember(h.db, await ctxFor(f.ownerId), f.clubId, member);

    // Left neither in the club nor holding a pending row an admin will later be asked about.
    const pending = await h.db
      .select()
      .from(clubJoinRequests)
      .where(
        and(eq(clubJoinRequests.clubId, f.clubId), eq(clubJoinRequests.status, 'pending')),
      );
    expect(pending).toHaveLength(0);
  });

  it('the Owner can never be removed, by anyone', async () => {
    const f = await setup();
    const admin = await makeUser('Admin');
    await addMember(h.db, await ctxFor(f.ownerId), f.clubId, admin);
    await changeRole(h.db, await ctxFor(f.ownerId), f.clubId, admin, 'admin');

    expect((await removeMember(h.db, await ctxFor(admin), f.clubId, f.ownerId)).ok).toBe(false);
    // Not even by themselves.
    expect((await removeMember(h.db, await ctxFor(f.ownerId), f.clubId, f.ownerId)).ok).toBe(
      false,
    );
  });
});

describe('deleting a club', () => {
  it('is Owner-only', async () => {
    const f = await setup();
    const admin = await makeUser('Admin');
    await addMember(h.db, await ctxFor(f.ownerId), f.clubId, admin);
    await changeRole(h.db, await ctxFor(f.ownerId), f.clubId, admin, 'admin');

    expect((await deleteClub(h.db, await ctxFor(admin), f.clubId)).ok).toBe(false);
    expect((await deleteClub(h.db, await ctxFor(f.ownerId), f.clubId)).ok).toBe(true);
  });

  it('cascades to channels, memberships and the Eboard space', async () => {
    const f = await setup();
    await deleteClub(h.db, await ctxFor(f.ownerId), f.clubId);

    const counts = await h.db.execute<{
      clubs: number;
      channels: number;
      memberships: number;
      eboards: number;
    }>(sql`
      SELECT
        (SELECT COUNT(*)::int FROM clubs WHERE id = ${f.clubId}) AS clubs,
        (SELECT COUNT(*)::int FROM channels WHERE club_id = ${f.clubId}) AS channels,
        (SELECT COUNT(*)::int FROM club_memberships WHERE club_id = ${f.clubId}) AS memberships,
        (SELECT COUNT(*)::int FROM eboard_channels WHERE club_id = ${f.clubId}) AS eboards
    `);
    const row = counts.rows[0]!;
    // A cascade must not be blocked by a child-level permission rule: deleting the club
    // really does remove the Owner's own membership row.
    expect([row.clubs, row.channels, row.memberships, row.eboards].map(Number)).toEqual([
      0, 0, 0, 0,
    ]);
  });

  it('revokes every member subscriptions', async () => {
    const f = await setup();
    const member = await makeUser('Bystander');
    await addMember(h.db, await ctxFor(f.ownerId), f.clubId, member);
    await drainOnce(h.db, deps);
    revocations = [];

    await deleteClub(h.db, await ctxFor(f.ownerId), f.clubId);
    await drainOnce(h.db, deps);

    const revoked = revocations.filter((r) => r.channel === 'ctrl:revoke');
    const users = revoked.map((r) => (JSON.parse(r.payload) as { userId: string }).userId);
    expect(users.sort()).toEqual([f.ownerId, member].sort());
  });
});

describe('editing the club', () => {
  /*
   * An authorization change, so it is proved by attempting the forbidden action rather than by
   * reading the predicate. A plain member editing the club's identity is the exact thing this
   * handler exists to refuse, and a handler that authorizes nothing looks identical to one that
   * authorizes correctly until somebody tries.
   */
  it('refuses a plain member and allows the admin tier', async () => {
    const owner = await makeUser('EditOwner');
    const admin = await makeUser('EditAdmin');
    const member = await makeUser('EditMember');
    const club = await createClub(h.db, { name: 'Before', sport: 'running', creatorId: owner });

    await addMember(h.db, await loadAccessContext(h.db, owner), club.clubId, admin);
    await addMember(h.db, await loadAccessContext(h.db, owner), club.clubId, member);
    await changeRole(h.db, await loadAccessContext(h.db, owner), club.clubId, admin, 'admin');

    // The forbidden action, attempted.
    const asMember = await updateClub(h.db, await loadAccessContext(h.db, member), club.clubId, {
      name: 'Renamed by a member',
    });
    expect(asMember).toEqual({ ok: false, code: 'forbidden' });

    const stillNamed = await h.db.execute<{ name: string }>(
      sql`SELECT name FROM clubs WHERE id = ${club.clubId}`,
    );
    expect(stillNamed.rows[0]?.name, 'a refused edit still changed the club').toBe('Before');

    // An admin may, and so may the owner.
    expect(
      await updateClub(h.db, await loadAccessContext(h.db, admin), club.clubId, { name: 'After' }),
    ).toEqual({ ok: true, updated: true });

    const renamed = await h.db.execute<{ name: string }>(
      sql`SELECT name FROM clubs WHERE id = ${club.clubId}`,
    );
    expect(renamed.rows[0]?.name).toBe('After');
  });

  it('leaves an absent field alone and clears an explicit null', async () => {
    const owner = await makeUser('PatchOwner');
    const club = await createClub(h.db, {
      name: 'Patchy',
      sport: 'running',
      description: 'the original',
      creatorId: owner,
    });
    const ctx = await loadAccessContext(h.db, owner);

    // Absent: untouched. The two are different instructions and must not collapse into one.
    await updateClub(h.db, ctx, club.clubId, { name: 'Patchy II' });
    const afterRename = await h.db.execute<{ name: string; description: string | null }>(
      sql`SELECT name, description FROM clubs WHERE id = ${club.clubId}`,
    );
    expect(afterRename.rows[0]?.name).toBe('Patchy II');
    expect(afterRename.rows[0]?.description).toBe('the original');

    // Explicit null: cleared.
    await updateClub(h.db, ctx, club.clubId, { description: null });
    const afterClear = await h.db.execute<{ description: string | null }>(
      sql`SELECT description FROM clubs WHERE id = ${club.clubId}`,
    );
    expect(afterClear.rows[0]?.description).toBeNull();
  });
});

describe('the Eboard follows the role', () => {
  /*
   * Membership of Eboard & Council is not managed by hand in the normal case: it IS the club's
   * admin tier, kept in step by `changeRole` in the same transaction as the role itself. Pinned
   * here because the two could drift apart silently - a promotion that forgot the space leaves an
   * admin who cannot see the admins' conversation, and a demotion that forgot it leaves an
   * ex-admin reading it indefinitely, which is the direction that actually matters.
   */
  it('adds on promotion and removes on demotion, in step with the role', async () => {
    const f = await setup();
    const person = await makeUser('RolePerson');
    await addMember(h.db, await ctxFor(f.ownerId), f.clubId, person);

    const inEboard = async () => {
      const rows = await h.db
        .select()
        .from(eboardMemberships)
        .where(
          and(eq(eboardMemberships.eboardId, f.eboardId), eq(eboardMemberships.userId, person)),
        );
      return rows.length === 1;
    };

    expect(await inEboard(), 'a plain member started out in the space').toBe(false);

    await changeRole(h.db, await ctxFor(f.ownerId), f.clubId, person, 'admin');
    expect(await roleOf(f.clubId, person)).toBe('admin');
    expect(await inEboard(), 'promotion did not add them to the space').toBe(true);

    await changeRole(h.db, await ctxFor(f.ownerId), f.clubId, person, 'member');
    expect(await roleOf(f.clubId, person)).toBe('member');
    expect(await inEboard(), 'demotion left them able to read the admins space').toBe(false);
  });

  it('names the actor and the space in what the demoted person is told', async () => {
    const f = await setup();
    const person = await makeUser('ToldPerson');
    await addMember(h.db, await ctxFor(f.ownerId), f.clubId, person);
    await changeRole(h.db, await ctxFor(f.ownerId), f.clubId, person, 'admin');
    await changeRole(h.db, await ctxFor(f.ownerId), f.clubId, person, 'member');
    await drainOnce(h.db, deps);

    const rows = await h.db.execute<{ params: Record<string, unknown> }>(sql`
      SELECT params FROM notifications
       WHERE recipient_id = ${person} AND type = 'role_changed'
       ORDER BY created_at DESC LIMIT 1
    `);
    const params = rows.rows[0]?.params;
    expect(params, 'the demoted member was told nothing at all').toBeTruthy();

    const rendered = renderNotification({
      type: 'role_changed',
      params: params as Record<string, unknown>,
    });
    // Who did it, and what it cost them. A demotion is somebody's decision, and losing a whole
    // conversation is the part that gets noticed.
    expect(rendered.body).toContain('Owner');
    expect(rendered.body).toContain('Eboard & Council');
  });
});
