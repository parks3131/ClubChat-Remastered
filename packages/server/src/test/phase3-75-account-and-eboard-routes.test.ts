/**
 * The six capabilities that had no function of any kind.
 *
 * Club search, invite-token rotation, account deletion, profile editing, and the Eboard rejoin
 * path. Four of them sat on columns that already existed - which is why a schema-completeness
 * check passed them and only reading the spec against the router found them.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { buildApp } from '../api/app.ts';
import { createAuth, type Auth } from '../auth.ts';
import type { Config } from '../config.ts';
import { clubMemberships, users } from '../db/schema.ts';
import { FakeMediaStore } from '../media/store.ts';
import { silentMonitor } from '../monitoring.ts';
import { allowAll } from './fake-limiter.ts';
import { startTestDb, type TestDb } from './harness.ts';

let h: TestDb;
let app: FastifyInstance;
let auth: Auth;

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
  return {
    status: response.statusCode,
    body: response.body.length > 0 ? JSON.parse(response.body) : null,
  };
}

async function createClubAs(
  actor: Actor,
  overrides: Record<string, unknown> = {},
): Promise<{ clubId: string; inviteToken: string }> {
  const created = await as(actor, 'POST', '/clubs', {
    name: `Club ${crypto.randomUUID().slice(0, 6)}`,
    sport: 'running',
    ...overrides,
  });
  expect(created.status).toBe(201);
  return { clubId: created.body.clubId, inviteToken: created.body.inviteToken };
}

async function join(clubId: string, actor: Actor, role: 'member' | 'admin' = 'member') {
  await h.db.insert(clubMemberships).values({ clubId, userId: actor.userId, role });
}

async function eboardIdOf(clubId: string): Promise<string> {
  const rows = await h.db.execute<{ id: string }>(
    sql`SELECT id::text AS id FROM eboard_channels WHERE club_id = ${clubId}`,
  );
  const id = rows.rows[0]?.id;
  if (!id) throw new Error('club has no eboard space');
  return id;
}

beforeAll(async () => {
  h = await startTestDb();
  auth = createAuth(h.db, {
    secret: 'test-secret-not-a-real-one',
    baseURL: config.BETTER_AUTH_URL,
  });
  app = buildApp({ db: h.db, auth, config, mediaStore: new FakeMediaStore(), monitor: silentMonitor(), limiter: allowAll() });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close().catch(() => undefined);
  await h?.stop().catch(() => undefined);
});

describe('club search', () => {
  it('finds a club by name with a safe projection and nothing inside it', async () => {
    const owner = await signUp('SearchOwner');
    const seeker = await signUp('SearchSeeker');
    const name = `Findable ${crypto.randomUUID().slice(0, 6)}`;
    const { clubId } = await createClubAs(owner, { name, description: 'private notes' });

    const found = await as(seeker, 'GET', `/clubs/search?q=${encodeURIComponent(name)}`);
    expect(found.status).toBe(200);
    expect(found.body.clubs).toHaveLength(1);

    const club = found.body.clubs[0];
    expect(club.id).toBe(clubId);
    expect(club.name).toBe(name);
    expect(club.sport).toBe('running');
    expect(club.memberCount).toBe(1);
    expect(club.joinPolicy).toBe('open');
    expect(club.requestPending).toBe(false);
    // The projection is the whole point: nothing inside the club comes back with it.
    expect(club).not.toHaveProperty('inviteToken');
    expect(club).not.toHaveProperty('description');
    expect(club).not.toHaveProperty('channelId');
  });

  it('excludes clubs the caller is already in', async () => {
    const owner = await signUp('SearchMemberOwner');
    const name = `Mine ${crypto.randomUUID().slice(0, 6)}`;
    await createClubAs(owner, { name });

    // Their own club is absent: the client already knows it from GET /clubs, and returning it
    // here would duplicate that list into a second shape that could disagree.
    const mine = await as(owner, 'GET', `/clubs/search?q=${encodeURIComponent(name)}`);
    expect(mine.body.clubs).toEqual([]);
  });

  it('reports a pending request so the action can read "Requested"', async () => {
    const owner = await signUp('SearchReqOwner');
    const seeker = await signUp('SearchReqSeeker');
    const name = `Gated ${crypto.randomUUID().slice(0, 6)}`;
    const { clubId } = await createClubAs(owner, { name, joinPolicy: 'request' });

    expect((await as(seeker, 'POST', `/clubs/${clubId}/join`)).body.status).toBe('requested');

    const found = await as(seeker, 'GET', `/clubs/search?q=${encodeURIComponent(name)}`);
    expect(found.body.clubs[0].requestPending).toBe(true);
  });

  it('returns nothing for an empty query rather than every club', async () => {
    const seeker = await signUp('SearchEmptySeeker');
    const owner = await signUp('SearchEmptyOwner');
    await createClubAs(owner);

    // A bare listing would be a club directory, which this deliberately is not.
    expect((await as(seeker, 'GET', '/clubs/search?q=')).body.clubs).toEqual([]);
    expect((await as(seeker, 'GET', '/clubs/search?q=%20%20')).body.clubs).toEqual([]);
    // And the parameter is required rather than defaulted.
    expect((await as(seeker, 'GET', '/clubs/search')).status).toBe(400);
  });
});

describe('invite-token rotation', () => {
  it('invalidates every outstanding link at once', async () => {
    const owner = await signUp('RotateOwner');
    const early = await signUp('RotateEarly');
    const late = await signUp('RotateLate');
    const { clubId, inviteToken } = await createClubAs(owner, { joinPolicy: 'request' });

    // The old link works, even on a request club, which is the whole point of a link.
    expect((await as(early, 'POST', `/invites/${inviteToken}/redeem`)).status).toBe(200);

    const rotated = await as(owner, 'POST', `/clubs/${clubId}/invite-token/rotate`);
    expect(rotated.status).toBe(200);
    expect(rotated.body.inviteToken).toBeTruthy();
    expect(rotated.body.inviteToken).not.toBe(inviteToken);

    // The leaked link is dead. Total invalidation is the remedy, not a side effect.
    expect((await as(late, 'POST', `/invites/${inviteToken}/redeem`)).status).toBe(404);
    // The new one works.
    expect((await as(late, 'POST', `/invites/${rotated.body.inviteToken}/redeem`)).status).toBe(200);

    // And it is recorded, which is what the column was always for.
    const rows = await h.db.execute<{ rotated: string | null }>(
      sql`SELECT invite_token_rotated_at::text AS rotated FROM clubs WHERE id = ${clubId}`,
    );
    expect(rows.rows[0]?.rotated).toBeTruthy();
  });

  it('is admin-only, and refuses a member and an outsider identically', async () => {
    const owner = await signUp('RotateGateOwner');
    const member = await signUp('RotateGateMember');
    const outsider = await signUp('RotateGateOutsider');
    const { clubId } = await createClubAs(owner);
    await join(clubId, member);

    expect((await as(member, 'POST', `/clubs/${clubId}/invite-token/rotate`)).status).toBe(404);
    expect((await as(outsider, 'POST', `/clubs/${clubId}/invite-token/rotate`)).status).toBe(404);
  });

  /**
   * Rotation replaces BOTH links, because whoever rotates does not know which one leaked.
   */
  it('kills the member link as well as the admin one', async () => {
    const owner = await signUp('RotateBothOwner');
    const member = await signUp('RotateBothMember');
    const joiner = await signUp('RotateBothJoiner');
    const { clubId } = await createClubAs(owner);
    await join(clubId, member);

    const memberLink = (await as(member, 'GET', `/clubs/${clubId}`)).body.club.inviteToken;
    await as(owner, 'POST', `/clubs/${clubId}/invite-token/rotate`);

    expect((await as(joiner, 'POST', `/invites/${memberLink}/redeem`)).status).toBe(404);
    const fresh = (await as(member, 'GET', `/clubs/${clubId}`)).body.club.inviteToken;
    expect(fresh).not.toBe(memberLink);
    expect((await as(joiner, 'POST', `/invites/${fresh}/redeem`)).status).toBe(200);
  });
});

