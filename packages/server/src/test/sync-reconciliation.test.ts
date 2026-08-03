/**
 * That a change to a message the client already holds reaches it.
 *
 * > **The defect these exist for, `PRD/17` item 14:** sync asked for `seq > <the client's local
 * > max>`, so a row already cached was never fetched again - and a pin, a tombstone and a
 * > reaction all mutate rows BELOW that mark. A client offline when a message was deleted kept
 * > showing it, with its text, indefinitely.
 *
 * **Every automated check passed while that was true**, because each half was individually
 * correct: the live `msg.update` frame carried the change, and sync correctly returned everything
 * new. Nothing asked the one question that spans them - what happens to a change that arrives
 * while nobody is listening. That is the shape these tests are written to catch.
 *
 * The client is simulated as a watermark, which is exactly what a real one is: sync from the mark,
 * apply what comes back, remember the new mark.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createClub } from '../domain/create-club.ts';
import { sendMessage, setPinned, softDeleteMessage } from '../domain/send-message.ts';
import { toggleReaction } from '../domain/reactions.ts';
import { getChannelRef, syncSince } from '../domain/reads.ts';
import { loadAccessContext } from '../policy/context.ts';
import { users } from '../db/schema.ts';
import { anyViewer, startTestDb, type TestDb } from './harness.ts';
import type { ChannelRef } from '../policy/predicates.ts';

let h: TestDb;

beforeAll(async () => {
  h = await startTestDb();
}, 120_000);
afterAll(async () => {
  await h?.stop();
});

beforeEach(async () => {
  await h.db.execute(sql`TRUNCATE message_reactions, outbox RESTART IDENTITY CASCADE`);
});

const ctxFor = (id: string) => loadAccessContext(h.db, id);

async function makeUser(name: string): Promise<string> {
  const id = crypto.randomUUID();
  await h.db.insert(users).values({ id, name, email: `${name}-${id.slice(0, 8)}@t.invalid` });
  return id;
}

async function setup(): Promise<{ ownerId: string; channel: ChannelRef }> {
  const ownerId = await makeUser('SyncOwner');
  const created = await createClub(h.db, {
    name: `Club ${crypto.randomUUID().slice(0, 6)}`,
    sport: 'running',
    creatorId: ownerId,
  });
  const channel = await getChannelRef(h.db, created.mainChannelId);
  if (!channel) throw new Error('no channel');
  return { ownerId, channel };
}

async function say(userId: string, channel: ChannelRef, body: string) {
  const result = await sendMessage(h.db, await ctxFor(userId), channel, {
    channelId: channel.id,
    clientMsgId: crypto.randomUUID(),
    body,
  });
  if (!result.ok) throw new Error(`send refused: ${result.code}`);
  return result.message;
}

/**
 * A client: sync from its marks, and remember where it got to.
 *
 * Deliberately mirrors `chat-client.syncChannel` rather than importing it - the point is to
 * assert the SERVER contract from the outside, and a shared implementation would make both halves
 * agree with each other rather than with the requirement.
 */
function fakeClient(channel: ChannelRef) {
  const held = new Map<number, { body: string | null; pinned: boolean; deleted: boolean; reactions: number }>();
  let mark = 0;
  let maxSeq = 0;

  return {
    held,
    get mark() {
      return mark;
    },
    async sync() {
      const page = await syncSince(h.db, anyViewer(), channel.id, maxSeq, 500, mark);
      for (const message of page.messages) {
        held.set(message.seq, {
          body: message.body,
          pinned: message.pinned,
          deleted: message.deletedAt !== null,
          reactions: message.reactions?.length ?? 0,
        });
        if (message.seq > maxSeq) maxSeq = message.seq;
      }
      if (page.maxRev > mark) mark = page.maxRev;
      return page;
    },
  };
}

