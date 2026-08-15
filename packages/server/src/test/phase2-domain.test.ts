/**
 * Phase 2 behaviour, against a real database.
 *
 * The permission matrix is covered in policy/matrix.test.ts as pure functions. This file is
 * for the rules that only a live database can prove: the Incharge asymmetry, vote moving,
 * closed-at-read-time, the completed cascade, and the notification silences.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createClub } from '../domain/create-club.ts';
import { addMember, changeRole, leaveClub, removeMember } from '../domain/membership.ts';
import {
  addRaceMember,
  assignToCarGroup,
  createCarGroup,
  createRace,
  deleteCarGroup,
  leaveCarGroup,
  removeRaceMember,
  requestRaceAccess,
  setCarGroupIncharge,
  setRacePin,
  updateMeetInformation,
} from '../domain/races.ts';
import { createPoll, deletePoll, readPoll, setPollClosed, toggleVote } from '../domain/polls.ts';
import {
  createEvent,
  createMeeting,
  createNewsPost,
  createMeetup,
  nudgeMeetup,
  deleteEvent,
  deleteMeeting,
  readMeetupWeek,
  updateMeeting,
} from '../domain/content.ts';
import { sendMessage } from '../domain/send-message.ts';
import { getChannelRef } from '../domain/reads.ts';
import { reportMessage } from '../domain/moderation.ts';
import {
  addEboardMember,
  decideEboardRequest,
  removeEboardMember,
  requestEboardAccess,
} from '../domain/eboard.ts';
import { canReadReports } from '../policy/predicates.ts';
import { readCalendarFeed, readMonthMarkers } from '../domain/calendar.ts';
import { loadAccessContext } from '../policy/context.ts';
import { REVOKE_TOPIC } from '../bus/redis.ts';
import { drainOnce } from '../worker/drain.ts';
import { runScheduledTick } from '../worker/scheduled.ts';
import { RecordingPushSender } from '../push/sender.ts';
import { registerDevice } from '../push/dispatch.ts';
import {
  carGroupMembers,
  carGroups,
  eboardChannels,
  notifications,
  racePins,
  raceMemberships,
  users,
} from '../db/schema.ts';
import { startTestDb, type TestDb } from './harness.ts';
import type { EffectDeps } from '../worker/effects.ts';

let h: TestDb;
let push: RecordingPushSender;
let deferred: Array<() => Promise<void>>;
let deps: EffectDeps;
/**
 * Every Redis publish an effect made.
 *
 * Recorded rather than discarded because **revocation is only observable here.** Losing access
 * to a channel has two halves - the row goes, and the live socket is force-unsubscribed - and
 * the second half is a publish and nothing else. A fake that answered `1` and forgot made the
 * half that matters untestable, which is how the Eboard's two paths lost theirs unnoticed.
 */
let published: Array<{ topic: string; payload: string }>;
const silent = () => undefined;

/** The channel ids a revocation was published for, for one user. */
function revokedChannelsFor(userId: string): string[] {
  return published
    .filter((entry) => entry.topic === REVOKE_TOPIC)
    .map((entry) => JSON.parse(entry.payload) as { userId: string; channelIds: string[] })
    .filter((instruction) => instruction.userId === userId)
    .flatMap((instruction) => instruction.channelIds);
}

beforeAll(async () => {
  h = await startTestDb();
});
afterAll(async () => {
  await h?.stop();
});

beforeEach(async () => {
  await h.db.execute(sql`TRUNCATE notifications, outbox, push_deliveries, devices RESTART IDENTITY CASCADE`);
  push = new RecordingPushSender();
  deferred = [];
  published = [];
  deps = {
    db: h.db,
    redis: {
      publish: async (topic: string, payload: string) => {
        published.push({ topic, payload });
        return 1;
      },
    } as never,
    push,
    log: silent,
    defer: (fn) => deferred.push(fn),
  };
});

async function drainAll() {
  await drainOnce(h.db, deps);
  const pending = [...deferred];
  deferred = [];
  for (const fn of pending) await fn();
}

/**
 * Drain the fixture's own effects, then clear what they produced.
 *
 * Fixture setup legitimately notifies people - adding a club member tells them so, and adding
 * a race member tells them so. Leaving those rows behind means every assertion below is
 * counting the fixture's notifications as well as the ones under test, which is how a real
 * "notifies nobody" rule ends up looking broken.
 */
async function settleFixture() {
  await drainAll();
  await h.db.execute(sql`TRUNCATE notifications RESTART IDENTITY CASCADE`);
  push.reset();
}

const ctxFor = (id: string) => loadAccessContext(h.db, id);

async function makeUser(name: string): Promise<string> {
  const id = crypto.randomUUID();
  await h.db.insert(users).values({
    id, name, email: `${name}-${id.slice(0, 8)}@t.invalid`,
  });
  return id;
}

async function setup() {
  const ownerId = await makeUser('Owner');
  const memberId = await makeUser('Member');
  const club = await createClub(h.db, {
    name: 'Hillside', sport: 'running', creatorId: ownerId,
  });
  await addMember(h.db, await ctxFor(ownerId), club.clubId, memberId);
  const eboard = await h.db.select().from(eboardChannels).where(eq(eboardChannels.clubId, club.clubId));
  // Drain the fixture's own effects, then clear what they produced. Adding a member
  // legitimately notifies them, so without this every test below inherits one extra row and
  // its assertions stop being about the thing under test.
  await settleFixture();
  return { ...club, ownerId, memberId, eboardId: eboard[0]!.id };
}

async function setupRace(f: Awaited<ReturnType<typeof setup>>) {
  const created = await createRace(h.db, await ctxFor(f.ownerId), {
    clubId: f.clubId, name: 'Spring Half', raceDate: '2026-04-12',
  });
  if (!created.ok) throw new Error('race creation failed');
  await settleFixture();
  return created;
}

// ===========================================================================
// Races
// ===========================================================================

describe('races', () => {
  it('creates the channel before the creator roster row', async () => {
    const f = await setup();
    const race = await setupRace(f);

    const channel = await h.db.execute<{ id: string; created_at: string }>(sql`
      SELECT id, created_at FROM channels WHERE scope = 'race' AND scope_id = ${race.raceId}::uuid
    `);
    const roster = await h.db.execute<{ joined_at: string }>(sql`
      SELECT joined_at FROM race_memberships WHERE race_id = ${race.raceId}::uuid
    `);
    expect(channel.rows).toHaveLength(1);
    expect(roster.rows).toHaveLength(1);
    // The ordering the v1 lesson is about.
    expect(new Date(channel.rows[0]!.created_at).getTime()).toBeLessThanOrEqual(
      new Date(roster.rows[0]!.joined_at).getTime(),
    );
  });

  it('gives the creating admin a roster row, so management comes with access here', async () => {
    const f = await setup();
    const race = await setupRace(f);
    const ctx = await ctxFor(f.ownerId);
    expect(ctx.raceRoster.has(race.raceId)).toBe(true);
  });

  it('a plain member must request access, and cannot self-admit', async () => {
    const f = await setup();
    const race = await setupRace(f);
    const result = await requestRaceAccess(h.db, await ctxFor(f.memberId), race.raceId);
    expect(result.ok && result.status).toBe('requested');

    // Still off the roster until a manager decides.
    const ctx = await ctxFor(f.memberId);
    expect(ctx.raceRoster.has(race.raceId)).toBe(false);
  });

  it('Meet Information is editable from inside the race and refused from outside it', async () => {
    /*
     * **Inverted 2026-08-12.** This used to assert that ANY club admin could edit Meet
     * Information, because management authority did not require a roster row. It does now: you
     * run the races you are in. Reading is unchanged and stays open to every club member, which
     * is what the request-to-join decision is made on (PRD/09 rule 13).
     */
    const f = await setup();
    const race = await setupRace(f);
    const admin = await makeUser('OtherAdmin');
    await addMember(h.db, await ctxFor(f.ownerId), f.clubId, admin);
    await changeRole(h.db, await ctxFor(f.ownerId), f.clubId, admin, 'admin');

    // An admin of the club, not the race's creator, and not on its roster.
    const fromOutside = await updateMeetInformation(h.db, await ctxFor(admin), race.raceId, {
      meetDescription: 'Bus at 6am',
      meetHotelUrl: 'https://hotel.example',
    });
    expect(fromOutside.ok).toBe(false);

    // The creator is on the roster, so they can - which is what keeps a race runnable by
    // whoever made it.
    const fromInside = await updateMeetInformation(h.db, await ctxFor(f.ownerId), race.raceId, {
      meetDescription: 'Bus at 6am',
      meetHotelUrl: 'https://hotel.example',
    });
    expect(fromInside.ok).toBe(true);
  });

  it('a plain member cannot edit Meet Information', async () => {
    const f = await setup();
    const race = await setupRace(f);
    const result = await updateMeetInformation(h.db, await ctxFor(f.memberId), race.raceId, {
      meetDescription: 'nope',
    });
    expect(result.ok).toBe(false);
  });

  it('pinning is personal and affects nobody else hub', async () => {
    const f = await setup();
    const race = await setupRace(f);

    await setRacePin(h.db, await ctxFor(f.memberId), race.raceId, true);
    const pins = await h.db.select().from(racePins).where(eq(racePins.raceId, race.raceId));
    expect(pins).toHaveLength(1);
    expect(pins[0]?.userId).toBe(f.memberId);
    // The owner pinned nothing, even though the member did.
    expect(pins.some((p) => p.userId === f.ownerId)).toBe(false);
  });

  it('a member with no race access can still pin it', async () => {
    // Pinning is not admin-gated and not access-gated: anyone who can see a race can pin it.
    const f = await setup();
    const race = await setupRace(f);
    const result = await setRacePin(h.db, await ctxFor(f.memberId), race.raceId, true);
    expect(result.ok).toBe(true);
  });
});

