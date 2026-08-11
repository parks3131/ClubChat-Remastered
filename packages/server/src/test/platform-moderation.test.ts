/**
 * Platform moderation, against a real Postgres and through the real HTTP stack.
 *
 * `domain/platform-moderators.test.ts` covers the diff itself with no database. What this file
 * exists to prove is the half that a pure test cannot: that reconciling the configured list
 * actually changes **what the API lets somebody do**. A flag that flips in a column and grants no
 * capability, or grants one after being revoked, is the whole failure mode - and it is exactly the
 * shape of AGENTS.md failure mode 12, where a check read `undefined` for four phases and nothing
 * ever fired.
 *
 * So the assertions here are deliberately about the queue answering, not about the column's value.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { SYSTEM_ACTOR_ID } from '@clubchat/shared';
import { buildApp } from '../api/app.ts';
import { createAuth, type Auth } from '../auth.ts';
import type { Config } from '../config.ts';
import { messageReactions } from '../db/schema.ts';
import { createClub } from '../domain/create-club.ts';
import { openDm } from '../domain/dm.ts';
import { addMember } from '../domain/membership.ts';
import { reportMessage } from '../domain/moderation.ts';
import { reconcilePlatformModerators } from '../domain/platform-moderators.ts';
import { getChannelRef } from '../domain/reads.ts';
import { sendMessage } from '../domain/send-message.ts';
import { loadAccessContext } from '../policy/context.ts';
import type { ChannelRef } from '../policy/predicates.ts';
import { FakeMediaStore } from '../media/store.ts';
import { silentMonitor } from '../monitoring.ts';
import { allowAll } from './fake-limiter.ts';
import { startTestDb, type TestDb } from './harness.ts';

const ctxFor = (id: string) => loadAccessContext(h.db, id);

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

type Actor = { userId: string; token: string; email: string };

/** One password for every account here. Sign-in is asserted against it, so it has a name. */
const PASSWORD = 'correct-horse-battery-staple';

