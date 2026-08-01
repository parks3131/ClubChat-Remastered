/**
 * appendMessage - the single write path into the channel log.
 *
 * Every message enters the system here: a user's send, a system message, and a
 * poll/event/meeting card all call this function, so they all get the same sequence
 * allocation and the same publish. The worker calls it too. There is no second path,
 * and adding one would silently break ordering.
 *
 * See SPEC/TECH/02-channel-log.md and SPEC/TECH/03-message-flows.md.
 */

import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import {
  replyPreview,
  type MessageEnvelope,
  type MessageReplyRef,
  type MessageType,
} from '@clubchat/shared';
import type { Db } from '../db/client.ts';
import { messages, outbox, users } from '../db/schema.ts';
import { isUniqueViolation } from '../db/errors.ts';

export type AppendMessageInput = {
  channelId: string;
  senderId: string;
  clientMsgId: string;
  type?: MessageType;
  body?: string | null;
  /**
   * What this message is a card for, if it is one. Set by the worker's card posters so a
   * later delete can find and remove the card rather than leaving a dead link.
   */
  linkedPollId?: string | null | undefined;
  linkedEventId?: string | null | undefined;
  linkedMeetingId?: string | null | undefined;
  mediaId?: string | null | undefined;
  documentName?: string | null | undefined;
  documentSize?: number | null | undefined;
  /**
   * The message this one answers, as its seq in the same channel.
   *
   * Not validated here: `messages_reply_to_fk` is a composite foreign key on
   * `(channel_id, reply_to_seq)`, so a seq that does not exist in THIS channel is rejected by
   * the database rather than by a check this function could forget to make.
   */
  replyToSeq?: number | null | undefined;
  /**
   * Extra outbox events to write in the SAME transaction as the message. Used by
   * command handlers that need an effect to be atomic with the message itself.
   */
  extraOutbox?: ReadonlyArray<{ partitionKey: string; eventType: string; payload: unknown }>;
};

export type AppendMessageResult = {
  message: MessageEnvelope;
  /**
   * True when this call hit the idempotency index and returned the existing row
   * rather than writing a new one. The caller still acks: from the client's point of
   * view a retry that resolves to the original message is a success, and that is
   * exactly what makes the send outbox safe to retry aggressively.
   */
  deduplicated: boolean;
};

/**
 * Derive a deterministic `client_msg_id` for a server-authored message.
 *
 * The worker's messages need an idempotency key that is stable across redelivery,
 * because outbox delivery is at-least-once and a redelivered event would otherwise
 * post "X was added to the club" twice. Deriving the key from the outbox event id
 * makes the unique index do the deduplication for free.
 *
 * Formatted as a v5-shaped UUID (version and variant bits set) so it satisfies the
 * uuid column type and reads as a UUID everywhere it surfaces.
 */