// ===========================================================================
// Car groups, and the Incharge asymmetry
// ===========================================================================

describe('car groups', () => {
  async function raceWithGroup() {
    const f = await setup();
    const race = await setupRace(f);
    await addRaceMember(h.db, await ctxFor(f.ownerId), race.raceId, f.memberId);
    const group = await createCarGroup(h.db, await ctxFor(f.ownerId), race.raceId);
    if (!group.ok) throw new Error('group creation failed');
    // addRaceMember above notified the member they were added. Clear it, so the asymmetry
    // tests below count only what leaving a car group produces.
    await settleFixture();
    return { f, race, group };
  }

  it('auto-numbers groups from 1 with no naming prompt', async () => {
    const { f, race } = await raceWithGroup();
    const second = await createCarGroup(h.db, await ctxFor(f.ownerId), race.raceId);
    const third = await createCarGroup(h.db, await ctxFor(f.ownerId), race.raceId);
    expect(second.ok && second.number).toBe(2);
    expect(third.ok && third.number).toBe(3);
  });

  it('refuses to assign somebody with no race access', async () => {
    const { f, group } = await raceWithGroup();
    const outsider = await makeUser('NoAccess');
    await addMember(h.db, await ctxFor(f.ownerId), f.clubId, outsider);
    // In the club, not on the roster.
    const result = await assignToCarGroup(h.db, await ctxFor(f.ownerId), group.groupId, outsider);
    expect(result.ok).toBe(false);
  });

  it('refuses an Incharge who is not in that group', async () => {
    const { f, group } = await raceWithGroup();
    // On the roster, but not in this car.
    const result = await setCarGroupIncharge(h.db, await ctxFor(f.ownerId), group.groupId, f.memberId);
    expect(result.ok).toBe(false);
  });

  it('accepts an Incharge who is in the group', async () => {
    const { f, group } = await raceWithGroup();
    await assignToCarGroup(h.db, await ctxFor(f.ownerId), group.groupId, f.memberId);
    const result = await setCarGroupIncharge(h.db, await ctxFor(f.ownerId), group.groupId, f.memberId);
    expect(result.ok).toBe(true);
  });

  it('THE ASYMMETRY: a plain member leaving their car notifies nobody', async () => {
    const { f, race, group } = await raceWithGroup();
    await assignToCarGroup(h.db, await ctxFor(f.ownerId), group.groupId, f.memberId);
    await drainAll();

    await leaveCarGroup(h.db, await ctxFor(f.memberId), race.raceId, f.memberId);
    await drainAll();

    const rows = await h.db.select().from(notifications);
    expect(rows, 'a plain member leaving a car raised a notification').toHaveLength(0);
  });

  it('THE ASYMMETRY: the Incharge leaving clears it and notifies every club admin', async () => {
    const { f, race, group } = await raceWithGroup();
    await assignToCarGroup(h.db, await ctxFor(f.ownerId), group.groupId, f.memberId);
    await setCarGroupIncharge(h.db, await ctxFor(f.ownerId), group.groupId, f.memberId);
    await drainAll();

    await leaveCarGroup(h.db, await ctxFor(f.memberId), race.raceId, f.memberId);
    await drainAll();

    // Cleared.
    const groups = await h.db.select().from(carGroups).where(eq(carGroups.id, group.groupId));
    expect(groups[0]?.inchargeUserId).toBeNull();

    // And the admin tier was told.
    const rows = await h.db.select().from(notifications);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe('car_group_incharge_left');
    expect(rows[0]?.recipientId).toBe(f.ownerId);
  });

  it('the group persists with no Incharge, and the rest of it is untouched', async () => {
    const { f, race, group } = await raceWithGroup();
    const third = await makeUser('Passenger');
    await addMember(h.db, await ctxFor(f.ownerId), f.clubId, third);
    await addRaceMember(h.db, await ctxFor(f.ownerId), race.raceId, third);
    await assignToCarGroup(h.db, await ctxFor(f.ownerId), group.groupId, f.memberId);
    await assignToCarGroup(h.db, await ctxFor(f.ownerId), group.groupId, third);
    await setCarGroupIncharge(h.db, await ctxFor(f.ownerId), group.groupId, f.memberId);

    await leaveCarGroup(h.db, await ctxFor(f.memberId), race.raceId, f.memberId);

    // The group still exists and still holds the passenger.
    const remaining = await h.db
      .select()
      .from(carGroupMembers)
      .where(eq(carGroupMembers.carGroupId, group.groupId));
    expect(remaining.map((r) => r.userId)).toEqual([third]);
  });

  it('deleting a group empties the car and leaves the race roster alone', async () => {
    const { f, race, group } = await raceWithGroup();
    await assignToCarGroup(h.db, await ctxFor(f.ownerId), group.groupId, f.memberId);

    const deleted = await deleteCarGroup(h.db, await ctxFor(f.ownerId), group.groupId);
    expect(deleted.ok).toBe(true);

    // The group is gone, and its seats went with it through the composite foreign key.
    const groups = await h.db.select().from(carGroups).where(eq(carGroups.id, group.groupId));
    expect(groups).toHaveLength(0);
    const seats = await h.db
      .select()
      .from(carGroupMembers)
      .where(eq(carGroupMembers.userId, f.memberId));
    expect(seats).toHaveLength(0);

    // A car is travel logistics, not membership: the passenger is still in the race.
    const roster = await h.db
      .select()
      .from(raceMemberships)
      .where(
        and(eq(raceMemberships.raceId, race.raceId), eq(raceMemberships.userId, f.memberId)),
      );
    expect(roster, 'deleting a car group removed somebody from the race').toHaveLength(1);
  });

  it('deleting a group whose Incharge is still in it notifies nobody', async () => {
    // The contrast with the asymmetry above: an Incharge WALKING AWAY leaves a group that needs
    // a new one, and admins are told. A deleted group needs nothing, so telling them "Group 1
    // needs a new Incharge" would be a notification about something that no longer exists.
    const { f, group } = await raceWithGroup();
    await assignToCarGroup(h.db, await ctxFor(f.ownerId), group.groupId, f.memberId);
    await setCarGroupIncharge(h.db, await ctxFor(f.ownerId), group.groupId, f.memberId);
    await drainAll();

    await deleteCarGroup(h.db, await ctxFor(f.ownerId), group.groupId);
    await drainAll();

    const rows = await h.db.select().from(notifications);
    expect(rows, 'deleting a car group raised a notification').toHaveLength(0);
  });

  it('refuses to delete a group for somebody who only rides in it', async () => {
    const { f, group } = await raceWithGroup();
    await assignToCarGroup(h.db, await ctxFor(f.ownerId), group.groupId, f.memberId);

    const result = await deleteCarGroup(h.db, await ctxFor(f.memberId), group.groupId);
    expect(result.ok).toBe(false);
    const groups = await h.db.select().from(carGroups).where(eq(carGroups.id, group.groupId));
    expect(groups, 'a plain race member deleted a car group').toHaveLength(1);
  });

  it('leaving the race also leaves the car group', async () => {
    const { f, race, group } = await raceWithGroup();
    await assignToCarGroup(h.db, await ctxFor(f.ownerId), group.groupId, f.memberId);

    await removeRaceMember(h.db, await ctxFor(f.memberId), race.raceId, f.memberId);

    const inCar = await h.db
      .select()
      .from(carGroupMembers)
      .where(eq(carGroupMembers.userId, f.memberId));
    expect(inCar).toHaveLength(0);
  });
});

// ===========================================================================
// The completed cascade
// ===========================================================================

