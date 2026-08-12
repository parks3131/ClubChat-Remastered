/**
 * A race's date is optional, and the null means "not on the calendar".
 *
 * The date used to be `NOT NULL`, so every race was a calendar entry whether or not it was a
 * dated event. The same object is used for an ordinary side group, and inventing a date for one
 * put a fictional entry on the club calendar - which is worse than the group being absent from
 * it. So the column is nullable, and **that null is load-bearing rather than merely permitted**:
 * `readCalendar` unions in only the races that carry a date.
 *
 * The calendar assertions are the point of this file. A test that only checked "a race can be
 * created without a date" would pass against a build where undated races land on the feed with a
 * null day, which is the failure this design exists to avoid.
 *
 * Ordering is here too because it changed for the same reason: a dateless group cannot be placed
 * on a date-ordered list, so the list sorts by creation instead.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { buildApp } from '../api/app.ts';
import { createAuth, type Auth } from '../auth.ts';
import type { Config } from '../config.ts';
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

async function club(owner: Actor) {
  const created = await as(owner, 'POST', '/clubs', {
    name: `Club ${crypto.randomUUID().slice(0, 6)}`,
    sport: 'running',
  });
  expect(created.status).toBe(201);
  return created.body.clubId as string;
}

async function addRace(owner: Actor, clubId: string, name: string, raceDate?: string | null) {
  const created = await as(owner, 'POST', `/clubs/${clubId}/races`, {
    name,
    ...(raceDate === undefined ? {} : { raceDate }),
  });
  return created;
}

/** The club's races, newest-created first, as the hub reads them. */
async function raceNames(actor: Actor, clubId: string): Promise<string[]> {
  const listed = await as(actor, 'GET', `/clubs/${clubId}/races`);
  expect(listed.status).toBe(200);
  return (listed.body.races as Array<{ name: string }>).map((race) => race.name);
}

