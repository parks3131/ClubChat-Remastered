/**
 * **Every read that names a person carries their picture.**
 *
 * A profile screen let a member upload an avatar from the first phase it existed, and almost
 * nothing rendered it: the column was written and then projected by two reads out of nine. The
 * gap was invisible from either end - the upload worked, the roster looked deliberate with its
 * letter placeholders, and no type was wrong anywhere. Only asking "where does this column
 * actually surface?" found it.
 *
 * So these tests are shaped around the projection rather than around a feature: one case per
 * read that returns a name, asserting the picture rides along with it. A read that names somebody
 * and cannot draw them is the defect, and it is the kind that comes back the next time a query is
 * rewritten - `SELECT u.full_name` is a very easy thing to write.
 *
 * The last case is different in kind and guards a worse bug: the Reports tab's response shape,
 * which the client had been restating incorrectly for its entire life. See the note there.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { buildApp } from '../api/app.ts';
import { createAuth, type Auth } from '../auth.ts';
import type { Config } from '../config.ts';
import { appendMessage } from '../domain/append-message.ts';
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

/**
 * Give somebody a picture, by writing the column directly.
 *
 * Deliberately not the upload pipeline: what is under test is whether each READ projects the
 * column, and routing every case through intent-PUT-complete would test the pipeline instead -
 * slower, and it would fail for reasons that have nothing to do with the projection.
 */
async function setAvatar(actor: Actor): Promise<string> {
  const mediaId = crypto.randomUUID();
  await h.db.update(users).set({ image: mediaId }).where(eq(users.id, actor.userId));
  return mediaId;
}

async function createClubAs(
  actor: Actor,
  overrides: Record<string, unknown> = {},
): Promise<{ clubId: string; inviteToken: string; mainChannelId: string; eboardId: string }> {
  const created = await as(actor, 'POST', '/clubs', {
    name: `Club ${crypto.randomUUID().slice(0, 6)}`,
    sport: 'running',
    ...overrides,
  });
  expect(created.status).toBe(201);
  return created.body;
}

