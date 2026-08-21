/**
 * A club the size of the largest one this system is designed for.
 *
 * > **This is the gap that let both N+1s live.** Every other fixture in this repo creates one or
 * > two rows, so every route in it is measured against a club of two people holding one poll.
 * > The two N+1s found on 2026-08-18 were found because a REAL account happened to have 26 poll
 * > cards in one conversation; no automated test had ever built a conversation like that, and no
 * > amount of running the existing suite would have produced one.
 * > [`SPEC/TECH/18`](../../../../SPEC/TECH/18-mission-backend-cleaning.md) section 6.5 names this
 * > as "the actual reason the N+1 lived so long", and
 * > [the roadmap](../../../../SPEC/TECH/20-road-to-the-first-club.md) milestone 3 requires it.
 *
 * **The numbers are taken from the design and from the trace, never invented.** Each is defended
 * where it is declared below, because a fixture whose sizes are arbitrary teaches a reader
 * nothing about whether the thing it measured matters.
 *
 * **What this fixture is for, and what it is not for.** It exists so a cost that scales with
 * input has somewhere to show itself: a statement count taken against it answers "does drawing
 * forty cards cost forty times drawing one". It is deliberately NOT the tool for asking whether
 * a single statement uses the right index. That question needs enough rows for the planner's
 * choice to carry information, and the honest number there is far larger - `hot-path-plans.test.ts`
 * seeds 20,000 rows per table for exactly that reason, and says why. Conflating the two is the
 * error that produced `EXPLAIN` output from a 75-row table as evidence of a missing index: on
 * tables that small Postgres scans sequentially whether or not a usable index exists, so the
 * plan proves nothing in either direction.
 *
 * **Built through the real routes wherever the row shape is subtle**, and by direct insert only
 * for the bulk. A poll carries its options and a media object carries its derived variants and
 * its status; a hand-written row for either is a guess that typechecks, and a fixture built on a
 * guess measures a shape the application never produces. Members and ordinary messages have no
 * such subtlety and there are thousands of them, so those are inserted directly.
 */

import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import {
  channels,
  clubMemberships,
  clubs,
  mediaObjects,
  messages,
  users,
} from '../db/schema.ts';
import type { FakeMediaStore } from '../media/store.ts';

/**
 * The largest channel the design targets.
 *
 * [`SPEC/TECH/00`](../../../../SPEC/TECH/00-overview.md)'s scale table says "~300 members", and
 * that is the number here rather than a round "hundreds": the point of the fixture is to be the
 * biggest club the system claims to serve, so that a cost which is fine at this size is fine.
 */
export const MEMBER_COUNT = 300;

/**
 * Cards in one conversation.
 *
 * The trace on 2026-08-18 found a real account with 26 poll cards and 10 event cards in a single
 * chat, which cost 36 requests to draw. Twenty of each is just past the worst case actually
 * observed, which is the right side of it to sit on.
 */
export const POLL_COUNT = 20;
export const EVENT_COUNT = 20;

/** Photos in one gallery. The roadmap names fifty, and fifty is what a season produces. */
export const PHOTO_COUNT = 50;

/**
 * Ordinary messages in the main channel, on top of the card and photo messages.
 *
 * Five thousand is roughly a term of daily use for a club of this size, and it is what makes
 * `/sync` and the channel reads page over something rather than returning everything they hold.
 * It also puts `last_seq` somewhere realistic, which matters because a gapless counter's cost
 * under contention is the load test's first number.
 */
export const MESSAGE_COUNT = 5_000;

/**
 * How many of the members vote on each poll.
 *
 * Sixty percent of 300, on 20 polls, is 3,600 rows in `poll_votes` - a table the dev database
 * held 75 rows of. It is enough that a per-card vote read is doing real work; it is NOT enough
 * to make a plan meaningful, which is the distinction this file's header draws.
 */
export const VOTER_FRACTION = 0.6;

/** What one request against the fixture looks like, whoever is driving it. */
export type Inject = (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
) => Promise<{ status: number; body: any }>;

export type LargeFixture = {
  clubId: string;
  mainChannelId: string;
  pollIds: string[];
  eventIds: string[];
  mediaIds: string[];
  memberIds: string[];
  /** The channel's `last_seq` once everything is in, which is what `/sync` is asked about. */
  lastSeq: number;
  /** Every row count this fixture produced, so a test can report what it measured against. */
  counts: Record<string, number>;
};

/**
 * A 64px jpeg, encoded once for the whole fixture.
 *
 * Small enough that fifty of them are fast, real enough that the upload path's decode and
 * dimension probe do their actual work rather than being handed something they reject.
 */
