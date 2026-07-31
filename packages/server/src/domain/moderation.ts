/**
 * Reporting a message, and the two places a report can go.
 *
 * > **Every other scope answers "who sees a report?" with "that space's admins". A DM has
 * > none, so the question needs its own answer rather than a fallback.**
 * >
 * > | Channel scope | Report visible to |
 * > |---|---|
 * > | club / race / eboard | admins of that space, in the Highlights Reports tab |
 * > | **dm** | **platform moderators, in a separate queue** |
 *
 * Mechanically it is the same `message_reports` row either way; only the reader differs, and
 * the reader is selected by the reported message's channel scope. `canReadReports` is the one
 * place that selection happens.
 *
 * The blocking path is deliberately separate from this one: **blocking is instant and
 * self-service, reporting is reviewed.** A member protecting themselves must never have to
 * wait on a moderator, which is why nothing in this file is on the critical path of anyone's
 * safety.
 */

import { and, eq, sql } from 'drizzle-orm';
import type { MessageEnvelope, MessageType } from '@clubchat/shared';
import type { Db } from '../db/client.ts';
import { messageReports, moderationReads } from '../db/schema.ts';
import type { AccessContext } from '../policy/context.ts';
import {
  canDismissReport,
  canReadReports,
  canReportMessage,
  type ChannelRef,
} from '../policy/predicates.ts';
import { getChannelRef } from './reads.ts';
import { reactionsForMessages } from './reactions.ts';

export type ModerationRefusal = { ok: false; code: 'forbidden' | 'not_found' };
export type ModerationResult<T> = ({ ok: true } & T) | ModerationRefusal;

/**
 * How far either side of the reported message a moderator may read.
 *
 * > **Moderation is not a licence to browse private conversations.** Eleven messages is enough
 * > to tell an argument from an abuse and far short of a transcript. The number is here rather
 * > than at the call site so widening it is one visible edit.
 */
export const MODERATION_CONTEXT_RADIUS = 5;

// ---------------------------------------------------------------------------
// Filing a report
// ---------------------------------------------------------------------------

/**
 * Report a message.
 *
 * **Idempotent by the primary key**, which is what makes PRD/05 rule 10 - "reporting twice is
 * a no-op" - a property of the data rather than a check a handler could forget. Nothing about
 * the DM path relaxes it.
 *
 * Emits no outbox event and writes no notification, in either kind of scope:
 *
 *  - In a DM, PRD/14 is explicit that the other participant is not told.
 *  - In a group scope, the report surfaces in the Reports tab, which is a work list the admin
 *    pulls. There is no `message_reported` notification type in the catalogue, and adding one
 *    would need an audience rule for platform moderators, who are not members of any club.
 */
