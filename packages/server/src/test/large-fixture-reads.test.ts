/**
 * The batch routes and `/sync`, measured against a club the size of the largest one designed for.
 *
 * > **Every cost this project has recorded was measured against one or two rows.** That is the
 * > reason both N+1s survived: `batch-reads.test.ts` guards `GET /polls?ids=` and
 * > `GET /media/urls?ids=` at EIGHT ids in a club of two people, which is enough to prove the
 * > shape of the fix and not enough to resemble anything a club does. The defects were found by a
 * > trace of a real account that happened to hold 26 poll cards in one conversation.
 * > [The roadmap](../../../../SPEC/TECH/20-road-to-the-first-club.md) milestone 3 requires the
 * > fixture and these guards; `large-fixture.ts` defends every number it uses.
 *
 * So this file asks the same questions `batch-reads.test.ts` asks, at 20 polls and 50 photos,
 * against 300 members, 3,600 votes and 5,000 messages - and adds the two it does not ask at all:
 * `/sync`, whose cost must not scale with how far behind a client is, and `GET /events?ids=`,
 * which is still the one batch route with no guard.
 *
 * **What a statement count can and cannot see.** It answers "how many round trips", which is the
 * question both N+1s failed. It says nothing about whether one of those statements uses the right
 * index - that needs a planner with enough rows to have an opinion, and it is
 * `hot-path-plans.test.ts`'s job at 20,000 rows per table. Neither file is evidence for the
 * other's question.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../api/app.ts';
import { createAuth, type Auth } from '../auth.ts';
import type { Config } from '../config.ts';
import { FakeMediaStore } from '../media/store.ts';
import { silentMonitor } from '../monitoring.ts';
import { instrumentPool } from '../dev/queries.ts';
import type { TraceEvent, TraceInput } from '../dev/trace.ts';
import { allowAll } from './fake-limiter.ts';
import { startTestDb, type TestDb } from './harness.ts';
import {
  seedLargeClub,
  seedMessages,
  MEMBER_COUNT,
  MESSAGE_COUNT,
  PHOTO_COUNT,
  POLL_COUNT,
  type LargeFixture,
} from './large-fixture.ts';

let h: TestDb;
let app: FastifyInstance;
let auth: Auth;
let store: FakeMediaStore;
let traced: TraceEvent[];
let fixture: LargeFixture;
let token = '';
let ownerId = '';

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

async function as(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
): Promise<{ status: number; body: any }> {
  const response = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  return {
    status: response.statusCode,
    body: response.body.length > 0 ? JSON.parse(response.body) : null,
  };
}

/** The query count the real dashboard shows, for the most recent request on a route. */
function queriesFor(route: string): number {
  const last = [...traced].reverse().find((e) => e.kind === 'http' && e.route === route);
  if (!last || last.kind !== 'http' || last.queries === undefined) {
    throw new Error(`no traced ${route} request carried a query count`);
  }
  return last.queries;
}

beforeAll(async () => {
  h = await startTestDb();
  auth = createAuth(h.db, {
    secret: 'test-secret-not-a-real-one',
    baseURL: config.BETTER_AUTH_URL,
  });
  store = new FakeMediaStore();
  traced = [];
  instrumentPool(h.pool);
  app = buildApp({
    db: h.db,
    auth,
    config,
    mediaStore: store,
    monitor: silentMonitor(),
    limiter: allowAll(),
    tracer: { emit: (event: TraceInput) => traced.push(event as TraceEvent) },
  });
  await app.ready();

  const signedUp = await auth.api.signUpEmail({
    body: {
      name: 'LargeFixtureOwner',
      email: `large-${crypto.randomUUID().slice(0, 8)}@test.invalid`,
      password: 'correct-horse-battery-staple',
    },
  });
  const issued = (signedUp as { token?: string }).token;
  if (!issued) throw new Error('sign-up returned no session token');
  token = issued;
  ownerId = signedUp.user.id;

  fixture = await seedLargeClub({
    db: h.db,
    request: as,
    store,
    ownerId: signedUp.user.id,
  });
  // 300 members, 20 polls, 3,600 votes, 20 events, 50 photos and 5,070 messages take a while,
  // and paying it once for the file is the whole point of a fixture this size.
}, 600_000);