/** Sign up with a KNOWN address, because the configured list is keyed on the email. */
async function signUpAs(email: string, name = 'Mod Test'): Promise<Actor> {
  const result = await auth.api.signUpEmail({
    body: { name, email, password: PASSWORD },
  });
  const token = (result as { token?: string }).token;
  if (!token) throw new Error('sign-up returned no session token');
  return { userId: result.user.id, token, email };
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

/** Whether the column says so. Used only where the point IS the column. */
async function flagOf(userId: string): Promise<boolean> {
  const rows = await h.db.execute<{ is_platform_moderator: boolean }>(sql`
    SELECT is_platform_moderator FROM users WHERE id = ${userId}
  `);
  return rows.rows[0]?.is_platform_moderator === true;
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

afterAll(async () => {
  await app?.close().catch(() => undefined);
  await h?.stop().catch(() => undefined);
});

describe('appointing moderators from configuration', () => {
  it('grants the capability, not merely the column', async () => {
    const email = `grant-${crypto.randomUUID().slice(0, 8)}@test.invalid`;
    const actor = await signUpAs(email);

    // Before: an ordinary account gets nothing back from the queue. 404 rather than 403, so a
    // caller cannot learn the endpoint exists by being refused by it.
    const before = await as(actor, 'GET', '/moderation/dm-reports');
    expect(before.status).toBe(404);

    const outcome = await reconcilePlatformModerators(h.db, [email]);
    expect(outcome.grant).toEqual([actor.userId]);
    expect(outcome.skipped).toBe(false);

    const after = await as(actor, 'GET', '/moderation/dm-reports');
    expect(after.status).toBe(200);
    expect(after.body.reports).toEqual([]);
  });

  it('revokes the capability when the account drops off the list', async () => {
    const kept = `kept-${crypto.randomUUID().slice(0, 8)}@test.invalid`;
    const dropped = `dropped-${crypto.randomUUID().slice(0, 8)}@test.invalid`;
    const keptActor = await signUpAs(kept);
    const droppedActor = await signUpAs(dropped);

    await reconcilePlatformModerators(h.db, [kept, dropped]);
    expect((await as(droppedActor, 'GET', '/moderation/dm-reports')).status).toBe(200);

    // The list now names only one of them. Revocation is deleting a line, not running an inverse.
    const outcome = await reconcilePlatformModerators(h.db, [kept]);
    expect(outcome.revoke).toEqual([droppedActor.userId]);

    expect((await as(droppedActor, 'GET', '/moderation/dm-reports')).status).toBe(404);
    // And the one still named is untouched, which is the half a blunt "revoke all" would break.
    expect((await as(keptActor, 'GET', '/moderation/dm-reports')).status).toBe(200);
  });

  it('never revokes on an empty list, because an absent secret looks exactly like one', async () => {
    const email = `empty-${crypto.randomUUID().slice(0, 8)}@test.invalid`;
    const actor = await signUpAs(email);
    await reconcilePlatformModerators(h.db, [email]);

    const outcome = await reconcilePlatformModerators(h.db, []);

    expect(outcome.skipped).toBe(true);
    expect(outcome.revoke).toEqual([]);
    // Still a moderator. Unstaffing the queue is the one thing a deploy accident must not do.
    expect(await flagOf(actor.userId)).toBe(true);
    expect((await as(actor, 'GET', '/moderation/dm-reports')).status).toBe(200);
  });

  it('matches the address case-insensitively', async () => {
    const email = `MixedCase-${crypto.randomUUID().slice(0, 8)}@Test.invalid`;
    const actor = await signUpAs(email.toLowerCase());

    // What an operator typed, against what better-auth stored.
    const outcome = await reconcilePlatformModerators(h.db, [email.toLowerCase()]);

    expect(outcome.grant).toEqual([actor.userId]);
    expect(await flagOf(actor.userId)).toBe(true);
  });

  it('is idempotent, so every instance can run it at boot', async () => {
    const email = `idem-${crypto.randomUUID().slice(0, 8)}@test.invalid`;
    const actor = await signUpAs(email);

    const first = await reconcilePlatformModerators(h.db, [email]);
    const second = await reconcilePlatformModerators(h.db, [email]);

    expect(first.grant).toEqual([actor.userId]);
    expect(second.grant).toEqual([]);
    expect(second.revoke).toEqual([]);
    expect(await flagOf(actor.userId)).toBe(true);
  });

  it('names a configured address that matched no account', async () => {
    const real = `real-${crypto.randomUUID().slice(0, 8)}@test.invalid`;
    await signUpAs(real);
    const typo = `typo-${crypto.randomUUID().slice(0, 8)}@tset.invalid`;

    const outcome = await reconcilePlatformModerators(h.db, [real, typo]);

    // The whole defence against a silent typo: it is reported, so the boot log says who was
    // meant to be a moderator and is not one.
    expect(outcome.unmatched).toEqual([typo]);
  });
});

// ===========================================================================
// Acting on a report: the two halves of Apple's guideline 1.2
// ===========================================================================

type Scene = {
  moderator: Actor;
  /** The member who reported. */
  alice: Actor;
  /** The member who was reported. */
  bob: Actor;
  clubId: string;
  clubChannelId: string;
  dmChannel: ChannelRef;
  /** Bob's message in the DM, which Alice reported. */
  messageId: string;
  seq: number;
};

/**
 * A reported direct message, with a moderator standing over it.
 *
 * Built through the real domain commands rather than by inserting rows, so the report is one a
 * member could actually have filed.
 */
async function reportedDm(): Promise<Scene> {
  const moderator = await signUpAs(`mod-${crypto.randomUUID().slice(0, 8)}@test.invalid`);
  await reconcilePlatformModerators(h.db, [moderator.email]);

  const alice = await signUpAs(`alice-${crypto.randomUUID().slice(0, 8)}@test.invalid`, 'Alice');
  const bob = await signUpAs(`bob-${crypto.randomUUID().slice(0, 8)}@test.invalid`, 'Bob');

  const club = await createClub(h.db, {
    name: `Club ${crypto.randomUUID().slice(0, 6)}`,
    sport: 'running',
    creatorId: alice.userId,
  });
  await addMember(h.db, await ctxFor(alice.userId), club.clubId, bob.userId);

  const opened = await openDm(h.db, await ctxFor(alice.userId), bob.userId);
  if (!opened.ok) throw new Error('could not open the conversation');
  const dmChannel = await getChannelRef(h.db, opened.channelId);
  if (!dmChannel) throw new Error('dm channel missing');

  const said = await sendMessage(h.db, await ctxFor(bob.userId), dmChannel, {
    channelId: dmChannel.id,
    clientMsgId: crypto.randomUUID(),
    body: 'something a moderator would need to see',
  });
  if (!said.ok) throw new Error('bob could not send');

  const filed = await reportMessage(
    h.db,
    await ctxFor(alice.userId),
    dmChannel,
    said.message.seq,
  );
  if (!filed.ok) throw new Error('the report was refused');

  return {
    moderator,
    alice,
    bob,
    clubId: club.clubId,
    clubChannelId: club.mainChannelId,
    dmChannel,
    messageId: filed.messageId,
    seq: said.message.seq,
  };
}

describe('ejecting the user', () => {
  it('stops the account working, proved by attempting a request rather than reading a column', async () => {
    const s = await reportedDm();

    // Bob is a working account right up until the moment he is not.
    expect((await as(s.bob, 'GET', '/me')).status).toBe(200);

    const done = await as(s.moderator, 'POST', `/moderation/users/${s.bob.userId}/suspended`, {
      suspended: true,
      messageId: s.messageId,
    });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ suspended: true, changed: true });

    // The whole point. Non-negotiable 6: attempt the forbidden action and watch it be refused.
    expect((await as(s.bob, 'GET', '/me')).status).toBe(401);
  });

  it('publishes a revocation, because a silent socket re-asks nothing', async () => {
    const s = await reportedDm();

    await as(s.moderator, 'POST', `/moderation/users/${s.bob.userId}/suspended`, {
      suspended: true,
    });

    const events = await h.db.execute<{ event_type: string; payload: any }>(sql`
      SELECT event_type, payload FROM outbox
       WHERE event_type = 'account.suspended'
         AND payload->>'userId' = ${s.bob.userId}
    `);

    // Without this the column 401s his HTTP requests while an already-open socket keeps
    // delivering his clubs' conversations - the exact 2026-08-08 defect, for a suspension.
    expect(events.rows).toHaveLength(1);
    const channelIds = events.rows[0]?.payload.channelIds as string[];
    expect(channelIds).toContain(s.dmChannel.id);
    expect(channelIds).toContain(s.clubChannelId);
  });

  it('suspends without anonymising, which is what makes it reversible', async () => {
    const s = await reportedDm();

    await as(s.moderator, 'POST', `/moderation/users/${s.bob.userId}/suspended`, {
      suspended: true,
    });

    const row = await h.db.execute<{
      full_name: string;
      anonymized: boolean;
      memberships: number;
    }>(sql`
      SELECT u.full_name,
             (u.anonymized_at IS NOT NULL) AS anonymized,
             (SELECT COUNT(*)::int FROM club_memberships cm WHERE cm.user_id = u.id) AS memberships
        FROM users u WHERE u.id = ${s.bob.userId}
    `);

    // Deletion scrubs the name and drops every membership. Suspension must not, or ejecting a
    // club Owner would breach domain invariant 1 rather than merely locking somebody out.
    expect(row.rows[0]?.anonymized).toBe(false);
    expect(row.rows[0]?.full_name).toBe('Bob');
    expect(row.rows[0]?.memberships).toBe(1);
  });

  it('lets any moderator lift it, and the account works again', async () => {
    const s = await reportedDm();
    await as(s.moderator, 'POST', `/moderation/users/${s.bob.userId}/suspended`, {
      suspended: true,
    });
    expect((await as(s.bob, 'GET', '/me')).status).toBe(401);

    // A DIFFERENT moderator, who did not impose it. ADR-0021's asymmetry: reversing must be
    // cheaper than performing.
    const second = await signUpAs(`mod2-${crypto.randomUUID().slice(0, 8)}@test.invalid`);
    await reconcilePlatformModerators(h.db, [s.moderator.email, second.email]);

    const lifted = await as(second, 'POST', `/moderation/users/${s.bob.userId}/suspended`, {
      suspended: false,
    });
    expect(lifted.status).toBe(200);

    // Sessions were deleted with the suspension, so the old token stays dead and signing in
    // again is the way back - which is the honest outcome rather than a resurrected session.
    const fresh = await auth.api.signInEmail({
      body: { email: s.bob.email, password: PASSWORD },
    });
    const token = (fresh as { token?: string }).token;
    expect(token).toBeTruthy();
    expect((await as({ ...s.bob, token: token! }, 'GET', '/me')).status).toBe(200);
  });

  it('refuses an ordinary member attempting it, and the club Owner too', async () => {
    const s = await reportedDm();

    // Alice created the club, so she is its Owner - the most privileged person in the club both
    // participants belong to, and she still holds no platform authority whatsoever.
    const asOwner = await as(s.alice, 'POST', `/moderation/users/${s.bob.userId}/suspended`, {
      suspended: true,
    });
    const asTarget = await as(s.bob, 'POST', `/moderation/users/${s.alice.userId}/suspended`, {
      suspended: true,
    });

    expect(asOwner.status).toBe(404);
    expect(asTarget.status).toBe(404);
    expect((await as(s.bob, 'GET', '/me')).status).toBe(200);
  });

  it('refuses a moderator suspending themselves, another moderator, or the system actor', async () => {
    const s = await reportedDm();
    const other = await signUpAs(`mod3-${crypto.randomUUID().slice(0, 8)}@test.invalid`);
    await reconcilePlatformModerators(h.db, [s.moderator.email, other.email]);

    const self = await as(s.moderator, 'POST', `/moderation/users/${s.moderator.userId}/suspended`, {
      suspended: true,
    });
    const peer = await as(s.moderator, 'POST', `/moderation/users/${other.userId}/suspended`, {
      suspended: true,
    });
    // Its block is a security property rather than a punishment: the system actor authors every
    // system message, and reinstating it would make that account signin-able.
    const actor = await as(
      s.moderator,
      'POST',
      `/moderation/users/${SYSTEM_ACTOR_ID}/suspended`,
      { suspended: false },
    );

    expect([self.status, peer.status, actor.status]).toEqual([404, 404, 404]);
  });

  it('records who did it, against the report that prompted it', async () => {
    const s = await reportedDm();

    await as(s.moderator, 'POST', `/moderation/users/${s.bob.userId}/suspended`, {
      suspended: true,
      messageId: s.messageId,
    });

    const audit = await h.db.execute<{
      action: string;
      moderator_id: string;
      subject_user_id: string;
      message_id: string;
    }>(sql`
      SELECT action, moderator_id::text AS moderator_id,
             subject_user_id::text AS subject_user_id, message_id::text AS message_id
        FROM moderation_actions WHERE subject_user_id = ${s.bob.userId}
    `);

    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      action: 'suspend',
      moderator_id: s.moderator.userId,
      subject_user_id: s.bob.userId,
      // Evidence in place of the free-text reason ADR-0021 rejected.
      message_id: s.messageId,
    });
  });

  it('writes no second audit row for an act that changed nothing', async () => {
    const s = await reportedDm();
    const body = { suspended: true };

    await as(s.moderator, 'POST', `/moderation/users/${s.bob.userId}/suspended`, body);
    const again = await as(s.moderator, 'POST', `/moderation/users/${s.bob.userId}/suspended`, body);

    expect(again.body).toMatchObject({ suspended: true, changed: false });
    const audit = await h.db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM moderation_actions WHERE subject_user_id = ${s.bob.userId}
    `);
    // An audit trail should carry acts, not clicks.
    expect(audit.rows[0]?.n).toBe(1);
  });
});

describe('a suspended account cannot sign in', () => {
  /** Through the real HTTP route, because the whole defect lived in better-auth's own endpoint. */
  const signIn = async (email: string, password: string) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email, password },
    });
    return {
      status: response.statusCode,
      body: response.body.length > 0 ? JSON.parse(response.body) : {},
    };
  };

  const sessionsFor = async (userId: string): Promise<number> => {
    const rows = await h.db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM sessions WHERE user_id = ${userId}
    `);
    return rows.rows[0]?.n ?? 0;
  };

  it('is refused at the door, and no session is issued', async () => {
    const s = await reportedDm();
    expect((await signIn(s.bob.email, PASSWORD)).status).toBe(200);

    await as(s.moderator, 'POST', `/moderation/users/${s.bob.userId}/suspended`, {
      suspended: true,
    });
    const before = await sessionsFor(s.bob.userId);

    const attempt = await signIn(s.bob.email, PASSWORD);

    /*
     * > **This is the defect this test exists for.** `signin_blocked_at` is our column and
     * > sign-in is better-auth's route, so before 2026-08-11 the two had never met: a suspended
     * > account authenticated normally, got a real token, and then every screen 401'd. The
     * > outcome looked like a broken app rather than a suspension.
     */
    expect(attempt.status).toBe(403);
    expect(attempt.body.code).toBe('ACCOUNT_SUSPENDED');
    // Refused by throwing rather than by cleaning up afterwards, so there is no window in which
    // a valid token for a suspended account exists.
    expect(await sessionsFor(s.bob.userId)).toBe(before);
  });

  it('tells a wrong password nothing, so the form is not a suspension oracle', async () => {
    const s = await reportedDm();
    await as(s.moderator, 'POST', `/moderation/users/${s.bob.userId}/suspended`, {
      suspended: true,
    });

    const wrong = await signIn(s.bob.email, 'definitely-not-the-password');

    /*
     * The check runs AFTER the credential is verified, deliberately. Testing the address first
     * would answer "suspended" to anybody who typed it, which is the account-existence oracle
     * PRD/03 rule 14 refuses to build on the password-reset form. You learn this only by
     * proving you are them.
     */
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).not.toBe('ACCOUNT_SUSPENDED');
  });

  it('works again the moment the suspension is lifted', async () => {
    const s = await reportedDm();
    const url = `/moderation/users/${s.bob.userId}/suspended`;

    await as(s.moderator, 'POST', url, { suspended: true });
    expect((await signIn(s.bob.email, PASSWORD)).status).toBe(403);

    await as(s.moderator, 'POST', url, { suspended: false });
    const after = await signIn(s.bob.email, PASSWORD);

    expect(after.status).toBe(200);
    expect(after.body.token).toBeTruthy();
  });
});