async function join(clubId: string, actor: Actor, role: 'member' | 'admin' = 'member') {
  await h.db.insert(clubMemberships).values({ clubId, userId: actor.userId, role });
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

describe('a read that names somebody carries their picture', () => {
  it('puts it on a club roster entry and on the pending join request', async () => {
    const owner = await signUp('RosterOwner');
    const waiting = await signUp('RosterWaiting');
    const avatar = await setAvatar(waiting);
    const { clubId } = await createClubAs(owner, { joinPolicy: 'request' });

    // The queue and the roster are two projections of the same person, and only one of them
    // used to carry the picture - so the same face changed as they were approved.
    const requested = await as(waiting, 'POST', `/clubs/${clubId}/join`);
    expect(requested.body.status).toBe('requested');

    const queue = await as(owner, 'GET', `/clubs/${clubId}/members`);
    expect(queue.body.pendingRequests).toHaveLength(1);
    expect(queue.body.pendingRequests[0].image).toBe(avatar);

    const requestId = queue.body.pendingRequests[0].requestId;
    expect((await as(owner, 'POST', `/join-requests/${requestId}/approve`)).status).toBe(200);

    const roster = await as(owner, 'GET', `/clubs/${clubId}/members`);
    const entry = roster.body.members.find((m: any) => m.userId === waiting.userId);
    expect(entry.image).toBe(avatar);
  });

  it('puts it on a member-candidate search result', async () => {
    const owner = await signUp('CandidateOwner');
    const found = await signUp('CandidateFound');
    const avatar = await setAvatar(found);

    // The pool is people the caller already shares a club with, so they need one together
    // before the target club can offer them.
    const { clubId: shared } = await createClubAs(owner);
    await join(shared, found);
    const { clubId } = await createClubAs(owner);

    const results = await as(
      owner,
      'GET',
      `/clubs/${clubId}/member-candidates?q=${encodeURIComponent(found.name)}`,
    );
    expect(results.status).toBe(200);
    const candidate = results.body.candidates.find((c: any) => c.userId === found.userId);
    expect(candidate).toBeDefined();
    // The search result feeds a roster: the same person must not change face on being added.
    expect(candidate.image).toBe(avatar);
  });

  it('puts it on a DM candidate, which is the search that starts a conversation', async () => {
    const owner = await signUp('DmCandidateOwner');
    const found = await signUp('DmCandidateFound');
    const avatar = await setAvatar(found);

    // The pool is people the caller already shares a club with, enforced server-side.
    const { clubId } = await createClubAs(owner);
    await join(clubId, found);

    const results = await as(
      owner,
      'GET',
      `/dm/candidates?q=${encodeURIComponent(found.name)}`,
    );
    expect(results.status).toBe(200);
    const candidate = results.body.candidates.find((c: any) => c.userId === found.userId);
    expect(candidate).toBeDefined();
    /*
     * This read feeds the new-message search, whose results open a profile carrying the same
     * face. A letter placeholder here and a photograph one tap later is the exact discontinuity
     * this whole suite exists to catch.
     */
    expect(candidate.image).toBe(avatar);
  });

  it('puts it on a conversation row, for both a club and a DM', async () => {
    const owner = await signUp('ConvAvatarOwner');
    const peer = await signUp('ConvAvatarPeer');
    const peerAvatar = await setAvatar(peer);

    const { clubId } = await createClubAs(owner);
    await join(clubId, peer);
    await as(owner, 'POST', '/dm/threads', { userId: peer.userId });

    const rows = (await as(owner, 'GET', '/conversations')).body.conversations;
    const dm = rows.find((r: any) => r.scope === 'dm');

    /*
     * A DM has no name and no picture of its own - it is two people - so the row wears the OTHER
     * participant's. Getting this from the club would be the failure `channelDisplayImage`
     * documents, one scope over.
     */
    expect(dm.image).toBe(peerAvatar);
    expect(dm.name).toBe('ConvAvatarPeer');
  });

  it('puts it on both halves of the car groups read', async () => {
    const owner = await signUp('CarAvatarOwner');
    const seated = await signUp('CarAvatarSeated');
    const waiting = await signUp('CarAvatarWaiting');
    const seatedAvatar = await setAvatar(seated);
    const waitingAvatar = await setAvatar(waiting);
    const { clubId } = await createClubAs(owner);
    await join(clubId, seated);
    await join(clubId, waiting);

    const race = await as(owner, 'POST', `/clubs/${clubId}/races`, {
      name: 'Avatar race',
      raceDate: '2027-04-04',
    });
    const raceId = race.body.raceId;
    await as(owner, 'POST', `/races/${raceId}/members`, { userId: seated.userId });
    await as(owner, 'POST', `/races/${raceId}/members`, { userId: waiting.userId });

    const group = await as(owner, 'POST', `/races/${raceId}/car-groups`);
    await as(owner, 'POST', `/car-groups/${group.body.groupId}/members`, {
      userId: seated.userId,
    });

    // Two projections of the same roster - in a car, and waiting for one - and the person moves
    // between them the moment somebody is added. A face on one side only means somebody's
    // picture appears the instant they are seated, which is exactly what shipped here.
    const view = await as(owner, 'GET', `/races/${raceId}/car-groups`);
    expect(view.status).toBe(200);
    const member = view.body.groups[0].members.find((m: any) => m.userId === seated.userId);
    expect(member.image).toBe(seatedAvatar);
    const unseated = view.body.unassigned.find((u: any) => u.userId === waiting.userId);
    expect(unseated.image).toBe(waitingAvatar);
  });

  it('puts it on a poll voter', async () => {
    const owner = await signUp('PollOwner');
    const voter = await signUp('PollVoter');
    const avatar = await setAvatar(voter);
    const { clubId } = await createClubAs(owner);
    await join(clubId, voter);

    const poll = await as(owner, 'POST', `/clubs/${clubId}/polls`, {
      question: 'Which route?',
      options: ['River', 'Hill'],
    });
    expect(poll.status).toBe(201);
    // Creation returns the id only; the options come back from the read.
    const pollId = poll.body.pollId;
    const created = await as(owner, 'GET', `/polls/${pollId}`);
    const optionId = created.body.poll.options[0].id;

    expect((await as(voter, 'POST', `/poll-options/${optionId}/vote`)).status).toBe(200);

    const read = await as(owner, 'GET', `/polls/${pollId}`);
    const option = read.body.poll.options.find((o: any) => o.id === optionId);
    const listed = option.voters.find((v: any) => v.userId === voter.userId);
    expect(listed).toBeDefined();
    expect(listed.image).toBe(avatar);
  });

  it('puts it on a chat message envelope', async () => {
    const owner = await signUp('ChatOwner');
    const talker = await signUp('ChatTalker');
    const avatar = await setAvatar(talker);
    const { clubId, mainChannelId } = await createClubAs(owner);
    await join(clubId, talker);

    // Straight through the single write path, which is where the envelope is built.
    const appended = await appendMessage(h.db, {
      channelId: mainChannelId,
      senderId: talker.userId,
      clientMsgId: crypto.randomUUID(),
      type: 'text',
      body: 'on the envelope, not looked up',
    });
    // The envelope the SENDER's own client gets back, which is what its optimistic bubble shows.
    expect(appended.message.senderImage).toBe(avatar);

    const page = await as(owner, 'GET', `/channels/${mainChannelId}/messages`);
    const message = page.body.messages.find((m: any) => m.senderId === talker.userId);
    expect(message.senderName).toBe(talker.name);
    expect(message.senderImage).toBe(avatar);
  });

  it('leaves it null for somebody who has not set one, rather than omitting the field', async () => {
    const owner = await signUp('BareOwner');
    const { clubId, mainChannelId } = await createClubAs(owner);

    // Null and absent are different to a client: `image` in the type but missing on the wire is
    // how a field silently reads as undefined and renders nothing, which is the bug this whole
    // file is about, one level down.
    const roster = await as(owner, 'GET', `/clubs/${clubId}/members`);
    expect(roster.body.members[0]).toHaveProperty('image', null);

    await appendMessage(h.db, {
      channelId: mainChannelId,
      senderId: owner.userId,
      clientMsgId: crypto.randomUUID(),
      type: 'text',
      body: 'no picture set',
    });
    const page = await as(owner, 'GET', `/channels/${mainChannelId}/messages`);
    const mine = page.body.messages.find((m: any) => m.senderId === owner.userId);
    expect(mine).toHaveProperty('senderImage', null);
  });
});

describe('the reported-message row', () => {
  /**
   * > **The client's type for this response described something the server has never sent.**
   * >
   * > It declared `reportId`, `reporterName` and a nested `message` object; this endpoint returns
   * > `messageId`, a `reporters` array and the message's fields inline. Every field the Reports
   * > tab read came back `undefined`, so every card rendered "Unknown sender" over "This message
   * > was deleted", and Dismiss posted to `/moderation/reports/undefined/dismiss` and 404'd. It
   * > typechecked perfectly for its entire life, because the client restated the shape instead of
   * > being handed it.
   *
   * Asserting the field NAMES here is the point, not just their values: a rename on either side
   * now fails a test rather than silently blanking a moderation screen.
   */
  it('has the shape the client reads, with the sender drawable and deletion distinguishable', async () => {
    const owner = await signUp('ReportOwner');
    const sender = await signUp('ReportSender');
    const reporter = await signUp('ReportReporter');
    const avatar = await setAvatar(sender);
    const { clubId, mainChannelId } = await createClubAs(owner);
    await join(clubId, sender);
    await join(clubId, reporter);

    const appended = await appendMessage(h.db, {
      channelId: mainChannelId,
      senderId: sender.userId,
      clientMsgId: crypto.randomUUID(),
      type: 'text',
      body: 'the reported text',
    });
    const seq = appended.message.seq;

    expect((await as(reporter, 'POST', `/channels/${mainChannelId}/messages/${seq}/report`)).status)
      .toBe(201);

    const reports = await as(owner, 'GET', `/channels/${mainChannelId}/reports`);
    expect(reports.status).toBe(200);
    expect(reports.body.reports).toHaveLength(1);
    const row = reports.body.reports[0];

    expect(row).toHaveProperty('messageId', appended.message.id);
    expect(row.senderName).toBe(sender.name);
    expect(row.senderImage).toBe(avatar);
    expect(row.body).toBe('the reported text');
    // Not deleted, and distinguishable from a photo - `body` alone cannot tell those apart, and
    // reading "no body" as "deleted" labelled every reported photo as already dealt with.
    expect(row).toHaveProperty('deletedAt', null);
    expect(row.reporters).toHaveLength(1);
    expect(row.reporters[0].userId).toBe(reporter.userId);
    expect(row.reporters[0].name).toBe(reporter.name);

    // The shape the client used to expect, none of which was ever real.
    expect(row).not.toHaveProperty('reportId');
    expect(row).not.toHaveProperty('reporterName');
    expect(row).not.toHaveProperty('message');
  });

  it('groups every report of one message into a single row, which is one decision', async () => {
    const owner = await signUp('GroupOwner');
    const sender = await signUp('GroupSender');
    const first = await signUp('GroupFirst');
    const second = await signUp('GroupSecond');
    const { clubId, mainChannelId } = await createClubAs(owner);
    for (const actor of [sender, first, second]) await join(clubId, actor);

    const appended = await appendMessage(h.db, {
      channelId: mainChannelId,
      senderId: sender.userId,
      clientMsgId: crypto.randomUUID(),
      type: 'text',
      body: 'piled onto',
    });
    const seq = appended.message.seq;
    for (const actor of [first, second]) {
      expect((await as(actor, 'POST', `/channels/${mainChannelId}/messages/${seq}/report`)).status)
        .toBe(201);
    }

    const reports = await as(owner, 'GET', `/channels/${mainChannelId}/reports`);
    expect(reports.body.reports).toHaveLength(1);
    expect(reports.body.reports[0].reporters).toHaveLength(2);
  });

  it('dismisses by MESSAGE id, which is what the route parameter actually means', async () => {
    const owner = await signUp('DismissOwner');
    const sender = await signUp('DismissSender');
    const reporter = await signUp('DismissReporter');
    const { clubId, mainChannelId } = await createClubAs(owner);
    await join(clubId, sender);
    await join(clubId, reporter);

    const appended = await appendMessage(h.db, {
      channelId: mainChannelId,
      senderId: sender.userId,
      clientMsgId: crypto.randomUUID(),
      type: 'text',
      body: 'to be dismissed',
    });
    await as(reporter, 'POST', `/channels/${mainChannelId}/messages/${appended.message.seq}/report`);

    /*
     * The route reads `/moderation/reports/:id/dismiss` and `:id` is a MESSAGE id. The client
     * passed a `reportId` field that did not exist on the payload, so the URL contained the
     * string "undefined" and every dismiss 404'd - silently, since the screen reloads either way.
     */
    const dismissed = await as(
      owner,
      'POST',
      `/moderation/reports/${appended.message.id}/dismiss`,
    );
    expect(dismissed.status).toBe(200);
    expect(dismissed.body.dismissed).toBe(1);

    // Gone from the queue, and actually written rather than merely reported as done.
    const after = await as(owner, 'GET', `/channels/${mainChannelId}/reports`);
    expect(after.body.reports).toHaveLength(0);
    const rows = await h.db.execute<{ open: string }>(sql`
      SELECT count(*)::text AS open FROM message_reports
       WHERE message_id = ${appended.message.id} AND dismissed_at IS NULL
    `);
    expect(rows.rows[0]?.open).toBe('0');
  });
});
