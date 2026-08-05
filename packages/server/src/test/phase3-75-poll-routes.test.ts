/**
 * The poll HTTP surface, in all three scopes.
 *
 * The rule this file exists to hold down is the one the acceptance checklist states twice: **a
 * race poll is invisible to an admin without a roster row, including by direct URL.** Every
 * other poll rule is about privacy or about who may close one, and both are easy to get right
 * in a handler and easy to lose at a route that trusts its caller's parameters.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { buildApp } from '../api/app.ts';
import { createAuth, type Auth } from '../auth.ts';
import type { Config } from '../config.ts';
import { clubMemberships } from '../db/schema.ts';
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

async function createClubAs(actor: Actor): Promise<{ clubId: string; channelId: string }> {
  const created = await as(actor, 'POST', '/clubs', {
    name: `Club ${crypto.randomUUID().slice(0, 6)}`,
    sport: 'running',
  });
  expect(created.status).toBe(201);
  return { clubId: created.body.clubId, channelId: created.body.channelId };
}

async function join(clubId: string, actor: Actor, role: 'member' | 'admin' = 'member') {
  await h.db.insert(clubMemberships).values({ clubId, userId: actor.userId, role });
}

/** The Eboard space auto-created with a club. */
async function eboardIdOf(clubId: string): Promise<string> {
  const rows = await h.db.execute<{ id: string }>(
    sql`SELECT id::text AS id FROM eboard_channels WHERE club_id = ${clubId}`,
  );
  const id = rows.rows[0]?.id;
  if (!id) throw new Error('club has no eboard space');
  return id;
}

const TWO_OPTIONS = { question: 'Which day?', options: ['Saturday', 'Sunday'] };

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

describe('poll routes: creation and option limits', () => {
  it('lets a club admin create one and refuses a plain member', async () => {
    const owner = await signUp('PollOwner');
    const member = await signUp('PollMember');
    const { clubId } = await createClubAs(owner);
    await join(clubId, member);

    expect((await as(member, 'POST', `/clubs/${clubId}/polls`, TWO_OPTIONS)).status).toBe(404);

    const created = await as(owner, 'POST', `/clubs/${clubId}/polls`, TWO_OPTIONS);
    expect(created.status).toBe(201);
    expect(created.body.pollId).toBeTruthy();
  });

  it('accepts 2 and 10 options and refuses 1 and 11', async () => {
    const owner = await signUp('LimitOwner');
    const { clubId } = await createClubAs(owner);
    const labels = (n: number) => Array.from({ length: n }, (_, i) => `Option ${i + 1}`);

    expect(
      (await as(owner, 'POST', `/clubs/${clubId}/polls`, { question: 'q', options: labels(1) }))
        .status,
    ).toBe(400);
    expect(
      (await as(owner, 'POST', `/clubs/${clubId}/polls`, { question: 'q', options: labels(2) }))
        .status,
    ).toBe(201);
    expect(
      (await as(owner, 'POST', `/clubs/${clubId}/polls`, { question: 'q', options: labels(10) }))
        .status,
    ).toBe(201);
    expect(
      (await as(owner, 'POST', `/clubs/${clubId}/polls`, { question: 'q', options: labels(11) }))
        .status,
    ).toBe(400);
  });
});

