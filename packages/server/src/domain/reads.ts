/**
 * Query side. Every read here is access-scoped by construction.
 *
 * "Deliver what you missed" and "page through history" are THE SAME QUERY with a
 * different bound. That is the whole return on storing messages once in a durable log
 * instead of per-recipient inboxes, and it is why there is no inbox table, no Redis
 * inbox, no drain-on-connect path and no delete-after-delivery job. See ADR-0003.
 */

import { and, asc, desc, eq, getTableColumns, gt, gte, isNull, lt, lte, sql } from 'drizzle-orm';
import type { ChannelState, MessageEnvelope, MessageType } from '@clubchat/shared';
import type { Db } from '../db/client.ts';
import { channels, messages, users } from '../db/schema.ts';
import type { ChannelRef } from '../policy/predicates.ts';
import { accessibleChannelPredicate } from './channel-access.ts';
import { reactionsForMessages } from './reactions.ts';

/** The page size chat opens with, then pages backward from. */
export const HISTORY_PAGE_SIZE = 40;

/** Cap on one sync response, so a client offline for a week pages rather than blocks. */
export const SYNC_PAGE_SIZE = 500;

/**
 * A message row plus the sender's current name.
 *
 * The name is **joined, never stored on the message** - so a rename changes it everywhere at once,
 * and a deleted account's history reads "Deleted member" without anything having to rewrite it.
 */
type MessageRow = typeof messages.$inferSelect & { senderName: string | null };

/**
 * Every read in this module selects the message columns plus the sender's name.
 *
 * A `leftJoin`, not an inner one: an inner join would silently drop a message whose sender row is
 * missing, which turns a data problem into a hole in the conversation - and a hole is exactly what
 * the gapless log exists to make impossible. A null name renders as unattributed instead.
 */
const messageColumns = { ...getTableColumns(messages), senderName: users.name };