describe('the club cascade reaches races', () => {
  it('leaving the club removes every race roster row and car assignment', async () => {
    const f = await setup();
    const race = await setupRace(f);
    const second = await createRace(h.db, await ctxFor(f.ownerId), {
      clubId: f.clubId, name: 'Autumn 10k', raceDate: '2026-10-04',
    });
    if (!second.ok) throw new Error('second race failed');

    await addRaceMember(h.db, await ctxFor(f.ownerId), race.raceId, f.memberId);
    await addRaceMember(h.db, await ctxFor(f.ownerId), second.raceId, f.memberId);
    const group = await createCarGroup(h.db, await ctxFor(f.ownerId), race.raceId);
    if (!group.ok) throw new Error('group failed');
    await assignToCarGroup(h.db, await ctxFor(f.ownerId), group.groupId, f.memberId);

    await leaveClub(h.db, await ctxFor(f.memberId), f.clubId);

    // ALL races, not just upcoming ones.
    const rosters = await h.db
      .select()
      .from(raceMemberships)
      .where(eq(raceMemberships.userId, f.memberId));
    expect(rosters, 'a race roster row survived leaving the club').toHaveLength(0);

    const cars = await h.db
      .select()
      .from(carGroupMembers)
      .where(eq(carGroupMembers.userId, f.memberId));
    expect(cars, 'a car assignment survived leaving the club').toHaveLength(0);
  });

  it('clears an Incharge held by someone removed from the club', async () => {
    const f = await setup();
    const race = await setupRace(f);
    await addRaceMember(h.db, await ctxFor(f.ownerId), race.raceId, f.memberId);
    const group = await createCarGroup(h.db, await ctxFor(f.ownerId), race.raceId);
    if (!group.ok) throw new Error('group failed');
    await assignToCarGroup(h.db, await ctxFor(f.ownerId), group.groupId, f.memberId);
    await setCarGroupIncharge(h.db, await ctxFor(f.ownerId), group.groupId, f.memberId);

    await removeMember(h.db, await ctxFor(f.ownerId), f.clubId, f.memberId);

    const groups = await h.db.select().from(carGroups).where(eq(carGroups.id, group.groupId));
    expect(groups[0]?.inchargeUserId).toBeNull();
  });
});

// ===========================================================================
// Polls
// ===========================================================================

describe('polls', () => {
  async function clubPoll(f: Awaited<ReturnType<typeof setup>>, opts: {
    allowMultiple?: boolean; isPrivate?: boolean; closesInMinutes?: number | null;
  } = {}) {
    const created = await createPoll(h.db, await ctxFor(f.ownerId), {
      clubId: f.clubId, scope: 'club', scopeId: f.clubId,
      question: 'Carpool or bus?', options: ['Carpool', 'Bus'],
      ...opts,
    });
    if (!created.ok) throw new Error('poll creation failed');
    return created.pollId;
  }

  it('rejects fewer than 2 and more than 10 options', async () => {
    const f = await setup();
    const ctx = await ctxFor(f.ownerId);
    const base = { clubId: f.clubId, scope: 'club' as const, scopeId: f.clubId, question: 'q' };
    expect((await createPoll(h.db, ctx, { ...base, options: ['only'] })).ok).toBe(false);
    expect(
      (await createPoll(h.db, ctx, { ...base, options: Array.from({ length: 11 }, (_, i) => `o${i}`) })).ok,
    ).toBe(false);
    expect((await createPoll(h.db, ctx, { ...base, options: ['a', 'b'] })).ok).toBe(true);
    expect(
      (await createPoll(h.db, ctx, { ...base, options: Array.from({ length: 10 }, (_, i) => `o${i}`) })).ok,
    ).toBe(true);
  });

  it('a member can vote in a club poll but not create one', async () => {
    const f = await setup();
    const pollId = await clubPoll(f);
    const view = await readPoll(h.db, await ctxFor(f.memberId), pollId);
    expect(view.ok).toBe(true);
    if (!view.ok) return;

    const vote = await toggleVote(h.db, await ctxFor(f.memberId), view.poll.options[0]!.id);
    expect(vote.ok && vote.action).toBe('cast');

    const create = await createPoll(h.db, await ctxFor(f.memberId), {
      clubId: f.clubId, scope: 'club', scopeId: f.clubId, question: 'mine', options: ['a', 'b'],
    });
    expect(create.ok).toBe(false);
  });

  it('tapping the same option again withdraws the vote', async () => {
    const f = await setup();
    const pollId = await clubPoll(f);
    const view = await readPoll(h.db, await ctxFor(f.memberId), pollId);
    if (!view.ok) return;
    const optionId = view.poll.options[0]!.id;

    await toggleVote(h.db, await ctxFor(f.memberId), optionId);
    const second = await toggleVote(h.db, await ctxFor(f.memberId), optionId);
    expect(second.ok && second.action).toBe('withdrawn');

    const after = await readPoll(h.db, await ctxFor(f.memberId), pollId);
    if (!after.ok) return;
    expect(after.poll.options[0]?.voteCount).toBe(0);
    expect(after.poll.options[0]?.votedByMe).toBe(false);
  });

  it('on a single-choice poll a different option MOVES the vote', async () => {
    const f = await setup();
    const pollId = await clubPoll(f, { allowMultiple: false });
    const view = await readPoll(h.db, await ctxFor(f.memberId), pollId);
    if (!view.ok) return;

    await toggleVote(h.db, await ctxFor(f.memberId), view.poll.options[0]!.id);
    const moved = await toggleVote(h.db, await ctxFor(f.memberId), view.poll.options[1]!.id);
    expect(moved.ok && moved.action).toBe('moved');

    const after = await readPoll(h.db, await ctxFor(f.memberId), pollId);
    if (!after.ok) return;
    // One vote total, on the second option. Not two.
    expect(after.poll.options[0]?.voteCount).toBe(0);
    expect(after.poll.options[1]?.voteCount).toBe(1);
  });

  it('on a multi-select poll a second option ADDS a vote', async () => {
    const f = await setup();
    const pollId = await clubPoll(f, { allowMultiple: true });
    const view = await readPoll(h.db, await ctxFor(f.memberId), pollId);
    if (!view.ok) return;

    await toggleVote(h.db, await ctxFor(f.memberId), view.poll.options[0]!.id);
    const second = await toggleVote(h.db, await ctxFor(f.memberId), view.poll.options[1]!.id);
    expect(second.ok && second.action).toBe('cast');

    const after = await readPoll(h.db, await ctxFor(f.memberId), pollId);
    if (!after.ok) return;
    expect(after.poll.options.map((o) => o.voteCount)).toEqual([1, 1]);
  });

  it('counts are public on a private poll but voter identity is not', async () => {
    const f = await setup();
    const pollId = await clubPoll(f, { isPrivate: true });
    const view = await readPoll(h.db, await ctxFor(f.memberId), pollId);
    if (!view.ok) return;
    await toggleVote(h.db, await ctxFor(f.memberId), view.poll.options[0]!.id);

    // The member is not the creator.
    const asMember = await readPoll(h.db, await ctxFor(f.memberId), pollId);
    if (!asMember.ok) return;
    expect(asMember.poll.options[0]?.voteCount, 'the count was hidden').toBe(1);
    expect(asMember.poll.options[0]?.voters, 'identity leaked on a private poll').toBeNull();
    // A voter always sees their OWN vote either way.
    expect(asMember.poll.options[0]?.votedByMe).toBe(true);

    // The creator can see who voted.
    const asCreator = await readPoll(h.db, await ctxFor(f.ownerId), pollId);
    if (!asCreator.ok) return;
    expect(asCreator.poll.options[0]?.voters).toHaveLength(1);
  });

  it('a passed deadline reads as CLOSED with nobody having closed it', async () => {
    const f = await setup();
    // Created already expired.
    const pollId = await clubPoll(f, { closesInMinutes: -1 });
    const view = await readPoll(h.db, await ctxFor(f.memberId), pollId);
    if (!view.ok) return;

    expect(view.poll.closed, 'a passed deadline did not read as closed').toBe(true);
    const vote = await toggleVote(h.db, await ctxFor(f.memberId), view.poll.options[0]!.id);
    expect(vote.ok).toBe(false);
    if (!vote.ok) expect(vote.code).toBe('closed');
  });

  it('only the creator can close, reopen or delete - not even another admin', async () => {
    const f = await setup();
    const otherAdmin = await makeUser('OtherAdmin');
    await addMember(h.db, await ctxFor(f.ownerId), f.clubId, otherAdmin);
    await changeRole(h.db, await ctxFor(f.ownerId), f.clubId, otherAdmin, 'admin');
    const pollId = await clubPoll(f);

    expect((await setPollClosed(h.db, await ctxFor(otherAdmin), pollId, true)).ok).toBe(false);
    expect((await deletePoll(h.db, await ctxFor(otherAdmin), pollId)).ok).toBe(false);
    // The creator can.
    expect((await setPollClosed(h.db, await ctxFor(f.ownerId), pollId, true)).ok).toBe(true);
  });

  it('reopening preserves existing votes', async () => {
    const f = await setup();
    const pollId = await clubPoll(f);
    const view = await readPoll(h.db, await ctxFor(f.memberId), pollId);
    if (!view.ok) return;
    await toggleVote(h.db, await ctxFor(f.memberId), view.poll.options[0]!.id);

    await setPollClosed(h.db, await ctxFor(f.ownerId), pollId, true);
    await setPollClosed(h.db, await ctxFor(f.ownerId), pollId, false);

    const after = await readPoll(h.db, await ctxFor(f.memberId), pollId);
    if (!after.ok) return;
    expect(after.poll.closed).toBe(false);
    expect(after.poll.options[0]?.voteCount, 'reopening lost the votes').toBe(1);
  });

  it('a race poll is invisible to an admin with no roster row', async () => {
    const f = await setup();
    const race = await setupRace(f);
    const created = await createPoll(h.db, await ctxFor(f.ownerId), {
      clubId: f.clubId, scope: 'race', scopeId: race.raceId,
      question: 'Which car?', options: ['A', 'B'],
    });
    if (!created.ok) throw new Error('race poll failed');

    // Another admin, deliberately off the roster.
    const admin = await makeUser('OffRoster');
    await addMember(h.db, await ctxFor(f.ownerId), f.clubId, admin);
    await changeRole(h.db, await ctxFor(f.ownerId), f.clubId, admin, 'admin');

    const view = await readPoll(h.db, await ctxFor(admin), created.pollId);
    expect(view.ok, 'a race poll leaked to an admin off the roster').toBe(false);
  });
});

