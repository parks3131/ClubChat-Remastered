/**
 * What the club hub navigates on.
 *
 * The hub opens all three of its conversations **directly** - main chat, the Eboard space and a
 * race - rather than pushing a landing screen that redirects. That is what makes entering them
 * feel the same, and it means two fields have stopped being merely informational and become
 * navigation targets:
 *
 * | Field | Non-null when |
 * |---|---|
 * | `RaceListItem.channelId` | the viewer holds a roster row for that race |
 * | `ClubDetail.eboardChannelId` | the viewer is a member of the space |
 *
 * Both were already gated when they were only being displayed. These tests exist because the
 * consequence of a regression changed: a leaked channel id used to be a wrong badge, and is now a
 * tap into a conversation the server will refuse. Nothing is disclosed either way - the read is
 * still access-checked - but the difference between "a number is wrong" and "the app takes you
 * somewhere and then says no" is worth a test.
 *
 * Note what is deliberately NOT asserted here: that the landing screens still exist. They do, and
 * they still redirect, because a notification, a direct URL and a non-member all still arrive
 * that way. Only the hub stopped going through them.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
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

describe('a race opens directly only for somebody on its roster', () => {
  it('gives the creator a channel and withholds it from an admin who never joined', async () => {
    const owner = await signUp(`HubOwner${crypto.randomUUID().slice(0, 4)}`);
    const other = await signUp(`HubAdmin${crypto.randomUUID().slice(0, 4)}`);

    const club = await as(owner, 'POST', '/clubs', { name: 'Hub FC' });
    expect(club.status).toBe(201);
    const clubId = club.body.clubId as string;
    // A club admin, and deliberately never added to the race roster: management authority is
    // not access, which is the rule this whole field exists to respect.
    await h.db.insert(clubMemberships).values({ clubId, userId: other.userId, role: 'admin' });

    const race = await as(owner, 'POST', `/clubs/${clubId}/races`, {
      name: 'Sectionals',
      raceDate: '2026-09-12',
    });
    expect(race.status).toBe(201);

    const mine = await as(owner, 'GET', `/clubs/${clubId}/races`);
    const theirs = await as(other, 'GET', `/clubs/${clubId}/races`);
    const forOwner = (mine.body.races as any[])[0];
    const forAdmin = (theirs.body.races as any[])[0];

    // Creating a race auto-adds the creator to the roster, so they have access and a channel.
    expect(forOwner.hasAccess).toBe(true);
    expect(forOwner.channelId).not.toBeNull();

    /*
     * The admin sees the race - every club member does - and gets NO channel, so the hub sends
     * them to the preview where the request-to-join lives rather than into a conversation they
     * cannot read. `hasAccess` and `channelId` must agree; a channel without access would be a
     * tap that lands on a refusal.
     */
    expect(forAdmin.hasAccess).toBe(false);
    expect(forAdmin.channelId).toBeNull();
  });
});

describe('the Eboard opens directly only for a member of the space', () => {
  it('names the channel to the owner, who is in it, and to nobody else', async () => {
    const owner = await signUp(`HubEbOwner${crypto.randomUUID().slice(0, 4)}`);
    const member = await signUp(`HubEbMember${crypto.randomUUID().slice(0, 4)}`);

    const club = await as(owner, 'POST', '/clubs', { name: 'Board FC' });
    const clubId = club.body.clubId as string;
    // An ordinary member: PRD/10 rule 4 gives them no visibility of the space at all.
    await h.db.insert(clubMemberships).values({ clubId, userId: member.userId, role: 'member' });

    const forOwner = (await as(owner, 'GET', `/clubs/${clubId}`)).body.club;
    const forMember = (await as(member, 'GET', `/clubs/${clubId}`)).body.club;

    // The owner is the space's first member, so both the id and the channel are named.
    expect(forOwner.eboardId).not.toBeNull();
    expect(forOwner.eboardChannelId).not.toBeNull();

    /*
     * And for an ordinary member both are null - the channel on exactly the same terms as the
     * id. This is the field that would leak the space's existence if it were gated differently
     * from its sibling, which is the whole reason they are computed from one condition.
     */
    expect(forMember.eboardId).toBeNull();
    expect(forMember.eboardChannelId).toBeNull();
  });

  it('withholds it from a club admin who has left the space', async () => {
    const owner = await signUp(`HubLeftOwner${crypto.randomUUID().slice(0, 4)}`);
    const club = await as(owner, 'POST', '/clubs', { name: 'Left FC' });
    const clubId = club.body.clubId as string;
    const before = (await as(owner, 'GET', `/clubs/${clubId}`)).body.club;
    expect(before.eboardChannelId).not.toBeNull();

    // Leaving is free; removing is Owner-only. Leaving their own space is the case that makes
    // "admin tier" and "member of the space" come apart while the person is still an admin.
    const left = await as(owner, 'DELETE', `/eboards/${before.eboardId}/members/${owner.userId}`);
    expect(left.status).toBeLessThan(300);

    const after = (await as(owner, 'GET', `/clubs/${clubId}`)).body.club;
    // Still the club's owner, and no longer in the space - so no channel to open directly.
    expect(after.eboardId).toBeNull();
    expect(after.eboardChannelId).toBeNull();
  });
});