let encodedJpeg: Buffer | null = null;
async function jpegBytes(): Promise<Buffer> {
  if (encodedJpeg) return encodedJpeg;
  const sharp = (await import('sharp')).default;
  encodedJpeg = await sharp({
    create: { width: 64, height: 64, channels: 3, background: '#3355aa' },
  })
    .jpeg()
    .toBuffer();
  return encodedJpeg;
}

/**
 * Build it.
 *
 * `owner` must already be a signed-up account holding a session, because the routes this drives
 * are authenticated ones - the fixture makes it the club's owner and hangs everything off it.
 */
export async function seedLargeClub(deps: {
  db: Db;
  request: Inject;
  store: FakeMediaStore;
  ownerId: string;
}): Promise<LargeFixture> {
  const { db, request, store, ownerId } = deps;

  const created = await request('POST', '/clubs', {
    name: `Large Club ${crypto.randomUUID().slice(0, 6)}`,
  });
  if (created.status !== 201) throw new Error(`club create failed: ${created.status}`);
  const clubId: string = created.body.clubId;
  const mainChannelId: string = created.body.mainChannelId;

  const memberIds = await seedRoster(db, clubId, MEMBER_COUNT);
  const pollIds = await addPolls(request, clubId);
  const eventIds = await addEvents(request, clubId);
  await castVotes(db, pollIds, memberIds);
  const mediaIds = await addPhotos(db, request, store, mainChannelId);
  const lastSeq = await addMessages(db, mainChannelId, memberIds, ownerId);

  return {
    clubId,
    mainChannelId,
    pollIds,
    eventIds,
    mediaIds,
    memberIds,
    lastSeq,
    counts: {
      members: memberIds.length + 1,
      polls: pollIds.length,
      pollVotes: pollIds.length * Math.floor(memberIds.length * VOTER_FRACTION),
      events: eventIds.length,
      photos: mediaIds.length,
      messages: lastSeq,
    },
  };
}

/**
 * The roster, inserted directly.
 *
 * Three hundred sign-ups through better-auth would be three hundred password hashes, which is
 * minutes of deliberate work by a function designed to be slow. Nothing here reads a credential:
 * the roster's job is to be large, and `users` plus `club_memberships` is the whole of that.
 *
 * Exported because the load test needs the same roster and must not import the vitest harness:
 * `harness.ts` imports `inject` from vitest, so anything reaching through it cannot be run by
 * plain node. This module deliberately imports neither vitest nor anything that does.
 */
export async function seedRoster(db: Db, clubId: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  const userRows: Array<{ id: string; name: string; email: string }> = [];
  const membershipRows: Array<{ clubId: string; userId: string; role: 'member' | 'admin' }> = [];

  for (let i = 0; i < count; i += 1) {
    const id = crypto.randomUUID();
    ids.push(id);
    userRows.push({
      id,
      name: `Member ${i}`,
      email: `member-${i}-${id.slice(0, 8)}@test.invalid`,
    });
    membershipRows.push({
      clubId,
      userId: id,
      // A handful of admins, because several reads branch on role and a roster of pure members
      // exercises only one side of that branch.
      role: i % 25 === 0 ? 'admin' : 'member',
    });
  }

  await insertInChunks(userRows, (chunk) => db.insert(users).values(chunk));
  await insertInChunks(membershipRows, (chunk) => db.insert(clubMemberships).values(chunk));
  return ids;
}

async function addPolls(request: Inject, clubId: string): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < POLL_COUNT; i += 1) {
    const created = await request('POST', `/clubs/${clubId}/polls`, {
      question: `Which day suits for session ${i}?`,
      options: ['Saturday', 'Sunday', 'Neither'],
    });
    if (created.status !== 201) throw new Error(`poll create failed: ${created.status}`);
    ids.push(created.body.pollId);
  }
  return ids;
}

async function addEvents(request: Inject, clubId: string): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < EVENT_COUNT; i += 1) {
    const created = await request('POST', `/clubs/${clubId}/events`, {
      type: 'practice' as const,
      title: `Practice ${i}`,
      // Spread across a season, so a calendar read over this is doing real ordering work
      // rather than sorting twenty rows that share a timestamp.
      startsAt: new Date(Date.UTC(2027, 3, 1 + i, 17, 0, 0)).toISOString(),
    });
    if (created.status !== 201) throw new Error(`event create failed: ${created.status}`);
    ids.push(created.body.eventId);
  }
  return ids;
}

/**
 * Votes, inserted through the real vote path's own effect on the counts.
 *
 * `poll_options.vote_count` is a maintained column rather than a derived one - deliberately, so
 * that a public tally can be shown to somebody forbidden to read the individual votes - so a
 * fixture that wrote `poll_votes` and left the counts at zero would produce cards that are
 * internally inconsistent in exactly the way the schema exists to prevent. Both are written.
 */