describe('a change made while the client was away', () => {
  it('delivers a deletion to a client that already held the message', async () => {
    /*
     * The moderation hole, stated as a test. Before revisions this failed: the client had seq 1,
     * sync asked for seq > 1, and the tombstone lived on seq 1.
     */
    const { ownerId, channel } = await setup();
    const message = await say(ownerId, channel, 'something regrettable');

    const client = fakeClient(channel);
    await client.sync();
    expect(client.held.get(message.seq)?.body).toBe('something regrettable');
    expect(client.held.get(message.seq)?.deleted).toBe(false);

    // Offline for this part.
    const deleted = await softDeleteMessage(h.db, await ctxFor(ownerId), channel, message.seq);
    expect(deleted.ok).toBe(true);

    await client.sync();

    const after = client.held.get(message.seq);
    expect(after?.deleted, 'a deletion did not reach a client that was offline for it').toBe(true);
    // The body goes with it. A tombstone that still carried its text would be a delete in name.
    expect(after?.body).toBeNull();
  });

  it('delivers a pin', async () => {
    const { ownerId, channel } = await setup();
    const message = await say(ownerId, channel, 'worth keeping');

    const client = fakeClient(channel);
    await client.sync();
    expect(client.held.get(message.seq)?.pinned).toBe(false);

    await setPinned(h.db, await ctxFor(ownerId), channel, message.seq, true);
    await client.sync();

    expect(client.held.get(message.seq)?.pinned).toBe(true);
  });

  it('delivers a reaction, which does not change the message row at all', async () => {
    /*
     * The subtlest of the three: a reaction lives in another table, so nothing about the message
     * changes except what its envelope says. Without an explicit touch there is no signal at all.
     */
    const { ownerId, channel } = await setup();
    const message = await say(ownerId, channel, 'funny');

    const client = fakeClient(channel);
    await client.sync();
    expect(client.held.get(message.seq)?.reactions).toBe(0);

    const reacted = await toggleReaction(h.db, await ctxFor(ownerId), channel, message.seq, '🔥');
    expect(reacted.ok).toBe(true);

    await client.sync();
    expect(client.held.get(message.seq)?.reactions).toBe(1);
  });
});

describe('the watermark itself', () => {
  it('does not move when nothing changed, and returns nothing', async () => {
    // A quiet sync must be genuinely quiet. A mark that crept forward on an empty page would be
    // harmless; one that reset would re-pull the channel on every foreground.
    const { ownerId, channel } = await setup();
    await say(ownerId, channel, 'hello');

    const client = fakeClient(channel);
    await client.sync();
    const settled = client.mark;
    expect(settled).toBeGreaterThan(0);

    const second = await client.sync();
    expect(second.messages).toHaveLength(0);
    expect(client.mark).toBe(settled);
  });

  it('advances past an append as well as a change, so one mark covers both', async () => {
    const { ownerId, channel } = await setup();
    await say(ownerId, channel, 'first');

    const client = fakeClient(channel);
    await client.sync();
    const afterFirst = client.mark;

    await say(ownerId, channel, 'second');
    const page = await client.sync();

    expect(page.messages.map((m) => m.body)).toContain('second');
    expect(client.mark).toBeGreaterThan(afterFirst);
  });

  it('returns a changed message ONCE, not on every subsequent sync', async () => {
    // If the mark did not advance past a change, every sync would re-deliver it - which reads as
    // working and quietly turns reconnect into a full channel pull.
    const { ownerId, channel } = await setup();
    const message = await say(ownerId, channel, 'pin me');

    const client = fakeClient(channel);
    await client.sync();

    await setPinned(h.db, await ctxFor(ownerId), channel, message.seq, true);
    const carrying = await client.sync();
    expect(carrying.messages).toHaveLength(1);

    const quiet = await client.sync();
    expect(quiet.messages).toHaveLength(0);
  });
});

describe('a client that predates revisions', () => {
  it('still gets new messages when it sends no mark', async () => {
    /*
     * The mixed-fleet case. A phone that has not been updated sends `id:seq` and must keep
     * working exactly as before - correct but incomplete, rather than broken.
     */
    const { ownerId, channel } = await setup();
    const first = await say(ownerId, channel, 'one');
    await say(ownerId, channel, 'two');

    const page = await syncSince(h.db, anyViewer(), channel.id, first.seq);

    expect(page.messages.map((m) => m.body)).toEqual(['two']);
  });
});