function toEnvelope(row: MessageRow): MessageEnvelope {
  return {
    id: row.id,
    channelId: row.channelId,
    seq: row.seq,
    senderId: row.senderId,
    senderName: row.senderName,
    type: row.type as MessageType,
    body: row.body,
    clientMsgId: row.clientMsgId,
    pinned: row.pinned,
    // Filled in by `withReactions` for reads that return more than one row, so the whole
    // page costs one extra query rather than one per message.
    reactions: [],
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

export async function getChannelRef(db: Db, channelId: string): Promise<ChannelRef | null> {
  const rows = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    scope: row.scope as ChannelRef['scope'],
    clubId: row.clubId,
    scopeId: row.scopeId,
  };
}

/**
 * Every channel this user can access, with the two numbers the client needs.
 *
 * Handed to the client on `auth.ok`, which means the client knows **every channel
 * with a gap before it fetches a single message**: compare each `lastSeq` against its
 * own local max. That is what makes reconnect reconciliation exact rather than
 * heuristic.
 *
 * One query, not one per channel, and the access predicate comes from `channel-access.ts`
 * rather than being written here. It used to be written here, and it was one of the four
 * hand-written copies that all missed the race scope.
 */
export async function listAccessibleChannels(db: Db, userId: string): Promise<ChannelState[]> {
  const result = await db.execute<{
    id: string;
    scope: string;
    club_id: string | null;
    last_seq: number;
    last_read_seq: number;
  }>(sql`
    SELECT c.id,
           c.scope,
           c.club_id,
           c.last_seq,
           COALESCE(rc.last_read_seq, 0) AS last_read_seq
      FROM channels c
      LEFT JOIN read_cursors rc
             ON rc.channel_id = c.id
            AND rc.user_id = ${userId}
     WHERE ${accessibleChannelPredicate(userId)}
     ORDER BY c.created_at
  `);

  return result.rows.map((row) => ({
    id: row.id,
    scope: row.scope as ChannelState['scope'],
    clubId: row.club_id,
    lastSeq: row.last_seq,
    lastReadSeq: row.last_read_seq,
  }));
}

/**
 * Page backward through history.
 *
 * Chat pages upward from the live tail only - there is no bidirectional paging. Rows
 * come back oldest-first so the caller can append them directly without reversing.
 */
export async function readHistory(
  db: Db,
  channelId: string,
  opts: { before?: number | undefined; limit?: number | undefined } = {},
): Promise<MessageEnvelope[]> {
  const limit = Math.min(opts.limit ?? HISTORY_PAGE_SIZE, 200);
  const where =
    opts.before === undefined
      ? eq(messages.channelId, channelId)
      : and(eq(messages.channelId, channelId), lt(messages.seq, opts.before));

  const rows = await db
    .select(messageColumns)
    .from(messages)
    .leftJoin(users, eq(users.id, messages.senderId))
    .where(where)
    // Ordered by seq, never by timestamp. A timestamp is not an ordering: clock skew
    // is real, and timestamps here are for display only.
    .orderBy(desc(messages.seq))
    .limit(limit);

  return withReactions(db, rows.reverse().map(toEnvelope));
}

/**
 * A window centred on one message, for jump-to-message.
 *
 * > **Three lines of the acceptance checklist need this and nothing else can provide them**:
 * > the pinned strip's notice jumping to its message on the **first** tap, chat opening on the
 * > first unread with no visible scrolling, and a notification deep-linking to a message that
 * > may be thousands of rows back. Paging backward from the tail until the target appears is
 * > what makes the "first tap" version impossible - the message is not loaded yet, so the first
 * > tap can only start fetching.
 *
 * Returns the target plus `radius` messages either side, oldest-first, and reports whether
 * more exists in each direction so a client knows which way it may still page. A target that
 * does not exist yields an empty window rather than a refusal: the caller has already been
 * authorized for the channel, and a deleted message is a legitimate thing to land on.
 */
export async function readAround(
  db: Db,
  channelId: string,
  seq: number,
  radius = 20,
): Promise<{
  messages: MessageEnvelope[];
  hasBefore: boolean;
  hasAfter: boolean;
}> {
  const span = Math.min(Math.max(radius, 1), 100);

  const rows = await db
    .select(messageColumns)
    .from(messages)
    .leftJoin(users, eq(users.id, messages.senderId))
    .where(
      and(
        eq(messages.channelId, channelId),
        gte(messages.seq, seq - span),
        lte(messages.seq, seq + span),
      ),
    )
    .orderBy(asc(messages.seq));

  const envelopes = await withReactions(db, rows.map(toEnvelope));
  const lowest = envelopes[0]?.seq ?? seq;
  const highest = envelopes[envelopes.length - 1]?.seq ?? seq;

  // Asked of the channel head and of seq 1 rather than inferred from a full page, because a
  // window with holes in it - deleted rows leave their seq behind, so there are none, but a
  // gapless log is the reason that is true - would otherwise read as "no more".
  const head = await db
    .select({ lastSeq: channels.lastSeq })
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);

  return {
    messages: envelopes,
    hasBefore: lowest > 1,
    hasAfter: highest < (head[0]?.lastSeq ?? highest),
  };
}

/**
 * Everything pinned in a channel, or every announcement.
 *
 * > **Queried over the whole channel, never over a loaded window**, which is debt item 6:
 * > v1 computed both lists from a bounded slice of history, so a pin older than the loaded
 * > page silently vanished from Highlights. The partial indexes on `messages` exist for
 * > exactly these two reads.
 *
 * Tombstones are excluded from both. A soft delete clears `pinned` anyway, so a deleted pin
 * cannot appear - but an announcement keeps its type, and Highlights listing "this message was
 * deleted" as a club announcement would be worse than listing nothing.
 */
export async function readHighlights(
  db: Db,
  channelId: string,
  kind: 'pinned' | 'announcements',
  opts: { before?: number | undefined; limit?: number | undefined } = {},
): Promise<{ messages: MessageEnvelope[]; hasMore: boolean }> {
  const limit = Math.min(opts.limit ?? HISTORY_PAGE_SIZE, 200);

  const conditions = [
    eq(messages.channelId, channelId),
    isNull(messages.deletedAt),
    kind === 'pinned' ? eq(messages.pinned, true) : eq(messages.type, 'announcement'),
  ];
  if (opts.before !== undefined) conditions.push(lt(messages.seq, opts.before));

  const rows = await db
    .select(messageColumns)
    .from(messages)
    .leftJoin(users, eq(users.id, messages.senderId))
    .where(and(...conditions))
    // Newest first: Highlights is a reference list rather than a conversation, so the most
    // recent pin is the one somebody opening the tab is looking for.
    .orderBy(desc(messages.seq))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  return {
    messages: await withReactions(db, rows.slice(0, limit).map(toEnvelope)),
    hasMore,
  };
}

