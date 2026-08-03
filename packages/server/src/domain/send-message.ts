/**
 * The authorized send path, and message moderation.
 *
 * `appendMessage` owns durability and ordering and trusts its caller. This module owns
 * the authorization in front of it, so there is exactly ONE place where "may this person
 * post this kind of message here" is decided. The gateway and the API both come through
 * here rather than calling appendMessage directly.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { MessageEnvelope, MessageType } from '@clubchat/shared';
import type { Db } from '../db/client.ts';
import {
  mediaObjects,
  messageMentions,
  messageReactions,
  messages,
  outbox,
  users,
} from '../db/schema.ts';
import { appendMessage, type AppendMessageResult } from './append-message.ts';
import { channelAudience } from './channel-access.ts';
import { nextRevision } from './revisions.ts';
import type { AccessContext } from '../policy/context.ts';
import {
  canAnnounceInChannel,
  canDeleteMessage,
  canPinInChannel,
  canPostInChannel,
  type ChannelRef,
} from '../policy/predicates.ts';

export type SendRefusal = {
  ok: false;
  code: 'forbidden' | 'channel_gone' | 'invalid_type' | 'media_not_ready';
};
export type SendSuccess = { ok: true } & AppendMessageResult;
export type SendResult = SendSuccess | SendRefusal;

/**
 * Message types a client may originate.
 *
 * `system` is absent on purpose: only the worker writes those, using the reserved system
 * actor. A client that could send `type: 'system'` could forge "Riley was removed from
 * the club", which would be indistinguishable from the real thing.
 *
 * The card types are equally absent - a poll card exists because a poll was created, so
 * it is produced by the effect, never asked for directly.
 */
const CLIENT_ORIGINATED: readonly MessageType[] = ['text', 'photo', 'document', 'announcement'];

export type SendMessageInput = {
  channelId: string;
  clientMsgId: string;
  type?: MessageType;
  body?: string | null | undefined;
  mentions?: readonly string[] | undefined;
  /** For a photo or document message: an object already uploaded and completed. */
  mediaId?: string | null | undefined;
  /**
   * The message being answered, as its seq in this channel.
   *
   * Passed straight through rather than checked here, and that is deliberate: the composite
   * foreign key on `(channel_id, reply_to_seq)` already refuses a seq from another channel or
   * from nowhere at all, so a check in this function would be the same rule written twice - and
   * the copy in the handler is the one that races. A refused reply surfaces as the insert
   * failing, which the caller reports like any other failed send.
   */
  replyToSeq?: number | null | undefined;
};

/**
 * Send a message as a user.
 *
 * Note the two-step gate: membership to post at all, and **admin of that space
 * additionally** to post an announcement. The second is `canAnnounceInChannel`, which is
 * `isChannelAdmin` - so it is constant-false in a DM and announcements disappear from
 * that scope without a DM-specific branch anywhere.
 */
export async function sendMessage(
  db: Db,
  ctx: AccessContext,
  channel: ChannelRef,
  input: SendMessageInput,
): Promise<SendResult> {
  const type = input.type ?? 'text';

  if (!CLIENT_ORIGINATED.includes(type)) return { ok: false, code: 'invalid_type' };
  if (!canPostInChannel(ctx, channel)) return { ok: false, code: 'forbidden' };
  if (type === 'announcement' && !canAnnounceInChannel(ctx, channel)) {
    return { ok: false, code: 'forbidden' };
  }

  // Media is validated BEFORE the send, never inside it.
  //
  // > The sequence-allocating transaction performs no I/O. Verifying an attachment there
  // > would serialize the entire channel behind an object-storage round trip, because the
  // > `last_seq` row lock is held until commit.
  //
  // So the object must already be `ready` - which /media/:id/complete established by HEADing
  // it - and this is a cheap indexed read of that fact.
  let document: { name: string | null; size: number } | null = null;
  if (input.mediaId) {
    const ready = await db
      .select({
        status: mediaObjects.status,
        bytes: mediaObjects.bytes,
        channelId: mediaObjects.channelId,
        uploaderId: mediaObjects.uploaderId,
        documentName: mediaObjects.documentName,
      })
      .from(mediaObjects)
      .where(eq(mediaObjects.id, input.mediaId))
      .limit(1);
    const media = ready[0];
    if (!media || media.status !== 'ready') return { ok: false, code: 'media_not_ready' };
    // The object must belong to THIS channel and to THIS sender. Otherwise a member could
    // attach somebody else's private upload, or move a photo from a channel they can read
    // into one they cannot - laundering it past the download authorization.
    if (media.channelId !== channel.id) return { ok: false, code: 'forbidden' };
    if (media.uploaderId !== ctx.userId) return { ok: false, code: 'forbidden' };
    document = { name: media.documentName, size: media.bytes };
  }

  // Mentions are filtered to people who can actually reach this chat, and to names that really
  // appear in the body, BEFORE they are stored - so a client naming an outsider cannot
  // manufacture a notification into a conversation that person has no access to, and a name
  // deleted before sending takes its mention with it. The audience function re-checks anyway;
  // this keeps the stored rows honest as well.
  const mentions = await resolveMentions(db, channel, input.mentions ?? [], input.body ?? null);

  const result = await appendMessage(db, {
    channelId: input.channelId,
    senderId: ctx.userId,
    clientMsgId: input.clientMsgId,
    type,
    body: input.body ?? null,
    mediaId: input.mediaId ?? null,
    // Shown on a document bubble. A photo carries neither.
    documentName: type === 'document' ? document?.name ?? null : null,
    documentSize: type === 'document' ? document?.size ?? null : null,
    replyToSeq: input.replyToSeq ?? null,
  });

  // Point the object back at the message that owns it, which is what lets the nightly GC
  // find objects whose message is gone.
  if (!result.deduplicated && input.mediaId) {
    await db
      .update(mediaObjects)
      .set({ ownerId: result.message.id })
      .where(eq(mediaObjects.id, input.mediaId));
  }

  if (!result.deduplicated && mentions.length > 0) {
    await db
      .insert(messageMentions)
      .values(
        mentions.map((mention) => ({
          messageId: result.message.id,
          userId: mention.userId,
          name: mention.name,
        })),
      )
      .onConflictDoNothing();
  }

  return { ok: true, ...result };
}