describe('poll routes: the race scope, by direct URL', () => {
  it('hides a race poll from an admin with no roster row', async () => {
    const owner = await signUp('RacePollOwner');
    const admin = await signUp('RacePollAdmin');
    const racer = await signUp('RacePollRacer');
    const { clubId } = await createClubAs(owner);
    await join(clubId, admin, 'admin');
    await join(clubId, racer);

    const race = await as(owner, 'POST', `/clubs/${clubId}/races`, {
      name: 'Poll race',
      raceDate: '2027-09-09',
    });
    const raceId = race.body.raceId;
    await as(owner, 'POST', `/races/${raceId}/members`, { userIds: [racer.userId] });

    // The owner created the race, so they hold both a roster row and club-admin status -
    // which is exactly what creating a race poll requires.
    const created = await as(owner, 'POST', `/races/${raceId}/polls`, TWO_OPTIONS);
    expect(created.status).toBe(201);
    const pollId = created.body.pollId;

    // A club admin with no roster row cannot create one...
    expect((await as(admin, 'POST', `/races/${raceId}/polls`, TWO_OPTIONS)).status).toBe(404);
    // ...cannot read one by direct id, which is the checklist line...
    expect((await as(admin, 'GET', `/polls/${pollId}`)).status).toBe(404);
    // ...cannot see it in the list...
    expect((await as(admin, 'GET', `/races/${raceId}/polls`)).body.polls).toEqual([]);
    // ...and cannot vote in it.
    const options = (await as(owner, 'GET', `/polls/${pollId}`)).body.poll.options;
    expect((await as(admin, 'POST', `/poll-options/${options[0].id}/vote`)).status).toBe(404);

    // A race member with no admin status reads and votes, and cannot create.
    expect((await as(racer, 'GET', `/polls/${pollId}`)).status).toBe(200);
    expect((await as(racer, 'POST', `/poll-options/${options[0].id}/vote`)).status).toBe(200);
    expect((await as(racer, 'POST', `/races/${raceId}/polls`, TWO_OPTIONS)).status).toBe(404);
  });

  it('cannot be tricked into pairing one club with another club race', async () => {
    /*
     * The reason the scope's club is resolved server-side rather than taken from the body.
     *
     * `canCreatePoll` for a race asks two questions - a roster row on the race, and club-admin
     * on the club - and cannot tell whether the two arguments describe the same race. This
     * actor satisfies both halves against DIFFERENT clubs: on the roster of a race in a club
     * where they are a plain member, and an admin of an unrelated club. If the route accepted
     * a clubId, that pairing would create a poll inside a race they have no authority over.
     */
    const victimOwner = await signUp('PairVictim');
    const attacker = await signUp('PairAttacker');
    const { clubId: victimClub } = await createClubAs(victimOwner);
    // A plain member of the victim's club, and on one of its race rosters.
    await join(victimClub, attacker);

    const race = await as(victimOwner, 'POST', `/clubs/${victimClub}/races`, {
      name: 'Victim race',
      raceDate: '2027-10-10',
    });
    const raceId = race.body.raceId;
    await as(victimOwner, 'POST', `/races/${raceId}/members`, { userIds: [attacker.userId] });

    // ...and an owner, therefore an admin, of a club of their own.
    await createClubAs(attacker);

    // The route names the race and nothing else, so there is no parameter to pair with.
    // Extra fields in the body are ignored rather than trusted.
    const attempt = await as(attacker, 'POST', `/races/${raceId}/polls`, {
      ...TWO_OPTIONS,
      clubId: (await as(attacker, 'GET', '/clubs')).body.clubs[0].id,
      scope: 'race',
      scopeId: raceId,
    });
    expect(attempt.status).toBe(404);

    // And nothing was written.
    expect((await as(victimOwner, 'GET', `/races/${raceId}/polls`)).body.polls).toEqual([]);
  });
});

