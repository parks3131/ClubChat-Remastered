/**
 * The content filter, where it actually sits: in the send path, against a real database.
 *
 * `content-filter.test.ts` proves the matcher. This proves the two things the matcher cannot:
 * that a refused message leaves **nothing behind** - no row, no `seq`, no fan-out - and that a
 * flagged one posts normally and lands in the queue a human already reads.
 *
 * The second half is the one worth having an integration test for. The flag tier reuses
 * `message_reports` through the seeded system actor rather than adding a table, and the claim
 * that the existing queue therefore works unchanged is only worth as much as an assertion that
 * reads it back through the same function the moderation screen calls.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { SYSTEM_ACTOR_ID } from '@clubchat/shared';
import { buildApp } from '../api/app.ts';
import { createAuth, type Auth } from '../auth.ts';
import type { Config } from '../config.ts';
import { clubMemberships } from '../db/schema.ts';
import { listChannelReports } from '../domain/moderation.ts';
import { getChannelRef } from '../domain/reads.ts';
import { sendMessage } from '../domain/send-message.ts';
import { loadAccessContext } from '../policy/context.ts';
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

async function send(actor: Actor, channelId: string, body: string) {
  const channel = await getChannelRef(h.db, channelId);
  if (!channel) throw new Error('no such channel');
  const ctx = await loadAccessContext(h.db, actor.userId);
  return sendMessage(h.db, ctx, channel, {
    channelId,
    clientMsgId: crypto.randomUUID(),
    body,
  });
}

/** A club with an owner and one ordinary member. */
async function club() {
  const owner = await signUp(`CfOwner${crypto.randomUUID().slice(0, 4)}`);
  const member = await signUp(`CfMember${crypto.randomUUID().slice(0, 4)}`);
  const created = await as(owner, 'POST', '/clubs', {
    name: `Club ${crypto.randomUUID().slice(0, 6)}`,
  });
  expect(created.status).toBe(201);
  const clubId = created.body.clubId as string;
  const channelId = created.body.mainChannelId as string;
  await h.db.insert(clubMemberships).values({ clubId, userId: member.userId, role: 'member' });
  return { owner, member, clubId, channelId };
}

async function messageCount(channelId: string): Promise<number> {
  const rows = await h.db.execute<{ n: string }>(
    sql`SELECT count(*)::text AS n FROM messages WHERE channel_id = ${channelId}`,
  );
  return Number(rows.rows[0]!.n);
}

async function lastSeq(channelId: string): Promise<number> {
  const rows = await h.db.execute<{ last_seq: number }>(
    sql`SELECT last_seq FROM channels WHERE id = ${channelId}`,
  );
  return Number(rows.rows[0]!.last_seq);
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

describe('a refused message', () => {
  it('is refused with content_refused', async () => {
    const { member, channelId } = await club();
    const result = await send(member, channelId, 'you faggot');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('content_refused');
  });

  /**
   * **"Filtering objectionable material from being posted" means nothing is posted.** A design
   * that stored the row and hid it would satisfy the sentence and not the requirement, and it
   * would leave the words on disk where a later read path could surface them.
   */
  it('writes no message row', async () => {
    const { member, channelId } = await club();
    const before = await messageCount(channelId);
    await send(member, channelId, 'you faggot');
    expect(await messageCount(channelId)).toBe(before);
  });

  /**
   * The gapless-`seq` invariant. A refusal must happen before the counter moves, or every
   * client's gap detection sees a hole that will never be filled and syncs forever chasing it.
   */
  it('does not consume a seq', async () => {
    const { member, channelId } = await club();
    const before = await lastSeq(channelId);
    await send(member, channelId, 'you faggot');
    expect(await lastSeq(channelId)).toBe(before);

    // And the next legitimate message takes the seq the refused one did not.
    const ok = await send(member, channelId, 'good run today');
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.message.seq).toBe(before + 1);
  });

  it('files no report, because there is nothing to look at', async () => {
    const { owner, member, channelId } = await club();
    await send(member, channelId, 'you faggot');
    const ctx = await loadAccessContext(h.db, owner.userId);
    const channel = await getChannelRef(h.db, channelId);
    const reports = await listChannelReports(h.db, ctx, channel!);
    expect(reports.ok).toBe(true);
    if (reports.ok) expect(reports.reports).toHaveLength(0);
  });

  /**
   * Ordinary swearing is not objectionable material, and this product deliberately allows it.
   * See ADR-0026 - a filter aimed at profanity would fire constantly in a university club and
   * catch none of what guideline 1.1.1 actually describes.
   */
  it('does not refuse ordinary swearing', async () => {
    const { member, channelId } = await club();
    const result = await send(member, channelId, 'that hill was fucking brutal');
    expect(result.ok).toBe(true);
  });
});

