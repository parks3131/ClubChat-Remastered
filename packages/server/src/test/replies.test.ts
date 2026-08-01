/**
 * Replies: one integer stored, a whole quote read back.
 *
 * A message stores `reply_to_seq` and nothing else about what it answers. Everything a quote box
 * draws - who said it, what it said, its photo - is **joined on every read**, and these tests are
 * shaped around that decision rather than around the feature, because the decision is what has an
 * easy way to look correct while being wrong:
 *
 *  - **A deleted original stops showing its words everywhere at once.** This is the case that
 *    rules out storing a snapshot of the quoted text at send time. A snapshot survives the
 *    delete, so words an admin removed would live on inside every reply that quoted them, out of
 *    reach of the thing that was supposed to remove them.
 *  - **A rename reaches the quote too**, for the same reason `senderName` is joined.
 *  - **The live path carries the quote, not only the read path.** `msg.new` is built from
 *    `appendMessage`'s envelope, and a field stored on the message but never put on the wire is
 *    the exact defect `mediaId` and `linkedPollId` each shipped with. Asserted on the envelope
 *    the send returns, which is the one that gets published.
 *  - **A reply cannot reach into another channel.** Enforced by the composite foreign key rather
 *    than by a check in the handler, so it is asserted as a refusal of the write.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { REPLY_PREVIEW_CHARS } from '@clubchat/shared';
import { createClub } from '../domain/create-club.ts';
import { addMember } from '../domain/membership.ts';
import { sendMessage, softDeleteMessage } from '../domain/send-message.ts';
import { getChannelRef, readHistory, syncSince } from '../domain/reads.ts';
import { loadAccessContext } from '../policy/context.ts';
import { messages, users } from '../db/schema.ts';
import { startTestDb, type TestDb } from './harness.ts';
import type { ChannelRef } from '../policy/predicates.ts';

let h: TestDb;

beforeAll(async () => {
  h = await startTestDb();
}, 120_000);
afterAll(async () => {
  await h?.stop();
});

const ctxFor = (id: string) => loadAccessContext(h.db, id);

async function makeUser(name: string): Promise<string> {
  const id = crypto.randomUUID();
  await h.db.insert(users).values({ id, name, email: `${name}-${id.slice(0, 8)}@t.invalid` });
  return id;
}

async function say(
  userId: string,
  channel: ChannelRef,
  body: string | null,
  extra: { replyToSeq?: number; type?: 'text' | 'photo' | 'document' } = {},
) {
  const result = await sendMessage(h.db, await ctxFor(userId), channel, {
    channelId: channel.id,
    clientMsgId: crypto.randomUUID(),
    body,
    ...extra,
  });
  if (!result.ok) throw new Error(`send refused: ${result.code}`);
  return result.message;
}

type Fixture = { channel: ChannelRef; second: ChannelRef; ownerId: string; memberId: string };

async function setup(): Promise<Fixture> {
  const ownerId = await makeUser('Owner');
  const memberId = await makeUser('Member');
  const club = await createClub(h.db, { name: 'Hillside', sport: 'running', creatorId: ownerId });
  await addMember(h.db, await ctxFor(ownerId), club.clubId, memberId);
  const channel = await getChannelRef(h.db, club.mainChannelId);

  // A second club, for the cross-channel case. Two channels the same person can reach is the
  // interesting shape: authorization would let them post in both, so only the reference itself
  // can stop a quote crossing between them.
  const other = await createClub(h.db, { name: 'Riverside', sport: 'running', creatorId: ownerId });
  const second = await getChannelRef(h.db, other.mainChannelId);
  if (!channel || !second) throw new Error('fixture channel missing');
  return { channel, second, ownerId, memberId };
}

/** The one message in a page, by seq. Reads go through the real query, never a hand-built row. */
async function reread(channel: ChannelRef, seq: number) {
  const page = await readHistory(h.db, channel.id, {});
  const found = page.find((message) => message.seq === seq);
  if (!found) throw new Error(`seq ${seq} not in history`);
  return found;
}

describe('a reply carries the message it answers', () => {
  it('resolves the quote on the read: who, what, and that it is not deleted', async () => {
    const f = await setup();
    const original = await say(f.ownerId, f.channel, 'who is driving on Saturday?');
    const reply = await say(f.memberId, f.channel, 'I can take four', {
      replyToSeq: original.seq,
    });

    const read = await reread(f.channel, reply.seq);
    // Field names, not just shape. The client restates response shapes by hand, and every one of
    // the four crashes in Phase 3.75 was a name that did not exist on the real payload.
    expect(read.replyTo).toEqual({
      seq: original.seq,
      senderId: f.ownerId,
      senderName: 'Owner',
      type: 'text',
      preview: 'who is driving on Saturday?',
      mediaId: null,
      documentName: null,
      deleted: false,
    });
    // And the message it is a reply TO carries nothing, so a quote box is drawn on exactly one
    // of the two.
    expect((await reread(f.channel, original.seq)).replyTo).toBeNull();
  });

  it('puts the quote on the envelope the send returns, which is what msg.new publishes', async () => {
    const f = await setup();
    const original = await say(f.ownerId, f.channel, 'bring cones');
    const reply = await say(f.memberId, f.channel, 'got them', { replyToSeq: original.seq });

    // Not re-read: this is the object the gateway hands to `publishToChannel`. A null here is a
    // reply that draws no quote on every other device until that row is fetched again - which
    // sync never does, because it pulls strictly above the local max.
    expect(reply.replyTo?.seq).toBe(original.seq);
    expect(reply.replyTo?.preview).toBe('bring cones');
    expect(reply.replyTo?.senderName).toBe('Owner');
  });

  it('reaches the sync path too, so a client catching up gets its quotes', async () => {
    const f = await setup();
    const original = await say(f.ownerId, f.channel, 'meet at seven');
    const reply = await say(f.memberId, f.channel, 'see you there', {
      replyToSeq: original.seq,
    });

    const backlog = await syncSince(h.db, f.channel.id, 0);
    const synced = backlog.messages.find((message) => message.seq === reply.seq);
    expect(synced?.replyTo?.preview).toBe('meet at seven');
  });

  it('truncates a long quote rather than carrying the whole message twice', async () => {
    const f = await setup();
    const long = 'x'.repeat(REPLY_PREVIEW_CHARS + 200);
    const original = await say(f.ownerId, f.channel, long);
    const reply = await say(f.memberId, f.channel, 'ok', { replyToSeq: original.seq });

    const read = await reread(f.channel, reply.seq);
    expect(read.replyTo?.preview).toHaveLength(REPLY_PREVIEW_CHARS);
    // The message's own body is untouched. Only the quote is cut.
    expect((await reread(f.channel, original.seq)).body).toHaveLength(long.length);
  });
});

