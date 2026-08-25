/**
 * `GET /invites/:token/preview`, through the real HTTP stack and against a real Postgres.
 *
 * The endpoint exists so that `https://clubchatapp.com/join/<token>` can greet a stranger with the
 * club's name (ADR-0045, ADR-0046). The person holding that link has no account, so the page
 * serving them has no session to borrow, and the api answers them directly.
 *
 * **What makes it safe is that the token is already a bearer credential.** Anybody holding it can
 * redeem it and be inside the club a second later, so telling that same holder the club's name
 * discloses strictly less than they already have. Everything asserted below follows from that one
 * sentence, and each half of it is a separate failure:
 *
 *  1. **It must disclose nothing beyond the contract.** Not the club id, not its description, not
 *     its join policy, not either invite token, and above all nothing about a member. The
 *     assertion is a whole-body `toEqual` against an exact literal plus a scan of the raw bytes,
 *     rather than a check that the two expected fields are present - a spread of a database row
 *     passes the second and fails the first.
 *  2. **It must not become an oracle.** An unknown token, a revoked one and one whose club has
 *     been deleted have to be indistinguishable: same status, same body, same headers. A
 *     distinguishable "revoked" would confirm that a club with that token once existed, which is
 *     a fact about somebody else's club that the caller did not have.
 *  3. **It must answer somebody who holds nothing.** The control in the same app is `/me` refusing
 *     with 401, so a route "tidied" into `protectedRoutes` cannot answer 200 here by accident.
 *  4. **It must be limited.** It is the only unauthenticated read in this api, so the per-user
 *     limiter cannot serve it and a bucket of its own is the whole of its ceiling.
 *
 * There is no expiry to test, and that is a property of the data model rather than an omission:
 * `clubs.invite_token` is a bearer string with no expiry column, valid until it is rotated. So
 * "expired" and "revoked" are the same state, reached by rotating, and the third indistinguishable
 * case - the club deleted out from under the link - is tested beside it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { pino } from 'pino';
import { buildApp } from '../api/app.ts';
import { clubMemberships, clubs } from '../db/schema.ts';
import { createAuth, type Auth } from '../auth.ts';
import type { Config } from '../config.ts';
import type { KeyedRateLimiter } from '../bus/redis.ts';
import { deleteClub, rotateInviteToken } from '../domain/membership.ts';
import { FakeMediaStore } from '../media/store.ts';
import { silentMonitor } from '../monitoring.ts';
import { accessContextOf } from '../policy/context.ts';
import { allowAll, allowFirst, recordingLimiter } from './fake-limiter.ts';
import { seedClub, seedUser, startTestDb, type TestDb } from './harness.ts';

let h: TestDb;
let auth: Auth;

const config = {
  LOG_LEVEL: 'silent',
  CLIENT_ORIGIN: 'http://localhost:8081',
  BETTER_AUTH_URL: 'http://localhost:3000',
  S3_BUCKET_PUBLIC: 'identity',
  S3_BUCKET_PRIVATE: 'content',
  MEDIA_SIGNING_SECRET: 'test-signing-secret-not-real',
  MEDIA_CDN_BASE_URL: 'http://cdn.invalid/content',
  MEDIA_URL_MODE: 'cdn',
} as unknown as Config;

function appWith(limiter: KeyedRateLimiter = allowAll()): FastifyInstance {
  return buildApp({
    db: h.db,
    auth,
    config,
    mediaStore: new FakeMediaStore(),
    monitor: silentMonitor(),
    limiter,
  });
}

/**
 * An app whose log is a string array, at the level a deployed api actually runs at.
 *
 * `LOG_LEVEL` is `silent` everywhere else in this file, which would make "the token is not in the
 * log" pass against a log that does not exist. This one runs at `info` - what `fly/api.toml`
 * configures - so the automatic request logging that carries `req.url` is switched on and the
 * assertion is about the route rather than about the level.
 */
function appLogging(limiter: KeyedRateLimiter = allowAll()): {
  app: FastifyInstance;
  lines: string[];
} {
  const lines: string[] = [];
  const logger = pino(
    { level: 'info' },
    { write: (chunk: string) => void lines.push(chunk) },
  );

  return {
    lines,
    app: buildApp({
      db: h.db,
      auth,
      config,
      mediaStore: new FakeMediaStore(),
      monitor: silentMonitor(),
      limiter,
      logger,
    }),
  };
}

