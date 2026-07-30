/**
 * The race HTTP surface.
 *
 * Phase 2 built twelve race command handlers and no routes, and the permission matrix passed
 * anyway, because a matrix over pure functions cannot tell whether anything calls them. So
 * this file deliberately tests at a different altitude from `policy/matrix.test.ts`: every
 * assertion goes through `app.inject`, with a real session token, against a real database.
 *
 * The one rule it exists to keep honest is the authority-versus-access boundary. A club admin
 * manages every race in their club and gains **no** access to one, so the interesting cases
 * here are the ones where the same actor is allowed and refused on adjacent routes.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { buildApp } from '../api/app.ts';
import { createAuth, type Auth } from '../auth.ts';
import type { Config } from '../config.ts';
import { clubMemberships, users } from '../db/schema.ts';
import { FakeMediaStore } from '../media/store.ts';
import { startTestDb, type TestDb } from './harness.ts';

let h: TestDb;
let app: FastifyInstance;
let auth: Auth;

/**
 * Only the keys the API actually reads. Loading the real environment here would make the
 * suite depend on a developer's `.env`, which is the opposite of a hermetic test.
 */
const config = {
  LOG_LEVEL: 'error',
  CLIENT_ORIGIN: 'http://localhost:8081',
  BETTER_AUTH_URL: 'http://localhost:3000',
  S3_BUCKET_PUBLIC: 'identity',
  S3_BUCKET_PRIVATE: 'content',
  MEDIA_SIGNING_SECRET: 'test-signing-secret-not-real',
  MEDIA_CDN_BASE_URL: 'http://cdn.invalid/content',
  MEDIA_URL_MODE: 'cdn',
} as unknown as Config;

type Actor = { userId: string; token: string; name: string };

async function signUp(name: string): Promise<Actor> {
  const email = `${name.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}@test.invalid`;
  const result = await auth.api.signUpEmail({
    body: { name, email, password: 'correct-horse-battery-staple' },
  });
  const token = (result as { token?: string }).token;
  if (!token) throw new Error('sign-up returned no session token');
  return { userId: result.user.id, token, name };
}