async function calendarTitles(actor: Actor, clubId: string): Promise<string[]> {
  const feed = await as(actor, 'GET', `/calendar?clubId=${clubId}`);
  expect(feed.status).toBe(200);
  const entries = (feed.body.entries ?? feed.body.items ?? []) as Array<{
    kind?: string;
    type?: string;
    title: string;
  }>;
  return entries.filter((e) => (e.kind ?? e.type) === 'race').map((e) => e.title);
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

describe('creating a race without a date', () => {
  it('is accepted, and the race carries no date', async () => {
    const owner = await signUp(`RdOwner${crypto.randomUUID().slice(0, 4)}`);
    const clubId = await club(owner);

    const created = await addRace(owner, clubId, 'Tuesday Track Group');
    expect(created.status).toBe(201);

    const detail = await as(owner, 'GET', `/races/${created.body.raceId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.race.raceDate).toBeNull();
  });

  it('accepts an explicit null, which is what an empty date box sends', async () => {
    const owner = await signUp(`RdNull${crypto.randomUUID().slice(0, 4)}`);
    const clubId = await club(owner);

    const created = await addRace(owner, clubId, 'Recovery Run Crew', null);
    expect(created.status).toBe(201);

    const detail = await as(owner, 'GET', `/races/${created.body.raceId}`);
    expect(detail.body.race.raceDate).toBeNull();
  });

  it('still refuses a malformed date', async () => {
    const owner = await signUp(`RdBad${crypto.randomUUID().slice(0, 4)}`);
    const clubId = await club(owner);

    const created = await addRace(owner, clubId, 'Bad Date', '12 March');
    expect(created.status).toBe(400);
  });

  it('still accepts one, because a real race has a day', async () => {
    const owner = await signUp(`RdGood${crypto.randomUUID().slice(0, 4)}`);
    const clubId = await club(owner);

    const created = await addRace(owner, clubId, 'Nittany Lion Invitational', '2026-11-14');
    expect(created.status).toBe(201);

    const detail = await as(owner, 'GET', `/races/${created.body.raceId}`);
    expect(detail.body.race.raceDate).toBe('2026-11-14');
  });
});

describe('the calendar, which is what the date is for', () => {
  it('carries the dated race and not the undated group', async () => {
    const owner = await signUp(`RdCal${crypto.randomUUID().slice(0, 4)}`);
    const clubId = await club(owner);

    await addRace(owner, clubId, 'Dated Invitational', '2026-11-14');
    await addRace(owner, clubId, 'Undated Group');

    const titles = await calendarTitles(owner, clubId);
    expect(titles).toContain('Dated Invitational');
    expect(titles).not.toContain('Undated Group');
  });

  /**
   * The reverse direction, and the reason `raceDate` is `nullish` rather than `optional` on the
   * PATCH body: a group created by mistake as a dated race has to be able to stop being a
   * calendar entry. Folding null into absent would make a date impossible to undo.
   */
  it('drops a race that has its date cleared', async () => {
    const owner = await signUp(`RdClear${crypto.randomUUID().slice(0, 4)}`);
    const clubId = await club(owner);

    const created = await addRace(owner, clubId, 'Briefly Dated', '2026-11-14');
    expect(await calendarTitles(owner, clubId)).toContain('Briefly Dated');

    const cleared = await as(owner, 'PATCH', `/races/${created.body.raceId}`, { raceDate: null });
    expect(cleared.status).toBe(200);

    expect(await calendarTitles(owner, clubId)).not.toContain('Briefly Dated');
    const detail = await as(owner, 'GET', `/races/${created.body.raceId}`);
    expect(detail.body.race.raceDate).toBeNull();
  });

  it('adds one that gains a date later', async () => {
    const owner = await signUp(`RdGain${crypto.randomUUID().slice(0, 4)}`);
    const clubId = await club(owner);

    const created = await addRace(owner, clubId, 'Later Dated');
    expect(await calendarTitles(owner, clubId)).not.toContain('Later Dated');

    const dated = await as(owner, 'PATCH', `/races/${created.body.raceId}`, {
      raceDate: '2026-12-01',
    });
    expect(dated.status).toBe(200);

    expect(await calendarTitles(owner, clubId)).toContain('Later Dated');
  });
});

describe('ordering', () => {
  /**
   * The rule the founder asked for: whatever was created most recently is at the top, so a group
   * made today sits above one made last week regardless of either one's name or date.
   */
  it('is newest-created first, not by date and not alphabetical', async () => {
    const owner = await signUp(`RdOrder${crypto.randomUUID().slice(0, 4)}`);
    const clubId = await club(owner);

    // Created oldest to newest. The names and dates are chosen to disagree with creation order
    // in both directions, so a list that sorted by either would come back differently.
    await addRace(owner, clubId, 'Alpha', '2027-01-01');
    await addRace(owner, clubId, 'Zulu', '2026-01-01');
    await addRace(owner, clubId, 'Mike');

    expect(await raceNames(owner, clubId)).toEqual(['Mike', 'Zulu', 'Alpha']);
  });

  /**
   * Pins still win, because a pin exists to control what appears in the hub's short preview.
   * Ignoring them would leave the feature drawing an icon and moving nothing.
   */
  it('puts a pinned race above newer unpinned ones', async () => {
    const owner = await signUp(`RdPin${crypto.randomUUID().slice(0, 4)}`);
    const clubId = await club(owner);

    const first = await addRace(owner, clubId, 'Pinned Oldest');
    await addRace(owner, clubId, 'Newer One');
    await addRace(owner, clubId, 'Newest One');

    expect(await raceNames(owner, clubId)).toEqual(['Newest One', 'Newer One', 'Pinned Oldest']);

    const pinned = await as(owner, 'POST', `/races/${first.body.raceId}/pin`, { pinned: true });
    expect(pinned.status).toBe(200);

    expect(await raceNames(owner, clubId)).toEqual(['Pinned Oldest', 'Newest One', 'Newer One']);
  });
});