describe('a flagged message', () => {
  it('posts normally', async () => {
    const { member, channelId } = await club();
    const before = await lastSeq(channelId);
    const result = await send(member, channelId, 'kys');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.message.seq).toBe(before + 1);
    expect(await messageCount(channelId)).toBeGreaterThan(0);
  });

  /**
   * The claim the whole design rests on: the flag tier needs no new table, no new reader and no
   * new screen, because it files the same report a member would. Read back through the exact
   * function the Reports tab calls.
   */
  it('appears in the space Reports tab, filed by the system actor', async () => {
    const { owner, member, channelId } = await club();
    const sent = await send(member, channelId, 'kys');
    expect(sent.ok).toBe(true);

    const ctx = await loadAccessContext(h.db, owner.userId);
    const channel = await getChannelRef(h.db, channelId);
    const reports = await listChannelReports(h.db, ctx, channel!);
    expect(reports.ok).toBe(true);
    if (!reports.ok) return;

    expect(reports.reports).toHaveLength(1);
    const report = reports.reports[0]!;
    expect(report.senderId).toBe(member.userId);
    expect(report.reporters).toHaveLength(1);
    expect(report.reporters[0]!.userId).toBe(SYSTEM_ACTOR_ID);
  });

  /**
   * An admin can act on it with the powers they already have, which is the other half of the
   * reuse claim. Dismissing is the common case - most flags will be banter.
   */
  it('can be dismissed by an admin like any other report', async () => {
    const { owner, member, channelId } = await club();
    const sent = await send(member, channelId, 'kys');
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;

    const dismissed = await as(owner, 'POST', `/moderation/reports/${sent.message.id}/dismiss`);
    expect(dismissed.status).toBe(200);

    const ctx = await loadAccessContext(h.db, owner.userId);
    const channel = await getChannelRef(h.db, channelId);
    const reports = await listChannelReports(h.db, ctx, channel!);
    if (reports.ok) expect(reports.reports).toHaveLength(0);
  });

  /**
   * **A retry must not file a second opinion.** The send is idempotent by `client_msg_id`, so a
   * flaky network can deliver the same message twice - and an automatic report that fired per
   * attempt would buzz every admin again for a message they have already seen.
   */
  it('files one report even when the send is retried', async () => {
    const { owner, member, channelId } = await club();
    const channel = await getChannelRef(h.db, channelId);
    const ctx = await loadAccessContext(h.db, member.userId);
    const clientMsgId = crypto.randomUUID();

    const first = await sendMessage(h.db, ctx, channel!, {
      channelId,
      clientMsgId,
      body: 'kys',
    });
    const second = await sendMessage(h.db, ctx, channel!, {
      channelId,
      clientMsgId,
      body: 'kys',
    });
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.message.seq).toBe(first.message.seq);

    const adminCtx = await loadAccessContext(h.db, owner.userId);
    const reports = await listChannelReports(h.db, adminCtx, channel!);
    if (reports.ok) expect(reports.reports).toHaveLength(1);
  });

  it('leaves an ordinary message unreported', async () => {
    const { owner, member, channelId } = await club();
    await send(member, channelId, 'meet at 7:45 by the track');
    const ctx = await loadAccessContext(h.db, owner.userId);
    const channel = await getChannelRef(h.db, channelId);
    const reports = await listChannelReports(h.db, ctx, channel!);
    if (reports.ok) expect(reports.reports).toHaveLength(0);
  });
});