/**
 * ADR-0025: a club has two links, and which one was redeemed decides whether the join policy
 * applies. The point is that a member can bring somebody without being able to grant what only
 * an admin may grant - so every assertion here is a pair, and the pairs are what make it a rule
 * rather than a coincidence of one code path.
 */
describe('the member link and the admin link', () => {
  it('hands an admin and a member different strings for the same club', async () => {
    const owner = await signUp('TwoLinkOwner');
    const admin = await signUp('TwoLinkAdmin');
    const member = await signUp('TwoLinkMember');
    const { clubId } = await createClubAs(owner, { joinPolicy: 'request' });
    await join(clubId, admin, 'admin');
    await join(clubId, member);

    const ownerLink = (await as(owner, 'GET', `/clubs/${clubId}`)).body.club.inviteToken;
    const adminLink = (await as(admin, 'GET', `/clubs/${clubId}`)).body.club.inviteToken;
    const memberLink = (await as(member, 'GET', `/clubs/${clubId}`)).body.club.inviteToken;

    expect(adminLink).toBe(ownerLink);
    expect(memberLink).toBeTruthy();
    // The one that matters: a member never learns the string that bypasses the policy.
    expect(memberLink).not.toBe(adminLink);
  });

  it('on a request club, joins through the admin link and files a request through the member one', async () => {
    const owner = await signUp('PolicyOwner');
    const member = await signUp('PolicyMember');
    const viaAdmin = await signUp('PolicyViaAdmin');
    const viaMember = await signUp('PolicyViaMember');
    const { clubId } = await createClubAs(owner, { joinPolicy: 'request' });
    await join(clubId, member);

    const adminLink = (await as(owner, 'GET', `/clubs/${clubId}`)).body.club.inviteToken;
    const memberLink = (await as(member, 'GET', `/clubs/${clubId}`)).body.club.inviteToken;

    const bypassed = await as(viaAdmin, 'POST', `/invites/${adminLink}/redeem`);
    expect(bypassed.status).toBe(200);
    expect(bypassed.body.status).toBe('joined');

    const asked = await as(viaMember, 'POST', `/invites/${memberLink}/redeem`);
    expect(asked.status).toBe(200);
    expect(asked.body.status).toBe('requested');

    // Not a member yet, and visible to the admins as a pending row rather than as nothing.
    const roster = await as(owner, 'GET', `/clubs/${clubId}/members`);
    expect(roster.body.members.map((m: { name: string }) => m.name)).not.toContain('PolicyViaMember');
    expect(roster.body.pendingRequests.map((r: { name: string }) => r.name)).toContain(
      'PolicyViaMember',
    );
  });

  it('on an open club, both links join immediately', async () => {
    const owner = await signUp('OpenLinkOwner');
    const member = await signUp('OpenLinkMember');
    const viaAdmin = await signUp('OpenViaAdmin');
    const viaMember = await signUp('OpenViaMember');
    const { clubId } = await createClubAs(owner, { joinPolicy: 'open' });
    await join(clubId, member);

    const adminLink = (await as(owner, 'GET', `/clubs/${clubId}`)).body.club.inviteToken;
    const memberLink = (await as(member, 'GET', `/clubs/${clubId}`)).body.club.inviteToken;

    expect((await as(viaAdmin, 'POST', `/invites/${adminLink}/redeem`)).body.status).toBe('joined');
    // Nothing to bypass, so the member's link is not a lesser one here.
    expect((await as(viaMember, 'POST', `/invites/${memberLink}/redeem`)).body.status).toBe(
      'joined',
    );
  });

  it('refuses a banned person through the member link, without leaving a request behind', async () => {
    const owner = await signUp('BanLinkOwner');
    const member = await signUp('BanLinkMember');
    const banned = await signUp('BanLinkBanned');
    const { clubId } = await createClubAs(owner, { joinPolicy: 'request' });
    await join(clubId, member);
    await join(clubId, banned);
    expect(
      (await as(owner, 'POST', `/clubs/${clubId}/bans`, { userId: banned.userId })).status,
    ).toBe(201);

    const memberLink = (await as(member, 'GET', `/clubs/${clubId}`)).body.club.inviteToken;
    expect((await as(banned, 'POST', `/invites/${memberLink}/redeem`)).status).toBe(403);

    // A ban that still produced a pending row would teach admins it does not hold.
    const roster = await as(owner, 'GET', `/clubs/${clubId}/members`);
    expect(roster.body.pendingRequests.map((r: { name: string }) => r.name)).not.toContain(
      'BanLinkBanned',
    );
  });
});