afterAll(async () => {
  await app?.close().catch(() => undefined);
  await h?.stop().catch(() => undefined);
});

describe('the fixture', () => {
  /**
   * Stated out loud, so a number measured below is reported against a size rather than against
   * "a large fixture". Every one of these is defended where it is declared in `large-fixture.ts`.
   */
  it('is the size it claims to be', () => {
    expect(fixture.counts).toMatchObject({
      members: MEMBER_COUNT + 1,
      polls: POLL_COUNT,
      pollVotes: POLL_COUNT * Math.floor(MEMBER_COUNT * 0.6),
      events: 20,
      photos: PHOTO_COUNT,
    });
    expect(fixture.lastSeq).toBeGreaterThanOrEqual(MESSAGE_COUNT);
  });
});

describe('the batch routes, at the size a club actually reaches', () => {
  /**
   * Twenty poll cards is just past the 26-card conversation the trace found, and the guard is
   * the same one `batch-reads.test.ts` makes at eight: same statements for many as for one.
   * Making it again here is not duplication, because the thing that differs is everything
   * underneath - 300 members, 3,600 votes - and a read that batches its polls while looping its
   * voters would pass at eight and fail here.
   */
  it('reads twenty polls in no more statements than one', async () => {
    traced.length = 0;
    expect((await as('GET', `/polls?ids=${fixture.pollIds[0]}`)).status).toBe(200);
    const forOne = queriesFor('/polls');

    traced.length = 0;
    const all = await as('GET', `/polls?ids=${fixture.pollIds.join(',')}`);
    expect(all.status).toBe(200);
    expect(all.body.polls).toHaveLength(POLL_COUNT);

    const forTwenty = queriesFor('/polls');
    console.log(
      `[measured] GET /polls?ids=  1 id: ${forOne} statements, ${POLL_COUNT} ids: ${forTwenty} statements`,
    );
    expect(forTwenty, 'drawing a chat full of poll cards must not cost per card').toBe(forOne);
  });

  /**
   * Fifty photos in one gallery, which is what the roadmap names and what a season produces.
   * The defect this guards against is specific and was real: two statements per picture, the
   * media row and then the channel that owns it, in a gallery where every picture shares one
   * channel.
   */
  it('resolves fifty gallery photos in no more statements than one', async () => {
    traced.length = 0;
    expect((await as('GET', `/media/urls?ids=${fixture.mediaIds[0]}`)).status).toBe(200);
    const forOne = queriesFor('/media/urls');

    traced.length = 0;
    const all = await as('GET', `/media/urls?ids=${fixture.mediaIds.join(',')}`);
    expect(all.status).toBe(200);
    expect(all.body.urls).toHaveLength(PHOTO_COUNT);

    const forFifty = queriesFor('/media/urls');
    console.log(
      `[measured] GET /media/urls?ids=  1 id: ${forOne} statements, ${PHOTO_COUNT} ids: ${forFifty} statements`,
    );
    expect(forFifty, 'a gallery must not cost per photo').toBe(forOne);
  });

  /**
   * **`GET /events?ids=` was the last batch route without a flat guard, and this is now that
   * guard.**
   *
   * > It cost `3 + n`: the route looped `readEvent` once per id, exactly as `/polls` did before
   * > TECH/18 2.16. Measured here on 2026-08-21 at 4 statements for one id and 23 for twenty, and
   * > fixed the same day. Two review lanes found it independently and
   * > [the roadmap](../../../../SPEC/TECH/20-road-to-the-first-club.md) carried it as a milestone
   * > 2 exit criterion: "`GET /events?ids=` carries the same flat-statement guard as `/polls` and
   * > `/media/urls`".
   *
   * This case was written the day before the fix and deliberately asserted the DEFECT, so that
   * landing the fix had to come here and invert it rather than leaving a test that passed either
   * side of the change. That inversion is this commit.
   */
  it('reads twenty events in no more statements than one', async () => {
    traced.length = 0;
    expect((await as('GET', `/events?ids=${fixture.eventIds[0]}`)).status).toBe(200);
    const forOne = queriesFor('/events');

    traced.length = 0;
    const all = await as('GET', `/events?ids=${fixture.eventIds.join(',')}`);
    expect(all.status).toBe(200);
    expect(all.body.events).toHaveLength(20);
    const forTwenty = queriesFor('/events');

    console.log(
      `[measured] GET /events?ids=  1 id: ${forOne} statements, 20 ids: ${forTwenty} statements`,
    );
    expect(forTwenty, 'drawing a chat full of event cards must not cost per card').toBe(forOne);
  });

  /**
   * And the order, which is the one thing a batch can silently change without changing a count.
   *
   * `readEvents` iterates the caller's id list rather than the scan's output, the same way
   * `readPolls` does. A batch that returned rows in whatever order Postgres produced would look
   * correct in every count-based test here and quietly reshuffle a client's calendar.
   */
  it('returns events in the order they were asked for', async () => {
    const asked = [...fixture.eventIds].reverse();
    const response = await as('GET', `/events?ids=${asked.join(',')}`);
    expect(response.status).toBe(200);
    expect(response.body.events.map((e: { id: string }) => e.id)).toEqual(asked);
  });
});