describe('poll routes: voting', () => {
  it('moves a single-choice vote, adds a multi-select one, and withdraws on a repeat tap', async () => {
    const owner = await signUp('VoteOwner');
    const { clubId } = await createClubAs(owner);

    const single = await as(owner, 'POST', `/clubs/${clubId}/polls`, TWO_OPTIONS);
    let poll = (await as(owner, 'GET', `/polls/${single.body.pollId}`)).body.poll;
    const [first, second] = poll.options;

    expect((await as(owner, 'POST', `/poll-options/${first.id}/vote`)).body.action).toBe('cast');
    // Single choice: tapping another option moves the vote rather than adding one.
    expect((await as(owner, 'POST', `/poll-options/${second.id}/vote`)).body.action).toBe('moved');

    poll = (await as(owner, 'GET', `/polls/${single.body.pollId}`)).body.poll;
    expect(poll.options[0].voteCount).toBe(0);
    expect(poll.options[1].voteCount).toBe(1);
    expect(poll.options[1].votedByMe).toBe(true);

    // Tapping the current option withdraws it.
    expect((await as(owner, 'POST', `/poll-options/${second.id}/vote`)).body.action).toBe(
      'withdrawn',
    );
    poll = (await as(owner, 'GET', `/polls/${single.body.pollId}`)).body.poll;
    expect(poll.options[1].voteCount).toBe(0);
    expect(poll.options[1].votedByMe).toBe(false);

    const multi = await as(owner, 'POST', `/clubs/${clubId}/polls`, {
      ...TWO_OPTIONS,
      allowMultiple: true,
    });
    const multiPoll = (await as(owner, 'GET', `/polls/${multi.body.pollId}`)).body.poll;
    await as(owner, 'POST', `/poll-options/${multiPoll.options[0].id}/vote`);
    // Multi-select adds rather than moving.
    expect(
      (await as(owner, 'POST', `/poll-options/${multiPoll.options[1].id}/vote`)).body.action,
    ).toBe('cast');

    const after = (await as(owner, 'GET', `/polls/${multi.body.pollId}`)).body.poll;
    expect(after.options.every((o: { votedByMe: boolean }) => o.votedByMe)).toBe(true);
  });

  it('reads a passed deadline as closed with nobody having closed it, and refuses the vote', async () => {
    const owner = await signUp('DeadlineOwner');
    const { clubId } = await createClubAs(owner);

    const created = await as(owner, 'POST', `/clubs/${clubId}/polls`, {
      ...TWO_OPTIONS,
      closesInMinutes: 60,
    });
    const pollId = created.body.pollId;
    expect((await as(owner, 'GET', `/polls/${pollId}`)).body.poll.closed).toBe(false);

    // Move the deadline into the past rather than waiting for it. Nothing "closes" the poll:
    // closed-ness is evaluated on every read, which is why there is no job for this.
    await h.db.execute(
      sql`UPDATE polls SET closes_at = now() - interval '1 minute' WHERE id = ${pollId}`,
    );

    const view = await as(owner, 'GET', `/polls/${pollId}`);
    expect(view.body.poll.closed).toBe(true);

    const option = view.body.poll.options[0].id;
    // 409 rather than 404: the poll is visible, and "this has closed" is a different fact
    // from "there is nothing here".
    expect((await as(owner, 'POST', `/poll-options/${option}/vote`)).status).toBe(409);
  });
});