export async function reportMessage(
  db: Db,
  ctx: AccessContext,
  channel: ChannelRef,
  seq: number,
): Promise<ModerationResult<{ messageId: string; alreadyReported: boolean }>> {
  const rows = await db.execute<{ id: string; sender_id: string }>(sql`
    SELECT id::text AS id, sender_id::text AS sender_id
      FROM messages
     WHERE channel_id = ${channel.id} AND seq = ${seq}
  `);
  const message = rows.rows[0];
  if (!message) return { ok: false, code: 'not_found' };

  // Access AND "not your own message", from the policy module. Note it is gated on reading the
  // channel rather than on being able to post in it: a member who has just blocked someone, or
  // whose thread went read-only, must still be able to report what was said to them.
  if (!canReportMessage(ctx, channel, { senderId: message.sender_id })) {
    return { ok: false, code: 'forbidden' };
  }

  const inserted = await db
    .insert(messageReports)
    .values({ messageId: message.id, reporterId: ctx.userId })
    .onConflictDoNothing()
    .returning({ messageId: messageReports.messageId });

  return {
    ok: true,
    messageId: message.id,
    // Reported already. Still a success - the outcome the reporter wanted is true - but the
    // client can say "already reported" rather than implying a second one was filed.
    alreadyReported: inserted.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Reading reports: the per-space tab
// ---------------------------------------------------------------------------

export type ReportRow = {
  messageId: string;
  channelId: string;
  seq: number;
  /** Null on a soft-deleted message, and for the dm queue, which never carries content. */
  body: string | null;
  senderId: string;
  senderName: string;
  reporters: Array<{ userId: string; name: string; createdAt: string }>;
  dismissedAt: string | null;
};

/**
 * The Reports tab for one space.
 *
 * Includes the message body, unlike the DM queue below, and the asymmetry is the whole point:
 * an admin of a club can already read every message in it by scrolling, so withholding the
 * text here would protect nothing. A platform moderator has no such access, and their read is
 * therefore both narrowed and logged.
 *
 * Returns `not_found` for a dm channel even to a platform moderator - the queue is a separate
 * endpoint, so this one cannot become a way to enumerate a conversation by channel id.
 */
export async function listChannelReports(
  db: Db,
  ctx: AccessContext,
  channel: ChannelRef,
  opts: { includeDismissed?: boolean | undefined } = {},
): Promise<ModerationResult<{ reports: ReportRow[] }>> {
  if (channel.scope === 'dm') return { ok: false, code: 'not_found' };
  if (!canReadReports(ctx, channel)) return { ok: false, code: 'not_found' };

  const rows = await db.execute<{
    message_id: string;
    seq: number;
    body: string | null;
    sender_id: string;
    sender_name: string;
    dismissed_at: string | null;
    reporters: Array<{ userId: string; name: string; createdAt: string }>;
  }>(sql`
    SELECT m.id::text AS message_id,
           m.seq,
           m.body,
           m.sender_id::text AS sender_id,
           sender.full_name AS sender_name,
           MAX(r.dismissed_at)::text AS dismissed_at,
           json_agg(
             json_build_object('userId', reporter.id::text,
                               'name', reporter.full_name,
                               'createdAt', r.created_at)
             ORDER BY r.created_at
           ) AS reporters
      FROM message_reports r
      JOIN messages m ON m.id = r.message_id
      JOIN users sender ON sender.id = m.sender_id
      JOIN users reporter ON reporter.id = r.reporter_id
     WHERE m.channel_id = ${channel.id}
       ${opts.includeDismissed ? sql`` : sql`AND r.dismissed_at IS NULL`}
     GROUP BY m.id, m.seq, m.body, m.sender_id, sender.full_name
     ORDER BY m.seq DESC
  `);

  return {
    ok: true,
    reports: rows.rows.map((row) => ({
      messageId: row.message_id,
      channelId: channel.id,
      seq: Number(row.seq),
      body: row.body,
      senderId: row.sender_id,
      senderName: row.sender_name,
      reporters: row.reporters.map((r) => ({
        userId: r.userId,
        name: r.name,
        createdAt: new Date(r.createdAt).toISOString(),
      })),
      dismissedAt: row.dismissed_at === null ? null : new Date(row.dismissed_at).toISOString(),
    })),
  };
}

// ---------------------------------------------------------------------------
// Reading reports: the platform queue
// ---------------------------------------------------------------------------

/**
 * The DM report queue.
 *
 * > **Metadata only. No message bodies.**
 * >
 * > TECH/05 grants a moderator the reported message and its immediate context, and requires
 * > that read to be audit-logged. If the queue listing carried bodies, then either every
 * > refresh of the list would have to write a log row per report, or the content would be read
 * > without a log at all - the second silently defeats the rule and the first makes the log
 * > useless noise. So the list says who reported what and when, and `readReportedContext` is
 * > the single, logged door to the content.
 *
 * Gated on `is_platform_moderator` and on nothing else. It is not a tier above Owner and grants
 * no club capability: **a platform moderator sees DM reports and nothing more**, and a club
 * admin never appears here at all.
 */
export async function listDmReportQueue(
  db: Db,
  ctx: AccessContext,
  opts: { includeDismissed?: boolean | undefined; limit?: number | undefined } = {},
): Promise<
  ModerationResult<{
    reports: Array<{
      messageId: string;
      channelId: string;
      conversationId: string;
      seq: number;
      senderId: string;
      senderName: string;
      reporters: Array<{ userId: string; name: string; createdAt: string }>;
      dismissedAt: string | null;
      createdAt: string;
    }>;
  }>
> {
  // The one capability the flag grants. Checked here rather than through a channel, because the
  // queue spans every conversation and there is no single channel to authorize against.
  if (!ctx.isPlatformModerator) return { ok: false, code: 'not_found' };

  const limit = Math.min(opts.limit ?? 50, 200);

  const rows = await db.execute<{
    message_id: string;
    channel_id: string;
    conversation_id: string;
    seq: number;
    sender_id: string;
    sender_name: string;
    dismissed_at: string | null;
    created_at: string;
    reporters: Array<{ userId: string; name: string; createdAt: string }>;
  }>(sql`
    SELECT m.id::text AS message_id,
           c.id::text AS channel_id,
           c.scope_id::text AS conversation_id,
           m.seq,
           m.sender_id::text AS sender_id,
           sender.full_name AS sender_name,
           MAX(r.dismissed_at)::text AS dismissed_at,
           MIN(r.created_at)::text AS created_at,
           json_agg(
             json_build_object('userId', reporter.id::text,
                               'name', reporter.full_name,
                               'createdAt', r.created_at)
             ORDER BY r.created_at
           ) AS reporters
      FROM message_reports r
      JOIN messages m ON m.id = r.message_id
      JOIN channels c ON c.id = m.channel_id
      JOIN users sender ON sender.id = m.sender_id
      JOIN users reporter ON reporter.id = r.reporter_id
     -- The scope predicate is the whole authorization boundary of this query: a report from
     -- club, race or Eboard chat belongs to that space's admins and must never appear here.
     WHERE c.scope = 'dm'
       ${opts.includeDismissed ? sql`` : sql`AND r.dismissed_at IS NULL`}
     GROUP BY m.id, c.id, c.scope_id, m.seq, m.sender_id, sender.full_name
     ORDER BY MIN(r.created_at) DESC
     LIMIT ${limit}
  `);

  return {
    ok: true,
    reports: rows.rows.map((row) => ({
      messageId: row.message_id,
      channelId: row.channel_id,
      conversationId: row.conversation_id,
      seq: Number(row.seq),
      senderId: row.sender_id,
      senderName: row.sender_name,
      reporters: row.reporters.map((r) => ({
        userId: r.userId,
        name: r.name,
        createdAt: new Date(r.createdAt).toISOString(),
      })),
      dismissedAt: row.dismissed_at === null ? null : new Date(row.dismissed_at).toISOString(),
      createdAt: new Date(row.created_at).toISOString(),
    })),
  };
}

// ---------------------------------------------------------------------------
// The narrow, logged read
// ---------------------------------------------------------------------------

export type ReportedContext = {
  messageId: string;
  channelId: string;
  reportedSeq: number;
  fromSeq: number;
  toSeq: number;
  messages: MessageEnvelope[];
};

/**
 * Read the reported message and its immediate context.
 *
 * Two properties, both required by TECH/05 and both enforced here rather than trusted:
 *
 *  1. **Scoped to a window around the reported seq**, never the conversation. The window is
 *     computed from `MODERATION_CONTEXT_RADIUS` and the caller cannot widen it - there is no
 *     parameter for it, deliberately.
 *  2. **Audit-logged.** The row records the window that was actually served, and it is written
 *     in the same transaction as the read. A log written after the fact could be skipped by a
 *     failure between the two; a log written before it would record reads that never happened.
 *
 * For a group scope this is just a convenience view of messages the admin can already read, so
 * no log row is written - logging a read that conveys nothing new would dilute the log that
 * matters.
 */
export async function readReportedContext(
  db: Db,
  ctx: AccessContext,
  messageId: string,
): Promise<ModerationResult<ReportedContext>> {
  const located = await db.execute<{ channel_id: string; seq: number }>(sql`
    SELECT m.channel_id::text AS channel_id, m.seq
      FROM message_reports r
      JOIN messages m ON m.id = r.message_id
     WHERE r.message_id = ${messageId}
     LIMIT 1
  `);
  const target = located.rows[0];
  // Not merely "no such message": no such REPORT. A moderator has no door into a conversation
  // that nobody reported.
  if (!target) return { ok: false, code: 'not_found' };

  const channel = await getChannelRef(db, target.channel_id);
  if (!channel || !canReadReports(ctx, channel)) return { ok: false, code: 'not_found' };

  const reportedSeq = Number(target.seq);
  const fromSeq = Math.max(1, reportedSeq - MODERATION_CONTEXT_RADIUS);
  const toSeq = reportedSeq + MODERATION_CONTEXT_RADIUS;

  const messages = await db.transaction(async (tx) => {
    if (channel.scope === 'dm') {
      await tx.insert(moderationReads).values({
        moderatorId: ctx.userId,
        messageId,
        channelId: channel.id,
        fromSeq,
        toSeq,
      });
    }

    const rows = await tx.execute<{
      id: string;
      channel_id: string;
      seq: number;
      sender_id: string;
      sender_name: string | null;
      type: string;
      body: string | null;
      client_msg_id: string;
      pinned: boolean;
      media_id: string | null;
      document_name: string | null;
      document_size: number | null;
      linked_poll_id: string | null;
      linked_event_id: string | null;
      linked_meeting_id: string | null;
      deleted_at: string | null;
      created_at: string;
    }>(sql`
      SELECT m.id::text AS id, m.channel_id::text AS channel_id, m.seq,
             m.sender_id::text AS sender_id,
             -- Who said what. A moderation transcript without names is not evidence.
             u.full_name AS sender_name,
             m.type, m.body, m.client_msg_id::text AS client_msg_id, m.pinned,
             m.media_id::text AS media_id, m.document_name, m.document_size,
             m.linked_poll_id::text AS linked_poll_id,
             m.linked_event_id::text AS linked_event_id,
             m.linked_meeting_id::text AS linked_meeting_id,
             m.deleted_at::text AS deleted_at, m.created_at::text AS created_at
        FROM messages m
        LEFT JOIN users u ON u.id = m.sender_id
       WHERE m.channel_id = ${channel.id} AND m.seq BETWEEN ${fromSeq} AND ${toSeq}
       ORDER BY m.seq
    `);

    return rows.rows;
  });

  // Part of the context a moderator is judging: whether a message was piled onto changes what
  // it means. Loaded after the window is fixed, so it cannot widen what was served.
  const byMessage = await reactionsForMessages(
    db,
    messages.map((row) => row.id),
  );

  return {
    ok: true,
    messageId,
    channelId: channel.id,
    reportedSeq,
    fromSeq,
    toSeq,
    messages: messages.map((row) => ({
      id: row.id,
      channelId: row.channel_id,
      seq: Number(row.seq),
      // The moderation window shows who said what: an unattributed transcript is not evidence.
      senderName: row.sender_name ?? null,
      senderId: row.sender_id,
      type: row.type as MessageType,
      body: row.body,
      clientMsgId: row.client_msg_id,
      pinned: row.pinned,
      reactions: byMessage.get(row.id) ?? [],
      mediaId: row.media_id,
      documentName: row.document_name,
      documentSize: row.document_size === null ? null : Number(row.document_size),
      linkedPollId: row.linked_poll_id,
      linkedEventId: row.linked_event_id,
      linkedMeetingId: row.linked_meeting_id,
      // Strings, not Dates: db.execute does not apply Drizzle's column coercion, so a row type
      // claiming Date here would typecheck and fail at the call site.
      deletedAt: row.deleted_at === null ? null : new Date(row.deleted_at).toISOString(),
      createdAt: new Date(row.created_at).toISOString(),
    })),
  };
}

/** What a moderator has looked at. Their own trail, newest first. */
export async function listModerationReads(
  db: Db,
  ctx: AccessContext,
  opts: { limit?: number | undefined } = {},
): Promise<ModerationResult<{ reads: Array<{ messageId: string; channelId: string; fromSeq: number; toSeq: number; createdAt: string }> }>> {
  if (!ctx.isPlatformModerator) return { ok: false, code: 'not_found' };

  const rows = await db
    .select()
    .from(moderationReads)
    .where(eq(moderationReads.moderatorId, ctx.userId))
    .orderBy(sql`created_at DESC`)
    .limit(Math.min(opts.limit ?? 100, 500));

  return {
    ok: true,
    reads: rows.map((row) => ({
      messageId: row.messageId,
      channelId: row.channelId,
      fromSeq: row.fromSeq,
      toSeq: row.toSeq,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

// ---------------------------------------------------------------------------
// Dismissal
// ---------------------------------------------------------------------------

/**
 * Dismiss a report.
 *
 * Marks every open report on that message as dealt with, rather than one reporter's, because
 * the admin's decision is about the message and not about who complained.
 *
 * Deliberately does NOT delete the message. Deletion goes through `canDeleteMessage`, which is
 * why a platform moderator cannot remove a DM message: **nobody deletes anybody else's message
 * in a DM**, and moderation there is blocking plus reporting. The Reports tab in a group scope
 * offers both actions because a club admin genuinely holds both authorities.
 */
export async function dismissReport(
  db: Db,
  ctx: AccessContext,
  messageId: string,
): Promise<ModerationResult<{ dismissed: number }>> {
  const located = await db.execute<{ channel_id: string }>(sql`
    SELECT m.channel_id::text AS channel_id
      FROM message_reports r
      JOIN messages m ON m.id = r.message_id
     WHERE r.message_id = ${messageId}
     LIMIT 1
  `);
  const target = located.rows[0];
  if (!target) return { ok: false, code: 'not_found' };

  const channel = await getChannelRef(db, target.channel_id);
  if (!channel || !canDismissReport(ctx, channel)) return { ok: false, code: 'not_found' };

  const updated = await db
    .update(messageReports)
    .set({ dismissedAt: new Date(), dismissedBy: ctx.userId })
    .where(and(eq(messageReports.messageId, messageId), sql`dismissed_at IS NULL`))
    .returning({ reporterId: messageReports.reporterId });

  return { ok: true, dismissed: updated.length };
}