describe('/sync, against five thousand messages', () => {
  /**
   * **The cost of catching up must not depend on how far behind you are.**
   *
   * This is the property that matters for a pilot club, and it is the one nothing measured. A
   * member who has not opened the app for a fortnight is the case where a per-message round trip
   * would show up, and it is precisely the case no existing fixture could produce: every other
   * test in this repo syncs a channel holding a handful of rows.
   *
   * Asserted as "the same from seq 0 as from near the head" rather than as a fixed number, so
   * adding a column to the envelope does not fail this and reintroducing a loop does.
   */
  it('costs the same statements from the beginning as from the head', async () => {
    const channel = fixture.mainChannelId;

    traced.length = 0;
    const fromHead = await as('GET', `/sync?channels[]=${channel}:${fixture.lastSeq - 5}`);
    expect(fromHead.status).toBe(200);
    const nearHead = queriesFor('/sync');

    traced.length = 0;
    const fromZero = await as('GET', `/sync?channels[]=${channel}:0`);
    expect(fromZero.status).toBe(200);
    const fromScratch = queriesFor('/sync');

    expect(
      fromScratch,
      'a member a fortnight behind must cost the same round trips as one who is current',
    ).toBe(nearHead);

    console.log(
      `[measured] GET /sync over ${fixture.lastSeq} messages: ${fromScratch} statements from seq 0, ${nearHead} from the head`,
    );
  });

  /**
   * **And the other axis, which nothing has ever measured: how the cost grows per CHANNEL.**
   *
   * `/sync` loops its `channels[]` entries, and the contract admits 200 of them - which is what a
   * member of several clubs, each with races and an eboard, plus their DM threads, actually
   * sends. TECH/18 2.1 removed the per-channel round trips the CLIENT was making by giving it one
   * request instead of one per chat; whether the server then pays per channel underneath is a
   * different question and was left unasked.
   *
   * Recorded rather than asserted flat, because a per-channel cost here is defensible in a way a
   * per-id cost on a batch read is not: each channel is a different authorization subject and a
   * different slice of the log. What is worth pinning is the RATIO, so that a change which makes
   * it worse than linear is visible.
   */
  it('grows linearly per channel, at a slope this records', async () => {
    /*
     * Measured at four sizes rather than two, because two points fit any straight line and the
     * question is whether it IS one. Four extra clubs is four route calls; the channel each one
     * brings is empty, which is the right control - what is being measured is the per-channel
     * overhead, not the cost of the messages in it.
     */
    const extra: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const club = await as('POST', '/clubs', { name: `Sync Slope Club ${i}` });
      expect(club.status).toBe(201);
      /*
       * Populated, not empty, and that is the whole point of seeding them.
       *
       * An empty channel skips the reaction and mention side loads entirely, so a slope measured
       * over empty channels measures the cheap half of the cost and reports it as the whole
       * thing. That is exactly the mistake the first version of this test made on 2026-08-21: it
       * recorded `5 + 2n` when a sync over channels a member actually reads was `5 + 4n`.
       */
      await seedMessages(h.db, club.body.mainChannelId, fixture.memberIds, ownerId, 25);
      extra.push(club.body.mainChannelId);
    }
    const all = [fixture.mainChannelId, ...extra];

    const costFor = async (count: number): Promise<number> => {
      const query = all
        .slice(0, count)
        .map((id) => `channels[]=${id}:0`)
        .join('&');
      traced.length = 0;
      const response = await as('GET', `/sync?${query}`);
      expect(response.status).toBe(200);
      expect(response.body.channels).toHaveLength(count);
      return queriesFor('/sync');
    };

    const measured = [1, 2, 3, 5].map(() => 0);
    const sizes = [1, 2, 3, 5];
    for (let i = 0; i < sizes.length; i += 1) measured[i] = await costFor(sizes[i]!);

    const slope = (measured[3]! - measured[0]!) / (sizes[3]! - sizes[0]!);
    console.log(
      `[measured] GET /sync per channel: ${sizes
        .map((n, i) => `${n} -> ${measured[i]}`)
        .join(', ')} statements (slope ${slope} per channel)`,
    );

    /*
     * **Linear is the assertion, and it is a real one rather than a formality.** Each channel is
     * a separate authorization subject and a separate slice of the log, so a per-channel cost is
     * defensible in a way a per-id cost on a batch read is not. What is not defensible is
     * anything steeper: a client may send 200 entries, so a quadratic term would be four hundred
     * times the cost at the size the contract admits rather than four.
     */
    for (let i = 1; i < sizes.length; i += 1) {
      const predicted = measured[0]! + slope * (sizes[i]! - sizes[0]!);
      expect(
        measured[i],
        `/sync at ${sizes[i]} channels cost ${measured[i]} statements against a linear ${predicted}`,
      ).toBe(predicted);
    }
  });

  /**
   * And it pages rather than returning everything, which is the other half of the same promise:
   * a flat statement count would be no comfort if one of those statements returned five thousand
   * rows.
   */
  it('pages a five thousand message backlog rather than returning it whole', async () => {
    const response = await as('GET', `/sync?channels[]=${fixture.mainChannelId}:0`);
    expect(response.status).toBe(200);
    const [channel] = response.body.channels;
    expect(channel.hasMore, 'a backlog this size must report that there is more').toBe(true);
    expect(channel.messages.length).toBeLessThan(MESSAGE_COUNT);
  });
});