describe('poll routes: what the list row carries', () => {
  /*
   * The list card renders a tally and a countdown without opening the poll, so both have to be on
   * the summary. Pinned here because the alternative is a client that shows "0 VOTES" on a poll
   * with votes in it, and nothing else in the suite reads this row's shape.
   */
  it('sums votes ACROSS options and reports the deadline as ISO 8601', async () => {
    const owner = await signUp('ListOwner');
    const voter = await signUp('ListVoter');
    const { clubId } = await createClubAs(owner);
    await join(clubId, voter);

    const created = await as(owner, 'POST', `/clubs/${clubId}/polls`, {
      ...TWO_OPTIONS,
      allowMultiple: true,
      closesInMinutes: 60,
    });
    const pollId = created.body.pollId;
    const options = (await as(owner, 'GET', `/polls/${pollId}`)).body.poll.options;

    // A poll nobody has voted in reads 0, not null: SUM over no rows is null, and a null here
    // would render as an empty badge rather than a zero.
    const fresh = (await as(owner, 'GET', `/clubs/${clubId}/polls`)).body.polls[0];
    expect(fresh.voteCount).toBe(0);
    expect(fresh.votedByMe).toBe(false);

    // Two people, and one of them votes twice - the count is votes cast, not people.
    await as(owner, 'POST', `/poll-options/${options[0].id}/vote`);
    await as(owner, 'POST', `/poll-options/${options[1].id}/vote`);
    await as(voter, 'POST', `/poll-options/${options[0].id}/vote`);

    const row = (await as(owner, 'GET', `/clubs/${clubId}/polls`)).body.polls[0];
    expect(row.voteCount).toBe(3);
    expect(row.closed).toBe(false);
    expect(row.votedByMe).toBe(true);

    // The other member sees the same public tally and their own vote state.
    const asVoter = (await as(voter, 'GET', `/clubs/${clubId}/polls`)).body.polls[0];
    expect(asVoter.voteCount).toBe(3);
    expect(asVoter.votedByMe).toBe(true);

    /*
     * ISO 8601, not Postgres's own rendering.
     *
     * `::text` on a timestamptz produces "2026-07-30 08:42:41.123+00" - a space and a two-digit
     * offset - which `new Date()` happily parses, so eyeballing a response never catches it, and
     * a strict validator refuses it. Failure mode 14, asserted rather than trusted.
     */
    expect(row.closesAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    expect(Number.isNaN(Date.parse(row.closesAt))).toBe(false);
  });

  it('reports a null deadline for a poll that only closes by hand', async () => {
    const owner = await signUp('OpenEndedOwner');
    const { clubId } = await createClubAs(owner);
    await as(owner, 'POST', `/clubs/${clubId}/polls`, TWO_OPTIONS);

    const row = (await as(owner, 'GET', `/clubs/${clubId}/polls`)).body.polls[0];
    expect(row.closesAt).toBeNull();
    expect(row.closed).toBe(false);
  });
});

describe('poll routes: privacy and management', () => {
  it('shows counts to everyone and voter names only where privacy allows', async () => {
    const creator = await signUp('PrivacyCreator');
    const voter = await signUp('PrivacyVoter');
    const { clubId } = await createClubAs(creator);
    await join(clubId, voter, 'admin');

    const secret = await as(creator, 'POST', `/clubs/${clubId}/polls`, {
      ...TWO_OPTIONS,
      isPrivate: true,
    });
    const pollId = secret.body.pollId;
    const options = (await as(creator, 'GET', `/polls/${pollId}`)).body.poll.options;
    await as(voter, 'POST', `/poll-options/${options[0].id}/vote`);

    // The creator sees identities on their own private poll.
    const asCreator = (await as(creator, 'GET', `/polls/${pollId}`)).body.poll;
    expect(asCreator.options[0].voteCount).toBe(1);
    expect(asCreator.options[0].voters.map((v: { userId: string }) => v.userId)).toEqual([
      voter.userId,
    ]);

    // Another admin sees the count and NOT the names - null, not an empty list.
    const asVoter = (await as(voter, 'GET', `/polls/${pollId}`)).body.poll;
    expect(asVoter.options[0].voteCount).toBe(1);
    expect(asVoter.options[0].voters).toBeNull();
    // ...but always sees their own vote.
    expect(asVoter.options[0].votedByMe).toBe(true);

    // On a public poll, an eligible viewer sees the names.
    const open = await as(creator, 'POST', `/clubs/${clubId}/polls`, TWO_OPTIONS);
    const openOptions = (await as(creator, 'GET', `/polls/${open.body.pollId}`)).body.poll.options;
    await as(voter, 'POST', `/poll-options/${openOptions[0].id}/vote`);
    const openAsVoter = (await as(voter, 'GET', `/polls/${open.body.pollId}`)).body.poll;
    expect(openAsVoter.options[0].voters).toHaveLength(1);
  });

  it('offers close, reopen and delete to the creator only, including to other admins', async () => {
    const creator = await signUp('MgmtCreator');
    const otherAdmin = await signUp('MgmtOtherAdmin');
    const { clubId } = await createClubAs(creator);
    await join(clubId, otherAdmin, 'admin');

    const created = await as(creator, 'POST', `/clubs/${clubId}/polls`, TWO_OPTIONS);
    const pollId = created.body.pollId;

    // An admin who did not create it cannot close or delete it. 403 rather than 404: they can
    // see the poll, so the refusal is about authority and not about existence.
    expect((await as(otherAdmin, 'POST', `/polls/${pollId}/closed`, { closed: true })).status).toBe(
      403,
    );
    expect((await as(otherAdmin, 'DELETE', `/polls/${pollId}`)).status).toBe(403);

    // Vote first, so reopening can be shown to preserve it.
    const option = (await as(creator, 'GET', `/polls/${pollId}`)).body.poll.options[0].id;
    await as(otherAdmin, 'POST', `/poll-options/${option}/vote`);

    expect((await as(creator, 'POST', `/polls/${pollId}/closed`, { closed: true })).status).toBe(
      200,
    );
    expect((await as(creator, 'GET', `/polls/${pollId}`)).body.poll.closed).toBe(true);
    // A closed poll takes no votes.
    expect((await as(otherAdmin, 'POST', `/poll-options/${option}/vote`)).status).toBe(409);

    expect((await as(creator, 'POST', `/polls/${pollId}/closed`, { closed: false })).status).toBe(
      200,
    );
    const reopened = (await as(creator, 'GET', `/polls/${pollId}`)).body.poll;
    expect(reopened.closed).toBe(false);
    // Reopening preserved the vote.
    expect(reopened.options[0].voteCount).toBe(1);

    expect((await as(creator, 'DELETE', `/polls/${pollId}`)).status).toBe(200);
    expect((await as(creator, 'GET', `/polls/${pollId}`)).status).toBe(404);
  });
});

describe('poll routes: the Eboard scope', () => {
  it('lets any member of the space create one and hides it from an ordinary member', async () => {
    const owner = await signUp('EbPollOwner');
    const member = await signUp('EbPollMember');
    const { clubId } = await createClubAs(owner);
    await join(clubId, member);
    const eboardId = await eboardIdOf(clubId);

    // Any Eboard member creates a poll: no further role distinction inside the space.
    const created = await as(owner, 'POST', `/eboards/${eboardId}/polls`, TWO_OPTIONS);
    expect(created.status).toBe(201);

    // An ordinary club member is not in the space and is redirected off its routes.
    expect((await as(member, 'GET', `/polls/${created.body.pollId}`)).status).toBe(404);
    expect((await as(member, 'GET', `/eboards/${eboardId}/polls`)).body.polls).toEqual([]);
    expect((await as(member, 'POST', `/eboards/${eboardId}/polls`, TWO_OPTIONS)).status).toBe(404);
  });
});

describe('poll routes: unrouted scopes and bad ids', () => {
  it('answers 404 for a scope that does not exist rather than leaking which', async () => {
    const owner = await signUp('GhostOwner');
    await createClubAs(owner);
    const ghost = crypto.randomUUID();

    expect((await as(owner, 'POST', `/clubs/${ghost}/polls`, TWO_OPTIONS)).status).toBe(404);
    expect((await as(owner, 'POST', `/races/${ghost}/polls`, TWO_OPTIONS)).status).toBe(404);
    expect((await as(owner, 'POST', `/eboards/${ghost}/polls`, TWO_OPTIONS)).status).toBe(404);
    expect((await as(owner, 'GET', `/polls/${ghost}`)).status).toBe(404);
    expect((await as(owner, 'POST', `/poll-options/${ghost}/vote`)).status).toBe(404);
  });

  it('refuses every poll route without a session', async () => {
    for (const [method, url] of [
      ['GET', `/polls/${crypto.randomUUID()}`],
      ['POST', `/poll-options/${crypto.randomUUID()}/vote`],
      ['POST', `/clubs/${crypto.randomUUID()}/polls`],
      ['DELETE', `/polls/${crypto.randomUUID()}`],
    ] as const) {
      const response = await app.inject({ method, url, payload: {} });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
  });
});
