/**
 * The local store's one non-obvious rule: **a delete reaches every quote of the message.**
 *
 * Everything else `patch` does touches the row it names. This one does not, and it has to:
 *
 * The server joins a reply's quote on every read, so a FRESH read of a reply to a deleted message
 * already says "This message was deleted". A client that is already holding that reply will never
 * take a fresh read of it - `syncChannel` pulls strictly ABOVE the local max, so a row once
 * cached is never fetched again. Without this rule the words an admin deleted stay legible inside
 * every cached reply that quoted them, permanently, on every device that was in the conversation
 * at the time. Nothing else in the system would ever correct it.
 *
 * The interface owes this, not one implementation of it, which is why it is tested here against
 * the in-memory store rather than against the app's SQLite one.
 */

import { describe, expect, it } from 'vitest';
import type { MessageEnvelope, MessageReplyRef } from '@clubchat/shared';
import { InMemoryMessageStore, strikeQuotedMessage } from './store.ts';

const CHANNEL = '11111111-1111-4111-8111-111111111111';

function message(seq: number, overrides: Partial<MessageEnvelope> = {}): MessageEnvelope {
  return {
    id: `m${seq}`,
    channelId: CHANNEL,
    seq,
    senderId: 'someone',
    senderName: 'Someone',
    senderImage: null,
    type: 'text',
    body: `message ${seq}`,
    clientMsgId: `c${seq}`,
    pinned: false,
    pinnedAt: null,
    reactions: [],
    mentions: [],
    mediaId: null,
    documentName: null,
    documentSize: null,
    linkedPollId: null,
    linkedEventId: null,
    linkedMeetingId: null,
    replyTo: null,
    deletedAt: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

const quote = (seq: number, preview: string): MessageReplyRef => ({
  seq,
  senderId: 'someone',
  senderName: 'Someone',
  type: 'text',
  preview,
  mediaId: null,
  documentName: null,
  deleted: false,
});

describe('deleting a message strikes it out of every quote of it', () => {
  it('clears the preview and marks the quote deleted', async () => {
    const store = new InMemoryMessageStore();
    await store.upsert([
      message(1, { body: 'something regrettable' }),
      message(2, { replyTo: quote(1, 'something regrettable') }),
    ]);

    await store.patch(CHANNEL, 1, { deletedAt: '2026-08-01T01:00:00.000Z' });

    const [original, reply] = await store.list(CHANNEL);
    expect(original?.deletedAt).not.toBeNull();
    expect(reply?.replyTo?.deleted).toBe(true);
    // The words, not just the flag. A box that says "deleted" while still holding the text is
    // the same defect wearing a label.
    expect(reply?.replyTo?.preview).toBeNull();
  });

  it('strikes the quote even when the deleted message itself is not cached', async () => {
    const store = new InMemoryMessageStore();
    // A client can hold a reply without holding what it answers: the quote travels ON the reply,
    // which is the entire point of it. This is exactly the case where nothing else could ever
    // correct the quote, so it is the one that must not be skipped.
    await store.upsert([message(9, { replyTo: quote(1, 'something regrettable') })]);

    await store.patch(CHANNEL, 1, { deletedAt: '2026-08-01T01:00:00.000Z' });

    expect((await store.list(CHANNEL))[0]?.replyTo?.deleted).toBe(true);
  });

  it('leaves quotes of OTHER messages alone', async () => {
    const store = new InMemoryMessageStore();
    await store.upsert([
      message(1),
      message(2),
      message(3, { replyTo: quote(1, 'message 1') }),
      message(4, { replyTo: quote(2, 'message 2') }),
    ]);

    await store.patch(CHANNEL, 1, { deletedAt: '2026-08-01T01:00:00.000Z' });

    const held = await store.list(CHANNEL);
    expect(held[2]?.replyTo?.deleted).toBe(true);
    expect(held[3]?.replyTo?.deleted).toBe(false);
    expect(held[3]?.replyTo?.preview).toBe('message 2');
  });

  it('does not touch quotes for a pin or a reaction', async () => {
    const store = new InMemoryMessageStore();
    await store.upsert([message(1), message(2, { replyTo: quote(1, 'message 1') })]);

    await store.patch(CHANNEL, 1, { pinned: true });
    await store.patch(CHANNEL, 1, { reactions: [{ emoji: '🔥', userIds: ['someone'] }] });
    // `deletedAt: null` is a legitimate value meaning "not deleted", and must not be mistaken
    // for a deletion - the whole reason absence and null stay distinguishable in a patch.
    await store.patch(CHANNEL, 1, { deletedAt: null });

    expect((await store.list(CHANNEL))[1]?.replyTo?.preview).toBe('message 1');
  });
});

describe('strikeQuotedMessage', () => {
  it('drops everything the box would have drawn, and keeps the address it jumps to', () => {
    const struck = strikeQuotedMessage({
      ...quote(4, 'a caption'),
      mediaId: 'media-1',
      documentName: 'plan.pdf',
    });
    expect(struck).toEqual({
      // The seq survives: tapping the quote of a deleted message still takes you to its
      // tombstone, which is where the conversation makes sense again.
      seq: 4,
      senderId: 'someone',
      senderName: 'Someone',
      type: 'text',
      preview: null,
      mediaId: null,
      documentName: null,
      deleted: true,
    });
  });
});
