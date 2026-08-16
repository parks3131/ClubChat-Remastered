/**
 * Reporting a **person**, against a real Postgres and through the real HTTP stack.
 *
 * > **The reason this is its own file rather than three cases added to `platform-moderation`:**
 * > every other report in the product is keyed by `messageId`, and this one is not. The queue, the
 * > audited context read, the removal and the dismissal all hang off a message; a person report
 * > hangs off an account and has no evidence attached at all. That difference is the thing under
 * > test, so the assertions are about who can reach what, not about a row existing.
 *
 * Three properties, each of which is a rule somewhere and none of which a reader of the code can
 * confirm by reading it:
 *
 *  1. **One destination, always.** A club admin never sees these, no matter which club the card
 *     was opened from (ADR-0035). Proved by attempting it as a club Owner and watching the 404.
 *  2. **Invisible to its subject.** PRD/05 rule 10 and PRD/14 rule 7. Proved by asserting on the
 *     notification rows, because a subject who was told would be told by exactly that mechanism.
 *  3. **The card can only offer what the server answers.** `canReport` and the `dm` block are
 *     read here for the same reason `DESIGN/10` rule 4 exists - a client deriving either is a
 *     second definition of a rule that has one.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { buildApp } from '../api/app.ts';
import { createAuth, type Auth } from '../auth.ts';
import type { Config } from '../config.ts';
import { createClub } from '../domain/create-club.ts';
import { openDm } from '../domain/dm.ts';
import { addMember } from '../domain/membership.ts';
import { reconcilePlatformModerators } from '../domain/platform-moderators.ts';
import { loadAccessContext } from '../policy/context.ts';
import { FakeMediaStore } from '../media/store.ts';
import { silentMonitor } from '../monitoring.ts';
import { registerDevice } from '../push/dispatch.ts';
import { RecordingPushSender } from '../push/sender.ts';
import { drainOnce } from '../worker/drain.ts';
import type { EffectDeps } from '../worker/effects.ts';
import { allowAll } from './fake-limiter.ts';
import { startTestDb, type TestDb } from './harness.ts';

const ctxFor = (id: string) => loadAccessContext(h.db, id);

let h: TestDb;
let app: FastifyInstance;
let auth: Auth;
let push: RecordingPushSender;
let deferred: Array<() => Promise<void>>;
let deps: EffectDeps;

/**
 * Drain the outbox, then run whatever push evaluation it deferred.
 *
 * The report writes a row and an event in one transaction; nothing reaches a moderator until the
 * worker runs. Asserting on the outbox alone would be asserting that a producer produced, which
 * is failure mode 30's exact blind spot - a producer with no consumer parks in silence.
 */
async function drainAndPush(): Promise<void> {
  await drainOnce(h.db, deps);
  const pending = [...deferred];
  deferred = [];
  for (const fn of pending) await fn();
}

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

type Actor = { userId: string; token: string; email: string; name: string };

const PASSWORD = 'correct-horse-battery-staple';

