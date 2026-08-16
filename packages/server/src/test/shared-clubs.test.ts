/**
 * The clubs two people share.
 *
 * `sharedClubs` has existed since Phase 3.5 and had **no tests at all**, which was found on
 * 2026-08-12 by writing a second copy of it for the member profile card before noticing it was
 * already there. The copy was deleted; these tests are what the exercise was actually worth.
 *
 * > **The assertions that matter are the negative ones.** A test that only checks "the club we
 * > both belong to is listed" passes against an implementation that returns the SUBJECT's whole
 * > club list - which would name clubs the viewer is not in, and undo the rule `canViewProfile`
 * > exists to enforce (ADR-0009, PRD/03 rule 8a). So every case below that establishes what IS
 * > listed is paired with one establishing what is not.
 *
 * The empty answer is tested too, because it is a real state rather than an error: a DM stays
 * readable after the last shared club is gone, so a profile reached that way legitimately shares
 * no clubs and the card that shows them has to cope.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { clubMemberships } from '../db/schema.ts';
import { buildApp } from '../api/app.ts';
import { createAuth, type Auth } from '../auth.ts';
import type { Config } from '../config.ts';
import { sharedClubs } from '../domain/dm.ts';
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

async function as(actor: Actor, method: 'GET' | 'POST', url: string, payload?: unknown) {
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

async function makeClub(owner: Actor, name: string): Promise<string> {
  const created = await as(owner, 'POST', '/clubs', { name });
  expect(created.status).toBe(201);
  return created.body.clubId as string;
}

async function join(clubId: string, actor: Actor) {
  await h.db.insert(clubMemberships).values({ clubId, userId: actor.userId, role: 'member' });
}

/** The shared-club names between `viewer` and `subject`, as the viewer is told them. */
async function sharedNames(viewer: Actor, subject: Actor): Promise<string[]> {
  const ctx = await loadAccessContext(h.db, viewer.userId);
  return (await sharedClubs(h.db, ctx, subject.userId)).map((club) => club.name);
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

describe('the clubs two people share', () => {
  it('lists a club they are both in', async () => {
    const alice = await signUp(`ScAlice${crypto.randomUUID().slice(0, 4)}`);
    const bob = await signUp(`ScBob${crypto.randomUUID().slice(0, 4)}`);
    const clubId = await makeClub(alice, `Shared ${crypto.randomUUID().slice(0, 6)}`);
    await join(clubId, bob);

    const names = await sharedNames(alice, bob);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^Shared /);
  });

  /**
   * **The disclosure direction.** Bob is in a club Alice knows nothing about, and it must not be
   * named on his card. An implementation returning his own memberships passes every other test
   * in this file and fails this one.
   */
  it("never names a club the viewer is not in", async () => {
    const alice = await signUp(`ScAlice2${crypto.randomUUID().slice(0, 4)}`);
    const bob = await signUp(`ScBob2${crypto.randomUUID().slice(0, 4)}`);

    const together = await makeClub(alice, 'Both Of Us');
    await join(together, bob);

    // Bob's own club. Alice is not a member and must never learn it exists.
    const bobsOwn = await makeClub(bob, 'Bobs Private Club');
    expect(bobsOwn).toBeTruthy();

    const names = await sharedNames(alice, bob);
    expect(names).toEqual(['Both Of Us']);
    expect(names).not.toContain('Bobs Private Club');
  });

  /** And symmetrically: a club the VIEWER is in but the subject is not is not "shared" either. */
  it('never names a club the subject is not in', async () => {
    const alice = await signUp(`ScAlice3${crypto.randomUUID().slice(0, 4)}`);
    const bob = await signUp(`ScBob3${crypto.randomUUID().slice(0, 4)}`);

    const together = await makeClub(alice, 'Common Ground');
    await join(together, bob);
    await makeClub(alice, 'Alices Other Club');

    expect(await sharedNames(alice, bob)).toEqual(['Common Ground']);
  });

  it('lists every shared club, by name', async () => {
    const alice = await signUp(`ScAlice4${crypto.randomUUID().slice(0, 4)}`);
    const bob = await signUp(`ScBob4${crypto.randomUUID().slice(0, 4)}`);

    // Created out of alphabetical order, so the ordering assertion means something.
    for (const name of ['Zulu Club', 'Alpha Club', 'Mike Club']) {
      const clubId = await makeClub(alice, name);
      await join(clubId, bob);
    }

    expect(await sharedNames(alice, bob)).toEqual(['Alpha Club', 'Mike Club', 'Zulu Club']);
  });

  /**
   * Reachable through a DM with no club in common. `canViewProfile` allows it - an existing
   * conversation is standing on its own - so the card opens and simply shares nothing.
   */
  it('is empty for somebody reached through a conversation alone', async () => {
    const alice = await signUp(`ScAlice5${crypto.randomUUID().slice(0, 4)}`);
    const bob = await signUp(`ScBob5${crypto.randomUUID().slice(0, 4)}`);
    const clubId = await makeClub(alice, 'Temporary Club');
    await join(clubId, bob);

    const opened = await as(alice, 'POST', '/dm/threads', { userId: bob.userId });
    expect(opened.status).toBe(201);

    // Bob leaves, so the thread survives and the shared club does not.
    await h.db.execute(
      sql`DELETE FROM club_memberships WHERE club_id = ${clubId} AND user_id = ${bob.userId}`,
    );

    expect(await sharedNames(alice, bob)).toEqual([]);
  });

  it('is symmetric: each sees the same club on the other card', async () => {
    const alice = await signUp(`ScAlice6${crypto.randomUUID().slice(0, 4)}`);
    const bob = await signUp(`ScBob6${crypto.randomUUID().slice(0, 4)}`);
    const clubId = await makeClub(alice, 'Mutual Club');
    await join(clubId, bob);

    expect(await sharedNames(alice, bob)).toEqual(['Mutual Club']);
    expect(await sharedNames(bob, alice)).toEqual(['Mutual Club']);
  });

  it('reaches the client over the route both screens use', async () => {
    const alice = await signUp(`ScAlice7${crypto.randomUUID().slice(0, 4)}`);
    const bob = await signUp(`ScBob7${crypto.randomUUID().slice(0, 4)}`);
    const clubId = await makeClub(alice, 'Routed Club');
    await join(clubId, bob);

    const listed = await as(alice, 'GET', `/dm/shared-clubs/${bob.userId}`);
    expect(listed.status).toBe(200);
    expect(listed.body.clubs).toHaveLength(1);
    expect(listed.body.clubs[0].name).toBe('Routed Club');
    expect(listed.body.clubs[0].clubId).toBe(clubId);
  });
});
