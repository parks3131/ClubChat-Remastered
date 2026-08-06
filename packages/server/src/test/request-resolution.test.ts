/**
 * Join requests: who hears about them, and what happens to everyone else's copy once one
 * person decides.
 *
 * Two defects the founder hit on a real phone on 2026-08-05, and they compound:
 *
 *  1. A race join request went to the club's whole admin tier, so an Owner running none of
 *     the club's races was paged for every one of them.
 *  2. When one admin approved, nobody else's copy changed. `markInboxRead` deliberately
 *     refuses to clear the three request types, so every other admin kept an unread row
 *     saying "X asked to join" - pointing at a roster with nothing pending on it, and
 *     counting against their badge - until they each opened that roster themselves.
 *
 * The second is the one that reads as broken: an admin opens the app hours later and is
 * shown a job that was done before they woke up.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createClub } from '../domain/create-club.ts';
import {
  addRaceMember,
  addRaceMembers,
  createRace,
  decideRaceRequest,
  joinRaceDirectly,
  removeRaceMember,
  requestRaceAccess,
} from '../domain/races.ts';
import { readInbox, badgeCount, markInboxRead } from '../domain/inbox.ts';
import { loadAccessContext } from '../policy/context.ts';
import { drainOnce } from '../worker/drain.ts';
import { clubMemberships, users } from '../db/schema.ts';
import { startTestDb, type TestDb } from './harness.ts';
import type { EffectDeps } from '../worker/effects.ts';

let h: TestDb;
let deps: EffectDeps;

const silent = () => undefined;

beforeAll(async () => {
  h = await startTestDb();
});

afterAll(async () => {
  await h?.stop();
});

beforeEach(async () => {
  await h.db.execute(
    sql`TRUNCATE notifications, push_deliveries, devices, channel_mutes, outbox RESTART IDENTITY CASCADE`,
  );
  deps = {
    db: h.db,
    /*
     * A stub that answers rather than a null.
     *
     * These handlers publish - the departure path revokes a subscription and both paths post a
     * system message - and a null client throws inside the drain, which the outbox absorbs as a
     * retry. The effect would silently park and the assertions below would still pass, since
     * they would simply be looking at a database nothing had written to.
     */
    redis: { publish: async () => 1 } as never,
    push: { send: async () => [] } as never,
    log: silent,
    // Push evaluation is not what these tests are about; dropping the deferred work keeps
    // them to the inbox rows, which is the thing that was wrong.
    defer: () => undefined,
  };
});

async function makeUser(name: string): Promise<string> {
  const id = crypto.randomUUID();
  await h.db.insert(users).values({
    id,
    name,
    email: `${name.toLowerCase()}-${id.slice(0, 8)}@test.invalid`,
  });
  return id;
}

const ctxFor = (userId: string) => loadAccessContext(h.db, userId);

type Fixture = {
  clubId: string;
  raceId: string;
  raceChannelId: string;
  /** Creates the race, so auto-rostered on it. */
  hostAdminId: string;
  /** Admin tier, deliberately NOT on the race roster. */
  ownerId: string;
  offRosterAdminId: string;
  requesterId: string;
};

/**
 * A club whose Owner is not going to the race.
 *
 * The Owner creates the club, so a second admin has to create the race - that is what puts
 * an admin on the roster while leaving the Owner off it, which is exactly the shape the
 * founder described.
 */
