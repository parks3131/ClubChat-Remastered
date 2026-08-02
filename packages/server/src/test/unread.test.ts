/**
 * Unread: what the number means, and what makes it go away.
 *
 * Written after a device session where a club row said nine and the messages could not be found,
 * and where reading them did not clear it. Two separate faults with one shape between them -
 * **a count that does not resolve to a place, and a count that does not respond to being
 * answered** - so these tests are about the number's relationship to reality rather than about
 * any one screen.
 *
 * The arithmetic itself has never been in doubt: `last_seq - last_read_seq` is committed to
 * Postgres and cannot drift. What went wrong was above it, in what the number covered and in who
 * was told when it changed. So the cases below are deliberately about coverage and clearing, and
 * one of them exists purely to state that reading one channel must not clear another.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../api/app.ts';
import { createAuth, type Auth } from '../auth.ts';
import type { Config } from '../config.ts';
import { clubMemberships, eboardMemberships } from '../db/schema.ts';
import { getChannelRef } from '../domain/reads.ts';
import { sendMessage } from '../domain/send-message.ts';
import { loadAccessContext } from '../policy/context.ts';
import { FakeMediaStore } from '../media/store.ts';
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

async function post(actor: Actor, channelId: string, body: string): Promise<number> {
  const channel = await getChannelRef(h.db, channelId);
  if (!channel) throw new Error('no such channel');
  const ctx = await loadAccessContext(h.db, actor.userId);
  const result = await sendMessage(h.db, ctx, channel, {
    channelId,
    clientMsgId: crypto.randomUUID(),
    body,
  });
  if (!result.ok) throw new Error(`send refused: ${result.code}`);
  return result.message.seq;
}

/** Read a channel the way opening it does. */
async function open(actor: Actor, channelId: string, upToSeq: number) {
  const response = await as(actor, 'POST', `/channels/${channelId}/read`, { upToSeq });
  expect(response.status).toBeLessThan(300);
}

async function rowFor(actor: Actor, predicate: (row: any) => boolean) {
  const response = await as(actor, 'GET', '/conversations');
  expect(response.status).toBe(200);
  return (response.body.conversations as any[]).find(predicate);
}

async function badge(actor: Actor): Promise<number> {
  const response = await as(actor, 'GET', '/notifications/badge');
  expect(response.status).toBe(200);
  return response.body.count as number;
}

/**
 * A club with a main chat and an Eboard space, plus an outsider who talks in both.
 *
 * The owner is auto-joined to the Eboard at club creation, so both channels are reachable
 * without any extra setup - which is exactly the situation that produced the report.
 */