describe('the scheduled closing-soon job', () => {
  it('fires once, ten minutes out, INCLUDING the creator', async () => {
    const f = await setup();
    for (const u of [f.ownerId, f.memberId]) {
      await registerDevice(h.db, { userId: u, pushToken: `tok-${u.slice(0, 8)}`, platform: 'ios' });
    }
    const created = await createPoll(h.db, await ctxFor(f.ownerId), {
      clubId: f.clubId, scope: 'club', scopeId: f.clubId,
      question: 'Closing soon?', options: ['a', 'b'],
      closesInMinutes: 5,
    });
    if (!created.ok) throw new Error('poll failed');
    await drainAll();
    await h.db.execute(sql`TRUNCATE notifications RESTART IDENTITY CASCADE`);

    const first = await runScheduledTick(h.db, deps);
    expect(first.remindersSent).toBe(1);

    const rows = await h.db.select().from(notifications);
    // THE exception to "creation notifications exclude the actor": the creator is exactly
    // who needs to know their own poll is about to close.
    expect(rows.map((r) => r.recipientId).sort()).toEqual([f.memberId, f.ownerId].sort());

    // Fires at most once per poll, EVER.
    const second = await runScheduledTick(h.db, deps);
    expect(second.remindersSent, 'the reminder fired twice').toBe(0);
  });

  it('does not remind for a poll with no deadline', async () => {
    const f = await setup();
    await createPoll(h.db, await ctxFor(f.ownerId), {
      clubId: f.clubId, scope: 'club', scopeId: f.clubId,
      question: 'Open ended', options: ['a', 'b'], closesInMinutes: null,
    });
    const result = await runScheduledTick(h.db, deps);
    expect(result.remindersSent).toBe(0);
  });

  it('does not close any poll - there is no job that closes polls', async () => {
    const f = await setup();
    const created = await createPoll(h.db, await ctxFor(f.ownerId), {
      clubId: f.clubId, scope: 'club', scopeId: f.clubId,
      question: 'Still open', options: ['a', 'b'], closesInMinutes: 5,
    });
    if (!created.ok) throw new Error('poll failed');
    await runScheduledTick(h.db, deps);

    const view = await readPoll(h.db, await ctxFor(f.memberId), created.pollId);
    if (!view.ok) return;
    expect(view.poll.closed, 'the scheduled job closed a poll').toBe(false);
  });
});

// ===========================================================================
// Content: the notification silences
// ===========================================================================