async function setup(): Promise<Fixture> {
  const ownerId = await makeUser('Owner');
  const hostAdminId = await makeUser('HostAdmin');
  const offRosterAdminId = await makeUser('OffRosterAdmin');
  const requesterId = await makeUser('Requester');

  const club = await createClub(h.db, {
    name: 'Hillside Running Club',
    sport: 'running',
    creatorId: ownerId,
  });
  await h.db.insert(clubMemberships).values([
    { clubId: club.clubId, userId: hostAdminId, role: 'admin' },
    { clubId: club.clubId, userId: offRosterAdminId, role: 'admin' },
    { clubId: club.clubId, userId: requesterId, role: 'member' },
  ]);

  const race = await createRace(h.db, await ctxFor(hostAdminId), {
    clubId: club.clubId,
    name: 'Fall Classic',
    raceDate: '2026-10-04',
  });
  if (!race.ok) throw new Error('race setup failed');

  await drainOnce(h.db, deps);
  await h.db.execute(sql`TRUNCATE notifications RESTART IDENTITY`);

  return {
    clubId: club.clubId,
    raceId: race.raceId,
    raceChannelId: race.channelId,
    hostAdminId,
    ownerId,
    offRosterAdminId,
    requesterId,
  };
}

/** The system lines in race chat, oldest first. */
async function raceChatLines(f: Fixture): Promise<string[]> {
  const rows = await h.db.execute<{ body: string }>(sql`
    SELECT body FROM messages
     WHERE channel_id = ${f.raceChannelId}::uuid AND type = 'system'
     ORDER BY seq
  `);
  return rows.rows.map((r) => r.body);
}

/** Every notification this user can see, newest first, as `[body, read]` pairs. */
async function inboxOf(userId: string): Promise<Array<[string, boolean]>> {
  const page = await readInbox(h.db, userId);
  return page.rows
    .filter((r) => r.kind === 'notification')
    .map((r) => [r.body, r.read] as [string, boolean]);
}

async function requestAndDrain(f: Fixture, userId = f.requesterId) {
  const result = await requestRaceAccess(h.db, await ctxFor(userId), f.raceId);
  if (!result.ok) throw new Error(`request failed: ${result.code}`);
  await drainOnce(h.db, deps);
}

async function pendingRequestId(f: Fixture, userId: string): Promise<string> {
  const rows = await h.db.execute<{ id: string }>(sql`
    SELECT id FROM race_join_requests
     WHERE race_id = ${f.raceId}::uuid AND user_id = ${userId}::uuid AND status = 'pending'
  `);
  const id = rows.rows[0]?.id;
  if (!id) throw new Error('no pending request');
  return id;
}

/**
 * The statuses of this race's join requests, oldest first.
 *
 * Scoped to the fixture's race rather than reading the whole table: `beforeEach` truncates the
 * volatile tables only, so clubs, races and their requests accumulate across the file.
 */
async function requestStatuses(f: Fixture): Promise<string[]> {
  const rows = await h.db.execute<{ status: string }>(sql`
    SELECT status::text AS status FROM race_join_requests
     WHERE race_id = ${f.raceId}::uuid ORDER BY created_at
  `);
  return rows.rows.map((r) => r.status);
}

/**
 * Unread discrete notifications only.
 *
 * `badgeCount` deliberately adds one per channel with unread messages, and an admin on a race
 * roster has unread race chat from the joins themselves - so the badge is the wrong instrument
 * for asserting what happened to a notification row. Where the badge itself is the claim, the
 * tests below measure it as a delta instead.
 */