/**
 * A club with a description, a non-default join policy, and three members with real names.
 *
 * Every one of those is here to be looked for in the response body. A fixture whose only member is
 * the owner and whose description is null cannot fail the "discloses nothing more" assertion,
 * because there would be nothing there to leak.
 */
async function seedPreviewable(): Promise<{
  clubId: string;
  ownerId: string;
  name: string;
  description: string;
  adminToken: string;
  memberToken: string;
  memberNames: string[];
  memberCount: number;
}> {
  const { clubId, ownerId } = await seedClub(h.db, { ownerName: 'Ada Ownerly' });
  const description = 'Trains at six on Tuesdays, back bar afterwards';

  await h.db
    .update(clubs)
    .set({ description, joinPolicy: 'request' })
    .where(eq(clubs.id, clubId));

  const memberNames = ['Bruno Secondly', 'Clara Thirdly'];
  for (const name of memberNames) {
    const userId = await seedUser(h.db, name);
    await h.db.insert(clubMemberships).values({ clubId, userId, role: 'member' });
  }

  const rows = await h.db.select().from(clubs).where(eq(clubs.id, clubId)).limit(1);
  const row = rows[0];
  if (!row) throw new Error('the seeded club could not be read back');

  return {
    clubId,
    ownerId,
    name: row.name,
    description,
    adminToken: row.inviteToken,
    memberToken: row.memberInviteToken,
    memberNames: ['Ada Ownerly', ...memberNames],
    memberCount: 1 + memberNames.length,
  };
}

async function preview(app: FastifyInstance, token: string, remoteAddress?: string) {
  const response = await app.inject({
    method: 'GET',
    url: `/invites/${token}/preview`,
    ...(remoteAddress === undefined ? {} : { remoteAddress }),
  });
  return { status: response.statusCode, headers: response.headers, body: response.body };
}

/**
 * A token that is well formed and belongs to nothing.
 *
 * Well formed on purpose: an unknown token has to travel the same path a real one does, or the
 * "indistinguishable" assertions below would be comparing a rejection against a lookup.
 */
const UNKNOWN_TOKEN = 'Zm9yLXRoZS1hdm9pZGFuY2Utb2YtZG91YnQtbm90LXJlYWw';

beforeAll(async () => {
  h = await startTestDb();
  auth = createAuth(h.db, {
    secret: 'test-secret-not-a-real-one',
    baseURL: config.BETTER_AUTH_URL,
  });
}, 120_000);

afterAll(async () => {
  await h?.stop().catch(() => undefined);
});

describe('a live invite token', () => {
  it('answers with the club name and its member count', async () => {
    const app = appWith();
    await app.ready();
    const club = await seedPreviewable();

    const response = await preview(app, club.adminToken);

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      club: { name: club.name, memberCount: club.memberCount },
      expiresAt: null,
    });

    await app.close();
  });

  /**
   * The member link and the admin link answer identically.
   *
   * Which of the two a stranger is holding decides what redeeming it does (ADR-0025), and it is
   * not theirs to learn from a page that has not asked them to sign in. Two different answers here
   * would also hand anybody with a member link a way to test whether a second string is the
   * admin one.
   */
  it('answers a member link exactly as it answers an admin link', async () => {
    const app = appWith();
    await app.ready();
    const club = await seedPreviewable();

    const asAdmin = await preview(app, club.adminToken);
    const asMember = await preview(app, club.memberToken);

    expect(asMember.status).toBe(asAdmin.status);
    expect(asMember.body).toBe(asAdmin.body);

    await app.close();
  });

  /**
   * The count is the club's real one, not the fixture's shape by coincidence.
   *
   * Asserted by changing it: a hardcoded `1`, a `SELECT count(*)` over the wrong table, and a
   * count of admins would all survive a single assertion against a seeded club.
   */
  it('counts every member, and follows the count as it changes', async () => {
    const app = appWith();
    await app.ready();
    const club = await seedPreviewable();

    const before = JSON.parse((await preview(app, club.adminToken)).body);
    expect(before.club.memberCount).toBe(3);

    const joiner = await seedUser(h.db, 'Dev Fourthly');
    await h.db.insert(clubMemberships).values({ clubId: club.clubId, userId: joiner, role: 'member' });

    const after = JSON.parse((await preview(app, club.adminToken)).body);
    expect(after.club.memberCount).toBe(4);

    await app.close();
  });

  /**
   * `expiresAt` is in the contract and is always null, because a ClubChat invite token has no
   * expiry: it is valid until an admin rotates it. The field is answered rather than omitted so
   * the join page reads one shape, and it is pinned here so that a later expiry feature has to
   * come past this test rather than silently changing what null meant.
   */
  it('reports no expiry, because an invite token does not expire', async () => {
    const app = appWith();
    await app.ready();
    const club = await seedPreviewable();

    expect(JSON.parse((await preview(app, club.adminToken)).body).expiresAt).toBeNull();

    await app.close();
  });
});