async function signUpAs(name: string): Promise<Actor> {
  const email = `${name.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}@test.invalid`;
  const result = await auth.api.signUpEmail({ body: { name, email, password: PASSWORD } });
  const token = (result as { token?: string }).token;
  if (!token) throw new Error('sign-up returned no session token');
  return { userId: result.user.id, token, email, name };
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
 * A club with an Owner, two members, and a moderator standing outside it.
 *
 * The moderator is deliberately **not** in the club. That is the shape the routing has to survive:
 * they belong to nothing and are reachable by no membership query, which is the fact that made
 * `platformModerators` necessary in the first place.
 */
type Scene = {
  moderator: Actor;
  /** The club's Owner, who holds every club authority there is - and none of them is this one. */
  olivia: Actor;
  /** The member who reports. */
  alice: Actor;
  /** The member who is reported. */
  bob: Actor;
  /** Somebody in no club with any of them. */
  stranger: Actor;
  clubId: string;
};

async function scene(): Promise<Scene> {
  const moderator = await signUpAs('Mod');
  await reconcilePlatformModerators(h.db, [moderator.email]);

  const olivia = await signUpAs('Olivia');
  const alice = await signUpAs('Alice');
  const bob = await signUpAs('Bob');
  const stranger = await signUpAs('Stranger');

  const club = await createClub(h.db, {
    name: `Club ${crypto.randomUUID().slice(0, 6)}`,
    creatorId: olivia.userId,
  });
  await addMember(h.db, await ctxFor(olivia.userId), club.clubId, alice.userId);
  await addMember(h.db, await ctxFor(olivia.userId), club.clubId, bob.userId);

  return { moderator, olivia, alice, bob, stranger, clubId: club.clubId };
}

/** Every open report about somebody, straight from the table. */
async function openReportsAbout(userId: string): Promise<Array<{ reporter_id: string }>> {
  const rows = await h.db.execute<{ reporter_id: string }>(sql`
    SELECT reporter_id::text AS reporter_id FROM user_reports
     WHERE subject_id = ${userId} AND dismissed_at IS NULL
  `);
  return rows.rows;
}

/**
 * One subject's row out of the queue.
 *
 * > **The queue is global, and these tests share one database.** It spans every conversation and
 * > every club by design - that is what a *platform* queue is - so every scene in this file adds
 * > to the same list, and asserting on its length would be asserting on how many tests ran before
 * > this one. Every assertion here is therefore scoped to the scene's own subject.
 */
function rowFor(queue: any, subjectId: string): any[] {
  return (queue.reports as Array<{ subjectId: string }>).filter(
    (row) => row.subjectId === subjectId,
  );
}

beforeAll(async () => {
  h = await startTestDb();
  auth = createAuth(h.db, {
    secret: 'test-secret-not-a-real-one',
    baseURL: config.BETTER_AUTH_URL,
  });
  app = buildApp({
    db: h.db,
    auth,
    config,
    mediaStore: new FakeMediaStore(),
    monitor: silentMonitor(),
    limiter: allowAll(),
  });
  await app.ready();
}, 120_000);

beforeEach(async () => {
  push = new RecordingPushSender();
  deferred = [];
  /*
   * "Nobody else at all" is a stronger claim than "not this person", and it only means anything if
   * each test starts empty. Truncating is safe here and nowhere else: this is a throwaway
   * container. `user_reports` is deliberately NOT truncated - the queue is global and these tests
   * share one database, which is a property worth leaving visible rather than washing away.
   */
  await h.db.execute(sql`
    TRUNCATE notifications, push_deliveries, devices, outbox RESTART IDENTITY CASCADE
  `);
  deps = {
    db: h.db,
    redis: { publish: async () => 1 } as never,
    push,
    log: () => undefined,
    defer: (fn) => deferred.push(fn),
  };
});

afterAll(async () => {
  await app?.close().catch(() => undefined);
  await h?.stop().catch(() => undefined);
});

describe('filing a report about a person', () => {
  it('is accepted from anybody who shares a club', async () => {
    const s = await scene();

    const filed = await as(s.alice, 'POST', `/users/${s.bob.userId}/report`);

    expect(filed.status).toBe(201);
    expect(filed.body).toMatchObject({ alreadyReported: false });
    expect(await openReportsAbout(s.bob.userId)).toHaveLength(1);
  });

  it('is a no-op the second time, so a double tap is one entry in the queue', async () => {
    const s = await scene();

    const first = await as(s.alice, 'POST', `/users/${s.bob.userId}/report`);
    const second = await as(s.alice, 'POST', `/users/${s.bob.userId}/report`);

    expect(first.body).toMatchObject({ alreadyReported: false });
    // Still a 201 and still a success: the outcome the reporter wanted is true. What changes is
    // only what the client may say about it.
    expect(second.status).toBe(201);
    expect(second.body).toMatchObject({ alreadyReported: true });
    expect(await openReportsAbout(s.bob.userId)).toHaveLength(1);
  });

  it('counts a second reporter separately, because that count is the only evidence there is', async () => {
    const s = await scene();

    await as(s.alice, 'POST', `/users/${s.bob.userId}/report`);
    await as(s.olivia, 'POST', `/users/${s.bob.userId}/report`);

    expect(await openReportsAbout(s.bob.userId)).toHaveLength(2);
  });

  it('refuses a stranger, with the answer they would get for an account that did not exist', async () => {
    const s = await scene();

    const refused = await as(s.stranger, 'POST', `/users/${s.bob.userId}/report`);

    // 404 rather than 403. A distinguishable code would make this a way to test whether a given
    // uuid is a real member, which is what `GET /users/:id` refuses for the same reason.
    expect(refused.status).toBe(404);
    expect(await openReportsAbout(s.bob.userId)).toHaveLength(0);
  });

  it('refuses reporting yourself', async () => {
    const s = await scene();

    expect((await as(s.alice, 'POST', `/users/${s.alice.userId}/report`)).status).toBe(404);
    expect(await openReportsAbout(s.alice.userId)).toHaveLength(0);
  });

  it('refuses an id that is not a uuid, rather than letting it reach the database', async () => {
    const s = await scene();
    expect((await as(s.alice, 'POST', '/users/not-a-uuid/report')).status).toBe(404);
  });

  it('survives a block in either direction, because blocking must not close the reporting path', async () => {
    const s = await scene();

    // Alice blocks Bob and then reports him, which is the ordinary sequence for somebody
    // protecting themselves: the instant half first, the reviewed half second.
    expect((await as(s.alice, 'POST', '/blocks', { userId: s.bob.userId })).status).toBeLessThan(300);

    const filed = await as(s.alice, 'POST', `/users/${s.bob.userId}/report`);

    expect(filed.status).toBe(201);
    expect(await openReportsAbout(s.bob.userId)).toHaveLength(1);
  });
});

describe('who the report reaches', () => {
  it('reaches a platform moderator', async () => {
    const s = await scene();
    await as(s.alice, 'POST', `/users/${s.bob.userId}/report`);

    const queue = await as(s.moderator, 'GET', '/moderation/user-reports');
    const rows = rowFor(queue.body, s.bob.userId);

    expect(queue.status).toBe(200);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      subjectId: s.bob.userId,
      subjectName: 'Bob',
      subjectSuspended: false,
    });
    expect(rows[0].reporters).toHaveLength(1);
    expect(rows[0].reporters[0]).toMatchObject({ userId: s.alice.userId });
  });

  it('does NOT reach the club Owner, who holds every other authority over both of them', async () => {
    const s = await scene();
    await as(s.alice, 'POST', `/users/${s.bob.userId}/report`);

    // The decision in ADR-0035, proved rather than read. Olivia can remove Bob, ban Bob and read
    // every report raised in her club's chat - and this one is not hers.
    expect((await as(s.olivia, 'GET', '/moderation/user-reports')).status).toBe(404);
  });

  it('does not reach its subject, and does not reach the reporter either', async () => {
    const s = await scene();
    await as(s.alice, 'POST', `/users/${s.bob.userId}/report`);

    expect((await as(s.bob, 'GET', '/moderation/user-reports')).status).toBe(404);
    expect((await as(s.alice, 'GET', '/moderation/user-reports')).status).toBe(404);
  });

  it('groups several reporters into one row, because the decision is about the account', async () => {
    const s = await scene();
    await as(s.alice, 'POST', `/users/${s.bob.userId}/report`);
    await as(s.olivia, 'POST', `/users/${s.bob.userId}/report`);

    const rows = rowFor((await as(s.moderator, 'GET', '/moderation/user-reports')).body, s.bob.userId);

    expect(rows).toHaveLength(1);
    expect(rows[0].reporters).toHaveLength(2);
  });

  it('writes an outbox event, so the notification cannot be lost by a crash after the row', async () => {
    const s = await scene();
    await as(s.alice, 'POST', `/users/${s.bob.userId}/report`);

    const events = await h.db.execute<{ payload: any }>(sql`
      SELECT payload FROM outbox
       WHERE event_type = 'user.reported' AND payload->>'subjectId' = ${s.bob.userId}
    `);

    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]?.payload).toMatchObject({
      subjectId: s.bob.userId,
      reporterId: s.alice.userId,
    });
  });

  it('writes no second event for a repeat, so a moderator is not buzzed twice', async () => {
    const s = await scene();
    await as(s.alice, 'POST', `/users/${s.bob.userId}/report`);
    await as(s.alice, 'POST', `/users/${s.bob.userId}/report`);

    const events = await h.db.execute<{ id: string }>(sql`
      SELECT id::text AS id FROM outbox
       WHERE event_type = 'user.reported' AND payload->>'subjectId' = ${s.bob.userId}
    `);

    expect(events.rows).toHaveLength(1);
  });
});