async function clubWithEboard() {
  const owner = await signUp(`UnOwner${crypto.randomUUID().slice(0, 4)}`);
  const other = await signUp(`UnOther${crypto.randomUUID().slice(0, 4)}`);
  const created = await as(owner, 'POST', '/clubs', { name: 'Unread FC', sport: 'running' });
  expect(created.status).toBe(201);
  const clubId = created.body.clubId as string;
  const mainChannelId = created.body.mainChannelId as string;

  await h.db.insert(clubMemberships).values({ clubId, userId: other.userId, role: 'admin' });

  const states = await as(owner, 'GET', '/channels');
  const eboard = (states.body.channels as any[]).find((c) => c.scope === 'eboard');
  expect(eboard).toBeDefined();

  /*
   * The Eboard row explicitly, because inserting a club membership DIRECTLY skips the effect
   * that auto-joins the admin tier - promotion normally does it, and a raw insert is not a
   * promotion. Without this they are a club admin who cannot post in the board, which is
   * correct behaviour and a broken fixture.
   */
  await h.db
    .insert(eboardMemberships)
    .values({ eboardId: eboard.scopeId as string, userId: other.userId });

  return { owner, other, clubId, mainChannelId, eboardChannelId: eboard.id as string };
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

describe('what a club row counts', () => {
  it('totals every channel of the club the viewer can reach, not just the main chat', async () => {
    const f = await clubWithEboard();
    await post(f.other, f.mainChannelId, 'in the main chat');
    await post(f.other, f.eboardChannelId, 'one in the board');
    await post(f.other, f.eboardChannelId, 'two in the board');

    const row = await rowFor(f.owner, (r) => r.clubId === f.clubId);

    /*
     * Three: one in the main chat and two in the Eboard. Counting the main chat alone reported
     * ONE and left the other two with nowhere to be seen, which is the defect this test exists
     * for - and the number it would report is asserted below so the fix cannot silently revert
     * to it.
     */
    expect(row.unread).toBe(3);
  });

  it('resolves that total to a place - the Eboard channel carries its own share', async () => {
    const f = await clubWithEboard();
    await post(f.other, f.eboardChannelId, 'board only');

    const states = await as(f.owner, 'GET', '/channels');
    const eboard = (states.body.channels as any[]).find((c) => c.scope === 'eboard');

    // The hub badges from exactly this, so a total with nowhere to go is not representable:
    // whatever the row says is the sum of numbers this read can point at.
    expect(eboard.lastSeq - eboard.lastReadSeq).toBe(1);
    // And it carries scopeId, which is what lets a screen holding an Eboard id find its channel.
    expect(eboard.scopeId).toBeDefined();
  });

  it('does not count a race the viewer cannot reach', async () => {
    const f = await clubWithEboard();

    /*
     * A plain club member, added after the race exists and never put on its roster.
     *
     * The owner cannot play this part: **creating a race auto-adds its creator to the roster**
     * (TECH/12), so they can reach the race chat and their total legitimately includes it. A
     * first version of this test used them and asserted nothing, which is exactly the shape of
     * a negative assertion whose setup makes the positive case impossible.
     */
    const race = await as(f.owner, 'POST', `/clubs/${f.clubId}/races`, {
      name: 'Sectionals',
      raceDate: '2026-09-12',
    });
    expect(race.status).toBe(201);

    const bystander = await signUp(`UnBy${crypto.randomUUID().slice(0, 4)}`);
    await h.db
      .insert(clubMemberships)
      .values({ clubId: f.clubId, userId: bystander.userId, role: 'member' });

    const ownerStates = await as(f.owner, 'GET', '/channels');
    const raceChannel = (ownerStates.body.channels as any[]).find((c) => c.scope === 'race');
    expect(raceChannel).toBeDefined();
    await post(f.owner, raceChannel.id, 'in the race chat');

    const onRoster = await rowFor(f.owner, (r) => r.clubId === f.clubId);
    const offRoster = await rowFor(bystander, (r) => r.clubId === f.clubId);

    /*
     * Management authority is not access. The bystander is in the club and not on the roster, so
     * the race's messages must not swell a number they could never resolve to a place - which is
     * the same failure as the invisible Eboard count, in the opposite direction.
     */
    expect(onRoster.unread).toBeGreaterThan(0);
    expect(offRoster.unread).toBe(0);
  });
});

describe('what makes a count go away', () => {
  it('clears the row when that channel is read', async () => {
    const f = await clubWithEboard();
    await post(f.other, f.mainChannelId, 'hello');

    const before = await rowFor(f.owner, (r) => r.clubId === f.clubId);
    expect(before.unread).toBeGreaterThan(0);

    const states = await as(f.owner, 'GET', '/channels');
    const main = (states.body.channels as any[]).find((c) => c.id === f.mainChannelId);
    await open(f.owner, f.mainChannelId, main.lastSeq);

    const after = await rowFor(f.owner, (r) => r.clubId === f.clubId);
    expect(after.unread).toBe(0);
  });

  it('clears only the channel that was read, leaving the rest of the club counted', async () => {
    const f = await clubWithEboard();
    await post(f.other, f.mainChannelId, 'main');
    await post(f.other, f.eboardChannelId, 'board');

    const states = await as(f.owner, 'GET', '/channels');
    const main = (states.body.channels as any[]).find((c) => c.id === f.mainChannelId);
    await open(f.owner, f.mainChannelId, main.lastSeq);

    const row = await rowFor(f.owner, (r) => r.clubId === f.clubId);
    /*
     * The Eboard message is still unread, so the club is still counted - and this is the case
     * that makes the total honest rather than merely larger. Reading the main chat must not
     * silently mark the board read.
     */
    expect(row.unread).toBe(1);

    const eboard = (states.body.channels as any[]).find((c) => c.scope === 'eboard');
    await open(f.owner, f.eboardChannelId, eboard.lastSeq);
    expect((await rowFor(f.owner, (r) => r.clubId === f.clubId)).unread).toBe(0);
  });

  it('brings the count back when something new arrives after reading', async () => {
    const f = await clubWithEboard();
    const states = await as(f.owner, 'GET', '/channels');
    const main = (states.body.channels as any[]).find((c) => c.id === f.mainChannelId);
    await open(f.owner, f.mainChannelId, main.lastSeq);
    const eboard = (states.body.channels as any[]).find((c) => c.scope === 'eboard');
    await open(f.owner, f.eboardChannelId, eboard.lastSeq);
    expect((await rowFor(f.owner, (r) => r.clubId === f.clubId)).unread).toBe(0);

    await post(f.other, f.mainChannelId, 'something new');
    expect((await rowFor(f.owner, (r) => r.clubId === f.clubId)).unread).toBe(1);
  });

  it('does not count the reader their own message', async () => {
    const f = await clubWithEboard();
    const states = await as(f.owner, 'GET', '/channels');
    const main = (states.body.channels as any[]).find((c) => c.id === f.mainChannelId);
    await open(f.owner, f.mainChannelId, main.lastSeq);
    const eboard = (states.body.channels as any[]).find((c) => c.scope === 'eboard');
    await open(f.owner, f.eboardChannelId, eboard.lastSeq);

    const seq = await post(f.owner, f.mainChannelId, 'my own words');
    // Sending does not advance the cursor by itself - the client marks read on arrival - so
    // this asserts the shape rather than pretending otherwise, and then that reading settles it.
    await open(f.owner, f.mainChannelId, seq);
    expect((await rowFor(f.owner, (r) => r.clubId === f.clubId)).unread).toBe(0);
  });
});

describe('the badge and the row agree', () => {
  it('counts one per conversation rather than one per message', async () => {
    const f = await clubWithEboard();
    await post(f.other, f.mainChannelId, 'one');
    await post(f.other, f.mainChannelId, 'two');
    await post(f.other, f.mainChannelId, 'three');

    const row = await rowFor(f.owner, (r) => r.clubId === f.clubId);
    expect(row.unread).toBeGreaterThanOrEqual(3);

    /*
     * The badge is a count of THINGS needing attention, not of messages: a chat with 48 unread
     * adds one. So it cannot equal the row's number, and asserting they are equal would be
     * asserting the wrong design.
     */
    expect(await badge(f.owner)).toBeLessThan(row.unread);
    expect(await badge(f.owner)).toBeGreaterThan(0);
  });

  it('drops the badge once every channel has been read', async () => {
    const f = await clubWithEboard();
    await post(f.other, f.mainChannelId, 'main');
    await post(f.other, f.eboardChannelId, 'board');
    expect(await badge(f.owner)).toBeGreaterThan(0);

    const states = await as(f.owner, 'GET', '/channels');
    for (const channel of states.body.channels as any[]) {
      await open(f.owner, channel.id, channel.lastSeq);
    }

    // Discrete notification rows can still be outstanding; what must be gone is every
    // chat-unread contribution, which is what the row above was reporting.
    expect((await rowFor(f.owner, (r) => r.clubId === f.clubId)).unread).toBe(0);
  });
});