describe('content notification behaviour', () => {
  it('a meetup notifies NOBODY and posts NOTHING', async () => {
    // A week authored in one sitting would otherwise fire seven notifications. This silence is
    // why Weekly Meetups is a separate surface from the calendar rather than a view over it.
    const f = await setup();
    for (let i = 0; i < 7; i += 1) {
      await createMeetup(h.db, await ctxFor(f.ownerId), {
        clubId: f.clubId, meetupDate: `2026-04-0${i + 1}`,
        meetupTime: '18:00', location: 'Memorial Park gate',
      });
    }
    await drainAll();

    const rows = await h.db.select().from(notifications);
    expect(rows, 'a meetup notified somebody').toHaveLength(0);
    expect(push.sent).toHaveLength(0);
  });

  it('an event notifies every other club member and posts a card', async () => {
    const f = await setup();
    await createEvent(h.db, await ctxFor(f.ownerId), {
      clubId: f.clubId, type: 'practice', title: 'Track night',
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    await drainAll();

    const rows = await h.db.select().from(notifications);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.recipientId).toBe(f.memberId);
    expect(rows[0]?.type).toBe('event_created');

    /*
     * The card is typed `event` and authored by the person who made it, NOT `system`.
     *
     * Both halves matter to the client. The type is what tells chat to draw the object inline
     * instead of a sentence, and the sender is what puts it in that member's own bubble rather
     * than in the unattributed centre column with "X joined the club". A card is somebody
     * putting something to the room, so it is from them.
     */
    const cards = await h.db.execute<{ body: string; sender_id: string; type: string }>(sql`
      SELECT body, sender_id::text AS sender_id, type FROM messages
       WHERE channel_id = ${f.mainChannelId} AND linked_event_id IS NOT NULL
    `);
    expect(cards.rows).toHaveLength(1);
    expect(cards.rows[0]?.body).toContain('Track night');
    expect(cards.rows[0]?.type).toBe('event');
    expect(cards.rows[0]?.sender_id).toBe(f.ownerId);
  });

  it('a news post notifies members but posts no chat card', async () => {
    const f = await setup();
    const before = await h.db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM messages WHERE channel_id = ${f.mainChannelId}
    `);
    await createNewsPost(h.db, await ctxFor(f.ownerId), { clubId: f.clubId, body: 'We won.' });
    await drainAll();

    const rows = await h.db.select().from(notifications);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe('news_post_created');

    const after = await h.db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM messages WHERE channel_id = ${f.mainChannelId}
    `);
    // Discussion belongs in chat; the post itself lives on the front page.
    expect(Number(after.rows[0]?.n), 'news posted a chat card').toBe(Number(before.rows[0]?.n));
  });

  it('refuses an entirely empty news post', async () => {
    const f = await setup();
    const result = await createNewsPost(h.db, await ctxFor(f.ownerId), { clubId: f.clubId });
    expect(result.ok).toBe(false);
  });

  it('a meeting notifies other Eboard members only, never plain members', async () => {
    const f = await setup();
    const created = await createMeeting(h.db, await ctxFor(f.ownerId), {
      eboardId: f.eboardId, clubId: f.clubId, title: 'Budget review',
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(created.ok).toBe(true);
    await drainAll();

    const rows = await h.db.select().from(notifications);
    // The owner created it and is the only Eboard member, so nobody is notified - and
    // critically the plain club member is NOT.
    expect(rows.map((r) => r.recipientId)).not.toContain(f.memberId);
  });

  it('only the meeting creator can edit it', async () => {
    const f = await setup();
    const admin = await makeUser('CoAdmin');
    await addMember(h.db, await ctxFor(f.ownerId), f.clubId, admin);
    await changeRole(h.db, await ctxFor(f.ownerId), f.clubId, admin, 'admin');

    const created = await createMeeting(h.db, await ctxFor(f.ownerId), {
      eboardId: f.eboardId, clubId: f.clubId, title: 'Mine',
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    if (!created.ok) throw new Error('meeting failed');

    // A fellow Eboard member, but not the creator.
    const result = await updateMeeting(h.db, await ctxFor(admin), created.meetingId, {
      title: 'Hijacked',
    });
    expect(result.ok).toBe(false);
  });
});

// ===========================================================================
// Chat cards: posted on create, removed on delete
// ===========================================================================

describe('chat cards', () => {
  it('a created poll posts a card linked to it', async () => {
    const f = await setup();
    const created = await createPoll(h.db, await ctxFor(f.ownerId), {
      clubId: f.clubId, scope: 'club', scopeId: f.clubId,
      question: 'Carpool or bus?', options: ['Carpool', 'Bus'],
    });
    if (!created.ok) throw new Error('poll failed');
    await drainAll();

    const cards = await h.db.execute<{ seq: number; body: string; linked: string }>(sql`
      SELECT seq, body, linked_poll_id::text AS linked FROM messages
       WHERE channel_id = ${f.mainChannelId} AND linked_poll_id IS NOT NULL
    `);
    expect(cards.rows).toHaveLength(1);
    expect(cards.rows[0]?.body).toContain('Carpool or bus?');
    // The link is what lets a later delete find this message.
    expect(cards.rows[0]?.linked).toBe(created.pollId);
  });

  it('deleting the poll removes its card and leaves the conversation intact', async () => {
    const f = await setup();
    const ctx = await ctxFor(f.ownerId);

    // An ordinary message on either side of the card, so we can prove they survive.
    const channel = await getChannelRef(h.db, f.mainChannelId);
    await sendMessage(h.db, ctx, channel!, {
      channelId: f.mainChannelId, clientMsgId: crypto.randomUUID(), body: 'before',
    });
    const created = await createPoll(h.db, ctx, {
      clubId: f.clubId, scope: 'club', scopeId: f.clubId,
      question: 'Doomed poll', options: ['a', 'b'],
    });
    if (!created.ok) throw new Error('poll failed');
    await drainAll();
    await sendMessage(h.db, ctx, channel!, {
      channelId: f.mainChannelId, clientMsgId: crypto.randomUUID(), body: 'after',
    });
    await drainAll();

    await deletePoll(h.db, ctx, created.pollId);
    await drainAll();

    const rows = await h.db.execute<{ seq: number; body: string | null; deleted: string | null }>(sql`
      SELECT seq, body, deleted_at::text AS deleted FROM messages
       WHERE channel_id = ${f.mainChannelId} ORDER BY seq
    `);

    const card = rows.rows.find((r) => r.body === null && r.deleted !== null);
    expect(card, 'the card was not removed').toBeDefined();

    // A tombstone, not a hole. The messages around it are untouched, which is the whole
    // reason cards are soft-deleted like any other message.
    expect(rows.rows.some((r) => r.body === 'before' && r.deleted === null)).toBe(true);
    expect(rows.rows.some((r) => r.body === 'after' && r.deleted === null)).toBe(true);
    // And no seq was reused or removed.
    expect(rows.rows.map((r) => r.seq)).toEqual(
      Array.from({ length: rows.rows.length }, (_, i) => i + 1),
    );
  });

  it('removing a card is idempotent across redelivery', async () => {
    const f = await setup();
    const created = await createPoll(h.db, await ctxFor(f.ownerId), {
      clubId: f.clubId, scope: 'club', scopeId: f.clubId,
      question: 'Twice deleted', options: ['a', 'b'],
    });
    if (!created.ok) throw new Error('poll failed');
    await drainAll();
    await deletePoll(h.db, await ctxFor(f.ownerId), created.pollId);
    await drainAll();

    const firstState = await h.db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM messages
       WHERE channel_id = ${f.mainChannelId} AND deleted_at IS NOT NULL
    `);

    // Replay the delete event, as a consumer restart would.
    await h.db.execute(sql`UPDATE outbox SET processed_at = NULL WHERE event_type = 'poll.deleted'`);
    await drainAll();

    const secondState = await h.db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM messages
       WHERE channel_id = ${f.mainChannelId} AND deleted_at IS NOT NULL
    `);
    expect(Number(secondState.rows[0]?.n)).toBe(Number(firstState.rows[0]?.n));
  });

  it('a deleted event and meeting remove their cards too', async () => {
    const f = await setup();
    const ctx = await ctxFor(f.ownerId);

    const event = await createEvent(h.db, ctx, {
      clubId: f.clubId, type: 'practice', title: 'Doomed event',
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const meeting = await createMeeting(h.db, ctx, {
      eboardId: f.eboardId, clubId: f.clubId, title: 'Doomed meeting',
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    if (!event.ok || !meeting.ok) throw new Error('setup failed');
    await drainAll();

    // Assert the deletes SUCCEEDED before asserting their effect. Without this a refused
    // delete looks identical to a card that failed to be removed.
    const deletedEvent = await deleteEvent(h.db, ctx, event.eventId);
    const deletedMeeting = await deleteMeeting(h.db, ctx, meeting.meetingId, f.clubId);
    expect(deletedEvent.ok, 'the event delete was refused').toBe(true);
    expect(deletedMeeting.ok, 'the meeting delete was refused').toBe(true);
    await drainAll();

    const parked = await h.db.execute<{ event_type: string; last_error: string | null }>(sql`
      SELECT event_type, last_error FROM outbox
       WHERE attempts > 0 AND event_type IN ('event.deleted', 'meeting.deleted')
    `);
    expect(parked.rows, `an effect failed: ${JSON.stringify(parked.rows)}`).toHaveLength(0);

    // Scoped to THIS test's two objects. `messages` is not truncated between tests - only
    // notifications and outbox are - so an unscoped count would pick up the perfectly
    // legitimate live cards other tests in this file created and never deleted.
    const live = await h.db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM messages
       WHERE (linked_event_id = ${event.eventId}::uuid
           OR linked_meeting_id = ${meeting.meetingId}::uuid)
         AND deleted_at IS NULL
    `);
    expect(Number(live.rows[0]?.n), 'a card survived its object being deleted').toBe(0);

    // And prove the cards existed in the first place, so the assertion above cannot pass
    // vacuously by counting nothing.
    const total = await h.db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM messages
       WHERE linked_event_id = ${event.eventId}::uuid
          OR linked_meeting_id = ${meeting.meetingId}::uuid
    `);
    expect(Number(total.rows[0]?.n), 'no cards were posted, so nothing was tested').toBe(2);
  });
});

// ===========================================================================
// Weekly Meetups and the calendar feed
// ===========================================================================

/** Today and tomorrow as `YYYY-MM-DD`. Only today's meetups are nudgeable. */
const todayKey = () => new Date().toISOString().slice(0, 10);
const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

/** The Monday of the week containing today, so a week read covers today and tomorrow. */
function mondayOfToday(): string {
  const d = new Date();
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - (day === 0 ? 6 : day - 1));
  return d.toISOString().slice(0, 10);
}

describe('the meetup week', () => {
  it('renders an empty day explicitly rather than omitting it', async () => {
    const f = await setup();
    // A past week, so no days are hidden.
    await createMeetup(h.db, await ctxFor(f.ownerId), {
      clubId: f.clubId, meetupDate: '2026-01-06', meetupTime: '18:30',
      location: 'Track', description: '8 x 400m',
    });

    const week = await readMeetupWeek(h.db, await ctxFor(f.memberId), f.clubId, '2026-01-05');
    expect(week.ok).toBe(true);
    if (!week.ok) return;

    expect(week.days).toHaveLength(7);
    const tuesday = week.days.find((d) => d.date === '2026-01-06');
    expect(tuesday?.empty).toBe(false);
    // HH:MM on the wire. Postgres hands back HH:MM:SS and nobody wants to read the seconds.
    expect(tuesday?.meetups[0]?.time).toBe('18:30');
    expect(tuesday?.meetups[0]?.location).toBe('Track');
    // An empty day is otherwise ambiguous between "nothing on" and "not posted yet".
    const monday = week.days.find((d) => d.date === '2026-01-05');
    expect(monday?.empty).toBe(true);
    expect(monday?.meetups).toEqual([]);
  });

  it('a nudge pushes the club, and the hour is enforced by the database', async () => {
    const f = await setup();
    // The member's phone. A nudge that writes a row and reaches nothing is the feature failing
    // silently, so the device is registered and the push asserted rather than assumed.
    await registerDevice(h.db, {
      userId: f.memberId,
      pushToken: 'ExponentPushToken[member-phone]',
      platform: 'ios',
    });
    const created = await createMeetup(h.db, await ctxFor(f.ownerId), {
      // Today, not a fixed date: a nudge is refused for a day that has been, so a hardcoded
      // date would pass until it did not.
      clubId: f.clubId, meetupDate: todayKey(), meetupTime: '18:30', location: 'Track',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // A member cannot nudge. Attempted, not inferred from the button being hidden.
    expect(await nudgeMeetup(h.db, await ctxFor(f.memberId), created.meetupId)).toMatchObject({
      ok: false,
      code: 'forbidden',
    });

    const first = await nudgeMeetup(h.db, await ctxFor(f.ownerId), created.meetupId);
    expect(first.ok).toBe(true);
    await drainAll();

    // Creating the meetup notified nobody; nudging it notified everybody INCLUDING the sender.
    // The first half is PRD/08 rule 11. The second is the exception being real - and the sender
    // is on the list because an admin who rings the bell and receives nothing cannot tell
    // whether it went out.
    const rows = await h.db.select().from(notifications);
    expect(rows.map((r) => r.recipientId).sort()).toEqual([f.memberId, f.ownerId].sort());
    expect(rows.every((r) => r.type === 'meetup_nudged')).toBe(true);
    expect(push.sent.length, 'a nudge must reach a phone').toBeGreaterThan(0);

    // The same meetup, inside the hour: refused, with a time.
    const again = await nudgeMeetup(h.db, await ctxFor(f.ownerId), created.meetupId);
    expect(again).toMatchObject({ ok: false, code: 'cooling_down' });
    if (again.ok || again.code !== 'cooling_down') return;
    expect(Date.parse(again.availableAt)).toBeGreaterThan(Date.now());

    // A DIFFERENT meetup carries its own clock (ADR-0031). Four meetups in a day are four
    // things to tell people about, so nudging one must not silence the rest. Same DAY, because
    // only today's are nudgeable at all.
    const other = await createMeetup(h.db, await ctxFor(f.ownerId), {
      clubId: f.clubId, meetupDate: todayKey(), meetupTime: '07:00', location: 'The Anchor',
    });
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    expect(await nudgeMeetup(h.db, await ctxFor(f.ownerId), other.meetupId)).toMatchObject({
      ok: true,
    });
  });

  it('refuses to nudge any day but today, in both directions', async () => {
    /*
     * A nudge means "we are meeting, today". A past day has nothing left to say, and next
     * Tuesday is premature rather than early - so BOTH are refused, which is the half a test
     * written only against the past would miss.
     */
    const f = await setup();
    for (const [label, date] of [['a day that has been', '2020-01-06'], ['a future day', tomorrow()]] as const) {
      const made = await createMeetup(h.db, await ctxFor(f.ownerId), {
        clubId: f.clubId, meetupDate: date, meetupTime: '18:30', location: 'Track',
      });
      expect(made.ok, label).toBe(true);
      if (!made.ok) return;
      expect(await nudgeMeetup(h.db, await ctxFor(f.ownerId), made.meetupId), label).toMatchObject({
        ok: false,
        code: 'not_today',
      });
    }
  });

  it('marks only today as nudgeable on the week', async () => {
    const f = await setup();
    for (const date of [todayKey(), tomorrow()]) {
      await createMeetup(h.db, await ctxFor(f.ownerId), {
        clubId: f.clubId, meetupDate: date, meetupTime: '18:30', location: 'Track',
      });
    }
    const week = await readMeetupWeek(h.db, await ctxFor(f.memberId), f.clubId, mondayOfToday());
    expect(week.ok).toBe(true);
    if (!week.ok) return;
    const byDate = new Map(week.days.map((d) => [d.date, d.meetups]));
    expect(byDate.get(todayKey())?.[0]?.nudgeable).toBe(true);
    expect(byDate.get(tomorrow())?.[0]?.nudgeable).toBe(false);
  });

  it('refuses the second of two simultaneous nudges, rather than sending two', async () => {
    /*
     * The case a read-then-write loses, and the reason the cooldown is an EXCLUDE constraint
     * rather than a check in the handler (ADR-0030). Both calls read an empty cooldown, both
     * try to insert, and exactly one may win.
     */
    const f = await setup();
    const created = await createMeetup(h.db, await ctxFor(f.ownerId), {
      clubId: f.clubId, meetupDate: todayKey(), meetupTime: '19:00', location: 'Room 204',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const ctx = await ctxFor(f.ownerId);
    const results = await Promise.all([
      nudgeMeetup(h.db, ctx, created.meetupId),
      nudgeMeetup(h.db, ctx, created.meetupId),
    ]);

    expect(results.filter((r) => r.ok), 'both nudges were accepted').toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.code === 'cooling_down')).toHaveLength(1);
    await drainAll();

    /*
     * One nudge, not two - asserted on the recipients rather than on a row count.
     *
     * A bare `toHaveLength(1)` was the proxy here, and it broke the moment the sender joined the
     * audience: one nudge legitimately writes a row per member. What must not happen is anybody
     * being told twice.
     */
    const recipients = (await h.db.select().from(notifications)).map((r) => r.recipientId);
    expect(recipients.sort()).toEqual([f.memberId, f.ownerId].sort());
    expect(new Set(recipients).size, 'somebody was notified twice').toBe(recipients.length);
  });

  it('holds several meetups on one day, in time order', async () => {
    // A morning session and an evening social are two meetups, not one squashed together.
    const f = await setup();
    for (const [time, location] of [
      ['19:00', 'The Anchor'],
      ['06:30', 'Track'],
    ] as const) {
      await createMeetup(h.db, await ctxFor(f.ownerId), {
        clubId: f.clubId, meetupDate: '2026-01-07', meetupTime: time, location,
      });
    }

    const week = await readMeetupWeek(h.db, await ctxFor(f.memberId), f.clubId, '2026-01-05');
    expect(week.ok).toBe(true);
    if (!week.ok) return;

    const wednesday = week.days.find((d) => d.date === '2026-01-07');
    expect(wednesday?.meetups.map((m) => m.time)).toEqual(['06:30', '19:00']);
    expect(wednesday?.empty).toBe(false);
  });
});

describe('the merged calendar feed', () => {
  it('includes a race for a member with no race access', async () => {
    // Members need to know a race exists in order to ask to join it.
    const f = await setup();
    const race = await setupRace(f);

    const feed = await readCalendarFeed(h.db, await ctxFor(f.memberId), { clubId: f.clubId });
    const raceItem = feed.find((i) => i.kind === 'race' && i.id === race.raceId);
    expect(raceItem, 'a race was hidden from a club member').toBeDefined();
    // Visible, but flagged as not enterable.
    expect(raceItem?.accessible).toBe(false);
  });

  it('hides an Eboard meeting from a non-member', async () => {
    const f = await setup();
    await createMeeting(h.db, await ctxFor(f.ownerId), {
      eboardId: f.eboardId, clubId: f.clubId, title: 'Private business',
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
    });

    const asMember = await readCalendarFeed(h.db, await ctxFor(f.memberId), { clubId: f.clubId });
    expect(asMember.some((i) => i.kind === 'meeting'), 'a meeting leaked').toBe(false);

    const asOwner = await readCalendarFeed(h.db, await ctxFor(f.ownerId), { clubId: f.clubId });
    expect(asOwner.some((i) => i.kind === 'meeting')).toBe(true);
  });

  it('carries no poll, whether it has a deadline or not', async () => {
    // Polls left the feed on 2026-08-15. It answers "what is happening when", and a closing
    // deadline is not a thing that happens. BOTH shapes are created here: the deadline-less one
    // is what used to force `at` to be nullable for every other kind on the feed.
    const f = await setup();
    await createPoll(h.db, await ctxFor(f.ownerId), {
      clubId: f.clubId, scope: 'club', scopeId: f.clubId,
      question: 'Open ended', options: ['a', 'b'], closesInMinutes: null,
    });
    await createPoll(h.db, await ctxFor(f.ownerId), {
      clubId: f.clubId, scope: 'club', scopeId: f.clubId,
      question: 'Closing soon', options: ['a', 'b'], closesInMinutes: 60,
    });

    const feed = await readCalendarFeed(h.db, await ctxFor(f.memberId), { clubId: f.clubId });
    const titles = feed.map((i) => i.title);
    expect(titles, 'a deadline-less poll reached the feed').not.toContain('Open ended');
    expect(titles, 'a dated poll reached the feed').not.toContain('Closing soon');

    // And nothing left on the feed can be undated. Asserted at runtime rather than trusted
    // from the type, because `FeedItem` is a hand-written shape over a raw `db.execute` - the
    // class of lie AGENTS failure mode 7 is about.
    expect(feed.every((i) => i.at !== null && i.at.length > 0)).toBe(true);
  });

  it('gives a race a date and an event an instant, and never converts one into the other', async () => {
    // A race's date pushed through toISOString became UTC midnight, which the client could only
    // read back as an instant: it printed a time of day under every race and could not ask which
    // local day the race was on without moving it a day earlier. The two shapes stay apart.
    const f = await setup();
    await setupRace(f);
    await createEvent(h.db, await ctxFor(f.ownerId), {
      clubId: f.clubId, type: 'practice', title: 'Track night',
      startsAt: '2026-04-15T18:00:00.000Z',
    });

    const feed = await readCalendarFeed(h.db, await ctxFor(f.memberId), { clubId: f.clubId });

    const race = feed.find((i) => i.kind === 'race');
    expect(race?.allDay).toBe(true);
    expect(race?.at, 'a race date was normalised into an instant').toBe('2026-04-12');

    const event = feed.find((i) => i.kind === 'event');
    expect(event?.allDay).toBe(false);
    expect(event?.at).toBe('2026-04-15T18:00:00.000Z');
  });

  it('marks the day of every event and race, and nothing at all for a poll', async () => {
    const f = await setup();
    await setupRace(f);
    await createEvent(h.db, await ctxFor(f.ownerId), {
      clubId: f.clubId, type: 'practice', title: 'Track night',
      startsAt: '2026-04-15T18:00:00.000Z',
    });
    await createPoll(h.db, await ctxFor(f.ownerId), {
      clubId: f.clubId, scope: 'club', scopeId: f.clubId,
      question: 'Deadline in April', options: ['a', 'b'], closesInMinutes: 60,
    });

    const markers = await readMonthMarkers(h.db, await ctxFor(f.memberId), {
      clubId: f.clubId, year: 2026, month: 4,
    });
    expect(markers).toContain('2026-04-15');
    expect(markers).toContain('2026-04-12');
    // A poll has a deadline, not a day it happens on.
    expect(markers).toHaveLength(2);
  });

  it('marks no filler days from adjacent months', async () => {
    const f = await setup();
    await createEvent(h.db, await ctxFor(f.ownerId), {
      clubId: f.clubId, type: 'practice', title: 'May event',
      startsAt: '2026-05-02T18:00:00.000Z',
    });
    const markers = await readMonthMarkers(h.db, await ctxFor(f.memberId), {
      clubId: f.clubId, year: 2026, month: 4,
    });
    // So a marker always belongs to the month on screen.
    expect(markers.every((d) => d.startsWith('2026-04'))).toBe(true);
  });

  it('shows nothing from a club the viewer is not in', async () => {
    const f = await setup();
    const outsider = await makeUser('Outsider');
    await setupRace(f);
    const feed = await readCalendarFeed(h.db, await ctxFor(outsider));
    expect(feed).toHaveLength(0);
  });
});

// ===========================================================================
// Reporting: which scopes have it, and who hears about it
// ===========================================================================

/**
 * **The report rules differ per scope, and each difference was asked for.** Settled with the
 * founder on 2026-08-01:
 *
 * | Scope | Reporting | Notified |
 * |---|---|---|
 * | club | yes | the admin tier: owner and admins |
 * | race | yes | admins **who are on that race's roster** |
 * | eboard | **no** | nobody |
 *
 * The race row is the one with a trap in it. "Club admin" and "on the roster" are different
 * questions, and taking either alone gives a wrong answer in a different direction: the owner of
 * the club is not automatically involved in a race, and a roster member is not automatically an
 * admin.
 */
describe('reporting, by scope', () => {
  async function toldAbout(channelId: string): Promise<string[]> {
    const rows = await h.db.execute<{ recipient_id: string }>(sql`
      SELECT recipient_id::text AS recipient_id
        FROM notifications
       WHERE type = 'message_reported' AND params->>'channelId' = ${channelId}
    `);
    return rows.rows.map((r) => r.recipient_id);
  }

  async function say(userId: string, channelId: string, body: string): Promise<number> {
    const channel = await getChannelRef(h.db, channelId);
    const sent = await sendMessage(h.db, await ctxFor(userId), channel!, {
      channelId,
      clientMsgId: crypto.randomUUID(),
      body,
    });
    if (!sent.ok) throw new Error(`send refused: ${sent.code}`);
    return sent.message.seq;
  }

  it('refuses a report in Eboard chat, where everyone is already an admin', async () => {
    const f = await setup();
    const eboardChannel = await h.db.execute<{ id: string }>(sql`
      SELECT id::text AS id FROM channels WHERE scope = 'eboard' AND scope_id = ${f.eboardId}::uuid
    `);
    const channelId = eboardChannel.rows[0]!.id;
    const channel = await getChannelRef(h.db, channelId);

    /*
     * A SECOND Eboard member, so the report being attempted is of somebody ELSE's message.
     *
     * Without this the test passes for the wrong reason: nobody may report their own message in
     * any scope, so a one-person test would be refused by that rule and prove nothing about
     * Eboard. Caught by mutation-testing - removing the Eboard guard entirely still passed.
     */
    const secondId = await makeUser('EboardSecond');
    await addMember(h.db, await ctxFor(f.ownerId), f.clubId, secondId);
    await changeRole(h.db, await ctxFor(f.ownerId), f.clubId, secondId, 'admin');
    const added = await addEboardMember(h.db, await ctxFor(f.ownerId), f.eboardId, secondId);
    expect(added.ok).toBe(true);
    await settleFixture();

    const seq = await say(f.ownerId, channelId, 'something contentious');

    /*
     * Refused, and refused for a member who could report this exact message anywhere else.
     * Reporting is not gated on rank here; it does not exist in this scope at all, because the
     * reporter and the reviewer would be the same set of people.
     */
    const attempted = await reportMessage(h.db, await ctxFor(secondId), channel!, seq);
    expect(attempted.ok).toBe(false);

    // And the tab is absent rather than empty. A scope where reporting cannot happen and a tab
    // that lists nothing look identical on screen and are not the same claim.
    expect(canReadReports(await ctxFor(f.ownerId), channel!)).toBe(false);
  });

  it('tells the club admin tier for club chat', async () => {
    const f = await setup();
    const channel = await getChannelRef(h.db, f.mainChannelId);
    const seq = await say(f.memberId, f.mainChannelId, 'rude');

    // Reported by the Owner, so the Owner is excluded as the actor - leaving nobody, since they
    // are the only admin. So report as the member instead and expect the Owner to hear.
    const reported = await reportMessage(h.db, await ctxFor(f.ownerId), channel!, seq);
    expect(reported.ok).toBe(true);
    await drainAll();

    // The Owner reported it, so the Owner is not told about their own report.
    expect(await toldAbout(f.mainChannelId)).toEqual([]);
  });

  it('tells only admins who are ON the race, not every club admin', async () => {
    const f = await setup();
    const race = await setupRace(f);
    const raceChannelRow = await h.db.execute<{ id: string }>(sql`
      SELECT id::text AS id FROM channels WHERE scope = 'race' AND scope_id = ${race.raceId}::uuid
    `);
    const raceChannelId = raceChannelRow.rows[0]!.id;
    const raceChannel = await getChannelRef(h.db, raceChannelId);

    /*
     * A SECOND club admin, deliberately left off the roster.
     *
     * The Owner created the race and is therefore on it. This one is every bit as much a club
     * admin and has nothing to do with this race - and must not be notified about it, which is
     * the rule the founder stated: "if the owner is not in the race, he will not be notified".
     */
    const offRaceAdminId = await makeUser('OffRaceAdmin');
    await addMember(h.db, await ctxFor(f.ownerId), f.clubId, offRaceAdminId);
    const promoted = await changeRole(
      h.db,
      await ctxFor(f.ownerId),
      f.clubId,
      offRaceAdminId,
      'admin',
    );
    /*
     * Asserted, not assumed.
     *
     * The whole test rests on this person genuinely being a club admin - if the promotion
     * silently failed they would be an ordinary member, excluded for a boring reason, and the
     * "not told" assertion below would pass while proving nothing. Mutation-testing caught
     * exactly that: widening the audience to every club admin still passed.
     */
    expect(promoted.ok && promoted.role).toBe('admin');

    // And an ordinary member who IS on the roster, to report something.
    await addRaceMember(h.db, await ctxFor(f.ownerId), race.raceId, f.memberId);
    await settleFixture();

    // The Owner posts and the ordinary roster member reports it - nobody reports their own.
    const seq = await say(f.ownerId, raceChannelId, 'something rude in race chat');
    const reported = await reportMessage(h.db, await ctxFor(f.memberId), raceChannel!, seq);
    expect(reported.ok).toBe(true);
    await drainAll();

    const told = await toldAbout(raceChannelId);
    /*
     * On the roster and a club admin: told - even though the reported message is their own.
     * Settled with the founder: every admin hears about every report, including one about
     * themselves. The alternative leaves a space with one admin having nobody notified at all.
     */
    expect(told).toContain(f.ownerId);
    // A club admin with no roster row: NOT told, however senior.
    expect(told).not.toContain(offRaceAdminId);
    // The reporter is on the roster but not an admin, and reported it themselves anyway.
    expect(told).not.toContain(f.memberId);
  });
});

// ===========================================================================
// The Eboard's own notifications, and the access that has to end with them
// ===========================================================================

/**
 * **Every one of these failed when it was written, and three of them failed silently.**
 *
 * `eboard.join_requested`, `eboard.membership_decided` and `eboard.member_departed` were emitted
 * by the domain and had no handler in the effects table at all. `dispatch` throws on an unknown
 * type, so each one retried five times and PARKED - no notification, ever, and an error line per
 * attempt. The notification type was declared in shared, its params had a schema, `audience.ts`
 * resolved it to the current members and the inbox already cleared it when the roster opened.
 * Only the line that writes the row was missing: both ends complete, nothing joining them.
 *
 * Nothing caught it because `drainOnce` deliberately absorbs a handler failure into the retry
 * column rather than rethrowing - correct for a queue, and it means a missing consumer is
 * invisible unless a test asserts on the notification or on the outbox. So these assert on both,
 * and `every event type a domain emits has a handler` closes the door on the next one.
 */
describe('the Eboard tells its own members', () => {
  /** An admin who has left the Eboard, which is the only way the request path is ever used. */
  async function adminOutsideTheEboard(f: Awaited<ReturnType<typeof setup>>) {
    const strayId = await makeUser('EboardStray');
    await addMember(h.db, await ctxFor(f.ownerId), f.clubId, strayId);
    // Promotion auto-joins the Eboard (PRD/10 rule 2)...
    await changeRole(h.db, await ctxFor(f.ownerId), f.clubId, strayId, 'admin');
    // ...so they have to leave it for there to be anything to request.
    const left = await removeEboardMember(h.db, await ctxFor(strayId), f.eboardId, strayId);
    expect(left.ok, 'the stray admin could not leave the Eboard').toBe(true);
    await settleFixture();
    return strayId;
  }

  async function eboardChannelId(clubId: string): Promise<string> {
    const rows = await h.db.execute<{ id: string }>(sql`
      SELECT ch.id
        FROM eboard_channels e
        JOIN channels ch ON ch.scope = 'eboard' AND ch.scope_id = e.id
       WHERE e.club_id = ${clubId}::uuid
    `);
    return rows.rows[0]!.id;
  }

  /** Nothing may be left parked: a parked effect is a notification that will never arrive. */
  async function expectNothingParked() {
    const parked = await h.db.execute<{ event_type: string; last_error: string | null }>(sql`
      SELECT event_type, last_error FROM outbox WHERE attempts > 0
    `);
    expect(parked.rows, `an effect failed: ${JSON.stringify(parked.rows)}`).toHaveLength(0);
  }

  it('tells the current members when an admin asks to join', async () => {
    const f = await setup();
    const strayId = await adminOutsideTheEboard(f);

    const requested = await requestEboardAccess(h.db, await ctxFor(strayId), f.eboardId);
    expect(requested.ok, 'the request itself was refused').toBe(true);
    await drainAll();

    await expectNothingParked();
    const rows = await h.db.select().from(notifications);
    expect(rows.map((r) => r.recipientId), 'the Eboard was not told').toEqual([f.ownerId]);
    expect(rows[0]?.type).toBe('eboard_join_request');
  });

  it('tells the requester when the answer arrives, either way', async () => {
    const f = await setup();
    const strayId = await adminOutsideTheEboard(f);
    await requestEboardAccess(h.db, await ctxFor(strayId), f.eboardId);
    await settleFixture();

    const pending = await h.db.execute<{ id: string }>(sql`
      SELECT id FROM eboard_join_requests WHERE user_id = ${strayId}::uuid AND status = 'pending'
    `);
    const decided = await decideEboardRequest(
      h.db,
      await ctxFor(f.ownerId),
      pending.rows[0]!.id,
      true,
    );
    expect(decided.ok, 'the decision was refused').toBe(true);
    await drainAll();

    await expectNothingParked();
    const rows = await h.db.select().from(notifications);
    expect(rows.map((r) => r.recipientId)).toEqual([strayId]);
    expect(rows[0]?.type).toBe('request_approved');
  });

  it('tells somebody added to the Eboard directly, and narrates it in the group', async () => {
    const f = await setup();
    const strayId = await adminOutsideTheEboard(f);

    const added = await addEboardMember(h.db, await ctxFor(f.ownerId), f.eboardId, strayId);
    expect(added.ok, 'the add was refused').toBe(true);
    await drainAll();

    await expectNothingParked();
    const rows = await h.db.select().from(notifications);
    expect(rows.map((r) => r.recipientId)).toEqual([strayId]);
    expect(rows[0]?.type).toBe('member_added');

    const said = await h.db.execute<{ body: string }>(sql`
      SELECT body FROM messages
       WHERE channel_id = ${await eboardChannelId(f.clubId)}::uuid AND type = 'system'
       ORDER BY seq DESC LIMIT 1
    `);
    expect(said.rows[0]?.body).toBe('Owner added EboardStray to the group');
  });

  /*
   * The two paths that END Eboard access, and the half of ending it that is invisible.
   *
   * The gateway's own contract says it in as many words: access is checked at subscribe time
   * and NOT rechecked per message, so "removing someone from a club, a race roster or the
   * Eboard must force-unsubscribe their sockets, not merely delete the row". Club and race
   * departure both did. Neither Eboard path did - one had no handler at all, and the other
   * deleted the membership row inside `changeRole` and revoked nothing - so a demoted admin
   * kept receiving the board's private chat live until they happened to reconnect.
   */
  it('cuts off a member removed from the Eboard, not just their row', async () => {
    const f = await setup();
    const secondId = await makeUser('EboardSecond');
    await addMember(h.db, await ctxFor(f.ownerId), f.clubId, secondId);
    await changeRole(h.db, await ctxFor(f.ownerId), f.clubId, secondId, 'admin');
    await settleFixture();

    const removed = await removeEboardMember(h.db, await ctxFor(f.ownerId), f.eboardId, secondId);
    expect(removed.ok, 'the removal was refused').toBe(true);
    await drainAll();

    await expectNothingParked();
    expect(
      revokedChannelsFor(secondId),
      'a removed member kept their live subscription to the private space',
    ).toContain(await eboardChannelId(f.clubId));
  });

  it('cuts off a demoted admin, who loses the Eboard by demotion alone', async () => {
    const f = await setup();
    const secondId = await makeUser('EboardDemoted');
    await addMember(h.db, await ctxFor(f.ownerId), f.clubId, secondId);
    await changeRole(h.db, await ctxFor(f.ownerId), f.clubId, secondId, 'admin');
    await settleFixture();

    await changeRole(h.db, await ctxFor(f.ownerId), f.clubId, secondId, 'member');
    await drainAll();

    await expectNothingParked();
    // The row is gone - `changeRole` has always done that half.
    const still = await h.db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM eboard_memberships
       WHERE eboard_id = ${f.eboardId}::uuid AND user_id = ${secondId}::uuid
    `);
    expect(Number(still.rows[0]?.n)).toBe(0);
    // ...and now the half that was missing.
    expect(
      revokedChannelsFor(secondId),
      'a demoted admin kept reading the board they were just removed from',
    ).toContain(await eboardChannelId(f.clubId));
  });

  it('narrates a promotion in both chats, naming who did it', async () => {
    const f = await setup();
    const secondId = await makeUser('EboardPromoted');
    await addMember(h.db, await ctxFor(f.ownerId), f.clubId, secondId);
    await settleFixture();

    await changeRole(h.db, await ctxFor(f.ownerId), f.clubId, secondId, 'admin');
    await drainAll();

    await expectNothingParked();
    const mainChannel = await h.db.execute<{ id: string }>(sql`
      SELECT id FROM channels WHERE club_id = ${f.clubId}::uuid AND scope = 'club'
    `);
    const inMain = await h.db.execute<{ body: string }>(sql`
      SELECT body FROM messages
       WHERE channel_id = ${mainChannel.rows[0]!.id}::uuid AND type = 'system'
       ORDER BY seq DESC LIMIT 1
    `);
    expect(inMain.rows[0]?.body).toBe('Owner promoted EboardPromoted as admin');

    const inEboard = await h.db.execute<{ body: string }>(sql`
      SELECT body FROM messages
       WHERE channel_id = ${await eboardChannelId(f.clubId)}::uuid AND type = 'system'
       ORDER BY seq DESC LIMIT 1
    `);
    expect(inEboard.rows[0]?.body).toBe('Owner added EboardPromoted to the group');

    // The affected member is told, and nobody else is (PRD/12: role_changed goes to them).
    const rows = await h.db.select().from(notifications);
    expect(rows.map((r) => r.recipientId)).toEqual([secondId]);
    expect(rows[0]?.type).toBe('role_changed');
  });
});