/**
 * Narrow a client-supplied mention list to people who can access this channel **and are
 * actually named in the text**, resolving the name to store alongside each.
 *
 * Two independent gates, and both matter:
 *
 *  1. **Reachability.** Autocomplete already offers only eligible people, but that is UX. A
 *     member could name anyone by editing the payload, and a mention is a notification into a
 *     conversation the named person may have no access to.
 *  2. **The name is present in the body.** A client may claim a mention it did not write. More
 *     usefully in practice, somebody picks a name from the list and then deletes it again before
 *     sending - and being notified about a message that does not contain your name is confusing
 *     in a way that is hard to explain. Checking the body here makes "edit the name out and the
 *     mention goes with it" a property of the system rather than of the client remembering to.
 *
 * The name comes from the user record, never from the client, so a caller cannot make an
 * arbitrary run of text highlight as somebody. It is stored rather than re-joined on read - see
 * the note on the `name` column.
 */
async function resolveMentions(
  db: Db,
  channel: ChannelRef,
  candidates: readonly string[],
  body: string | null,
): Promise<Array<{ userId: string; name: string }>> {
  if (candidates.length === 0) return [];
  // Nothing to be named in. A photo with no caption cannot mention anybody.
  if (body === null || body.length === 0) return [];

  const reachable = new Set(await channelAudience(db, channel));
  const unique = [...new Set(candidates)].filter((id) => reachable.has(id));
  if (unique.length === 0) return [];

  const named = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(inArray(users.id, unique));

  return named
    .filter((row) => row.name !== null && body.includes(`@${row.name}`))
    .map((row) => ({ userId: row.id, name: row.name as string }));
}

// ---------------------------------------------------------------------------
// Moderation, and the column-level authority trap
// ---------------------------------------------------------------------------

export type ModerationRefusal = { ok: false; code: 'forbidden' | 'not_found' };
export type ModerationResult = { ok: true; message: MessageEnvelope } | ModerationRefusal;

/**
 * The sender's display name and picture, for an envelope built from a message that already
 * exists. Both from the one row: an avatar is not a second query.
 */
async function senderIdentityOf(
  db: Db,
  senderId: string,
): Promise<{ name: string | null; image: string | null }> {
  const rows = await db
    .select({ name: users.name, image: users.image })
    .from(users)
    .where(eq(users.id, senderId))
    .limit(1);
  return { name: rows[0]?.name ?? null, image: rows[0]?.image ?? null };
}

async function loadMessage(db: Db, channelId: string, seq: number) {
  const rows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.channelId, channelId), eq(messages.seq, seq)))
    .limit(1);
  return rows[0] ?? null;
}