/** One call as one actor. Returns the status and the parsed body, which is all any test wants. */
async function as(
  actor: Actor,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
): Promise<{ status: number; body: any }> {
  const response = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${actor.token}` },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  const text = response.body;
  return {
    status: response.statusCode,
    body: text.length > 0 ? JSON.parse(text) : null,
  };
}

/** A club with an owner, over HTTP, the way a client actually makes one. */
async function createClubAs(actor: Actor): Promise<{ clubId: string; channelId: string }> {
  const created = await as(actor, 'POST', '/clubs', {
    name: `Club ${crypto.randomUUID().slice(0, 6)}`,
    sport: 'running',
  });
  expect(created.status).toBe(201);
  return { clubId: created.body.clubId, channelId: created.body.channelId };
}

/** Put somebody in a club directly, since joining an open club is covered elsewhere. */
async function join(clubId: string, actor: Actor, role: 'member' | 'admin' = 'member') {
  await h.db.insert(clubMemberships).values({ clubId, userId: actor.userId, role });
}

beforeAll(async () => {
  h = await startTestDb();
  auth = createAuth(h.db, {
    secret: 'test-secret-not-a-real-one',
    baseURL: config.BETTER_AUTH_URL,
  });
  app = buildApp({ db: h.db, auth, config, mediaStore: new FakeMediaStore() });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close().catch(() => undefined);
  await h?.stop().catch(() => undefined);
});

describe('race routes: creation and visibility', () => {
  it('creates a race as an admin and refuses a plain member', async () => {
    const owner = await signUp('RaceOwner');
    const member = await signUp('RaceMember');
    const { clubId } = await createClubAs(owner);
    await join(clubId, member);

    const refused = await as(member, 'POST', `/clubs/${clubId}/races`, {
      name: 'Regionals',
      raceDate: '2026-09-12',
    });
    // 404, not 403: a refusal must not confirm what it refused.
    expect(refused.status).toBe(404);

    const created = await as(owner, 'POST', `/clubs/${clubId}/races`, {
      name: 'Regionals',
      raceDate: '2026-09-12',
    });
    expect(created.status).toBe(201);
    expect(created.body.raceId).toBeTruthy();
    expect(created.body.channelId).toBeTruthy();
  });

  it('rejects a date that is not a plain calendar day', async () => {
    const owner = await signUp('DateOwner');
    const { clubId } = await createClubAs(owner);

    // A timestamp would be parsed as UTC midnight and render a day early in a
    // negative-offset timezone, which is the bug the DATE column exists to prevent.
    const bad = await as(owner, 'POST', `/clubs/${clubId}/races`, {
      name: 'Bad date',
      raceDate: '2026-09-12T00:00:00Z',
    });
    expect(bad.status).toBe(400);
  });

  it('shows every club member that a race exists, with their own access state', async () => {
    const owner = await signUp('ListOwner');
    const member = await signUp('ListMember');
    const outsider = await signUp('ListOutsider');
    const { clubId } = await createClubAs(owner);
    await join(clubId, member);

    await as(owner, 'POST', `/clubs/${clubId}/races`, {
      name: 'Visible race',
      raceDate: '2026-10-01',
    });

    // Rule 2: every club member sees every race, whether or not they can enter it.
    const asMember = await as(member, 'GET', `/clubs/${clubId}/races`);
    expect(asMember.status).toBe(200);
    expect(asMember.body.races).toHaveLength(1);
    expect(asMember.body.races[0].hasAccess).toBe(false);
    expect(asMember.body.races[0].isManager).toBe(false);
    // Withheld without access, so a preview screen cannot navigate into the chat.
    expect(asMember.body.races[0].channelId).toBeNull();

    // The creator is on the roster, because creating a race gives the creator the access
    // that managing it does not.
    const asOwner = await as(owner, 'GET', `/clubs/${clubId}/races`);
    expect(asOwner.body.races[0].hasAccess).toBe(true);
    expect(asOwner.body.races[0].isManager).toBe(true);
    expect(asOwner.body.races[0].channelId).toBeTruthy();

    // Somebody in no club at all learns nothing, including whether the club exists.
    const asOutsider = await as(outsider, 'GET', `/clubs/${clubId}/races`);
    expect(asOutsider.status).toBe(404);
  });

  it('serves Meet Information to a club member with no race access', async () => {
    const owner = await signUp('MeetOwner');
    const member = await signUp('MeetMember');
    const outsider = await signUp('MeetOutsider');
    const { clubId } = await createClubAs(owner);
    await join(clubId, member);

    const created = await as(owner, 'POST', `/clubs/${clubId}/races`, {
      name: 'Meet race',
      raceDate: '2026-11-02',
    });
    const raceId = created.body.raceId;

    const saved = await as(owner, 'PATCH', `/races/${raceId}/meet-information`, {
      meetDescription: 'Leaving at 6am',
      meetHotelUrl: 'https://hotel.example/booking',
    });
    expect(saved.status).toBe(200);

    // Rule 13: readable by any club member, because it is what they need in order to
    // decide whether to ask to go.
    const preview = await as(member, 'GET', `/races/${raceId}`);
    expect(preview.status).toBe(200);
    expect(preview.body.race.meetDescription).toBe('Leaving at 6am');
    expect(preview.body.race.viewer.hasAccess).toBe(false);
    expect(preview.body.race.viewer.channelId).toBeNull();

    // The five fields are one form: writing two of them cleared the other three.
    expect(preview.body.race.meetLocationUrl).toBeNull();
    expect(preview.body.race.meetPhotosUrl).toBeNull();

    expect((await as(outsider, 'GET', `/races/${raceId}`)).status).toBe(404);
    // And a non-manager cannot write it.
    expect(
      (await as(member, 'PATCH', `/races/${raceId}/meet-information`, { meetDescription: 'no' }))
        .status,
    ).toBe(404);
  });
});

describe('race routes: the authority-versus-access boundary', () => {
  it('lets a manager with no roster row manage the roster and refuses them the race itself', async () => {
    const owner = await signUp('BoundaryOwner');
    const admin = await signUp('BoundaryAdmin');
    const member = await signUp('BoundaryMember');
    const { clubId } = await createClubAs(owner);
    await join(clubId, admin, 'admin');
    await join(clubId, member);

    const created = await as(owner, 'POST', `/clubs/${clubId}/races`, {
      name: 'Boundary race',
      raceDate: '2026-12-05',
    });
    const raceId = created.body.raceId;
    const channelId = created.body.channelId;

    // The admin holds full management authority and no roster row.
    const added = await as(admin, 'POST', `/races/${raceId}/members`, {
      userId: member.userId,
    });
    expect(added.status).toBe(200);

    // ...and can read the roster, which is the one race read authority does grant (rule 5).
    const roster = await as(admin, 'GET', `/races/${raceId}/members`);
    expect(roster.status).toBe(200);
    expect(roster.body.members.map((m: { userId: string }) => m.userId)).toContain(member.userId);
    // A manager sees who is waiting, because they are the one who decides.
    expect(roster.body.pendingRequests).toEqual([]);

    // ...and is refused the race's own content. Both answers are correct at once, which is
    // the whole point of the boundary.
    expect((await as(admin, 'GET', `/races/${raceId}/car-groups`)).status).toBe(404);
    expect((await as(admin, 'GET', `/channels/${channelId}/messages`)).status).toBe(404);

    // A plain race member reads the roster but not the pending requests: null rather than
    // an empty list, so "not allowed to see this" cannot be read as "nobody is waiting".
    const asMember = await as(member, 'GET', `/races/${raceId}/members`);
    expect(asMember.status).toBe(200);
    expect(asMember.body.pendingRequests).toBeNull();
  });

  it('refuses to seat a manager who is not on the roster in a car', async () => {
    const owner = await signUp('CarOwner');
    const admin = await signUp('CarAdmin');
    const { clubId } = await createClubAs(owner);
    await join(clubId, admin, 'admin');

    const created = await as(owner, 'POST', `/clubs/${clubId}/races`, {
      name: 'Car race',
      raceDate: '2027-01-10',
    });
    const raceId = created.body.raceId;

    const group = await as(admin, 'POST', `/races/${raceId}/car-groups`);
    expect(group.status).toBe(201);
    // Auto-numbered, with no name in the request.
    expect(group.body.number).toBe(1);

    // The clearest expression of authority not being access: they manage the groups and
    // cannot be put in one.
    const seated = await as(admin, 'POST', `/car-groups/${group.body.groupId}/members`, {
      userId: admin.userId,
    });
    expect(seated.status).toBe(404);

    // The owner is on the roster, so they can be.
    const ownerSeated = await as(admin, 'POST', `/car-groups/${group.body.groupId}/members`, {
      userId: owner.userId,
    });
    expect(ownerSeated.status).toBe(200);

    // One group per person per race, enforced by the database rather than by this handler.
    const second = await as(admin, 'POST', `/races/${raceId}/car-groups`);
    const twice = await as(admin, 'POST', `/car-groups/${second.body.groupId}/members`, {
      userId: owner.userId,
    });
    expect(twice.status).toBe(409);
  });

  it('refuses an Incharge who is not in that group', async () => {
    const owner = await signUp('InchargeOwner');
    const other = await signUp('InchargeOther');
    const { clubId } = await createClubAs(owner);
    await join(clubId, other);

    const created = await as(owner, 'POST', `/clubs/${clubId}/races`, {
      name: 'Incharge race',
      raceDate: '2027-02-14',
    });
    const raceId = created.body.raceId;
    await as(owner, 'POST', `/races/${raceId}/members`, { userId: other.userId });

    const group = await as(owner, 'POST', `/races/${raceId}/car-groups`);
    const groupId = group.body.groupId;

    // On the race roster, not in this car. The one person everyone calls when the car does
    // not show up must actually be in it.
    const wrong = await as(owner, 'PATCH', `/car-groups/${groupId}/incharge`, {
      userId: other.userId,
    });
    expect(wrong.status).toBe(409);

    await as(owner, 'POST', `/car-groups/${groupId}/members`, { userId: other.userId });
    const right = await as(owner, 'PATCH', `/car-groups/${groupId}/incharge`, {
      userId: other.userId,
    });
    expect(right.status).toBe(200);
    expect(right.body.inchargeUserId).toBe(other.userId);

    const groups = await as(owner, 'GET', `/races/${raceId}/car-groups`);
    expect(groups.body.groups).toHaveLength(1);
    expect(groups.body.groups[0].members).toHaveLength(1);
    expect(groups.body.groups[0].members[0].isIncharge).toBe(true);
    // The owner is on the roster and in no group, which is rule 16's add-member search.
    expect(groups.body.unassigned.map((u: { userId: string }) => u.userId)).toEqual([
      owner.userId,
    ]);

    // Clearing is a null, not a missing field.
    const cleared = await as(owner, 'PATCH', `/car-groups/${groupId}/incharge`, { userId: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.inchargeUserId).toBeNull();
  });
});

describe('race routes: requests and pins', () => {
  it('files a request, shows it as pending, and lets a manager approve it', async () => {
    const owner = await signUp('ReqOwner');
    const member = await signUp('ReqMember');
    const { clubId } = await createClubAs(owner);
    await join(clubId, member);

    const created = await as(owner, 'POST', `/clubs/${clubId}/races`, {
      name: 'Request race',
      raceDate: '2027-03-20',
    });
    const raceId = created.body.raceId;

    const filed = await as(member, 'POST', `/races/${raceId}/join-requests`);
    expect(filed.status).toBe(201);

    // The row and the preview both say "Requested".
    const listed = await as(member, 'GET', `/clubs/${clubId}/races`);
    expect(listed.body.races[0].requestPending).toBe(true);
    const detail = await as(member, 'GET', `/races/${raceId}`);
    expect(detail.body.race.viewer.requestPending).toBe(true);

    // Filing twice is a refusal rather than a second row.
    expect((await as(member, 'POST', `/races/${raceId}/join-requests`)).status).toBe(409);

    const roster = await as(owner, 'GET', `/races/${raceId}/members`);
    const requestId = roster.body.pendingRequests[0].requestId;
    expect(roster.body.pendingRequests[0].userId).toBe(member.userId);

    // A different club member cannot decide it.
    const bystander = await signUp('ReqBystander');
    await join(clubId, bystander);
    expect(
      (await as(bystander, 'POST', `/race-join-requests/${requestId}/approve`)).status,
    ).toBe(404);

    const approved = await as(owner, 'POST', `/race-join-requests/${requestId}/approve`);
    expect(approved.status).toBe(200);
    expect(approved.body.decided).toBe(true);

    // Now they have access, and the channel id appears.
    const after = await as(member, 'GET', `/races/${raceId}`);
    expect(after.body.race.viewer.hasAccess).toBe(true);
    expect(after.body.race.viewer.channelId).toBeTruthy();
    expect(after.body.race.viewer.requestPending).toBe(false);

    // Deciding again is idempotent rather than a second membership.
    const again = await as(owner, 'POST', `/race-join-requests/${requestId}/approve`);
    expect(again.body.decided).toBe(false);
  });

  it('pins a race for the pinner alone', async () => {
    const owner = await signUp('PinOwner');
    const member = await signUp('PinMember');
    const { clubId } = await createClubAs(owner);
    await join(clubId, member);

    const created = await as(owner, 'POST', `/clubs/${clubId}/races`, {
      name: 'Pinned race',
      raceDate: '2027-04-04',
    });
    const raceId = created.body.raceId;

    // Rule 22: any member can pin any race they can see, with no admin gate and no race
    // access needed.
    const pinned = await as(member, 'POST', `/races/${raceId}/pin`, { pinned: true });
    expect(pinned.status).toBe(200);

    expect((await as(member, 'GET', `/clubs/${clubId}/races`)).body.races[0].pinned).toBe(true);
    // Rule 21: it affects nobody else's hub.
    expect((await as(owner, 'GET', `/clubs/${clubId}/races`)).body.races[0].pinned).toBe(false);

    const unpinned = await as(member, 'POST', `/races/${raceId}/pin`, { pinned: false });
    expect(unpinned.status).toBe(200);
    expect((await as(member, 'GET', `/clubs/${clubId}/races`)).body.races[0].pinned).toBe(false);
  });

  it('lets a member leave, and refuses one member removing another', async () => {
    const owner = await signUp('LeaveOwner');
    const a = await signUp('LeaveA');
    const b = await signUp('LeaveB');
    const { clubId } = await createClubAs(owner);
    await join(clubId, a);
    await join(clubId, b);

    const created = await as(owner, 'POST', `/clubs/${clubId}/races`, {
      name: 'Leave race',
      raceDate: '2027-05-05',
    });
    const raceId = created.body.raceId;
    await as(owner, 'POST', `/races/${raceId}/members`, { userId: a.userId });
    await as(owner, 'POST', `/races/${raceId}/members`, { userId: b.userId });

    // One race member cannot remove another: that is a manager's business.
    expect((await as(a, 'DELETE', `/races/${raceId}/members/${b.userId}`)).status).toBe(404);

    // Their own row is their own business.
    expect((await as(a, 'DELETE', `/races/${raceId}/members/${a.userId}`)).status).toBe(200);
    const roster = await as(owner, 'GET', `/races/${raceId}/members`);
    expect(roster.body.members.map((m: { userId: string }) => m.userId)).not.toContain(a.userId);

    // And a manager can remove somebody else.
    expect((await as(owner, 'DELETE', `/races/${raceId}/members/${b.userId}`)).status).toBe(200);
  });

  it('deletes a race only for a manager', async () => {
    const owner = await signUp('DelOwner');
    const member = await signUp('DelMember');
    const { clubId } = await createClubAs(owner);
    await join(clubId, member);

    const created = await as(owner, 'POST', `/clubs/${clubId}/races`, {
      name: 'Doomed race',
      raceDate: '2027-06-06',
    });
    const raceId = created.body.raceId;
    await as(owner, 'POST', `/races/${raceId}/members`, { userId: member.userId });

    expect((await as(member, 'DELETE', `/races/${raceId}`)).status).toBe(404);

    const deleted = await as(owner, 'DELETE', `/races/${raceId}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body.channelIds).toHaveLength(1);
    expect((await as(owner, 'GET', `/races/${raceId}`)).status).toBe(404);
  });
});