async function castVotes(db: Db, pollIds: string[], memberIds: string[]): Promise<void> {
  const voterCount = Math.floor(memberIds.length * VOTER_FRACTION);
  if (voterCount === 0 || pollIds.length === 0) return;

  for (const pollId of pollIds) {
    const options = await db.execute<{ id: string; position: number }>(
      sql`select id, position from poll_options where poll_id = ${pollId} order by position`,
    );
    const rows = options.rows;
    if (rows.length === 0) continue;

    const votes: Array<{ pollId: string; optionId: string; userId: string; tally: number }> = [];
    for (let i = 0; i < voterCount; i += 1) {
      const option = rows[i % rows.length]!;
      votes.push({
        pollId,
        optionId: option.id,
        userId: memberIds[i]!,
        tally: i % rows.length,
      });
    }

    await insertInChunks(votes, async (chunk) => {
      const values = sql.join(
        chunk.map((v) => sql`(${v.pollId}, ${v.optionId}, ${v.userId}, false)`),
        sql`, `,
      );
      await db.execute(
        sql`insert into poll_votes (poll_id, option_id, user_id, allow_multiple) values ${values}`,
      );
    });

    for (const option of rows) {
      const cast = votes.filter((v) => v.optionId === option.id).length;
      await db.execute(
        sql`update poll_options set vote_count = ${cast} where id = ${option.id}`,
      );
    }
  }
}

/** Fifty photos, through the upload path a client actually takes: intent, PUT, complete. */
async function addPhotos(
  db: Db,
  request: Inject,
  store: FakeMediaStore,
  channelId: string,
): Promise<string[]> {
  const bytes = await jpegBytes();
  const ids: string[] = [];

  for (let i = 0; i < PHOTO_COUNT; i += 1) {
    const intent = await request('POST', '/media/upload-intent', {
      kind: 'photo',
      mime: 'image/jpeg',
      bytes: bytes.byteLength,
      channelId,
    });
    if (intent.status !== 201) throw new Error(`upload intent failed: ${intent.status}`);
    const mediaId: string = intent.body.mediaId;

    const row = await db.select().from(mediaObjects).where(eq(mediaObjects.id, mediaId)).limit(1);
    // Stands in for the client PUTting the bytes straight to object storage.
    store.simulateUpload(row[0]!.bucket, row[0]!.objectKey, new Uint8Array(bytes), 'image/jpeg');

    const done = await request('POST', `/media/${mediaId}/complete`, {});
    if (done.status !== 200) throw new Error(`upload complete failed: ${done.status}`);
    ids.push(mediaId);
  }

  return ids;
}

/**
 * The conversation itself, inserted directly, and the channel counter moved to match.
 *
 * `last_seq` is set once at the end rather than incremented per row for the same reason the rows
 * go in as a batch: this is a fixture standing in for months of sends, not a test of the append
 * path, and `append-message.test.ts` is where that path's gaplessness is actually proved.
 *
 * Every message is attributed to a real member, because a channel where one person said five
 * thousand things exercises none of the sender joins that a read does per row.
 */
async function addMessages(
  db: Db,
  channelId: string,
  memberIds: string[],
  ownerId: string,
): Promise<number> {
  const existing = await db
    .select({ lastSeq: channels.lastSeq })
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);
  let seq = existing[0]?.lastSeq ?? 0;

  const senders = [ownerId, ...memberIds];
  const rows: Array<{
    channelId: string;
    seq: number;
    senderId: string;
    type: string;
    body: string;
    clientMsgId: string;
  }> = [];

  for (let i = 0; i < MESSAGE_COUNT; i += 1) {
    seq += 1;
    rows.push({
      channelId,
      seq,
      senderId: senders[i % senders.length]!,
      type: 'text',
      body: `message ${i} in the long run of ordinary chat`,
      clientMsgId: crypto.randomUUID(),
    });
  }

  await insertInChunks(rows, (chunk) => db.insert(messages).values(chunk));
  await db.update(channels).set({ lastSeq: seq }).where(eq(channels.id, channelId));
  return seq;
}

/**
 * Insert in batches.
 *
 * Postgres binds parameters per statement and the ceiling is 65,535 of them; five thousand
 * messages at six columns each is past it, and the failure is a driver error at fixture time
 * rather than anything to do with the code under test. Five hundred rows is comfortably inside
 * it for every shape here.
 */
async function insertInChunks<T>(
  rows: readonly T[],
  insert: (chunk: T[]) => Promise<unknown>,
): Promise<void> {
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await insert(rows.slice(i, i + CHUNK));
  }
}