/**
 * **The half that the outbox assertions above cannot reach.**
 *
 * A producer with no consumer parks in silence (failure mode 30): `dispatch` throws on an unknown
 * event type, the drain absorbs a handler failure into `attempts`, and together they mean an event
 * nobody handles produces no notification, no error anybody sees, and no failing test. Three Eboard
 * event types lived that way for the whole life of the space.
 *
 * So these drain for real and assert on who ended up with a row.
 */
describe('the notification the report produces', () => {
  /** Who was told about a report. Scoped by the actor, because the table outlives each test. */
  async function toldBy(reporterName: string): Promise<string[]> {
    const rows = await h.db.execute<{ recipient_id: string }>(sql`
      SELECT recipient_id::text AS recipient_id
        FROM notifications
       WHERE type = 'user_reported' AND params->>'actorName' = ${reporterName}
    `);
    return rows.rows.map((r) => r.recipient_id);
  }

  it('reaches the moderator and nobody else at all', async () => {
    const s = await scene();
    await as(s.alice, 'POST', `/users/${s.bob.userId}/report`);

    await drainAndPush();

    const told = await toldBy('Alice');
    expect(told).toEqual([s.moderator.userId]);
    // The three that matter, stated one at a time so a failure names which rule broke.
    expect(told, 'the reported member was told').not.toContain(s.bob.userId);
    expect(told, 'the reporter was told about their own report').not.toContain(s.alice.userId);
    expect(told, 'the club Owner was told').not.toContain(s.olivia.userId);
  });

  it('carries the reporter and never the subject, so a lock screen cannot leak an accusation', async () => {
    const s = await scene();
    await as(s.alice, 'POST', `/users/${s.bob.userId}/report`);
    await drainAndPush();

    const rows = await h.db.execute<{ params: Record<string, unknown> }>(sql`
      SELECT params FROM notifications
       WHERE type = 'user_reported' AND recipient_id = ${s.moderator.userId}
    `);

    expect(rows.rows[0]?.params).toEqual({ actorName: 'Alice' });
    // Asserted as an exact shape rather than field by field: the point is that nothing ELSE is
    // there, and a `not.toHaveProperty` sweep would only catch the names somebody thought of.
    expect(rows.rows[0]?.params).not.toHaveProperty('subjectId');
  });

  it('buzzes the moderator, because a work queue nobody is told about is the defect this exists to avoid', async () => {
    const s = await scene();
    await registerDevice(h.db, {
      userId: s.moderator.userId,
      pushToken: 'mod-phone',
      platform: 'ios',
    });

    await as(s.alice, 'POST', `/users/${s.bob.userId}/report`);
    await drainAndPush();

    // Not suppressed by a read cursor, and there is nothing here that could be: a person report
    // has no conversation, so the "having read it is not having reviewed it" rule the message
    // version states explicitly is true here by construction.
    const sent = push.sent.filter((p) => p.token === 'mod-phone');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toContain('Alice');
    // The rule the params schema exists to enforce, checked where it actually lands: on a screen
    // somebody can read without unlocking their phone.
    expect(sent[0]?.body, 'the push named the reported member').not.toContain('Bob');
    expect(sent[0]?.title, 'the push title named somebody').toBe('Moderation');
  });
});