describe('race routes: the session boundary', () => {
  it('refuses every race route without a session', async () => {
    const owner = await signUp('AnonOwner');
    const { clubId } = await createClubAs(owner);
    const created = await as(owner, 'POST', `/clubs/${clubId}/races`, {
      name: 'Guarded race',
      raceDate: '2027-07-07',
    });
    const raceId = created.body.raceId;

    for (const [method, url] of [
      ['GET', `/clubs/${clubId}/races`],
      ['POST', `/clubs/${clubId}/races`],
      ['GET', `/races/${raceId}`],
      ['GET', `/races/${raceId}/members`],
      ['GET', `/races/${raceId}/car-groups`],
      ['POST', `/races/${raceId}/pin`],
      ['DELETE', `/races/${raceId}`],
    ] as const) {
      const response = await app.inject({ method, url, payload: {} });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('refuses a signed-in account whose sign-in has been blocked', async () => {
    const deleted = await signUp('BlockedActor');
    const { clubId } = await createClubAs(deleted);

    // Blocking does not invalidate an already-issued token, so the hook has to catch it.
    await h.db
      .update(users)
      .set({ signinBlockedAt: new Date() })
      .where(eq(users.id, deleted.userId));

    expect((await as(deleted, 'GET', `/clubs/${clubId}/races`)).status).toBe(401);
  });
});

describe('race routes: club scoping', () => {
  it('never serves a race to a member of a different club', async () => {
    const ownerA = await signUp('ScopeOwnerA');
    const ownerB = await signUp('ScopeOwnerB');
    const { clubId: clubA } = await createClubAs(ownerA);
    const { clubId: clubB } = await createClubAs(ownerB);

    const created = await as(ownerA, 'POST', `/clubs/${clubA}/races`, {
      name: 'Club A race',
      raceDate: '2027-08-08',
    });
    const raceId = created.body.raceId;

    // Owner of another club: full authority over their own, none here, by direct id.
    expect((await as(ownerB, 'GET', `/races/${raceId}`)).status).toBe(404);
    expect((await as(ownerB, 'GET', `/races/${raceId}/members`)).status).toBe(404);
    expect((await as(ownerB, 'POST', `/races/${raceId}/pin`, { pinned: true })).status).toBe(404);
    expect((await as(ownerB, 'DELETE', `/races/${raceId}`)).status).toBe(404);
    expect(
      (await as(ownerB, 'POST', `/races/${raceId}/members`, { userId: ownerB.userId })).status,
    ).toBe(404);

    // And their own club's list is unaffected by the other club's races.
    const clubs_ = await as(ownerB, 'GET', `/clubs/${clubB}/races`);
    expect(clubs_.body.races).toEqual([]);
  });
});

describe('club reads, which the race add-member search needs', () => {
  it('serves the roster to a member and its pending requests to an admin only', async () => {
    const owner = await signUp('RosterOwner');
    const member = await signUp('RosterMember');
    const applicant = await signUp('RosterApplicant');
    const outsider = await signUp('RosterOutsider');
    const { clubId } = await createClubAs(owner);
    await join(clubId, member);

    // A request club, so joining files a row rather than admitting.
    expect((await as(owner, 'PATCH', `/clubs/${clubId}`, { joinPolicy: 'request' })).status).toBe(
      200,
    );
    expect((await as(applicant, 'POST', `/clubs/${clubId}/join`)).body.status).toBe('requested');

    const asOwner = await as(owner, 'GET', `/clubs/${clubId}/members`);
    expect(asOwner.status).toBe(200);
    // Owner first, then admins, then members: the roster is where authority is granted.
    expect(asOwner.body.members[0].userId).toBe(owner.userId);
    expect(asOwner.body.members[0].role).toBe('owner');
    expect(asOwner.body.pendingRequests).toHaveLength(1);
    expect(asOwner.body.pendingRequests[0].userId).toBe(applicant.userId);

    // A plain member reads the roster and gets null for the requests, which is distinct from
    // an empty list on purpose.
    const asMember = await as(member, 'GET', `/clubs/${clubId}/members`);
    expect(asMember.status).toBe(200);
    expect(asMember.body.members).toHaveLength(2);
    expect(asMember.body.pendingRequests).toBeNull();

    // Somebody outside learns nothing, including whether the club exists.
    expect((await as(outsider, 'GET', `/clubs/${clubId}/members`)).status).toBe(404);
  });

  it('withholds the invite token from everyone but the admin tier', async () => {
    const owner = await signUp('TokenOwner');
    const admin = await signUp('TokenAdmin');
    const member = await signUp('TokenMember');
    const outsider = await signUp('TokenOutsider');
    const { clubId } = await createClubAs(owner);
    await join(clubId, admin, 'admin');
    await join(clubId, member);

    // The link is the only invite mechanism, so the token is the whole of a club's access
    // control against anybody holding it.
    expect((await as(owner, 'GET', `/clubs/${clubId}`)).body.club.inviteToken).toBeTruthy();
    expect((await as(admin, 'GET', `/clubs/${clubId}`)).body.club.inviteToken).toBeTruthy();

    const asMember = await as(member, 'GET', `/clubs/${clubId}`);
    expect(asMember.status).toBe(200);
    expect(asMember.body.club.inviteToken).toBeNull();
    expect(asMember.body.club.viewer.role).toBe('member');
    expect(asMember.body.club.viewer.isAdmin).toBe(false);
    expect(asMember.body.club.memberCount).toBe(3);

    expect((await as(outsider, 'GET', `/clubs/${clubId}`)).status).toBe(404);
  });

  it('names the Eboard space only to somebody inside it', async () => {
    const owner = await signUp('EboardOwner');
    const member = await signUp('EboardMember');
    const { clubId } = await createClubAs(owner);
    await join(clubId, member);

    // The Owner is auto-joined to the Eboard when the club is created.
    expect((await as(owner, 'GET', `/clubs/${clubId}`)).body.club.eboardId).toBeTruthy();
    // An ordinary member has no visibility of the space at all, so its id is not returned.
    expect((await as(member, 'GET', `/clubs/${clubId}`)).body.club.eboardId).toBeNull();
  });
});

describe('a race has its own identity', () => {
  /*
   * `PATCH /races/:id` and `PATCH /races/:id/meet-information` sit one handler apart and obey
   * OPPOSITE rules about an absent key: here absent means "leave it alone", there it means "this
   * field is now empty". That is the trap this block is pinned against - folding them into one
   * endpoint would make the avatar upload, which sends nothing but an image, indistinguishable
   * from a form that cleared the name.
   */
  it('changes the picture without touching the name or the date', async () => {
    const owner = await signUp('PicOwner');
    const { clubId } = await createClubAs(owner);
    const created = await as(owner, 'POST', `/clubs/${clubId}/races`, {
      name: 'Maine Invitational',
      raceDate: '2026-09-15',
    });
    const raceId = created.body.raceId;

    const mediaId = crypto.randomUUID();
    expect((await as(owner, 'PATCH', `/races/${raceId}`, { image: mediaId })).status).toBe(200);

    const after = (await as(owner, 'GET', `/races/${raceId}`)).body.race;
    expect(after.image).toBe(mediaId);
    expect(after.name, 'an image-only patch renamed the race').toBe('Maine Invitational');
    expect(after.raceDate, 'an image-only patch moved the race').toBe('2026-09-15');
  });

  it('renames and re-dates without dropping the picture', async () => {
    const owner = await signUp('RenameOwner');
    const { clubId } = await createClubAs(owner);
    const created = await as(owner, 'POST', `/clubs/${clubId}/races`, {
      name: 'Old name',
      raceDate: '2026-09-15',
    });
    const raceId = created.body.raceId;
    const mediaId = crypto.randomUUID();
    await as(owner, 'PATCH', `/races/${raceId}`, { image: mediaId });

    await as(owner, 'PATCH', `/races/${raceId}`, { name: 'New name', raceDate: '2026-10-01' });

    const after = (await as(owner, 'GET', `/races/${raceId}`)).body.race;
    expect(after.name).toBe('New name');
    expect(after.raceDate).toBe('2026-10-01');
    expect(after.image, 'the pencil wiped the picture it never touched').toBe(mediaId);
  });

  it('clears the picture on an explicit null, which is not the same as omitting it', async () => {
    const owner = await signUp('ClearOwner');
    const { clubId } = await createClubAs(owner);
    const created = await as(owner, 'POST', `/clubs/${clubId}/races`, {
      name: 'Clearable',
      raceDate: '2026-09-15',
    });
    const raceId = created.body.raceId;
    await as(owner, 'PATCH', `/races/${raceId}`, { image: crypto.randomUUID() });

    expect((await as(owner, 'PATCH', `/races/${raceId}`, { image: null })).status).toBe(200);
    expect((await as(owner, 'GET', `/races/${raceId}`)).body.race.image).toBeNull();
  });

  it('refuses a name that is only whitespace, rather than storing one nothing can render', async () => {
    const owner = await signUp('BlankOwner');
    const { clubId } = await createClubAs(owner);
    const created = await as(owner, 'POST', `/clubs/${clubId}/races`, {
      name: 'Has a name',
      raceDate: '2026-09-15',
    });
    const raceId = created.body.raceId;

    expect((await as(owner, 'PATCH', `/races/${raceId}`, { name: '   ' })).status).toBe(400);
    expect((await as(owner, 'GET', `/races/${raceId}`)).body.race.name).toBe('Has a name');
  });

  it('is management authority, so a roster member who is not an admin cannot edit it', async () => {
    const owner = await signUp('EditOwner');
    const runner = await signUp('EditRunner');
    const { clubId } = await createClubAs(owner);
    await join(clubId, runner);
    const created = await as(owner, 'POST', `/clubs/${clubId}/races`, {
      name: 'Managed',
      raceDate: '2026-09-15',
    });
    const raceId = created.body.raceId;
    // On the roster - which is ACCESS, and deliberately not authority.
    await as(owner, 'POST', `/races/${raceId}/members`, { userId: runner.userId });

    // 404 rather than 403, like every refusal in this codebase: it must not confirm what it
    // refused. The runner can read the race - they just cannot edit it.
    expect((await as(runner, 'PATCH', `/races/${raceId}`, { name: 'Mine now' })).status).toBe(404);
    expect((await as(owner, 'GET', `/races/${raceId}`)).body.race.name).toBe('Managed');
  });

  it('carries the picture into the race list the club hub reads', async () => {
    const owner = await signUp('ListPicOwner');
    const { clubId } = await createClubAs(owner);
    const created = await as(owner, 'POST', `/clubs/${clubId}/races`, {
      name: 'Listed',
      raceDate: '2026-09-15',
    });
    const mediaId = crypto.randomUUID();
    await as(owner, 'PATCH', `/races/${created.body.raceId}`, { image: mediaId });

    const listed = (await as(owner, 'GET', `/clubs/${clubId}/races`)).body.races;
    expect(listed.find((r: any) => r.id === created.body.raceId).image).toBe(mediaId);
  });
});

describe('deleting a race takes its conversation with it', () => {
  /*
   * ADR-0014 has a channel reference its scope ONE WAY - `scope_id` is a plain uuid, no foreign
   * key - so one table can serve four scopes. The price is that deleting a race cascades nothing,
   * and for four phases it did not: the race row went and its channel stayed, holding every
   * message in it, referenced by nothing and reachable from nothing. Invisible from the client,
   * because the effect handler revokes the sockets either way - its own comment even says "its
   * channel is gone".
   *
   * Found by deleting a test race by hand and counting the rows left behind.
   */
  it('leaves no orphaned channel behind', async () => {
    const owner = await signUp('OrphanOwner');
    const { clubId } = await createClubAs(owner);
    const created = await as(owner, 'POST', `/clubs/${clubId}/races`, {
      name: 'Doomed',
      raceDate: '2026-09-15',
    });
    const { raceId, channelId } = created.body;

    await as(owner, 'POST', `/channels/${channelId}/messages`, { body: 'anyone coming?' }).catch(
      () => undefined,
    );

    expect((await as(owner, 'DELETE', `/races/${raceId}`)).status).toBe(200);

    const left = await h.db.execute<{ channels: string; messages: string }>(sql`
      SELECT (SELECT count(*) FROM channels WHERE scope = 'race' AND scope_id = ${raceId})
               AS channels,
             (SELECT count(*) FROM messages WHERE channel_id = ${channelId}) AS messages
    `);
    expect(Number(left.rows[0]?.channels), 'the race is gone and its channel is not').toBe(0);
    // Cascades off `channel_id` once the channel row goes, which is the whole reason deleting
    // the channel is sufficient.
    expect(Number(left.rows[0]?.messages), 'messages outlived the channel they were in').toBe(0);
  });

  it('is refused for a roster member who is not a manager, leaving the race intact', async () => {
    const owner = await signUp('KeepOwner');
    const runner = await signUp('KeepRunner');
    const { clubId } = await createClubAs(owner);
    await join(clubId, runner);
    const created = await as(owner, 'POST', `/clubs/${clubId}/races`, {
      name: 'Kept',
      raceDate: '2026-09-15',
    });
    const raceId = created.body.raceId;
    await as(owner, 'POST', `/races/${raceId}/members`, { userId: runner.userId });

    expect((await as(runner, 'DELETE', `/races/${raceId}`)).status).toBe(404);
    expect((await as(owner, 'GET', `/races/${raceId}`)).status).toBe(200);
  });
});