export function deriveClientMsgId(scope: string, key: string | number): string {
  const digest = createHash('sha256').update(`${scope}:${key}`).digest();
  const bytes = Uint8Array.prototype.slice.call(digest, 0, 16);
  // Version 5, RFC 4122 variant.
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

function toEnvelope(
  row: typeof messages.$inferSelect,
  sender: SenderIdentity,
  replyTo: MessageReplyRef | null,
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
    // Never pinned at the moment it is appended.
    pinnedAt: null,
    // A message that has just been appended cannot have been reacted to yet. Not a
    // shortcut: there is no window in which it could have been.
    reactions: [],
    // Same: the mentions were just written, and the sender's own client already knows who it
    // named. A read of this message will carry them.
    mentions: [],
    mediaId: row.mediaId,
    documentName: row.documentName,
    documentSize: row.documentSize,
    linkedPollId: row.linkedPollId,
    linkedEventId: row.linkedEventId,
    linkedMeetingId: row.linkedMeetingId,
    /*
     * Resolved by the caller, not left null for the client to fill in.
     *
     * This envelope is what `msg.new` carries to everybody else in the channel, so a null here
     * would deliver a reply that draws no quote until that client happens to re-sync the row -
     * which `syncChannel` never does, because it pulls strictly above the local max. That is
     * the same defect `mediaId` and `linkedPollId` each shipped with: a field stored on the
     * message and never put on the wire.
     */
    replyTo,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Who the envelope says sent it: the name to print and the picture to draw. */
type SenderIdentity = { name: string | null; image: string | null };

/**
 * The quote to hang on a reply's envelope, read from the message it answers.
 *
 * Read OUTSIDE the sequence-allocating transaction for the same reason `senderIdentityOf` is:
 * that transaction holds the channel's row lock until commit, and nothing gets added to it.
 *
 * Null when there is no reply, and null when the quoted row cannot be found - which the
 * foreign key makes impossible for a row that is about to be inserted, so this is the
 * belt-and-braces branch rather than a case with behaviour.
 */
async function replyRefOf(
  db: Db,
  channelId: string,
  replyToSeq: number | null | undefined,
): Promise<MessageReplyRef | null> {
  if (replyToSeq === null || replyToSeq === undefined) return null;
  const rows = await db
    .select({
      seq: messages.seq,
      senderId: messages.senderId,
      senderName: users.name,
      type: messages.type,
      body: messages.body,
      mediaId: messages.mediaId,
      documentName: messages.documentName,
      deletedAt: messages.deletedAt,
    })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.senderId))
    .where(and(eq(messages.channelId, channelId), eq(messages.seq, replyToSeq)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    seq: row.seq,
    senderId: row.senderId,
    senderName: row.senderName,
    type: row.type as MessageType,
    preview: replyPreview(row.body),
    mediaId: row.mediaId,
    documentName: row.documentName,
    deleted: row.deletedAt !== null,
  };
}

/**
 * The sender's current display name and picture, for the envelope.
 *
 * > **Read OUTSIDE the transaction below, deliberately.** That transaction holds a row lock on the
 * > channel until commit and serializes every send to it, so the rule stated on `appendMessage` is
 * > that nothing gets added to it. A name lookup is a local indexed read rather than the network
 * > round trip that rule was written about, and it still does not belong inside: the sender's name
 * > has nothing to do with allocating a sequence number.
 *
 * Both columns come from the one row already being read - an avatar is not a second query.
 *
 * Null rather than a throw if the row is missing. A message with an unattributed sender renders as
 * unattributed; it does not fail to send.
 */
async function senderIdentityOf(db: Db, senderId: string): Promise<SenderIdentity> {
  const rows = await db
    .select({ name: users.name, image: users.image })
    .from(users)
    .where(eq(users.id, senderId))
    .limit(1);
  return { name: rows[0]?.name ?? null, image: rows[0]?.image ?? null };
}

async function findByIdempotencyKey(
  db: Db,
  input: Pick<AppendMessageInput, 'channelId' | 'senderId' | 'clientMsgId'>,
  sender: SenderIdentity,
): Promise<MessageEnvelope | null> {
  const found = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.channelId, input.channelId),
        eq(messages.senderId, input.senderId),
        eq(messages.clientMsgId, input.clientMsgId),
      ),
    )
    .limit(1);
  const row = found[0];
  if (!row) return null;
  // From the STORED row rather than from `input`: a retry is answered with what was actually
  // written, and the two can differ if a client resends the same id with a different payload.
  return toEnvelope(row, sender, await replyRefOf(db, row.channelId, row.replyToSeq));
}

/**
 * Append a message to a channel's log.
 *
 * Authorization is the CALLER's job and has already happened by the time we are
 * here. This function owns durability and ordering, nothing else.
 *
 * > **Invariant: this transaction performs no I/O.**
 * >
 * > `UPDATE channels SET last_seq = last_seq + 1` takes a row lock held until
 * > commit, serializing every send to this channel for the duration. No network
 * > call, object-storage HEAD, push dispatch or external HTTP may ever appear
 * > inside it. Media is validated at /media/:id/complete, before the message
 * > referencing it is sent; everything else goes through the outbox. This is stated
 * > loudly because the lock is invisible at the call site, and a well-meaning "just
 * > verify the attachment exists before we commit" is precisely the change that
 * > would serialize an entire channel behind a network round trip.
 */