describe('what the answer discloses', () => {
  /**
   * The whole point of the endpoint, proved by attempting to read the forbidden thing rather than
   * by reasoning that the handler looks careful. Non-negotiable 6: the claim is "it discloses
   * nothing more", and the way to prove it is to ask for the club and inspect every byte that
   * comes back.
   */
  it('carries no member identity and no club field beyond the contract', async () => {
    const app = appWith();
    await app.ready();
    const club = await seedPreviewable();

    const response = await preview(app, club.adminToken);
    const body = response.body;

    // The exact shape. A handler that spread a database row would pass every `toContain` below
    // and fail this line.
    expect(JSON.parse(body)).toEqual({
      club: { name: club.name, memberCount: club.memberCount },
      expiresAt: null,
    });

    // And the same claim from the other side, because the shape assertion is only as good as the
    // literal somebody maintains beside it.
    for (const name of club.memberNames) expect(body).not.toContain(name);
    expect(body).not.toContain(club.ownerId);
    expect(body).not.toContain(club.clubId);
    expect(body).not.toContain(club.description);
    expect(body).not.toContain('request');
    expect(body).not.toContain(club.adminToken);
    expect(body).not.toContain(club.memberToken);

    await app.close();
  });

  /** A bearer credential in a shared cache is a bearer credential handed to whoever reads it. */
  it('is never stored by a cache', async () => {
    const app = appWith();
    await app.ready();
    const club = await seedPreviewable();

    expect((await preview(app, club.adminToken)).headers['cache-control']).toBe('no-store');

    await app.close();
  });
});

describe('a token that is not live', () => {
  /**
   * Unknown, revoked, and revoked by the club ceasing to exist. All three are the same event to
   * the person holding the link, and telling them apart would confirm to a stranger that a club
   * with that token once existed.
   *
   * Compared as whole responses rather than as statuses: a body, a header or a `content-length`
   * that differed would be the same oracle by a quieter route.
   */
  it('is refused identically whether it is unknown, revoked, or the club is gone', async () => {
    const app = appWith();
    await app.ready();

    const rotated = await seedPreviewable();
    const revoked = rotated.adminToken;
    const rotation = await rotateInviteToken(
      h.db,
      accessContextOf({ userId: rotated.ownerId, clubRole: [[rotated.clubId, 'owner']] }),
      rotated.clubId,
    );
    expect(rotation.ok).toBe(true);

    const doomed = await seedPreviewable();
    const orphaned = doomed.adminToken;
    const deletion = await deleteClub(
      h.db,
      accessContextOf({ userId: doomed.ownerId, clubRole: [[doomed.clubId, 'owner']] }),
      doomed.clubId,
    );
    expect(deletion.ok).toBe(true);

    const unknown = await preview(app, UNKNOWN_TOKEN);
    const stale = await preview(app, revoked);
    const gone = await preview(app, orphaned);

    expect(unknown.status).toBe(404);
    expect(JSON.parse(unknown.body)).toEqual({ error: 'invite_invalid' });

    for (const other of [stale, gone]) {
      expect(other.status).toBe(unknown.status);
      expect(other.body).toBe(unknown.body);
      expect(other.headers['cache-control']).toBe(unknown.headers['cache-control']);
      expect(other.headers['content-type']).toBe(unknown.headers['content-type']);
    }

    await app.close();
  });

  /**
   * The rotated club is still perfectly readable through its NEW token, which is what makes the
   * assertion above about the old token rather than about a broken lookup.
   */
  it('still answers for the token that replaced a revoked one', async () => {
    const app = appWith();
    await app.ready();
    const club = await seedPreviewable();

    await rotateInviteToken(
      h.db,
      accessContextOf({ userId: club.ownerId, clubRole: [[club.clubId, 'owner']] }),
      club.clubId,
    );
    const rows = await h.db.select().from(clubs).where(eq(clubs.id, club.clubId)).limit(1);
    const fresh = rows[0]?.inviteToken;
    if (fresh === undefined) throw new Error('the rotated club could not be read back');

    const response = await preview(app, fresh);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).club.name).toBe(club.name);

    await app.close();
  });

  /**
   * Case-sensitively, per ADR-0010. The token is 32 bytes of CSPRNG as base64url and was never
   * meant to be typed, so a case-insensitive match here would throw away a quarter of its entropy
   * on the one surface anybody can reach without an account.
   */
  it('does not match a token in the wrong case', async () => {
    const app = appWith();
    await app.ready();
    const club = await seedPreviewable();

    const flipped = club.adminToken.toUpperCase();
    expect(flipped).not.toBe(club.adminToken);

    const response = await preview(app, flipped);
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body)).toEqual({ error: 'invite_invalid' });

    await app.close();
  });

  /**
   * A token that is not a token at all - the shape a scanner produces from a poster with a
   * coffee ring on it - is the same flat refusal, and never a 400, a 500, or a driver error.
   */
  it('refuses a malformed token with the same answer', async () => {
    const app = appWith();
    await app.ready();

    for (const junk of ['undefined', 'short', 'not%20a%20token', '%27%20OR%201%3D1--']) {
      const response = await preview(app, junk);
      expect(response.status).toBe(404);
      expect(JSON.parse(response.body)).toEqual({ error: 'invite_invalid' });
    }

    await app.close();
  });
});

