/**
 * Query side. Every read here is access-scoped by construction.
 *
 * "Deliver what you missed" and "page through history" are THE SAME QUERY with a
 * different bound. That is the whole return on storing messages once in a durable log
 * instead of per-recipient inboxes, and it is why there is no inbox table, no Redis
 * inbox, no drain-on-connect path and no delete-after-delivery job. See ADR-0003.
 */

import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  gte,
  isNull,
  lt,
  lte,
  sql,
  type SQL,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  conversationPreview,
  replyPreview,
  type ChannelState,
  type ConversationSummary,
  type MessageEnvelope,
  type MessageType,
} from '@clubchat/shared';
import type { Db } from '../db/client.ts';
import { channels, messages, users } from '../db/schema.ts';
import { isoUtc } from '../db/sql-helpers.ts';
import { clearedFloor, type AccessContext } from '../policy/context.ts';
import { canPostInChannel, type ChannelRef } from '../policy/predicates.ts';
import {
  accessibleChannelPredicate,
  channelDisplayImage,
  channelDisplayName,
  channelNameJoins,
} from './channel-access.ts';
import { mentionsForMessages } from './mentions.ts';
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
type MessageRow = typeof messages.$inferSelect & {
  senderName: string | null;
  senderImage: string | null;
  quoted: {
    seq: number | null;
    senderId: string | null;
    senderName: string | null;
    type: string | null;
    body: string | null;
    mediaId: string | null;
    documentName: string | null;
    deletedAt: Date | null;
  };
};

/**
 * The quoted message, joined to whatever is replying to it.
 *
 * > **A self-join, matched on `(channel_id, seq)`** - the same pair the foreign key uses, so the
 * > quote cannot resolve to a message in another channel even if a row somehow held one.
 *
 * An alias rather than a second query, because the alternative is a side load: one extra round
 * trip per page like `withReactions`, for a column most messages do not use. The join costs
 * nothing on a page with no replies in it.
 */
const quotedMessage = alias(messages, 'quoted');
const quotedSender = alias(users, 'quoted_sender');

/**
 * Every read in this module selects the message columns plus the sender's name.
 *
 * A `leftJoin`, not an inner one: an inner join would silently drop a message whose sender row is
 * missing, which turns a data problem into a hole in the conversation - and a hole is exactly what
 * the gapless log exists to make impossible. A null name renders as unattributed instead.
 */
const messageColumns = {
  ...getTableColumns(messages),
  senderName: users.name,
  senderImage: users.image,
  quoted: {
    seq: quotedMessage.seq,
    senderId: quotedMessage.senderId,
    senderName: quotedSender.name,
    type: quotedMessage.type,
    body: quotedMessage.body,
    mediaId: quotedMessage.mediaId,
    documentName: quotedMessage.documentName,
    deletedAt: quotedMessage.deletedAt,
  },
};

/**
 * The `SELECT ... FROM messages` every read in this module starts from, joins and all.
 *
 * > **One definition, four callers.** History, the jump window, Highlights and sync each need
 * > identical joins, and the second time a `WHERE`/`JOIN` clause is written out is the moment it
 * > starts diverging silently - failure mode 9, which cost a whole phase when "which channels can
 * > this user reach" existed in four hand-written copies. Adding a column to a message means
 * > editing this once.
 *
 * Callers add their own `where`, `orderBy` and `limit`, which is all that differs between them.
 */
function selectMessages(db: Db) {
  return db
    .select(messageColumns)
    .from(messages)
    .leftJoin(users, eq(users.id, messages.senderId))
    .leftJoin(
      quotedMessage,
      and(
        eq(quotedMessage.channelId, messages.channelId),
        eq(quotedMessage.seq, messages.replyToSeq),
      ),
    )
    .leftJoin(quotedSender, eq(quotedSender.id, quotedMessage.senderId));
}