describe('the quote follows the original rather than snapshotting it', () => {
  it('reads "deleted" and loses the text once the original is deleted', async () => {
    const f = await setup();
    const original = await say(f.ownerId, f.channel, 'something regrettable');
    const reply = await say(f.memberId, f.channel, 'oh dear', { replyToSeq: original.seq });

    expect((await reread(f.channel, reply.seq)).replyTo?.preview).toBe('something regrettable');

    const removed = await softDeleteMessage(h.db, await ctxFor(f.ownerId), f.channel, original.seq);
    expect(removed.ok).toBe(true);

    const after = await reread(f.channel, reply.seq);
    expect(after.replyTo?.deleted).toBe(true);
    /*
     * The words are gone, not merely flagged. This is the assertion that a stored snapshot could
     * not pass, and it is why the quote is joined: a deletion has to remove the text from every
     * place it appears, including inside a quote of it in somebody else's bubble.
     */
    expect(after.replyTo?.preview).toBeNull();
    // The reply itself survives. A message vanishing mid-conversation is what the tombstone
    // exists to prevent; that applies to the reply as much as to the original.
    expect(after.body).toBe('oh dear');
    expect(after.deletedAt).toBeNull();
  });

  it('follows a rename, exactly as senderName does', async () => {
    const f = await setup();
    const original = await say(f.ownerId, f.channel, 'my old name said this');
    const reply = await say(f.memberId, f.channel, 'quoting you', { replyToSeq: original.seq });

    await h.db.update(users).set({ name: 'Renamed Owner' }).where(eq(users.id, f.ownerId));

    expect((await reread(f.channel, reply.seq)).replyTo?.senderName).toBe('Renamed Owner');
  });

  it('quotes an attachment by identity, so the box can draw a thumbnail or a filename', async () => {
    const f = await setup();
    /*
     * Written straight to the row rather than through the upload pipeline. What is under test is
     * the projection - does the quote carry the attachment's identity - and routing this through
     * intent-PUT-complete would be testing the media pipeline instead, and would fail for reasons
     * that have nothing to do with the quote.
     */
    const photo = await say(f.ownerId, f.channel, null, { type: 'photo' });
    const mediaId = crypto.randomUUID();
    await h.db
      .update(messages)
      .set({ mediaId, documentName: null })
      .where(eq(messages.id, photo.id));

    const reply = await say(f.memberId, f.channel, 'nice one', { replyToSeq: photo.seq });
    const read = await reread(f.channel, reply.seq);
    expect(read.replyTo?.mediaId).toBe(mediaId);
    expect(read.replyTo?.type).toBe('photo');
    // Null preview, because there was no caption. The client labels this "Photo" rather than
    // drawing an empty box.
    expect(read.replyTo?.preview).toBeNull();
  });
});

describe('what a reply may point at', () => {
  it('refuses a quote of a message in another channel', async () => {
    const f = await setup();
    const elsewhere = await say(f.ownerId, f.second, 'said in the other club');

    /*
     * The refusal comes from `messages_reply_to_fk`, a composite key on
     * `(channel_id, reply_to_seq)` - not from a check in the send handler. That is the whole
     * argument for referencing a seq rather than a message id: with an id this write would
     * succeed, and every read drawing the quote would have to re-check the channel itself.
     */
    await expect(
      say(f.ownerId, f.channel, 'leaking', { replyToSeq: elsewhere.seq }),
    ).rejects.toThrow();
  });

  it('refuses a quote of a seq that does not exist', async () => {
    const f = await setup();
    await expect(say(f.ownerId, f.channel, 'answering nothing', { replyToSeq: 9999 })).rejects.toThrow();
  });

  it('lets a reply be replied to, and does not chain the quotes', async () => {
    const f = await setup();
    const first = await say(f.ownerId, f.channel, 'one');
    const second = await say(f.memberId, f.channel, 'two', { replyToSeq: first.seq });
    const third = await say(f.ownerId, f.channel, 'three', { replyToSeq: second.seq });

    // Flat, by construction: a quote carries the message's own text, never the quote inside it.
    // Nesting would grow without bound down a long back-and-forth.
    const read = await reread(f.channel, third.seq);
    expect(read.replyTo?.seq).toBe(second.seq);
    expect(read.replyTo?.preview).toBe('two');
  });
});