/**
 * Attach reactions to a page of envelopes.
 *
 * One query for the whole page. Reactions ride along on the envelope rather than being
 * fetched separately so they survive airplane mode with the messages they belong to, which
 * is the entire argument of ADR-0017 - and this is the function that makes it cost one
 * round trip instead of one per message.
 */
async function withReactions(db: Db, envelopes: MessageEnvelope[]): Promise<MessageEnvelope[]> {
  if (envelopes.length === 0) return envelopes;
  const byMessage = await reactionsForMessages(
    db,
    envelopes.map((envelope) => envelope.id),
  );
  // Only rewrite the envelopes that actually have reactions, so the common case allocates
  // nothing beyond the lookup.
  return envelopes.map((envelope) => {
    const reactions = byMessage.get(envelope.id);
    return reactions === undefined ? envelope : { ...envelope, reactions };
  });
}

/**
 * The reconnect and foreground path: everything after a known point.
 *
 * `hasMore` lets a client that has been away long enough to exceed one page keep
 * pulling rather than silently receiving a truncated backlog and believing it is
 * caught up - which is the exact state the sequence design exists to make
 * unrepresentable.
 */
export async function syncSince(
  db: Db,
  channelId: string,
  sinceSeq: number,
  limit = SYNC_PAGE_SIZE,
): Promise<{ messages: MessageEnvelope[]; hasMore: boolean }> {
  const rows = await db
    .select(messageColumns)
    .from(messages)
    .leftJoin(users, eq(users.id, messages.senderId))
    .where(and(eq(messages.channelId, channelId), gt(messages.seq, sinceSeq)))
    .orderBy(asc(messages.seq))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  return {
    // Reactions travel with the backlog too. A client that has been offline for a week must
    // come back to the conversation as it stands, not to messages with their reactions
    // stripped off and no way to notice.
    messages: await withReactions(db, rows.slice(0, limit).map(toEnvelope)),
    hasMore,
  };
}

/**
 * Advance a read cursor.
 *
 * Monotonic on purpose: `GREATEST` means a late-arriving or out-of-order `msg.read`
 * frame can never move a cursor backward. A cursor that could regress would
 * un-suppress push for messages the member has already read, and would make an
 * unread count climb back up on its own.
 */
export async function advanceReadCursor(
  db: Db,
  userId: string,
  channelId: string,
  upToSeq: number,
): Promise<number> {
  const result = await db.execute<{ last_read_seq: number }>(sql`
    INSERT INTO read_cursors (user_id, channel_id, last_read_seq, updated_at)
    VALUES (${userId}, ${channelId}, ${upToSeq}, now())
    ON CONFLICT (user_id, channel_id) DO UPDATE
       SET last_read_seq = GREATEST(read_cursors.last_read_seq, EXCLUDED.last_read_seq),
           updated_at = now()
    RETURNING last_read_seq
  `);
  return result.rows[0]?.last_read_seq ?? upToSeq;
}

/** Clubs this user belongs to, with their role and main channel. */
export async function listClubsForUser(db: Db, userId: string) {
  const result = await db.execute<{
    id: string;
    name: string;
    sport: string;
    description: string | null;
    image: string | null;
    join_policy: string;
    role: string;
    main_channel_id: string;
  }>(sql`
    SELECT cl.id,
           cl.name,
           cl.sport,
           cl.description,
           cl.image,
           cl.join_policy,
           cm.role,
           ch.id AS main_channel_id
      FROM clubs cl
      JOIN club_memberships cm ON cm.club_id = cl.id AND cm.user_id = ${userId}
      -- The scope predicate is not optional. A join to channels on club_id alone
      -- also matches the club's eboard channel, and forgetting it produced "more
      -- than one row returned by a subquery" twice in v1.
      JOIN channels ch ON ch.club_id = cl.id AND ch.scope = 'club'
     ORDER BY cl.created_at DESC
  `);

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    sport: row.sport,
    image: row.image,
    description: row.description,
    joinPolicy: row.join_policy as 'open' | 'request',
    role: row.role as 'owner' | 'admin' | 'member',
    mainChannelId: row.main_channel_id,
  }));
}