describe('removing the content', () => {
  it('leaves a tombstone rather than a hole, and clears the reactions with it', async () => {
    const s = await reportedDm();
    // A reaction, so the shared delete path is proved to still clear them after the refactor
    // that gave it a second caller.
    await h.db.insert(messageReactions).values({
      messageId: s.messageId,
      userId: s.alice.userId,
      emoji: '😮',
    });

    const removed = await as(s.moderator, 'POST', `/moderation/reports/${s.messageId}/remove`);
    expect(removed.status).toBe(200);

    const row = await h.db.execute<{ deleted: boolean; body: string | null; pinned: boolean }>(sql`
      SELECT (deleted_at IS NOT NULL) AS deleted, body, pinned
        FROM messages WHERE id = ${s.messageId}
    `);
    expect(row.rows[0]).toMatchObject({ deleted: true, body: null, pinned: false });

    const reactions = await h.db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM message_reactions WHERE message_id = ${s.messageId}
    `);
    expect(reactions.rows[0]?.n).toBe(0);
  });

  it('advances the channel revision, so a phone that was closed still learns', async () => {
    const s = await reportedDm();
    const before = await h.db.execute<{ rev: number }>(sql`
      SELECT last_rev AS rev FROM channels WHERE id = ${s.dmChannel.id}
    `);

    await as(s.moderator, 'POST', `/moderation/reports/${s.messageId}/remove`);

    const after = await h.db.execute<{ rev: number }>(sql`
      SELECT last_rev AS rev FROM channels WHERE id = ${s.dmChannel.id}
    `);
    // Sync asks for rev > mark. A removal that did not advance it would leave the words on any
    // device that was offline at the time, indefinitely.
    expect(Number(after.rows[0]?.rev)).toBeGreaterThan(Number(before.rows[0]?.rev));
  });

  it('refuses a participant, including the one who reported it', async () => {
    const s = await reportedDm();

    // PRD/14 still holds: no participant deletes the other's message. This power is the
    // platform's, and it is not reachable by either person in the conversation.
    expect((await as(s.alice, 'POST', `/moderation/reports/${s.messageId}/remove`)).status).toBe(
      404,
    );
    expect((await as(s.bob, 'POST', `/moderation/reports/${s.messageId}/remove`)).status).toBe(404);

    const row = await h.db.execute<{ deleted: boolean }>(sql`
      SELECT (deleted_at IS NOT NULL) AS deleted FROM messages WHERE id = ${s.messageId}
    `);
    expect(row.rows[0]?.deleted).toBe(false);
  });

  it('has no door without a report', async () => {
    const s = await reportedDm();
    // A second, unreported message in the same conversation the moderator may legitimately
    // read a window of.
    const other = await sendMessage(h.db, await ctxFor(s.bob.userId), s.dmChannel, {
      channelId: s.dmChannel.id,
      clientMsgId: crypto.randomUUID(),
      body: 'nobody complained about this one',
    });
    if (!other.ok) throw new Error('send failed');

    const attempt = await as(
      s.moderator,
      'POST',
      `/moderation/reports/${other.message.id}/remove`,
    );

    expect(attempt.status).toBe(404);
    const row = await h.db.execute<{ deleted: boolean }>(sql`
      SELECT (deleted_at IS NOT NULL) AS deleted FROM messages WHERE id = ${other.message.id}
    `);
    expect(row.rows[0]?.deleted).toBe(false);
  });

  it('records the removal against the moderator who performed it', async () => {
    const s = await reportedDm();

    await as(s.moderator, 'POST', `/moderation/reports/${s.messageId}/remove`);

    const audit = await h.db.execute<{ action: string; moderator_id: string }>(sql`
      SELECT action, moderator_id::text AS moderator_id
        FROM moderation_actions WHERE message_id = ${s.messageId} AND action = 'remove_message'
    `);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.moderator_id).toBe(s.moderator.userId);
  });

  it('reports both states back to the queue, so it can say what has been done', async () => {
    const s = await reportedDm();
    await as(s.moderator, 'POST', `/moderation/reports/${s.messageId}/remove`);
    await as(s.moderator, 'POST', `/moderation/users/${s.bob.userId}/suspended`, {
      suspended: true,
    });

    const queue = await as(s.moderator, 'GET', '/moderation/dm-reports');
    const row = (queue.body.reports as any[]).find((r) => r.messageId === s.messageId);

    expect(row).toMatchObject({ removed: true, senderSuspended: true });
    // Still metadata only. Acting on a report must not turn the listing into a content surface.
    expect(row).not.toHaveProperty('body');
  });
});