describe('working the queue', () => {
  it('dismisses every open report about one person at once', async () => {
    const s = await scene();
    await as(s.alice, 'POST', `/users/${s.bob.userId}/report`);
    await as(s.olivia, 'POST', `/users/${s.bob.userId}/report`);

    const done = await as(
      s.moderator,
      'POST',
      `/moderation/user-reports/${s.bob.userId}/dismiss`,
    );

    expect(done.status).toBe(200);
    // Both, not one. Clearing them singly would leave a row saying "two people reported this"
    // that has already been judged.
    expect(done.body).toMatchObject({ dismissed: 2 });
    expect(await openReportsAbout(s.bob.userId)).toHaveLength(0);
    expect(
      rowFor((await as(s.moderator, 'GET', '/moderation/user-reports')).body, s.bob.userId),
    ).toEqual([]);
  });

  it('keeps a dismissed report rather than deleting it', async () => {
    const s = await scene();
    await as(s.alice, 'POST', `/users/${s.bob.userId}/report`);
    await as(s.moderator, 'POST', `/moderation/user-reports/${s.bob.userId}/dismiss`);

    const rows = rowFor((await as(s.moderator, 'GET', '/moderation/user-reports?all=true')).body, s.bob.userId);

    // "This was reviewed and was nothing" is a different fact from "this never happened", and a
    // queue that forgets its decisions invites the same report to be re-litigated.
    expect(rows).toHaveLength(1);
    expect(rows[0].dismissedAt).not.toBeNull();
  });

  it('refuses dismissal to a club Owner, so the read and the write agree', async () => {
    const s = await scene();
    await as(s.alice, 'POST', `/users/${s.bob.userId}/report`);

    expect(
      (await as(s.olivia, 'POST', `/moderation/user-reports/${s.bob.userId}/dismiss`)).status,
    ).toBe(404);
    // Still open. A refusal that refuses and writes anyway is worse than one that does neither.
    expect(await openReportsAbout(s.bob.userId)).toHaveLength(1);
  });

  it('says whether the account is already suspended, so the queue never offers a no-op', async () => {
    const s = await scene();
    await as(s.alice, 'POST', `/users/${s.bob.userId}/report`);
    await as(s.moderator, 'POST', `/moderation/users/${s.bob.userId}/suspended`, {
      suspended: true,
    });

    const rows = rowFor((await as(s.moderator, 'GET', '/moderation/user-reports')).body, s.bob.userId);

    expect(rows[0]).toMatchObject({ subjectSuspended: true });
  });
});