export async function appendMessage(
  db: Db,
  input: AppendMessageInput,
): Promise<AppendMessageResult> {
  // Both resolved once, before the transaction, and used by both paths below.
  const sender = await senderIdentityOf(db, input.senderId);
  const replyTo = await replyRefOf(db, input.channelId, input.replyToSeq);

  // Fast path. A retry that we can recognise before touching the counter costs one
  // indexed lookup and burns no sequence number.
  const existing = await findByIdempotencyKey(db, input, sender);
  if (existing) return { message: existing, deduplicated: true };

  try {
    const message = await db.transaction(async (tx) => {
      // The row lock. Held until commit, which is what serializes concurrent sends
      // to this channel and what makes `seq` gapless: if this transaction rolls
      // back, the increment rolls back with it. A Postgres SEQUENCE would NOT do
      // this - sequences are non-transactional and leak gaps on rollback, and a
      // phantom gap would send the client syncing forever after a hole that does
      // not exist.
      const bumped = await tx.execute<{ last_seq: number }>(sql`
        UPDATE channels
           SET last_seq = last_seq + 1
         WHERE id = ${input.channelId}
        RETURNING last_seq
      `);

      const seq = bumped.rows[0]?.last_seq;
      if (seq === undefined) {
        // The channel is gone. Distinguished from a permission failure by the
        // caller, which has already authorized: this is `channel_gone`.
        throw new ChannelGoneError(input.channelId);
      }

      const inserted = await tx
        .insert(messages)
        .values({
          channelId: input.channelId,
          seq,
          senderId: input.senderId,
          type: input.type ?? 'text',
          body: input.body ?? null,
          clientMsgId: input.clientMsgId,
          linkedPollId: input.linkedPollId ?? null,
          linkedEventId: input.linkedEventId ?? null,
          linkedMeetingId: input.linkedMeetingId ?? null,
          mediaId: input.mediaId ?? null,
          documentName: input.documentName ?? null,
          documentSize: input.documentSize ?? null,
          replyToSeq: input.replyToSeq ?? null,
        })
        .returning();

      const row = inserted[0];
      if (!row) throw new Error('insert returned no row');

      // Domain rows and outbox events in ONE transaction. Either both land or
      // neither does - the guarantee an external queue cannot give you, and the
      // entire reason the outbox exists rather than publishing from the handler.
      await tx.insert(outbox).values([
        {
          // The ordering domain. Kafka will eventually partition by this, and
          // ordering is guaranteed within a partition only, so per-channel ordering
          // depends on this being the channel.
          partitionKey: input.channelId,
          eventType: 'message.created',
          payload: {
            messageId: row.id,
            channelId: row.channelId,
            seq: row.seq,
            senderId: row.senderId,
            type: row.type,
            // Carried on the event so the effect does not have to read the message back.
            // Truncated here because the only consumer is a notification preview, and a
            // push payload has a size limit that a long message would blow past.
            preview: (row.body ?? '').slice(0, 140),
          },
        },
        ...(input.extraOutbox ?? []).map((event) => ({
          partitionKey: event.partitionKey,
          eventType: event.eventType,
          payload: event.payload as object,
        })),
      ]);

      return toEnvelope(row, sender, replyTo);
    });

    return { message, deduplicated: false };
  } catch (error) {
    // A concurrent identical send won the race. The transaction rolled back, so the
    // counter was restored and no gap exists; the winner's row is now visible.
    if (isUniqueViolation(error)) {
      const winner = await findByIdempotencyKey(db, input, sender);
      if (winner) return { message: winner, deduplicated: true };
    }
    throw error;
  }
}

export class ChannelGoneError extends Error {
  readonly channelId: string;

  // Explicit field assignment rather than a TypeScript parameter property. Node's
  // strip-only type removal cannot rewrite `constructor(readonly x: T)` into a field
  // write, so a parameter property typechecks, passes the esbuild-transformed test
  // suite, and then crashes the actual process at import time. See AGENTS.md 5.3.
  constructor(channelId: string) {
    super(`channel ${channelId} does not exist`);
    this.name = 'ChannelGoneError';
    this.channelId = channelId;
  }
}

