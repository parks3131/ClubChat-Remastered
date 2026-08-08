/**
 * Club bans: the revolving door, the ladder, and the rogue-admin containment.
 *
 * > **Removing somebody from an open club did not remove them.** `joinClub` admitted straight
 * > into a club whose policy is `open` with no check of any kind against a prior removal, and
 * > there was no ban concept in the schema at all. An ejected member tapped Join and was back,
 * > and the invite link they already held kept working. Removal was a request to leave that the
 * > person could decline.
 *
 * The tests that matter most here are not the ones proving a ban works. They are the ones proving
 * the **safeguard** works - that an admin acting in bad faith cannot do durable damage, because a
 * ban is deliberately easier to lift than to impose (ADR-0021). A feature that only ever gets
 * tested in the direction its author intended is how a permission model ships inverted.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createClub } from '../domain/create-club.ts';
import {
  addMember,
  banFromClub,
  changeRole,
  joinClub,
  liftClubBan,
  listClubBans,
  redeemInvite,
  removeMember,
} from '../domain/membership.ts';
import { loadAccessContext } from '../policy/context.ts';
import { drainOnce } from '../worker/drain.ts';
import { RecordingPushSender } from '../push/sender.ts';
import {
  clubBans,
  clubJoinRequests,
  clubMemberships,
  messages,
  notifications,
  users,
} from '../db/schema.ts';
import { startTestDb, type TestDb } from './harness.ts';
import type { EffectDeps } from '../worker/effects.ts';

let h: TestDb;
let deps: EffectDeps;

beforeAll(async () => {
  h = await startTestDb();
});
afterAll(async () => {
  await h?.stop();
});

beforeEach(async () => {
  await h.db.execute(sql`TRUNCATE notifications, outbox RESTART IDENTITY CASCADE`);
  deps = {
    db: h.db,
    redis: { publish: async () => 1 } as never,
    push: new RecordingPushSender(),
    log: () => undefined,
    defer: () => undefined,
  };
});

async function makeUser(name: string): Promise<string> {
  const id = crypto.randomUUID();
  await h.db
    .insert(users)
    .values({ id, name, email: `${name}-${id.slice(0, 8)}@test.invalid` });
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
  return { ...club, ownerId };
}

const ctxFor = (userId: string) => loadAccessContext(h.db, userId);

const isMember = async (clubId: string, userId: string) =>
  (
    await h.db
      .select()
      .from(clubMemberships)
      .where(and(eq(clubMemberships.clubId, clubId), eq(clubMemberships.userId, userId)))
  ).length > 0;

describe('the revolving door', () => {
  it('a removed member walks back into an open club, and a banned one cannot', async () => {
    const { clubId, ownerId } = await setup('open');
    const member = await makeUser('Member');
    expect((await joinClub(h.db, member, clubId)).ok).toBe(true);

    // Removal on its own. This is the defect: the club is open, so Join re-admits them.
    expect((await removeMember(h.db, await ctxFor(ownerId), clubId, member)).ok).toBe(true);
    expect(await isMember(clubId, member)).toBe(false);
    const walkedBack = await joinClub(h.db, member, clubId);
    expect(walkedBack.ok).toBe(true);
    expect(await isMember(clubId, member)).toBe(true);

    // A ban is the same act with a longer memory.
    expect((await banFromClub(h.db, await ctxFor(ownerId), clubId, member)).ok).toBe(true);
    expect(await isMember(clubId, member)).toBe(false);

    const refused = await joinClub(h.db, member, clubId);
    expect(refused).toEqual({ ok: false, code: 'banned' });
    expect(await isMember(clubId, member)).toBe(false);
  });

  it('closes the invite link, which rotation could only close for everybody', async () => {
    const { clubId, ownerId, inviteToken } = await setup('open');
    const member = await makeUser('Linked');
    expect((await redeemInvite(h.db, member, inviteToken)).ok).toBe(true);

    await banFromClub(h.db, await ctxFor(ownerId), clubId, member);

    // The link is unchanged and still works for everybody else - which is the point. Before
    // bans, excluding one holder meant rotating the token and breaking every outstanding link.
    expect(await redeemInvite(h.db, member, inviteToken)).toEqual({ ok: false, code: 'banned' });
    const other = await makeUser('Innocent');
    expect((await redeemInvite(h.db, other, inviteToken)).ok).toBe(true);
  });

  it('refuses a join request rather than leaving one for an admin to decide', async () => {
    const { clubId, ownerId } = await setup('request');
    const member = await makeUser('Asker');
    await banFromClub(h.db, await ctxFor(ownerId), clubId, member);

    // The request branch does not pass through `admit`, so it needs its own check. Without it
    // the ban holds and every admin still gets asked to decide something already decided.
    expect(await joinClub(h.db, member, clubId)).toEqual({ ok: false, code: 'banned' });
  });

  it('refuses an admin adding them back rather than silently lifting the ban', async () => {
    const { clubId, ownerId } = await setup('open');
    const member = await makeUser('Added');
    await banFromClub(h.db, await ctxFor(ownerId), clubId, member);

    // Deliberately a refusal, not an implicit unban: an admin who did not know about the ban
    // finds out, instead of overriding another admin's decision by accident.
    expect(await addMember(h.db, await ctxFor(ownerId), clubId, member)).toEqual({
      ok: false,
      code: 'banned',
    });

    // And the explicit route back is two steps, which is the intended shape.
    expect((await liftClubBan(h.db, await ctxFor(ownerId), clubId, member)).ok).toBe(true);
    expect((await addMember(h.db, await ctxFor(ownerId), clubId, member)).ok).toBe(true);
  });
});

describe('the ladder', () => {
  it('lets an admin ban a member and refuses them an admin', async () => {
    const { clubId, ownerId } = await setup();
    const adminA = await makeUser('AdminA');
    const adminB = await makeUser('AdminB');
    const member = await makeUser('Member');
    for (const u of [adminA, adminB, member]) await joinClub(h.db, u, clubId);
    await changeRole(h.db, await ctxFor(ownerId), clubId, adminA, 'admin');
    await changeRole(h.db, await ctxFor(ownerId), clubId, adminB, 'admin');

    expect((await banFromClub(h.db, await ctxFor(adminA), clubId, member)).ok).toBe(true);

    // The line that contains a rogue admin: they may not reach the people who could undo them.
    expect(await banFromClub(h.db, await ctxFor(adminA), clubId, adminB)).toEqual({
      ok: false,
      code: 'forbidden',
    });
    // The Owner may.
    expect((await banFromClub(h.db, await ctxFor(ownerId), clubId, adminB)).ok).toBe(true);
  });

  it('never lets anybody ban the Owner, or themselves', async () => {
    const { clubId, ownerId } = await setup();
    const admin = await makeUser('Admin');
    await joinClub(h.db, admin, clubId);
    await changeRole(h.db, await ctxFor(ownerId), clubId, admin, 'admin');

    // An ownerless club has no recovery path, which is why the Owner is unremovable and
    // therefore unbannable.
    expect(await banFromClub(h.db, await ctxFor(admin), clubId, ownerId)).toEqual({
      ok: false,
      code: 'forbidden',
    });
    // Banning yourself is leaving with extra steps, and would let an Owner strand their club.
    expect(await banFromClub(h.db, await ctxFor(ownerId), clubId, ownerId)).toEqual({
      ok: false,
      code: 'forbidden',
    });
    expect(await banFromClub(h.db, await ctxFor(admin), clubId, admin)).toEqual({
      ok: false,
      code: 'forbidden',
    });
  });

  it('refuses a plain member and a total outsider', async () => {
    const { clubId, ownerId } = await setup();
    const member = await makeUser('Member');
    const victim = await makeUser('Victim');
    const outsider = await makeUser('Outsider');
    for (const u of [member, victim]) await joinClub(h.db, u, clubId);

    expect(await banFromClub(h.db, await ctxFor(member), clubId, victim)).toEqual({
      ok: false,
      code: 'forbidden',
    });
    expect(await banFromClub(h.db, await ctxFor(outsider), clubId, victim)).toEqual({
      ok: false,
      code: 'forbidden',
    });
    expect(await isMember(clubId, victim)).toBe(true);
    // And the Owner still can, so the refusals above are about authority rather than a broken path.
    expect((await banFromClub(h.db, await ctxFor(ownerId), clubId, victim)).ok).toBe(true);
  });

  it('bans somebody who already left, which removal cannot express', async () => {
    const { clubId, ownerId } = await setup();
    const gone = await makeUser('Gone');

    // Never a member. Pre-emptive barring is the one thing a removal has no way to say.
    const result = await banFromClub(h.db, await ctxFor(ownerId), clubId, gone);
    expect(result.ok).toBe(true);
    expect(result.ok && result.removed).toBe(false);
    expect(await joinClub(h.db, gone, clubId)).toEqual({ ok: false, code: 'banned' });
  });

  it('refuses a uuid belonging to nobody rather than failing on a foreign key', async () => {
    const { clubId, ownerId } = await setup();
    expect(await banFromClub(h.db, await ctxFor(ownerId), clubId, crypto.randomUUID())).toEqual({
      ok: false,
      code: 'not_found',
    });
  });
});

describe('the safeguard', () => {
  /*
   * The scenario the whole design exists for: an admin acting in bad faith bans somebody the
   * club wants. Every assertion here is about the damage being bounded and cheap to undo.
   */
  it('lets any other admin undo a ban they did not impose', async () => {
    const { clubId, ownerId } = await setup('open');
    const rogue = await makeUser('Rogue');
    const other = await makeUser('OtherAdmin');
    const credible = await makeUser('Credible');
    for (const u of [rogue, other, credible]) await joinClub(h.db, u, clubId);
    await changeRole(h.db, await ctxFor(ownerId), clubId, rogue, 'admin');
    await changeRole(h.db, await ctxFor(ownerId), clubId, other, 'admin');

    await banFromClub(h.db, await ctxFor(rogue), clubId, credible);
    expect(await joinClub(h.db, credible, clubId)).toEqual({ ok: false, code: 'banned' });

    // An admin who had nothing to do with it lifts it. This asymmetry is the safeguard: every
    // other authority in the product is symmetric, and this one is deliberately not.
    expect((await liftClubBan(h.db, await ctxFor(other), clubId, credible)).ok).toBe(true);
    expect((await joinClub(h.db, credible, clubId)).ok).toBe(true);
    expect(await isMember(clubId, credible)).toBe(true);
  });

  it('does not re-admit anybody by itself', async () => {
    const { clubId, ownerId } = await setup('request');
    const member = await makeUser('Member');
    await joinClub(h.db, member, clubId); // files a request; this club is not open
    await banFromClub(h.db, await ctxFor(ownerId), clubId, member);
    await liftClubBan(h.db, await ctxFor(ownerId), clubId, member);

    // Lifting says "you may return", not "you are back" - so on a request-policy club they are
    // back to asking, exactly like anybody else.
    expect(await isMember(clubId, member)).toBe(false);
    expect(await joinClub(h.db, member, clubId)).toEqual({ ok: true, status: 'requested' });
  });

  it('clears a pending request rather than leaving it for an admin to decide', async () => {
    const { clubId, ownerId } = await setup('request');
    const asker = await makeUser('Asker');
    expect(await joinClub(h.db, asker, clubId)).toEqual({ ok: true, status: 'requested' });

    /*
     * They are not a member, so the membership cascade does not run - and the cascade is the only
     * other thing that clears a pending request. Without this, the ban held and every admin kept
     * being asked to decide something already decided, with denying it the only way to clear it.
     * Found by the test above failing, not by writing the handler.
     */
    await banFromClub(h.db, await ctxFor(ownerId), clubId, asker);

    const pending = await h.db
      .select()
      .from(clubJoinRequests)
      .where(
        and(
          eq(clubJoinRequests.clubId, clubId),
          eq(clubJoinRequests.userId, asker),
          eq(clubJoinRequests.status, 'pending'),
        ),
      );
    expect(pending).toHaveLength(0);
  });

  it('shows every admin who imposed each ban', async () => {
    const { clubId, ownerId } = await setup();
    const rogue = await makeUser('Rogue');
    const credible = await makeUser('Credible');
    for (const u of [rogue, credible]) await joinClub(h.db, u, clubId);
    await changeRole(h.db, await ctxFor(ownerId), clubId, rogue, 'admin');
    await banFromClub(h.db, await ctxFor(rogue), clubId, credible);

    const list = await listClubBans(h.db, await ctxFor(ownerId), clubId);
    expect(list.ok).toBe(true);
    expect(list.ok && list.bans).toHaveLength(1);
    expect(list.ok && list.bans[0]?.name).toBe('Credible');
    // Attribution is only a check if somebody can read it, which is the whole reason this
    // endpoint exists rather than the ban being a silent row.
    expect(list.ok && list.bans[0]?.bannedByName).toBe('Rogue');
    // ISO 8601, not Postgres's own `::text` rendering. Failure mode 14.
    expect(list.ok && list.bans[0]?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it('keeps the ban list to admins', async () => {
    const { clubId, ownerId } = await setup();
    const member = await makeUser('Member');
    const outsider = await makeUser('Outsider');
    await joinClub(h.db, member, clubId);
    await banFromClub(h.db, await ctxFor(ownerId), clubId, await makeUser('Banned'));

    expect(await listClubBans(h.db, await ctxFor(member), clubId)).toEqual({
      ok: false,
      code: 'forbidden',
    });
    expect(await listClubBans(h.db, await ctxFor(outsider), clubId)).toEqual({
      ok: false,
      code: 'forbidden',
    });
  });

  it('is idempotent in both directions', async () => {
    const { clubId, ownerId } = await setup();
    const member = await makeUser('Member');
    await joinClub(h.db, member, clubId);
    const owner = await ctxFor(ownerId);

    // Two admins can reach for a ban at the same moment; the second must not be an error.
    expect((await banFromClub(h.db, owner, clubId, member)).ok).toBe(true);
    expect((await banFromClub(h.db, owner, clubId, member)).ok).toBe(true);
    expect(
      (await h.db.select().from(clubBans).where(eq(clubBans.clubId, clubId))).length,
    ).toBe(1);

    // And two admins correcting the same wrongful ban must both succeed.
    expect((await liftClubBan(h.db, owner, clubId, member)).ok).toBe(true);
    expect((await liftClubBan(h.db, owner, clubId, member)).ok).toBe(true);
  });

  it('bars only the club it was imposed in', async () => {
    const first = await setup('open');
    const second = await setup('open');
    const member = await makeUser('Member');
    await joinClub(h.db, member, first.clubId);
    await joinClub(h.db, member, second.clubId);

    await banFromClub(h.db, await ctxFor(first.ownerId), first.clubId, member);

    expect(await isMember(first.clubId, member)).toBe(false);
    // A ban is a fact about one club, not a platform-wide judgement. Nothing about the other
    // club changes, including the membership they already hold.
    expect(await isMember(second.clubId, member)).toBe(true);
    expect((await joinClub(h.db, member, second.clubId)).ok).toBe(false); // already a member
  });
});

describe('what the club is told, and what the person is told', () => {
  it('narrates the ban to the club and the removal to the person', async () => {
    const { clubId, ownerId, mainChannelId } = await setup();
    const member = await makeUser('Mallory');
    await joinClub(h.db, member, clubId);
    await drainOnce(h.db, deps);

    await banFromClub(h.db, await ctxFor(ownerId), clubId, member);
    await drainOnce(h.db, deps);

    // Club chat says "banned", which is the public attribution that makes an open ban power
    // safe - the same argument that lets any Eboard member cancel a meeting.
    const posted = await h.db
      .select({ body: messages.body })
      .from(messages)
      .where(eq(messages.channelId, mainChannelId));
    expect(posted.map((m) => m.body)).toContain('Mallory was banned by Owner');

    /*
     * The person gets the ordinary removal notification, unchanged.
     *
     * A deliberate asymmetry rather than an oversight: naming a ban in a push is confrontational
     * and the refusal at the door tells them soon enough. The cost, recorded in ADR-0021, is
     * that the subject is the only party not told it was a ban - the same shape found on
     * 2026-08-05 with race removals. This test pins the decision so it is changed on purpose.
     */
    const rows = await h.db
      .select({ type: notifications.type, recipientId: notifications.recipientId })
      .from(notifications);
    const theirs = rows.filter((r) => r.recipientId === member);
    expect(theirs.map((r) => r.type)).toContain('member_removed');
    expect(theirs.map((r) => r.type)).not.toContain('member_banned');
  });

  it('narrates nothing when the person was never in the club', async () => {
    const { clubId, ownerId, mainChannelId } = await setup();
    const before = await h.db
      .select({ body: messages.body })
      .from(messages)
      .where(eq(messages.channelId, mainChannelId));

    await banFromClub(h.db, await ctxFor(ownerId), clubId, await makeUser('Stranger'));
    await drainOnce(h.db, deps);

    // Nothing happened in the club, so there is nothing to say about it. The ban list still
    // carries the attribution.
    const after = await h.db
      .select({ body: messages.body })
      .from(messages)
      .where(eq(messages.channelId, mainChannelId));
    expect(after).toHaveLength(before.length);
  });
});