describe('what the member card is allowed to draw', () => {
  it('offers Report on somebody you share a club with', async () => {
    const s = await scene();

    const card = await as(s.alice, 'GET', `/users/${s.bob.userId}?clubId=${s.clubId}`);

    expect(card.status).toBe(200);
    expect(card.body.canReport).toBe(true);
  });

  it('does not offer Report on your own card', async () => {
    const s = await scene();

    const card = await as(s.alice, 'GET', `/users/${s.alice.userId}?clubId=${s.clubId}`);

    expect(card.body.canReport).toBe(false);
  });

  it('carries no dm block until a conversation exists', async () => {
    const s = await scene();

    const before = await as(s.alice, 'GET', `/users/${s.bob.userId}?clubId=${s.clubId}`);

    // The whole reason the flag rides on this read: with no thread there is nothing for Mute and
    // Delete chat to act on, so the card must not draw them. See `ProfileDmActions`.
    expect(before.body.dm).toBeUndefined();
  });

  it('carries the channel once a conversation exists, and never creates one to find out', async () => {
    const s = await scene();

    // Reading the card must not bring a thread into being. Asserted before opening one, because
    // afterwards the two states are indistinguishable.
    await as(s.alice, 'GET', `/users/${s.bob.userId}?clubId=${s.clubId}`);
    const conversations = await h.db.execute<{ id: string }>(sql`
      SELECT id::text AS id FROM dm_conversations
       WHERE (user_a = ${s.alice.userId} AND user_b = ${s.bob.userId})
          OR (user_a = ${s.bob.userId} AND user_b = ${s.alice.userId})
    `);
    expect(conversations.rows).toHaveLength(0);

    const opened = await openDm(h.db, await ctxFor(s.alice.userId), s.bob.userId);
    if (!opened.ok) throw new Error('could not open the conversation');

    const after = await as(s.alice, 'GET', `/users/${s.bob.userId}?clubId=${s.clubId}`);
    expect(after.body.dm).toMatchObject({ channelId: opened.channelId, muted: false });
  });

  it('reports the mute state, so the card says Unmute because the server does', async () => {
    const s = await scene();
    const opened = await openDm(h.db, await ctxFor(s.alice.userId), s.bob.userId);
    if (!opened.ok) throw new Error('could not open the conversation');

    await as(s.alice, 'POST', `/channels/${opened.channelId}/mute`, {});
    expect((await as(s.alice, 'GET', `/users/${s.bob.userId}`)).body.dm).toMatchObject({
      muted: true,
    });

    await as(s.alice, 'DELETE', `/channels/${opened.channelId}/mute`);
    expect((await as(s.alice, 'GET', `/users/${s.bob.userId}`)).body.dm).toMatchObject({
      muted: false,
    });
  });

  it('shows the other side their own view of the same thread', async () => {
    const s = await scene();
    const opened = await openDm(h.db, await ctxFor(s.alice.userId), s.bob.userId);
    if (!opened.ok) throw new Error('could not open the conversation');

    await as(s.alice, 'POST', `/channels/${opened.channelId}/mute`, {});

    // Mute is per member. Bob opening Alice's card must see his own state, not hers - the same
    // channel, two rows, and the join is keyed on the caller.
    expect((await as(s.bob, 'GET', `/users/${s.alice.userId}`)).body.dm).toMatchObject({
      channelId: opened.channelId,
      muted: false,
    });
  });

  it('treats a lapsed mute as no mute', async () => {
    const s = await scene();
    const opened = await openDm(h.db, await ctxFor(s.alice.userId), s.bob.userId);
    if (!opened.ok) throw new Error('could not open the conversation');

    // A row whose expiry has passed. The row's existence is not the mute once `muted_until` is
    // set, which is the half of `muteInForce` that a hand-written copy loses.
    await h.db.execute(sql`
      INSERT INTO channel_mutes (user_id, channel_id, muted_until)
      VALUES (${s.alice.userId}, ${opened.channelId}, now() - interval '1 hour')
    `);

    expect((await as(s.alice, 'GET', `/users/${s.bob.userId}`)).body.dm).toMatchObject({
      muted: false,
    });
  });
});