function toEnvelope(row: MessageRow): MessageEnvelope {
  return {
    id: row.id,
    channelId: row.channelId,
    seq: row.seq,
    senderId: row.senderId,
    senderName: row.senderName,
    senderImage: row.senderImage,
    type: row.type as MessageType,
    body: row.body,
    clientMsgId: row.clientMsgId,
    pinned: row.pinned,
    pinnedAt: row.pinnedAt?.toISOString() ?? null,
    // Both filled in by `withReactions` for reads that return more than one row, so the whole
    // page costs two extra queries rather than two per message.
    reactions: [],
    mentions: [],
    mediaId: row.mediaId,
    documentName: row.documentName,
    documentSize: row.documentSize,
    linkedPollId: row.linkedPollId,
    linkedEventId: row.linkedEventId,
    linkedMeetingId: row.linkedMeetingId,
    /*
     * The quote, built from the joined row rather than from anything stored on this one.
     *
     * `row.quoted.seq` is the null test rather than `row.replyToSeq`, and that ordering matters:
     * a left join answers null for both "this is not a reply" and "the quoted row is missing",
     * and in the second case there is nothing to draw either way. The foreign key means the
     * second case cannot arise, which is what lets one branch cover both.
     */
    replyTo:
      row.quoted.seq === null
        ? null
        : {
            seq: row.quoted.seq,
            senderId: row.quoted.senderId as string,
            senderName: row.quoted.senderName,
            type: row.quoted.type as MessageType,
            // A tombstone has no body left to quote - `softDeleteMessage` nulls it - so this is
            // already null there rather than needing to be suppressed.
            preview: replyPreview(row.quoted.body),
            mediaId: row.quoted.mediaId,
            documentName: row.quoted.documentName,
            deleted: row.quoted.deletedAt !== null,
          },
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
    scope_id: string;
    club_id: string | null;
    last_seq: number;
    last_read_seq: number;
  }>(sql`
    SELECT c.id,
           c.scope,
           c.scope_id,
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
    scopeId: row.scope_id,
    clubId: row.club_id,
    lastSeq: row.last_seq,
    lastReadSeq: row.last_read_seq,
  }));
}

/**
 * The viewer's own floor into a channel, as a `WHERE` fragment.
 *
 * > **Every read that returns messages composes this, and that is why each of them takes an
 * > access context rather than a bare channel id.** The floor is per person - "Delete chat"
 * > hides one participant's view of a shared log without touching the other's - so a read that
 * > does not know who is asking cannot honour it. Making the context a required argument turns
 * > "this read forgot the floor" into a type error instead of a leak nobody would notice.
 *
 * Almost always `seq > 0`, which every row satisfies, so this costs nothing for the
 * overwhelming majority of reads.
 */
function visibleToViewer(ctx: AccessContext, channelId: string): SQL {
  return gt(messages.seq, clearedFloor(ctx, channelId));
}

/**
 * Page backward through history.
 *
 * Chat pages upward from the live tail only - there is no bidirectional paging. Rows
 * come back oldest-first so the caller can append them directly without reversing.
 */
export async function readHistory(
  db: Db,
  ctx: AccessContext,
  channelId: string,
  opts: { before?: number | undefined; limit?: number | undefined } = {},
): Promise<MessageEnvelope[]> {
  const limit = Math.min(opts.limit ?? HISTORY_PAGE_SIZE, 200);
  const floor = visibleToViewer(ctx, channelId);
  const where =
    opts.before === undefined
      ? and(eq(messages.channelId, channelId), floor)
      : and(eq(messages.channelId, channelId), lt(messages.seq, opts.before), floor);

  const rows = await selectMessages(db)
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
  ctx: AccessContext,
  channelId: string,
  seq: number,
  radius = 20,
): Promise<{
  messages: MessageEnvelope[];
  hasBefore: boolean;
  hasAfter: boolean;
}> {
  const span = Math.min(Math.max(radius, 1), 100);

  const rows = await selectMessages(db)
    .where(
      and(
        eq(messages.channelId, channelId),
        gte(messages.seq, seq - span),
        lte(messages.seq, seq + span),
        // A jump target below the viewer's own floor lands on an empty window rather than on
        // messages they cleared - a deep link from a notification predating the clear is
        // exactly how that would otherwise be reachable.
        visibleToViewer(ctx, channelId),
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
  ctx: AccessContext,
  channelId: string,
  kind: 'pinned' | 'announcements',
  opts: { before?: number | undefined; limit?: number | undefined } = {},
): Promise<{ messages: MessageEnvelope[]; hasMore: boolean }> {
  const limit = Math.min(opts.limit ?? HISTORY_PAGE_SIZE, 200);

  const conditions = [
    eq(messages.channelId, channelId),
    isNull(messages.deletedAt),
    kind === 'pinned' ? eq(messages.pinned, true) : eq(messages.type, 'announcement'),
    // Highlights reads the WHOLE channel by design, which is exactly why it needs the floor:
    // it is the one read that would happily reach back past a clear to the oldest pin.
    visibleToViewer(ctx, channelId),
  ];
  if (opts.before !== undefined) conditions.push(lt(messages.seq, opts.before));

  const rows = await selectMessages(db)
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
  const ids = envelopes.map((envelope) => envelope.id);
  /*
   * Both side loads for the page, together. Two queries for forty messages rather than eighty,
   * and issued concurrently because neither depends on the other.
   */
  const [reactionsByMessage, mentionsByMessage] = await Promise.all([
    reactionsForMessages(db, ids),
    mentionsForMessages(db, ids),
  ]);
  // Only rewrite the envelopes that actually have something, so the common case allocates
  // nothing beyond the lookups.
  return envelopes.map((envelope) => {
    const reactions = reactionsByMessage.get(envelope.id);
    const mentions = mentionsByMessage.get(envelope.id);
    if (reactions === undefined && mentions === undefined) return envelope;
    return {
      ...envelope,
      ...(reactions === undefined ? {} : { reactions }),
      ...(mentions === undefined ? {} : { mentions }),
    };
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
  ctx: AccessContext,
  channelId: string,
  sinceSeq: number,
  limit = SYNC_PAGE_SIZE,
  sinceRev?: number,
): Promise<{ messages: MessageEnvelope[]; hasMore: boolean; maxRev: number }> {
  /*
   * Two shapes, and which one runs is decided by whether the client sent a revision.
   *
   * > **`seq > mine` cannot see a change to a row the client already has**, and a pin, a
   * > tombstone and a reaction all mutate rows below that mark. A client offline when a message
   * > was deleted kept showing it, with its text, indefinitely - `PRD/17` item 14, and a
   * > moderation hole rather than staleness.
   *
   * `rev > mine` answers both halves at once: an append allocates a revision too, so a new
   * message and a changed message are the same question. Ordering follows the same column, which
   * is what lets the client page by the last `rev` it saw rather than needing two cursors.
   *
   * The seq form is kept for a client that has not been updated. It is the old behaviour exactly,
   * including the old gap - a mixed fleet gets correct-but-incomplete reconciliation rather than
   * a broken one, and upgrading is what closes it.
   */
  const reconciling = sinceRev !== undefined;
  const rows = await selectMessages(db)
    .where(
      and(
        eq(messages.channelId, channelId),
        reconciling ? gt(messages.rev, sinceRev) : gt(messages.seq, sinceSeq),
        // Without this a clear would undo itself on the next reconnect: sync pulls everything
        // above the client's local max, and a cleared client's local max is now below the
        // messages it just hid.
        visibleToViewer(ctx, channelId),
      ),
    )
    .orderBy(reconciling ? asc(messages.rev) : asc(messages.seq))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  return {
    // Reactions travel with the backlog too. A client that has been offline for a week must
    // come back to the conversation as it stands, not to messages with their reactions
    // stripped off and no way to notice.
    messages: await withReactions(db, page.map(toEnvelope)),
    hasMore,
    /*
     * The mark to resume from, computed here rather than by the client.
     *
     * A client cannot derive it: the envelope carries `seq`, not `rev`, and putting `rev` on the
     * wire would make an internal counter part of the message shape for no gain. Zero for an
     * empty page, which the client reads as "nothing moved, keep the mark you had".
     */
    maxRev: page.reduce((highest, row) => (row.rev > highest ? row.rev : highest), 0),
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

/**
 * The scopes the unified chat list shows.
 *
 * > **Club main chats and DMs only, and that is a product decision rather than a limit of this
 * > query.** A race and an Eboard space each have a real channel with a real unread count, and
 * > both are deliberately left out so the list stays the conversations somebody thinks of as
 * > theirs rather than one row per space they can reach. Neither disappears: both still produce a
 * > chat-unread row in the inbox and both still count toward the badge, because `readInbox` and
 * > `badgeCount` scope themselves with `accessibleChannelPredicate` and know nothing about this
 * > constant.
 *
 * Widening the list to a third scope is this array and nothing else - the select, the joins and
 * the wire type already cover every scope.
 */
const CONVERSATION_SCOPES = ['club', 'dm'] as const;

/**
 * Every conversation the viewer has, newest activity first.
 *
 * This is `listDmThreads` generalised from one scope to several, and it is deliberately built on
 * the fragments in `channel-access.ts` rather than on a membership join written out here. That
 * module exists because this exact question - "which channels can this person reach" - had been
 * restated four times with every copy wrong in the same way, so a fifth copy is the one thing
 * this function must not be.
 *
 * Two joins are worth reading twice:
 *
 *  - **The last message is a LATERAL rather than a correlated subquery per column.** One index
 *    seek per channel on `(channel_id, seq DESC)`, an index that already exists for paging, and
 *    it yields the whole row so the sender join has something to hang off.
 *  - **The sender's name is joined, never stored.** Same rule as `MessageRow` above: a rename
 *    changes every row at once, and an anonymised account reads as null here rather than keeping
 *    a name the product promised to drop.
 *
 * `canPost` comes from the policy module rather than from SQL, because the context already holds
 * whether a pair shares a club and whether either has blocked the other, and a predicate restated
 * in SQL is that same failure one layer down.
 */
export async function listConversations(
  db: Db,
  ctx: AccessContext,
): Promise<ConversationSummary[]> {
  const scopes = sql.param([...CONVERSATION_SCOPES]);
  const result = await db.execute<{
    channel_id: string;
    scope: string;
    scope_id: string;
    club_id: string | null;
    name: string;
    image: string | null;
    other_user_id: string | null;
    unread: number;
    muted: boolean;
    pinned: boolean;
    last_seq: number | null;
    last_type: string | null;
    last_body: string | null;
    last_document_name: string | null;
    last_deleted: boolean | null;
    last_sender_id: string | null;
    last_sender_name: string | null;
    last_at: string | null;
  }>(sql`
    /*
      Unread per club, over every channel of it this viewer can REACH.

      A CTE rather than a correlated subquery for one specific reason: the access fragment in
      channel-access.ts is documented as assuming the table is aliased c, and that convention is
      what stops a fifth hand-written copy of the membership join existing. Inside here the alias
      is c and the fragment applies unchanged; a subquery would have needed either a second alias
      or a parameterised fragment, and both are worse trades than one join.

      A race the viewer is not on the roster of contributes nothing, because the predicate never
      admits it - which is the same rule that keeps that race out of their channel list.
    */
    WITH reachable AS (
      SELECT c.id,
             c.club_id,
             GREATEST(c.last_seq - COALESCE(rc.last_read_seq, 0), 0) AS unread
        FROM channels c
        LEFT JOIN read_cursors rc
               ON rc.channel_id = c.id AND rc.user_id = ${ctx.userId}
       WHERE ${accessibleChannelPredicate(ctx.userId)}
    ),
    club_totals AS (
      SELECT club_id, SUM(unread) AS unread
        FROM reachable
       WHERE club_id IS NOT NULL
       GROUP BY club_id
    )
    SELECT c.id::text        AS channel_id,
           c.scope,
           c.scope_id::text  AS scope_id,
           c.club_id::text   AS club_id,
           ${channelDisplayName()}  AS name,
           ${channelDisplayImage()} AS image,
           peer.id::text     AS other_user_id,
           /*
             Unread for the ROW, which for a club means the whole club rather than its main
             chat alone.

             > **A club row stands for a place, not a channel.** It opens the hub, and the hub
             > leads to the main chat, the Eboard space and every race the viewer is on. Counting
             > the main chat alone made unread sitting in the Eboard invisible in the list, on the
             > hub and everywhere else - reported from a phone as "it says nine and I cannot find
             > them". The hub badges each row separately, so this total always resolves to a place
             > somebody can actually go.

             A DM has exactly one channel, so its own count is the whole answer.
           */
           CASE WHEN c.scope = 'dm'
                THEN GREATEST(c.last_seq - COALESCE(rc.last_read_seq, 0), 0)
                ELSE COALESCE(ct.unread, 0)
           END AS unread,
           (mute.user_id IS NOT NULL) AS muted,
           (pin.user_id IS NOT NULL) AS pinned,
           last.seq             AS last_seq,
           last.type            AS last_type,
           last.body            AS last_body,
           last.document_name   AS last_document_name,
           (last.deleted_at IS NOT NULL) AS last_deleted,
           last.sender_id::text AS last_sender_id,
           sender.full_name     AS last_sender_name,
           ${isoUtc(sql`last.created_at`)} AS last_at
      FROM channels c
      ${channelNameJoins(ctx.userId)}
      LEFT JOIN read_cursors rc
             ON rc.channel_id = c.id AND rc.user_id = ${ctx.userId}
      LEFT JOIN channel_mutes mute
             ON mute.channel_id = c.id
            AND mute.user_id = ${ctx.userId}
            AND (mute.muted_until IS NULL OR mute.muted_until > now())
      LEFT JOIN channel_pins pin
             ON pin.channel_id = c.id AND pin.user_id = ${ctx.userId}
      -- Null for a dm, which has no club and answers with its own count instead.
      LEFT JOIN club_totals ct ON ct.club_id = c.club_id
      -- The viewer's own floor, joined so the LATERAL below can compare against it. Absent for
      -- every channel nobody has cleared, which COALESCE turns into 0.
      LEFT JOIN channel_clears clr
             ON clr.channel_id = c.id AND clr.user_id = ${ctx.userId}
      LEFT JOIN LATERAL (
        SELECT m.seq, m.type, m.body, m.document_name, m.deleted_at, m.sender_id, m.created_at
          FROM messages m
         WHERE m.channel_id = c.id
           -- A cleared conversation must not preview the message it just hid. This is the same
           -- floor every other read applies, expressed in SQL because this one is raw.
           AND m.seq > COALESCE(clr.cleared_before_seq, 0)
         ORDER BY m.seq DESC
         LIMIT 1
      ) last ON true
      LEFT JOIN users sender ON sender.id = last.sender_id
     WHERE c.scope = ANY(${scopes}::text[])
       AND ${accessibleChannelPredicate(ctx.userId)}
       /*
         A cleared conversation with nothing said since drops out of the list entirely, which is
         what "Delete chat" promises. It comes back the moment anything arrives above the floor,
         carrying only that - so the row cannot become a permanent hiding place for a
         conversation somebody is still being sent messages in.

         Note this is deliberately NOT applied to a channel nobody has cleared: a null last.seq
         also describes a brand-new thread, which must stay in the list. And no backticks in
         here - inside a sql template literal one of those ends the string.
       */
       AND (clr.user_id IS NULL OR last.seq IS NOT NULL)
     /*
       Pinned first, then by activity within each group. Pinning exists precisely to defeat
       recency, so this cannot be a tiebreak on the timestamp - it has to be the primary key of
       the sort.
     */
     ORDER BY (pin.user_id IS NOT NULL) DESC,
              COALESCE(last.created_at, c.created_at) DESC
  `);

  return result.rows.map((row) => {
    const scope = row.scope as ConversationSummary['scope'];
    return {
      channelId: row.channel_id,
      scope,
      name: row.name,
      image: row.image,
      clubId: row.club_id,
      otherUserId: row.other_user_id,
      unread: Number(row.unread),
      muted: row.muted,
      pinned: row.pinned,
      canPost: canPostInChannel(ctx, {
        id: row.channel_id,
        scope,
        clubId: row.club_id,
        // The channel's own `scope_id`, read from the row rather than reconstructed. For a DM
        // that is the conversation the predicate looks up in the context's thread map, and
        // passing the channel id instead would answer "cannot post" for every thread.
        scopeId: row.scope_id,
      }),
      lastMessage:
        row.last_seq === null
          ? null
          : {
              seq: Number(row.last_seq),
              type: row.last_type as MessageType,
              // Null once deleted, because the tombstone nulls the column itself - there is no
              // stored text here that could leak back into a list.
              preview: conversationPreview(row.last_body),
              senderName: row.last_sender_name,
              senderId: row.last_sender_id ?? '',
              documentName: row.last_document_name,
              deleted: row.last_deleted === true,
              createdAt: row.last_at ?? '',
            },
    };
  });
}