describe('profile', () => {
  it('edits your own and has no route to edit anybody else', async () => {
    const me = await signUp('ProfileMe');
    const other = await signUp('ProfileOther');
    // A shared club, because since 2026-08-08 that is what makes a profile readable at all.
    // The two used to be strangers here and the final assertion still passed, which is how this
    // test quietly documented the hole it now guards.
    const { clubId } = await createClubAs(me);
    await join(clubId, other);

    const saved = await as(me, 'PATCH', '/me/profile', {
      name: 'Renamed Me',
      bio: 'Runs slowly',
      city: 'Boston',
      dob: '1999-04-01',
    });
    expect(saved.status).toBe(200);
    expect(saved.body.profile.name).toBe('Renamed Me');
    expect(saved.body.profile.bio).toBe('Runs slowly');
    expect(saved.body.profile.dob).toBe('1999-04-01');

    // Self-only is expressed as a route with no target, so editing somebody else cannot even be
    // requested. There is no PATCH /users/:id to try.
    const attempt = await app.inject({
      method: 'PATCH',
      url: `/users/${other.userId}`,
      headers: { authorization: `Bearer ${me.token}` },
      payload: { name: 'Hijacked' },
    });
    expect(attempt.statusCode).toBe(404);

    // And the other profile is untouched.
    expect((await as(me, 'GET', `/users/${other.userId}`)).body.profile.name).toBe('ProfileOther');
  });

  it('withholds the date of birth from everybody but its owner', async () => {
    const me = await signUp('DobMe');
    const other = await signUp('DobOther');
    const { clubId } = await createClubAs(me);
    await join(clubId, other);
    await as(me, 'PATCH', '/me/profile', { dob: '2001-02-03' });

    const own = await as(me, 'GET', `/users/${me.userId}`);
    expect(own.body.profile.dob).toBe('2001-02-03');

    // Clubs are small and often include minors, and nothing needs to show one member another's
    // birthday. Absent from the response rather than hidden in the UI.
    const theirs = await as(other, 'GET', `/users/${me.userId}`);
    expect(theirs.status).toBe(200);
    expect(theirs.body.profile).not.toHaveProperty('dob');
    // The email is auth-only and never appears in either shape.
    expect(theirs.body.profile).not.toHaveProperty('email');
    expect(own.body.profile).not.toHaveProperty('email');
  });

  it('refuses to empty a name and leaves absent fields alone', async () => {
    const me = await signUp('NameMe');
    await as(me, 'PATCH', '/me/profile', { name: 'Real Name', city: 'Boston' });

    // Nothing can render a member with no name: not a roster row, not a chat bubble, not the
    // letter-initial avatar placeholder.
    expect((await as(me, 'PATCH', '/me/profile', { name: '   ' })).status).toBe(400);

    // A partial patch keeps what it did not mention.
    const patched = await as(me, 'PATCH', '/me/profile', { bio: 'Added later' });
    expect(patched.body.profile.name).toBe('Real Name');
    expect(patched.body.profile.city).toBe('Boston');
    expect(patched.body.profile.bio).toBe('Added later');

    // An explicit null clears.
    const cleared = await as(me, 'PATCH', '/me/profile', { city: null });
    expect(cleared.body.profile.city).toBeNull();
  });

  it('rejects a timestamp where a calendar day belongs', async () => {
    const me = await signUp('DobFormatMe');
    expect((await as(me, 'PATCH', '/me/profile', { dob: '2001-02-03T00:00:00Z' })).status).toBe(
      400,
    );
  });

  /*
   * Who may open a profile card at all.
   *
   * > **Every one of these passed as a 200 until 2026-08-08.** `readProfile` took an access
   * > context and never consulted it, so any signed-in account could read any other account's
   * > name, bio, city, school and avatar given only a uuid. ADR-0009, PRD/03's rejected
   * > alternatives and `sharesAClub`'s own docstring all state the rule; nothing enforced it.
   */
  it('refuses a profile to somebody who shares no club and holds no conversation', async () => {
    const stranger = await signUp('ProfileStranger');
    const subject = await signUp('ProfileSubject');
    await as(subject, 'PATCH', '/me/profile', {
      bio: 'Sixteen, and at Northside High',
      city: 'Binghamton',
      school: 'Northside High',
    });

    // Neither of them belongs to anything, so there is no relationship to justify the read.
    const attempt = await as(stranger, 'GET', `/users/${subject.userId}`);
    // 404 rather than 403: a stranger must not learn that the account exists either, which also
    // stops this route being used to test whether a uuid is a real member.
    expect(attempt.status).toBe(404);
    expect(JSON.stringify(attempt.body)).not.toContain('Northside');

    // A shared club is what grants it, and nothing else changed.
    const { clubId } = await createClubAs(subject);
    await join(clubId, stranger);
    const now = await as(stranger, 'GET', `/users/${subject.userId}`);
    expect(now.status).toBe(200);
    expect(now.body.profile.school).toBe('Northside High');
  });

  it('keeps a conversation partner readable after the last shared club goes', async () => {
    const me = await signUp('DmProfileMe');
    const peer = await signUp('DmProfilePeer');
    const { clubId } = await createClubAs(me);
    await join(clubId, peer);

    const thread = await as(me, 'POST', '/dm/threads', { userId: peer.userId });
    expect(thread.status).toBe(201);

    // The club that made them eligible goes away. PRD/14 rule 3 keeps the thread's history
    // readable, so the name in that history has to stay tappable - gating on the shared club
    // alone would 404 a card the product is still showing, which reads as a bug, not privacy.
    await h.db
      .delete(clubMemberships)
      .where(sql`club_id = ${clubId} AND user_id IN (${me.userId}, ${peer.userId})`);

    const card = await as(me, 'GET', `/users/${peer.userId}`);
    expect(card.status).toBe(200);
    expect(card.body.profile.name).toBe('DmProfilePeer');
  });

  it('still shows the card to somebody who has been blocked, deliberately', async () => {
    const blocker = await signUp('BlockProfileA');
    const blocked = await signUp('BlockProfileB');
    const { clubId } = await createClubAs(blocker);
    await join(clubId, blocked);

    expect((await as(blocker, 'POST', '/blocks', { userId: blocked.userId })).status).toBe(201);

    /*
     * A block is not consulted by `canViewProfile`, and that is a decision rather than an
     * oversight. Blocking stops messages and hides the pair from each other's DM search; it does
     * not erase somebody from a club they are both still in, where their name and face sit on
     * the roster and beside every message they have ever sent. Withholding the card alone would
     * conceal nothing and would break the roster the blocker can already see.
     */
    expect((await as(blocked, 'GET', `/users/${blocker.userId}`)).status).toBe(200);
    expect((await as(blocker, 'GET', `/users/${blocked.userId}`)).status).toBe(200);

    // The search filter, which IS block-aware, still refuses - so the two rules coexist.
    const candidates = await as(blocked, 'GET', '/dm/candidates');
    expect(
      candidates.body.candidates.map((c: { userId: string }) => c.userId),
    ).not.toContain(blocker.userId);
  });
});

