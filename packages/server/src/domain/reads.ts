/**
 * Query side. Every read here is access-scoped by construction.
 *
 * "Deliver what you missed" and "page through history" are THE SAME QUERY with a
 * different bound. That is the whole return on storing messages once in a durable log
 * instead of per-recipient inboxes, and it is why there is no inbox table, no Redis
 * inbox, no drain-on-connect path and no delete-after-delivery job. See ADR-0003.
 */

import { and, asc, desc, eq, gt, lt, sql } from 'drizzle-orm';
import type { ChannelState, MessageEnvelope, MessageType } from '@clubchat/shared';
import type { Db } from '../db/client.ts';
import { channels, messages } from '../db/schema.ts';
import type { ChannelRef } from '../policy/predicates.ts';

/** The page size chat opens with, then pages backward from. */
export const HISTORY_PAGE_SIZE = 40;

/** Cap on one sync response, so a client offline for a week pages rather than blocks. */
export const SYNC_PAGE_SIZE = 500;

type MessageRow = typeof messages.$inferSelect;

function toEnvelope(row: MessageRow): MessageEnvelope {
  return {
    id: row.id,
    channelId: row.channelId,
    seq: row.seq,
    senderId: row.senderId,
    type: row.type as MessageType,
    body: row.body,
    clientMsgId: row.clientMsgId,
    pinned: row.pinned,
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
 * One query, not one per channel. Race and DM scopes are absent because Phase 0 has
 * no tables for them; adding each is one more branch in the WHERE clause, which is
 * exactly the cost the channel abstraction predicts.
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
     WHERE (c.scope = 'club'
            AND c.club_id IN (SELECT club_id FROM club_memberships WHERE user_id = ${userId}))
        OR (c.scope = 'eboard'
            AND c.scope_id IN (SELECT eboard_id FROM eboard_memberships WHERE user_id = ${userId}))
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
    .select()
    .from(messages)
    .where(where)
    // Ordered by seq, never by timestamp. A timestamp is not an ordering: clock skew
    // is real, and timestamps here are for display only.
    .orderBy(desc(messages.seq))
    .limit(limit);

  return rows.reverse().map(toEnvelope);
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
    .select()
    .from(messages)
    .where(and(eq(messages.channelId, channelId), gt(messages.seq, sinceSeq)))
    .orderBy(asc(messages.seq))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  return {
    messages: rows.slice(0, limit).map(toEnvelope),
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
    join_policy: string;
    role: string;
    main_channel_id: string;
  }>(sql`
    SELECT cl.id,
           cl.name,
           cl.sport,
           cl.description,
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
    description: row.description,
    joinPolicy: row.join_policy as 'open' | 'request',
    role: row.role as 'owner' | 'admin' | 'member',
    mainChannelId: row.main_channel_id,
  }));
}
