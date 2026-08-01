/**
 * Mentions: loading them onto message envelopes.
 *
 * The write side lives in `send-message.ts`, which filters a client's claimed mentions down to
 * people who can actually reach the channel before storing them. The notification side lives in
 * the worker. This module is only the read.
 *
 * > **Mentions travel on the envelope, exactly like reactions**, and for the same reason: chat is
 * > readable from the local cache with no network, so a mention that needed a second request
 * > would be the one thing missing precisely when the conversation is offline. See ADR-0017 for
 * > the reasoning, which applies here unchanged.
 */

import { inArray } from 'drizzle-orm';
import type { MessageMention } from '@clubchat/shared';
import type { Db } from '../db/client.ts';
import { messageMentions, users } from '../db/schema.ts';
import { channelAudienceById } from './channel-access.ts';

/**
 * Load mentions for a set of messages, in one query.
 *
 * Returns a map from message id to the people named in it. An empty input touches nothing,
 * because the common case - a page of history where nobody was mentioned - should cost nothing.
 *
 * **The stored name is used, never a joined one.** A mention highlights a run of characters
 * sitting immutably in somebody else's message; joining the member's current name would stop
 * matching that text the day they rename. Rows written before the column existed carry null and
 * are dropped rather than guessed at: no highlight is a smaller wrong than the wrong span
 * highlighted.
 */
export async function mentionsForMessages(
  db: Db,
  messageIds: readonly string[],
): Promise<Map<string, MessageMention[]>> {
  const byMessage = new Map<string, MessageMention[]>();
  if (messageIds.length === 0) return byMessage;

  // One query for the whole page, not one per message - the same rule reactions follow.
  const rows = await db
    .select({
      messageId: messageMentions.messageId,
      userId: messageMentions.userId,
      name: messageMentions.name,
    })
    .from(messageMentions)
    .where(inArray(messageMentions.messageId, [...messageIds]));

  for (const row of rows) {
    if (row.name === null) continue;
    const list = byMessage.get(row.messageId) ?? [];
    list.push({ userId: row.userId, name: row.name });
    byMessage.set(row.messageId, list);
  }

  return byMessage;
}

/**
 * Who can be named in this channel.
 *
 * The pool is the channel's own audience - club members, race roster, Eboard members, or the two
 * participants in a DM - resolved by `channelAudienceById`, which is **the same function the send
 * path filters against**. Deliberately the same source rather than a similar query: an
 * autocomplete offering somebody the send would then silently drop is a UI teaching a rule the
 * server does not have, and two hand-written copies of "who can see this channel" is exactly the
 * drift that put the race scope in three of four places once already.
 *
 * Excludes the caller. Mentioning yourself notifies yourself, and it takes a row in the list away
 * from somebody you might actually mean.
 *
 * Anonymised accounts are excluded: their history stays unattributed and there is nobody left to
 * notify.
 */
export async function mentionableMembers(
  db: Db,
  channelId: string,
  viewerId: string,
): Promise<Array<{ userId: string; name: string; image: string | null }>> {
  const audience = (await channelAudienceById(db, channelId)).filter((id) => id !== viewerId);
  if (audience.length === 0) return [];

  const rows = await db
    .select({ id: users.id, name: users.name, image: users.image, anonymizedAt: users.anonymizedAt })
    .from(users)
    .where(inArray(users.id, audience));

  return rows
    .filter((row) => row.anonymizedAt === null && row.name !== null)
    .map((row) => ({ userId: row.id, name: row.name as string, image: row.image }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