describe('account deletion', () => {
  it('anonymises, blocks the live session, and leaves the content', async () => {
    const owner = await signUp('DelClubOwner');
    const leaver = await signUp('DelLeaver');
    const { clubId } = await createClubAs(owner);
    await join(clubId, leaver);

    // Their profile is readable beforehand.
    expect((await as(owner, 'GET', `/users/${leaver.userId}`)).status).toBe(200);

    const deleted = await as(leaver, 'DELETE', '/me');
    expect(deleted.status).toBe(200);

    // The row survives - their messages point at it - but carries nothing personal.
    const rows = await h.db
      .select({
        name: users.name,
        bio: users.bio,
        image: users.image,
        anonymizedAt: users.anonymizedAt,
        signinBlockedAt: users.signinBlockedAt,
        email: users.email,
      })
      .from(users)
      .where(eq(users.id, leaver.userId));
    expect(rows[0]?.anonymizedAt).not.toBeNull();
    expect(rows[0]?.signinBlockedAt).not.toBeNull();
    expect(rows[0]?.name).toBe('Deleted member');
    expect(rows[0]?.bio).toBeNull();
    // The address is released rather than held, so the person can sign up again with it.
    expect(rows[0]?.email).not.toContain('delleaver');

    // The token they still hold is dead on the next request, because revocation is asked every
    // time rather than at sign-in.
    expect((await as(leaver, 'GET', '/clubs')).status).toBe(401);

    // They are off the roster, so no audience function or fan-out reaches them any more.
    const roster = await as(owner, 'GET', `/clubs/${clubId}/members`);
    expect(roster.body.members.map((m: { userId: string }) => m.userId)).not.toContain(
      leaver.userId,
    );

    // And their profile no longer opens.
    expect((await as(owner, 'GET', `/users/${leaver.userId}`)).status).toBe(404);

    /*
     * The sockets are told, and this is the half that was missing entirely until 2026-08-08.
     *
     * A subscription is authorized once, at subscribe time, and never rechecked per message - so
     * deleting the membership rows does not stop delivery to a socket that is already attached.
     * Every other removal path publishes a revocation; account deletion wrote no outbox event at
     * all, so a member who deleted their account kept receiving their old club's conversation in
     * real time for as long as they left the app open. Proved by watching a message posted after
     * DELETE /me arrive on the deleted account's socket.
     *
     * Asserted on the event rather than on Redis because that is where the guarantee lives: the
     * row commits in the same transaction as the deletion, so there is no window in which the
     * account is gone and the instruction was never durable.
     */
    const revocation = await h.db.execute<{ payload: { userId: string; channelIds: string[] } }>(
      sql`SELECT payload FROM outbox
           WHERE event_type = 'account.deleted' AND partition_key = ${leaver.userId}`,
    );
    expect(revocation.rows).toHaveLength(1);
    expect(revocation.rows[0]?.payload.userId).toBe(leaver.userId);
    // The club's own channel is in it, captured before the membership went.
    expect(revocation.rows[0]?.payload.channelIds.length).toBeGreaterThan(0);
  });

  it('refuses while the caller still owns a club, and names nothing it should not', async () => {
    const owner = await signUp('DelOwnerBlocked');
    await createClubAs(owner);

    /*
     * The collision between PRD/03 rule 11 (deletion is unconditional) and PRD/04 (an Owner
     * cannot leave; transfer is the only path) plus invariant 1 (exactly one Owner, always,
     * because an ownerless club has no recovery path). Refusing is the only outcome that keeps
     * both the invariant and the other members' club, so deletion asks them to hand it over
     * first. Recorded as an open question in PRD/17.
     */
    const refused = await as(owner, 'DELETE', '/me');
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('owns_clubs');

    // Still fully signed in - a refused deletion must not half-happen.
    expect((await as(owner, 'GET', '/clubs')).status).toBe(200);
  });

  it('goes through once ownership has been transferred', async () => {
    const owner = await signUp('DelTransferOwner');
    const heir = await signUp('DelTransferHeir');
    const { clubId } = await createClubAs(owner);
    await join(clubId, heir, 'admin');

    expect((await as(owner, 'DELETE', '/me')).status).toBe(409);

    const transferred = await as(owner, 'POST', `/clubs/${clubId}/transfer-ownership`, {
      toUserId: heir.userId,
    });
    expect(transferred.status).toBe(200);

    expect((await as(owner, 'DELETE', '/me')).status).toBe(200);
    // Exactly one Owner survives, which is the invariant the refusal was protecting.
    const roster = await as(heir, 'GET', `/clubs/${clubId}/members`);
    const owners = roster.body.members.filter((m: { role: string }) => m.role === 'owner');
    expect(owners).toHaveLength(1);
    expect(owners[0].userId).toBe(heir.userId);
  });
});