describe('placement and limiting', () => {
  /**
   * Placement. The caller is a stranger with no account, and the control in the same app is what
   * makes that sharp rather than incidental: `/me` refuses through the same absent session.
   */
  it('is answered for a caller with no session, in an app where /me refuses', async () => {
    const app = appWith();
    await app.ready();
    const club = await seedPreviewable();

    expect((await preview(app, club.adminToken)).status).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/me' })).statusCode).toBe(401);

    await app.close();
  });

  /**
   * The per-user limiter keys on `request.userId` and therefore cannot serve this route at all, so
   * a bucket of its own is the entire ceiling on an unauthenticated caller. A route that consulted
   * nothing would look exactly like this one until somebody pointed a script at it.
   */
  it('refuses with 429 and a Retry-After once its bucket is empty', async () => {
    const { app, lines } = appLogging(allowFirst(0));
    await app.ready();
    const club = await seedPreviewable();

    // A LIVE token, so the refusal is the limiter and not the lookup.
    const response = await preview(app, club.adminToken);

    expect(response.status).toBe(429);
    expect(JSON.parse(response.body)).toEqual({ error: 'rate_limited' });
    expect(Number(response.headers['retry-after'])).toBeGreaterThanOrEqual(1);

    // The refusal IS logged, so an operator can see the endpoint being hammered - and it names
    // the route pattern rather than the url, so seeing that costs nobody their invite link.
    const warned = lines.filter((line) => line.includes('rate limited'));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('/invites/:token/preview');
    expect(warned[0]).not.toContain(club.adminToken);

    await app.close();
  });

  /**
   * The url of this route IS a bearer credential, and Fastify logs `req.url` on every request at
   * info level. On every other route carrying a token the caller had to hold a session first; this
   * is the one an anonymous caller drives, so it is the one where a request log is somebody's
   * invite link written down for whoever can read the log.
   *
   * The route therefore carries `logLevel: 'warn'`, and this is the assertion that the option does
   * what the comment beside it claims. `/health` in the same app is the control: it is logged
   * normally, which proves request logging is switched on here and that the silence on the preview
   * route is the route's own doing rather than a level that swallowed everything.
   */
  it('keeps the invite token out of the request log', async () => {
    const { app, lines } = appLogging();
    await app.ready();
    const club = await seedPreviewable();

    expect((await preview(app, club.adminToken)).status).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);

    expect(lines.some((line) => line.includes('/health'))).toBe(true);
    for (const line of lines) {
      expect(line).not.toContain(club.adminToken);
      expect(line).not.toContain('/preview');
    }

    await app.close();
  });

  /**
   * Keyed per caller address, so one visitor cannot spend another's allowance - and keyed on
   * nothing the caller can choose, which rules out a header a stranger could vary to mint a fresh
   * bucket per request.
   */
  it('counts each caller address against its own bucket', async () => {
    const limiter = recordingLimiter();
    const app = appWith(limiter);
    await app.ready();
    const club = await seedPreviewable();

    await preview(app, club.adminToken, '203.0.113.9');
    await preview(app, club.adminToken, '198.51.100.4');

    expect(limiter.keys).toEqual(['rate:http:preview:203.0.113.9', 'rate:http:preview:198.51.100.4']);

    await app.close();
  });
});