function toEnvelope(
  row: typeof messages.$inferSelect,
  sender: { name: string | null; image: string | null },
): MessageEnvelope {
  return {
    id: row.id,
    channelId: row.channelId,
    seq: row.seq,
    senderId: row.senderId,
    senderName: sender.name,
    senderImage: sender.image,
    type: row.type as MessageType,
    body: row.body,
    clientMsgId: row.clientMsgId,
    pinned: row.pinned,
    pinnedAt: row.pinnedAt?.toISOString() ?? null,
    // All three empty for the same reason: this envelope answers a pin or a delete, and the
    // change that matters reaches other clients as a `msg.update` PATCH rather than as a whole
    // message. Nothing merges this over a cached copy, so none of them can erase one.
    reactions: [],
    mentions: [],
    replyTo: null,
    mediaId: row.mediaId,
    documentName: row.documentName,
    documentSize: row.documentSize,
    linkedPollId: row.linkedPollId,
    linkedEventId: row.linkedEventId,
    linkedMeetingId: row.linkedMeetingId,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Pin or unpin a message. Admin of that space only.
 *
 * > **This is the column-level authority trap, and it is why pinning is its own command.**
 * >
 * > The natural rule for updating a message is "its sender, or an admin of that space" -
 * > which is correct for a body edit and for a soft delete. It is NOT correct for the
 * > `pinned` and `type` columns. In v1 a single row-level rule covered the whole row, so
 * > **any member could pin their own message and then retro-flip it into an
 * > announcement**, which notifies the entire club. That shipped.
 * >
 * > Splitting the rule the other way would have been just as wrong: gating the whole row
 * > on admin would cost the sender their legitimate right to delete their own message.
 * >
 * > So the two authorities are separate commands with separate predicates, and neither
 * > can be reached through the other. Proved by attempting the write as a member, not by
 * > hiding the button.
 *
 * **Pinning notifies nobody.** Pins are reference, not interruption.
 */
export async function setPinned(
  db: Db,
  ctx: AccessContext,
  channel: ChannelRef,
  seq: number,
  pinned: boolean,
): Promise<ModerationResult> {
  if (!canPinInChannel(ctx, channel)) return { ok: false, code: 'forbidden' };

  const existing = await loadMessage(db, channel.id, seq);
  if (!existing) return { ok: false, code: 'not_found' };

  /*
   * The pin and its revision commit together.
   *
   * A pin that landed without advancing `rev` would be invisible to any client that already held
   * the message - which is every client that had the conversation open - because sync only
   * returns rows above the mark. Inside one transaction so a pin can never exist without the
   * revision that advertises it.
   */
  const row = await db.transaction(async (tx) => {
    const rev = await nextRevision(tx, channel.id);
    if (rev === null) return undefined;

    const updated = await tx
      .update(messages)
      /*
       * Stamped on every pin, including re-pinning something that was pinned before, so a re-pin
       * genuinely becomes the most recent - which is what the strip orders by. Cleared on unpin so
       * the column never claims a pin that is not there.
       */
      .set({ pinned, pinnedAt: pinned ? new Date() : null, rev })
      // The type is deliberately NOT in this SET. A pin must never be able to carry a
      // type change along with it.
      .where(and(eq(messages.channelId, channel.id), eq(messages.seq, seq)))
      .returning();

    return updated[0];
  });

  if (!row) return { ok: false, code: 'not_found' };

  // Everyone with the chat open must see the pinned strip appear, so the change is published
  // as an update rather than only being visible on the next refresh. Written to the outbox
  // rather than published here, so the API process does not need Redis and the effect is
  // retried if the worker is down.
  await db.insert(outbox).values({
    partitionKey: channel.id,
    eventType: 'message.pinned',
    payload: { channelId: channel.id, seq, pinned },
  });

  return { ok: true, message: toEnvelope(row, await senderIdentityOf(db, row.senderId)) };
}

/**
 * Soft delete. The sender, or an admin of that space.
 *
 * A tombstone rather than a removal: a message vanishing mid-conversation makes the
 * replies around it unreadable. Reactions and pin state are cleared with it.
 */
export async function softDeleteMessage(
  db: Db,
  ctx: AccessContext,
  channel: ChannelRef,
  seq: number,
): Promise<ModerationResult> {
  const existing = await loadMessage(db, channel.id, seq);
  if (!existing) return { ok: false, code: 'not_found' };

  if (!canDeleteMessage(ctx, channel, { senderId: existing.senderId })) {
    return { ok: false, code: 'forbidden' };
  }

  const updated = await db.transaction(async (tx) => {
    /*
     * The revision this delete happens at.
     *
     * **This is the case the whole mechanism exists for.** A tombstone that did not advance
     * `rev` reached only the clients that were connected at the time; anybody offline kept the
     * message and its body forever, because sync never looks below the mark. Allocated first, so
     * the tombstone and its revision commit or roll back as one.
     */
    const rev = await nextRevision(tx, channel.id);
    if (rev === null) return null;

    const rows = await tx
      .update(messages)
      .set({
        deletedAt: new Date(),
        // Pin state is cleared with the message, so Highlights does not keep listing a
        // tombstone as pinned content.
        pinned: false,
        body: null,
        rev,
      })
      .where(and(eq(messages.channelId, channel.id), eq(messages.seq, seq)))
      .returning();

    // Mentions go too: a deleted message must not keep a notification pointing at it
    // claiming someone was mentioned in text that no longer exists.
    await tx.delete(messageMentions).where(eq(messageMentions.messageId, existing.id));

    // And reactions, which PRD/05 rule 9 requires alongside the pin state. Six people
    // having laughed at text nobody can read any more is not information, and leaving them
    // would mean a tombstone that still carries a verdict on its own content.
    await tx.delete(messageReactions).where(eq(messageReactions.messageId, existing.id));

    await tx.insert(outbox).values({
      partitionKey: channel.id,
      eventType: 'message.deleted',
      payload: { channelId: channel.id, seq, messageId: existing.id },
    });

    return rows[0] ?? null;
  });

  if (!updated) return { ok: false, code: 'not_found' };
  return { ok: true, message: toEnvelope(updated, await senderIdentityOf(db, updated.senderId)) };
}