describe('the Eboard rejoin path', () => {
  it('lets an admin who left ask back in, and only members decide', async () => {
    const owner = await signUp('EbRejoinOwner');
    const admin = await signUp('EbRejoinAdmin');
    const member = await signUp('EbRejoinMember');
    const { clubId } = await createClubAs(owner);
    await join(clubId, member);
    const eboardId = await eboardIdOf(clubId);

    // Promotion auto-joins, which is how membership normally works.
    await as(owner, 'POST', `/clubs/${clubId}/members`, { userId: admin.userId });
    await as(owner, 'PATCH', `/clubs/${clubId}/members/${admin.userId}/role`, { role: 'admin' });
    expect((await as(admin, 'GET', `/eboards/${eboardId}`)).body.eboard.viewer.isMember).toBe(true);

    // They leave deliberately. Still admin-tier, so no promotion will ever re-add them - which
    // is the entire reason this path has to exist.
    expect(
      (await as(admin, 'DELETE', `/eboards/${eboardId}/members/${admin.userId}`)).status,
    ).toBe(200);

    const landing = await as(admin, 'GET', `/eboards/${eboardId}`);
    expect(landing.status).toBe(200);
    expect(landing.body.eboard.viewer.isMember).toBe(false);
    expect(landing.body.eboard.viewer.isClubAdmin).toBe(true);
    // The chat is withheld from a non-member, as a race withholds its chat with no roster row.
    expect(landing.body.eboard.channelId).toBeNull();

    const filed = await as(admin, 'POST', `/eboards/${eboardId}/join-requests`);
    expect(filed.status).toBe(201);
    expect((await as(admin, 'GET', `/eboards/${eboardId}`)).body.eboard.viewer.requestPending).toBe(
      true,
    );
    // Filing twice is a refusal rather than a second row.
    expect((await as(admin, 'POST', `/eboards/${eboardId}/join-requests`)).status).toBe(409);

    // A non-member cannot read the queue, even though they are a club admin...
    expect((await as(admin, 'GET', `/eboards/${eboardId}/members`)).status).toBe(404);

    const roster = await as(owner, 'GET', `/eboards/${eboardId}/members`);
    expect(roster.status).toBe(200);
    const requestId = roster.body.pendingRequests[0].requestId;
    expect(roster.body.pendingRequests[0].userId).toBe(admin.userId);

    // ...and cannot approve their own way in, which is the privacy boundary this space is.
    expect((await as(admin, 'POST', `/eboard-join-requests/${requestId}/approve`)).status).toBe(404);
    // An ordinary member sees none of it.
    expect((await as(member, 'GET', `/eboards/${eboardId}`)).status).toBe(404);
    expect((await as(member, 'POST', `/eboards/${eboardId}/join-requests`)).status).toBe(404);

    // An existing member approves.
    expect((await as(owner, 'POST', `/eboard-join-requests/${requestId}/approve`)).status).toBe(200);
    const back = await as(admin, 'GET', `/eboards/${eboardId}`);
    expect(back.body.eboard.viewer.isMember).toBe(true);
    expect(back.body.eboard.channelId).toBeTruthy();
    expect(back.body.eboard.viewer.requestPending).toBe(false);
  });

  it('refuses to add a plain member to the space', async () => {
    const owner = await signUp('EbAddOwner');
    const member = await signUp('EbAddMember');
    const { clubId } = await createClubAs(owner);
    await join(clubId, member);
    const eboardId = await eboardIdOf(clubId);

    // The space is for the admin tier. Adding somebody who never was an admin would put
    // somebody in it whom demotion could never remove.
    const refused = await as(owner, 'POST', `/eboards/${eboardId}/members`, {
      userIds: [member.userId],
    });
    expect(refused.status).toBe(404);
  });

  it('lets only the club Owner remove somebody else', async () => {
    const owner = await signUp('EbRemoveOwner');
    const adminA = await signUp('EbRemoveA');
    const adminB = await signUp('EbRemoveB');
    const { clubId } = await createClubAs(owner);
    const eboardId = await eboardIdOf(clubId);

    for (const admin of [adminA, adminB]) {
      await as(owner, 'POST', `/clubs/${clubId}/members`, { userId: admin.userId });
      await as(owner, 'PATCH', `/clubs/${clubId}/members/${admin.userId}/role`, { role: 'admin' });
    }

    // Mutual removal between admins was rejected outright: this is the highest-trust space in
    // the product, and two admins able to eject each other is a governance problem.
    expect(
      (await as(adminA, 'DELETE', `/eboards/${eboardId}/members/${adminB.userId}`)).status,
    ).toBe(404);
    // The Owner can.
    expect(
      (await as(owner, 'DELETE', `/eboards/${eboardId}/members/${adminB.userId}`)).status,
    ).toBe(200);
    // And anybody may leave of their own accord.
    expect(
      (await as(adminA, 'DELETE', `/eboards/${eboardId}/members/${adminA.userId}`)).status,
    ).toBe(200);
  });
});