describe('what the database thinks it spent its time on', () => {
  /**
   * `pg_stat_statements`, queryable - which is
   * [the roadmap](../../../../SPEC/TECH/20-road-to-the-first-club.md) milestone 3's second exit
   * criterion, and the one entry in TECH/18 section 6 that needs no application instrumentation
   * at all. The per-request counter above answers "what did THIS request cost"; this answers
   * "what is this database spending its life on", across every process including the worker and
   * the gateway.
   *
   * The extension is preloaded by `global-setup.ts` and by `docker-compose.yml`, which is the
   * part that cannot be done later: it has to be in `shared_preload_libraries` at server start.
   * `CREATE EXTENSION` is per database and deliberately not a migration - see the compose file.
   *
   * This asserts availability rather than any particular number. What the suite ran is not
   * interesting; that a running system can be asked is the whole point, and a facility available
   * in development but not in the container the tests run against is one nobody can check.
   */
  it('is queryable, and has been recording', async () => {
    await h.pool.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');

    const top = await h.pool.query<{ calls: string; total_exec_time: number; query: string }>(
      `SELECT calls, total_exec_time, query
         FROM pg_stat_statements
        WHERE query NOT LIKE '%pg_stat_statements%'
        ORDER BY calls DESC
        LIMIT 5`,
    );

    expect(
      top.rows.length,
      'the extension is loaded but recorded nothing, which means track is off',
    ).toBeGreaterThan(0);

    console.log('[measured] the five most-called statements while this file ran:');
    for (const row of top.rows) {
      console.log(`  ${String(row.calls).padStart(6)} calls  ${row.query.slice(0, 110)}`);
    }
  });
});
