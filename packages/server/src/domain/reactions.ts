/**
 * Reactions: the toggle, and loading them onto message envelopes.
 *
 * > **Reactions travel on the envelope, not on a side channel.** Every read that returns
 * > messages returns their reactions with them, which is what makes them survive airplane
 * > mode alongside the messages they belong to. A separate endpoint would have needed its
 * > own sync path, its own cache and its own offline story. See ADR-0017.
 *
 * The fixed six-emoji set is enforced by a check constraint on the column, so nothing here
 * needs to police it and no second write path can bypass it. The Zod enum at the API boundary
 * exists to return a 400 rather than a 500 - it is a courtesy, not the enforcement.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { reactionEmoji, type MessageReaction, type ReactionEmoji } from '@clubchat/shared';
import type { Db } from '../db/client.ts';
import { messageReactions, outbox } from '../db/schema.ts';
import type { AccessContext } from '../policy/context.ts';
import { canReactInChannel, type ChannelRef } from '../policy/predicates.ts';

export type ReactionRefusal = { ok: false; code: 'forbidden' | 'not_found' };
export type ReactionResult<T> = ({ ok: true } & T) | ReactionRefusal;

/**
 * Load reactions for a set of messages, in one query.
 *
 * Returns a map from message id to its reaction list, ordered by `reactionEmoji` so the
 * pill row renders in a stable order rather than reshuffling as counts change. An empty
 * input returns an empty map without touching the database, because the common case -
 * a page of history with no reactions at all - should cost nothing.
 */
export async function reactionsForMessages(
  db: Db,
  messageIds: readonly string[],
): Promise<Map<string, MessageReaction[]>> {
  const byMessage = new Map<string, MessageReaction[]>();
  if (messageIds.length === 0) return byMessage;

  // One query for the whole page, not one per message. A 40-message page with a query each
  // is 40 round trips for something the index answers in one.
  const rows = await db
    .select({
      messageId: messageReactions.messageId,
      emoji: messageReactions.emoji,
      userId: messageReactions.userId,
    })
    .from(messageReactions)
    .where(inArray(messageReactions.messageId, [...messageIds]));

  // emoji -> userIds, per message, then flattened in the canonical order below.
  const staging = new Map<string, Map<string, string[]>>();
  for (const row of rows) {
    let perMessage = staging.get(row.messageId);
    if (!perMessage) {
      perMessage = new Map();
      staging.set(row.messageId, perMessage);
    }
    const users = perMessage.get(row.emoji) ?? [];
    users.push(row.userId);
    perMessage.set(row.emoji, users);
  }

  for (const [messageId, perMessage] of staging) {
    const list: MessageReaction[] = [];
    for (const emoji of reactionEmoji) {
      const userIds = perMessage.get(emoji);
      if (userIds && userIds.length > 0) list.push({ emoji, userIds });
    }
    byMessage.set(messageId, list);
  }

  return byMessage;
}

/**
 * Toggle a reaction on or off.
 *
 * > **A delete-or-insert against the primary key, never a read-then-write.** Two fast taps
 * > on the same emoji race in a read-then-write and can leave both a row and no row
 * > depending on interleaving. Here the `DELETE ... RETURNING` decides: if it removed a row
 * > the reaction was on and is now off, and if it removed nothing the insert adds it. Both
 * > statements are keyed, so the outcome is the same whichever order concurrent taps arrive.
 *
 * Returns the full resulting set for the message rather than the delta, because that is what
 * the update frame carries and what the caller publishes - see `MsgUpdate` for why a delta
 * would be wrong on a transport with no sequence of its own.
 */
export async function toggleReaction(
  db: Db,
  ctx: AccessContext,
  channel: ChannelRef,
  seq: number,
  emoji: ReactionEmoji,
): Promise<
  ReactionResult<{
    messageId: string;
    seq: number;
    added: boolean;
    reactions: MessageReaction[];
  }>
> {
  // Reacting is a write into the conversation, so it takes the posting gate rather than the
  // reading one. A blocked DM participant can read the message and cannot react to it.
  if (!canReactInChannel(ctx, channel)) return { ok: false, code: 'forbidden' };

  const found = await db.execute<{ id: string; deleted_at: string | null }>(sql`
    SELECT id::text AS id, deleted_at::text AS deleted_at
      FROM messages
     WHERE channel_id = ${channel.id} AND seq = ${seq}
  `);
  const message = found.rows[0];
  if (!message) return { ok: false, code: 'not_found' };
  // A tombstone has its reactions cleared and must not accumulate new ones - the message it
  // reacted to is gone, and a reaction on "This message was deleted" means nothing.
  if (message.deleted_at !== null) return { ok: false, code: 'not_found' };

  const result = await db.transaction(async (tx) => {
    const removed = await tx
      .delete(messageReactions)
      .where(
        and(
          eq(messageReactions.messageId, message.id),
          eq(messageReactions.userId, ctx.userId),
          eq(messageReactions.emoji, emoji),
        ),
      )
      .returning({ emoji: messageReactions.emoji });

    const added = removed.length === 0;
    if (added) {
      await tx
        .insert(messageReactions)
        .values({ messageId: message.id, userId: ctx.userId, emoji })
        // Belt and braces against a concurrent insert of the same key: the toggle stays a
        // no-op rather than a 500.
        .onConflictDoNothing();
    }

    // Emitted inside the same transaction as the row change, so the published update can
    // never describe a state that was rolled back. The worker turns this into a msg.update.
    await tx.insert(outbox).values({
      partitionKey: channel.id,
      eventType: 'message.reacted',
      payload: { channelId: channel.id, messageId: message.id, seq, actorId: ctx.userId },
    });

    return { added };
  });

  const reactions = (await reactionsForMessages(db, [message.id])).get(message.id) ?? [];

  return { ok: true, messageId: message.id, seq, added: result.added, reactions };
}

/**
 * Who reacted, by emoji, for one message.
 *
 * Reactions are visible to everyone with access, so this needs no gate beyond reading the
 * channel - which the caller has already established. Exposed separately from the envelope
 * only so the client can show a who-reacted sheet without holding the whole page.
 */
export async function readReactions(
  db: Db,
  channel: ChannelRef,
  seq: number,
): Promise<ReactionResult<{ reactions: MessageReaction[] }>> {
  const found = await db.execute<{ id: string }>(sql`
    SELECT id::text AS id FROM messages WHERE channel_id = ${channel.id} AND seq = ${seq}
  `);
  const message = found.rows[0];
  if (!message) return { ok: false, code: 'not_found' };

  return {
    ok: true,
    reactions: (await reactionsForMessages(db, [message.id])).get(message.id) ?? [],
  };
}