describe('the session boundary', () => {
  it('refuses every new route without a session', async () => {
    const id = crypto.randomUUID();
    for (const [method, url] of [
      ['GET', '/clubs/search?q=x'],
      ['PATCH', '/me/profile'],
      ['DELETE', '/me'],
      ['GET', `/users/${id}`],
      ['POST', `/clubs/${id}/invite-token/rotate`],
      ['GET', `/eboards/${id}`],
      ['GET', `/eboards/${id}/members`],
      ['POST', `/eboards/${id}/join-requests`],
      ['POST', `/eboard-join-requests/${id}/approve`],
    ] as const) {
      const response = await app.inject({ method, url, payload: {} });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('answers 404 rather than 500 for a malformed id in any route', async () => {
    const actor = await signUp('MalformedIdActor');
    for (const url of [
      '/clubs/not-a-uuid',
      '/clubs/not-a-uuid/members',
      '/users/not-a-uuid',
      '/eboards/not-a-uuid',
      '/races/not-a-uuid',
      '/polls/not-a-uuid',
      '/meetings/not-a-uuid',
      '/channels/undefined/messages',
    ]) {
      const response = await as(actor, 'GET', url);
      // Before Phase 3.75a every one of these was a 500 with a stack trace in the log: the
      // value went straight into a uuid column and Postgres refused to parse it.
      expect(response.status, url).toBe(404);
    }
  });
});

describe('the Eboard space has its own identity', () => {
  /*
   * The authority boundary this whole module exists for, restated on a write nobody thinks of as
   * sensitive: renaming. A club admin who is NOT in the space can read it - that read is what
   * draws their landing screen - and must not be able to rename it or change its face from
   * outside. Authority over the club is not authority inside the space (rule 5), and the rename
   * route is the easiest place to forget that, because it looks like club settings.
   */
  it('lets a member change the picture, and refuses an admin standing outside', async () => {
    const owner = await signUp('SpaceOwner');
    const outsideAdmin = await signUp('SpaceOutsideAdmin');
    const { clubId } = await createClubAs(owner);
    await join(clubId, outsideAdmin, 'admin');
    const eboardId = await eboardIdOf(clubId);
    // Admin-tier auto-joins, so the only way to be an admin outside the space is to leave it.
    await as(outsideAdmin, 'DELETE', `/eboards/${eboardId}/members/${outsideAdmin.userId}`);

    // They can still read it - that read is the landing screen - which is what makes the
    // refusal below a real boundary rather than a 404 for something invisible.
    expect((await as(outsideAdmin, 'GET', `/eboards/${eboardId}`)).status).toBe(200);

    const mediaId = crypto.randomUUID();
    expect(
      (await as(outsideAdmin, 'PATCH', `/eboards/${eboardId}`, { image: mediaId })).status,
      'an admin outside the space changed its face',
    ).toBe(404);

    expect((await as(owner, 'PATCH', `/eboards/${eboardId}`, { image: mediaId })).status).toBe(200);
    expect((await as(owner, 'GET', `/eboards/${eboardId}`)).body.eboard.image).toBe(mediaId);
  });

  it('tells an ordinary member nothing, not even that the refusal was about permission', async () => {
    const owner = await signUp('SpaceHiddenOwner');
    const member = await signUp('SpaceHiddenMember');
    const { clubId } = await createClubAs(owner);
    await join(clubId, member);
    const eboardId = await eboardIdOf(clubId);

    // Rule 4: an ordinary member has no visibility that the space exists at all, so the
    // refusal must be indistinguishable from "no such thing".
    expect((await as(member, 'PATCH', `/eboards/${eboardId}`, { name: 'Mine' })).status).toBe(404);
  });

  it('changes the picture without renaming the space back to its default', async () => {
    const owner = await signUp('SpaceRenameOwner');
    const { clubId } = await createClubAs(owner);
    const eboardId = await eboardIdOf(clubId);

    await as(owner, 'PATCH', `/eboards/${eboardId}`, { name: 'Captains' });
    await as(owner, 'PATCH', `/eboards/${eboardId}`, { image: crypto.randomUUID() });

    const after = (await as(owner, 'GET', `/eboards/${eboardId}`)).body.eboard;
    expect(after.name, 'an image-only patch reverted the name').toBe('Captains');
    expect(after.image).toBeTruthy();
  });
});