async function unreadNotifications(userId: string): Promise<number> {
  const rows = await h.db.execute<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n FROM notifications
     WHERE recipient_id = ${userId}::uuid AND read_at IS NULL
  `);
  return Number(rows.rows[0]?.n ?? 0);
}

// ===========================================================================
// Who hears about a race join request
// ===========================================================================

describe('a race join request reaches the admins who are actually going', () => {
  it('notifies an admin on the roster and nobody off it', async () => {
    const f = await setup();
    await requestAndDrain(f);

    // On the roster, so this is their business.
    expect(await inboxOf(f.hostAdminId)).toEqual([
      ['Requester asked to join Fall Classic', false],
    ]);

    /*
     * The Owner is admin tier and may decide this request - `canManageRace` is every club
     * admin - and is still not told about it, because they are not going to this race.
     * Authority is not involvement. This is the founder's report: "the owner, if he's not in
     * the race, he has no business getting all those approved requests."
     */
    expect(await inboxOf(f.ownerId)).toEqual([]);
    expect(await inboxOf(f.offRosterAdminId)).toEqual([]);

    // And a plain roster member is not an admin, so they hear nothing either.
    expect(await inboxOf(f.requesterId)).toEqual([]);
  });

  it('notifies the Owner once they are on the roster, like any other admin', async () => {
    const f = await setup();

    const joined = await joinRaceDirectly(h.db, await ctxFor(f.ownerId), f.raceId);
    expect(joined).toMatchObject({ ok: true, joined: true });
    await drainOnce(h.db, deps);
    await h.db.execute(sql`TRUNCATE notifications RESTART IDENTITY`);

    await requestAndDrain(f);

    expect(await inboxOf(f.ownerId)).toEqual([['Requester asked to join Fall Classic', false]]);
  });

  /**
   * The founder's explicit call: no widening, no fallback.
   *
   * A race whose last admin has left notifies nobody, and the request waits on the roster
   * screen for whoever opens it. Asserted rather than left implicit, because "notifies
   * nobody" looks like a bug to anyone reading the audience function cold.
   */
  it('notifies nobody when no admin is left on the roster, and keeps the request', async () => {
    const f = await setup();

    const left = await removeRaceMember(h.db, await ctxFor(f.hostAdminId), f.raceId, f.hostAdminId);
    expect(left.ok).toBe(true);
    await drainOnce(h.db, deps);
    await h.db.execute(sql`TRUNCATE notifications RESTART IDENTITY`);

    await requestAndDrain(f);

    expect(await inboxOf(f.hostAdminId)).toEqual([]);
    expect(await inboxOf(f.ownerId)).toEqual([]);
    expect(await inboxOf(f.offRosterAdminId)).toEqual([]);

    // Still there to be found, which is the whole reason nobody being notified is tolerable.
    expect(await requestStatuses(f)).toEqual(['pending']);
  });
});

// ===========================================================================
// What happens to everyone else's copy
// ===========================================================================

describe('deciding a request settles it in every admin inbox', () => {
  it('restates the other admins rows instead of leaving them asking', async () => {
    const f = await setup();

    // Two admins on the roster, so there is a second copy to go stale.
    const added = await addRaceMember(
      h.db,
      await ctxFor(f.hostAdminId),
      f.raceId,
      f.offRosterAdminId,
    );
    expect(added).toMatchObject({ ok: true, added: true });
    await drainOnce(h.db, deps);
    await h.db.execute(sql`TRUNCATE notifications RESTART IDENTITY`);

    await requestAndDrain(f);
    expect(await inboxOf(f.offRosterAdminId)).toEqual([
      ['Requester asked to join Fall Classic', false],
    ]);

    const badgeBefore = await badgeCount(h.db, f.offRosterAdminId);

    // The other admin approves while this one is asleep.
    const decided = await decideRaceRequest(
      h.db,
      await ctxFor(f.hostAdminId),
      await pendingRequestId(f, f.requesterId),
      true,
    );
    expect(decided).toMatchObject({ ok: true, decided: true });
    await drainOnce(h.db, deps);

    /*
     * The row survives, tagged and read: PRD/12 rule 5 keeps the record, and naming the
     * decider answers the question an admin arriving late actually has - not "was this
     * handled" but "who handled it".
     */
    expect(await inboxOf(f.offRosterAdminId)).toEqual([
      ["HostAdmin approved Requester's request to join Fall Classic", true],
    ]);

    const page = await readInbox(h.db, f.offRosterAdminId);
    const row = page.rows.find((r) => r.kind === 'notification');
    expect(row).toMatchObject({ decision: 'approved' });

    // And it stops counting as work waiting on them, without their having gone anywhere.
    expect(await unreadNotifications(f.offRosterAdminId)).toBe(0);
    expect(await badgeCount(h.db, f.offRosterAdminId)).toBe(badgeBefore - 1);
  });

  it('says denied when it was denied, and tells the requester separately', async () => {
    const f = await setup();
    await requestAndDrain(f);

    const decided = await decideRaceRequest(
      h.db,
      await ctxFor(f.hostAdminId),
      await pendingRequestId(f, f.requesterId),
      false,
    );
    expect(decided).toMatchObject({ ok: true, decided: true });
    await drainOnce(h.db, deps);

    expect(await inboxOf(f.hostAdminId)).toEqual([
      ["HostAdmin denied Requester's request to join Fall Classic", true],
    ]);
    // The requester's own row is a different type and says nothing about who decided.
    expect(await inboxOf(f.requesterId)).toEqual([
      ['Your request to join Fall Classic was not approved', false],
    ]);
  });

  /**
   * The guard that makes the sweep safe to run twice.
   *
   * A denied request can be re-filed, so `(race, requester)` is not unique over time. Without
   * `params ->> 'decision' IS NULL` the second decision would reach back and rewrite the
   * record of the first one, and the admin's history would show two approvals for a request
   * that was denied once and approved once.
   */
  it('leaves an older decided row alone when the same person asks again', async () => {
    const f = await setup();

    await requestAndDrain(f);
    await decideRaceRequest(
      h.db,
      await ctxFor(f.hostAdminId),
      await pendingRequestId(f, f.requesterId),
      false,
    );
    await drainOnce(h.db, deps);

    await requestAndDrain(f);
    await decideRaceRequest(
      h.db,
      await ctxFor(f.hostAdminId),
      await pendingRequestId(f, f.requesterId),
      true,
    );
    await drainOnce(h.db, deps);

    // Newest first: the second ask was approved, and the first is still recorded as denied.
    expect(await inboxOf(f.hostAdminId)).toEqual([
      ["HostAdmin approved Requester's request to join Fall Classic", true],
      ["HostAdmin denied Requester's request to join Fall Classic", true],
    ]);
  });

  /**
   * Opening the inbox still must not clear a request that is genuinely outstanding.
   *
   * The founder chose to keep that rule, so the sweep must be the only thing that settles
   * these rows. A regression here would put back the behaviour that lost them real requests.
   */
  it('does not let a glance at the inbox clear a request nobody has decided', async () => {
    const f = await setup();
    await requestAndDrain(f);

    await markInboxRead(h.db, f.hostAdminId);

    expect(await inboxOf(f.hostAdminId)).toEqual([
      ['Requester asked to join Fall Classic', false],
    ]);
    expect(await unreadNotifications(f.hostAdminId)).toBe(1);
  });
});

// ===========================================================================
// What race chat says about its own roster
// ===========================================================================

/**
 * Race chat said nothing at all about who was on the roster.
 *
 * Club chat and Eboard chat have narrated joins and departures since Phase 1; this handler
 * wrote the requester's notification and stopped. The founder's report was that approving
 * somebody "didn't say anything in the chat, and the notification doesn't pop up to anyone" -
 * and the second half follows from the first, because a channel's unread count comes from its
 * messages. No message meant no unread, so no badge for anybody on the roster.
 */
describe('race chat narrates its roster, like club chat does', () => {
  it('says who joined when a request is approved', async () => {
    const f = await setup();
    await requestAndDrain(f);

    await decideRaceRequest(
      h.db,
      await ctxFor(f.hostAdminId),
      await pendingRequestId(f, f.requesterId),
      true,
    );
    await drainOnce(h.db, deps);

    expect(await raceChatLines(f)).toEqual(['Requester joined the race']);
  });

  it('names the admin when somebody is added rather than approved', async () => {
    const f = await setup();

    await addRaceMember(h.db, await ctxFor(f.hostAdminId), f.raceId, f.requesterId);
    await drainOnce(h.db, deps);

    expect(await raceChatLines(f)).toEqual(['Requester was added by HostAdmin']);
  });

  /** The Owner let themselves in, so they joined - "Owner was added by Owner" is nonsense. */
  it('says the Owner joined, not that they added themselves', async () => {
    const f = await setup();

    await joinRaceDirectly(h.db, await ctxFor(f.ownerId), f.raceId);
    await drainOnce(h.db, deps);

    expect(await raceChatLines(f)).toEqual(['Owner joined the race']);
  });

  it('says nothing when a request is denied', async () => {
    const f = await setup();
    await requestAndDrain(f);

    await decideRaceRequest(
      h.db,
      await ctxFor(f.hostAdminId),
      await pendingRequestId(f, f.requesterId),
      false,
    );
    await drainOnce(h.db, deps);

    // A refusal is addressed to the person refused. Announcing it to the room they were kept
    // out of is a different and worse act - the same rule the Eboard handler follows.
    expect(await raceChatLines(f)).toEqual([]);
  });

  it('says who left, and who removed them', async () => {
    const f = await setup();

    await addRaceMember(h.db, await ctxFor(f.hostAdminId), f.raceId, f.requesterId);
    await drainOnce(h.db, deps);

    // Removed by somebody else.
    await removeRaceMember(h.db, await ctxFor(f.hostAdminId), f.raceId, f.requesterId);
    await drainOnce(h.db, deps);

    // And leaving under their own steam.
    await addRaceMember(h.db, await ctxFor(f.hostAdminId), f.raceId, f.offRosterAdminId);
    await drainOnce(h.db, deps);
    await removeRaceMember(h.db, await ctxFor(f.offRosterAdminId), f.raceId, f.offRosterAdminId);
    await drainOnce(h.db, deps);

    expect(await raceChatLines(f)).toEqual([
      'Requester was added by HostAdmin',
      'Requester was removed by HostAdmin',
      'OffRosterAdmin was added by HostAdmin',
      'OffRosterAdmin left the race',
    ]);
  });

  /**
   * The removed member is the one person who cannot read the line above.
   *
   * `onRaceMemberDeparted` revokes their subscription BEFORE it posts, deliberately - you do
   * not deliver "Requester was removed by HostAdmin" to Requester, live, in a room they have
   * just lost. So the departure is narrated to the whole roster except its subject, and with no
   * notification the subject learned nothing at all: the founder's report on 2026-08-05 was
   * that the race just disappeared. Club and Eboard removal have written this row since Phase 1.
   */
  it('tells the person removed, naming the race and not the club', async () => {
    const f = await setup();

    await addRaceMember(h.db, await ctxFor(f.hostAdminId), f.raceId, f.requesterId);
    await drainOnce(h.db, deps);
    await removeRaceMember(h.db, await ctxFor(f.hostAdminId), f.raceId, f.requesterId);
    await drainOnce(h.db, deps);

    // Newest first. "removed you from Hillside Running Club" would be a false alarm - they are
    // still in the club, still in its chat, and still on every other race in it.
    expect(await inboxOf(f.requesterId)).toEqual([
      ['HostAdmin removed you from Fall Classic', false],
      ['HostAdmin added you to Fall Classic', false],
    ]);
  });

  /** They did it themselves, so there is nobody to tell. `actorId` is null on that path. */
  it('says nothing to somebody who left the race under their own steam', async () => {
    const f = await setup();

    await addRaceMember(h.db, await ctxFor(f.hostAdminId), f.raceId, f.offRosterAdminId);
    await drainOnce(h.db, deps);
    await removeRaceMember(h.db, await ctxFor(f.offRosterAdminId), f.raceId, f.offRosterAdminId);
    await drainOnce(h.db, deps);

    expect(await inboxOf(f.offRosterAdminId)).toEqual([
      ['HostAdmin added you to Fall Classic', false],
    ]);
  });

  /**
   * The point of the whole thing: a message is what gives a channel an unread count, so the
   * roster now hears about an arrival without anybody being sent a discrete notification.
   */
  it('gives the rest of the roster an unread chat, which is what nobody was getting', async () => {
    const f = await setup();
    await requestAndDrain(f);

    const before = await badgeCount(h.db, f.hostAdminId);

    await decideRaceRequest(
      h.db,
      await ctxFor(f.hostAdminId),
      await pendingRequestId(f, f.requesterId),
      true,
    );
    await drainOnce(h.db, deps);

    const page = await readInbox(h.db, f.hostAdminId);
    const unreadChat = page.rows.find(
      (r) => r.kind === 'chat_unread' && r.channelId === f.raceChannelId,
    );
    expect(unreadChat).toBeDefined();

    /*
     * The badge holds steady rather than climbing: the request row it was counting has just
     * been settled, and the race chat it is now counting has just gained a line. One piece of
     * outstanding work became one thing to read.
     */
    expect(await badgeCount(h.db, f.hostAdminId)).toBe(before);
  });
});

// ===========================================================================
// Adding several people at once
// ===========================================================================

/**
 * The roster picker adds a whole selection in one act, so the server has to treat it as one.
 *
 * Emitting an event per person would be simpler and wrong in a way the founder would see
 * immediately: a race created with eight people would open onto eight near-identical "was added
 * by" lines before anybody had said anything in it.
 */
describe('adding several people at once', () => {
  /** Extra club members, so there is a real batch to add. */
  async function extraMembers(f: Fixture, names: readonly string[]): Promise<string[]> {
    const ids = [];
    for (const name of names) {
      const id = await makeUser(name);
      await h.db.insert(clubMemberships).values({ clubId: f.clubId, userId: id, role: 'member' });
      ids.push(id);
    }
    return ids;
  }

  it('posts one line for the batch, naming two and counting the rest', async () => {
    const f = await setup();
    const ids = await extraMembers(f, ['Ana', 'Ben', 'Cara', 'Dan']);

    const result = await addRaceMembers(h.db, await ctxFor(f.hostAdminId), f.raceId, ids);
    expect(result).toMatchObject({ ok: true, added: 4 });
    await drainOnce(h.db, deps);

    expect(await raceChatLines(f)).toEqual(['HostAdmin added Ana, Ben and 2 others to the race']);
  });

  it('says "and 1 other" rather than "1 others"', async () => {
    const f = await setup();
    const ids = await extraMembers(f, ['Ana', 'Ben', 'Cara']);

    await addRaceMembers(h.db, await ctxFor(f.hostAdminId), f.raceId, ids);
    await drainOnce(h.db, deps);

    expect(await raceChatLines(f)).toEqual(['HostAdmin added Ana, Ben and 1 other to the race']);
  });

  it('names both when there are exactly two', async () => {
    const f = await setup();
    const ids = await extraMembers(f, ['Ana', 'Ben']);

    await addRaceMembers(h.db, await ctxFor(f.hostAdminId), f.raceId, ids);
    await drainOnce(h.db, deps);

    expect(await raceChatLines(f)).toEqual(['HostAdmin added Ana and Ben to the race']);
  });

  it('still tells each person individually, because that part IS addressed to them', async () => {
    const f = await setup();
    const ids = await extraMembers(f, ['Ana', 'Ben', 'Cara']);

    await addRaceMembers(h.db, await ctxFor(f.hostAdminId), f.raceId, ids);
    await drainOnce(h.db, deps);

    for (const id of ids) {
      expect(await inboxOf(id)).toEqual([['HostAdmin added you to Fall Classic', false]]);
    }
  });

  /**
   * A stale selection must not sink the whole batch.
   *
   * The picker's list is a snapshot, so somebody in it may have joined a second before Add was
   * pressed. Failing all eight because of one is a worse answer than adding the seven.
   */
  it('skips somebody already on the roster instead of refusing the batch', async () => {
    const f = await setup();
    const ids = await extraMembers(f, ['Ana', 'Ben']);

    await addRaceMembers(h.db, await ctxFor(f.hostAdminId), f.raceId, [ids[0]!]);
    await drainOnce(h.db, deps);

    const second = await addRaceMembers(h.db, await ctxFor(f.hostAdminId), f.raceId, ids);
    expect(second).toMatchObject({ ok: true, added: 1 });
    await drainOnce(h.db, deps);

    // The second line names only the person who was actually new.
    expect(await raceChatLines(f)).toEqual([
      'Ana was added by HostAdmin',
      'Ben was added by HostAdmin',
    ]);
  });

  it('refuses the batch if the manager put themselves in it', async () => {
    const f = await setup();
    const ids = await extraMembers(f, ['Ana']);

    const attempt = await addRaceMembers(h.db, await ctxFor(f.offRosterAdminId), f.raceId, [
      ...ids,
      f.offRosterAdminId,
    ]);
    expect(attempt).toEqual({ ok: false, code: 'forbidden' });

    // And nothing was added, so the refusal is not half-applied.
    await drainOnce(h.db, deps);
    expect(await raceChatLines(f)).toEqual([]);
  });
});

// ===========================================================================
// Getting onto a roster
// ===========================================================================

describe('joining a race directly', () => {
  it('lets the Owner walk on, and closes any request they had open', async () => {
    const f = await setup();
    await requestAndDrain(f, f.ownerId);

    const joined = await joinRaceDirectly(h.db, await ctxFor(f.ownerId), f.raceId);
    expect(joined).toMatchObject({ ok: true, joined: true });
    await drainOnce(h.db, deps);

    expect(await requestStatuses(f)).toEqual(['approved']);

    /*
     * Nobody is told about their own act (PRD/12 rule 10), so the Owner is not sent "you
     * approved your own request". Their inbox is empty rather than merely quiet: they were
     * never on this roster, so the request they filed was never addressed to them either.
     */
    expect(await inboxOf(f.ownerId)).toEqual([]);

    /*
     * The admin who WAS asked keeps the record, settled. This is the direct-join path running
     * the same sweep as a decision, which is what stops the roster and the inbox telling two
     * different stories about whether the Owner is still waiting.
     */
    expect(await inboxOf(f.hostAdminId)).toEqual([
      ["Owner approved Owner's request to join Fall Classic", true],
    ]);
  });

  it('refuses an admin who is not the Owner', async () => {
    const f = await setup();
    const attempt = await joinRaceDirectly(h.db, await ctxFor(f.offRosterAdminId), f.raceId);
    expect(attempt).toEqual({ ok: false, code: 'forbidden' });
  });

  /**
   * The loophole that made `canJoinRaceDirectly` necessary.
   *
   * `addRaceMember` never checked that the target was somebody else, so any manager could
   * pass their own id and walk onto any roster in the club - PRD/09 rule 4's "management
   * authority is not access" held only until an admin decided otherwise.
   */
  it('refuses a manager adding themselves through the add-member path', async () => {
    const f = await setup();
    const attempt = await addRaceMember(
      h.db,
      await ctxFor(f.offRosterAdminId),
      f.raceId,
      f.offRosterAdminId,
    );
    expect(attempt).toEqual({ ok: false, code: 'forbidden' });
  });

  it('tells someone added directly that they were added, not that a request was approved', async () => {
    const f = await setup();

    const added = await addRaceMember(
      h.db,
      await ctxFor(f.hostAdminId),
      f.raceId,
      f.offRosterAdminId,
    );
    expect(added).toMatchObject({ ok: true, added: true });
    await drainOnce(h.db, deps);

    expect(await inboxOf(f.offRosterAdminId)).toEqual([
      ['HostAdmin added you to Fall Classic', false],
    ]);
  });
});
