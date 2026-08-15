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
import { replyPreview, type MessageEnvelope, type MessageType } from '@clubchat/shared';
import type { Db } from '../db/client.ts';
import {
  messageReports,
  moderationActions,
  moderationReads,
  outbox,
} from '../db/schema.ts';
import type { AccessContext } from '../policy/context.ts';
import {
  canDismissReport,
  canReadReports,
  canReinstateAccount,
  canRemoveReportedMessage,
  canReportMessage,
  canSuspendAccount,
  type ChannelRef,
} from '../policy/predicates.ts';
import { accessibleChannelPredicate } from './channel-access.ts';
import { fileReport } from './file-report.ts';
import { getChannelRef } from './reads.ts';
import { reactionsForMessages } from './reactions.ts';
import { applySoftDelete } from './send-message.ts';

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
 * **Emits `message.reported`, in the same transaction as the row.** Either both land or neither
 * does, so a report can never sit in the queue with nobody told and a notification can never
 * point at a report that was rolled back. Only a report that was actually created emits one - a
 * repeat by the same person is absorbed by the primary key and must not buzz anybody a second
 * time.
 *
 * > **This used to emit nothing**, and said so here: "the report surfaces in the Reports tab,
 * > which is a work list the admin pulls". It was a work list nobody was told had work in it, and
 * > the founder found out by reporting something and hearing nothing. The note also named what
 * > the fix needed - "an audience rule for platform moderators, who are not members of any club"
 * > - which is `channelModerationAudienceById`.
 *
 * Who is told still differs by scope, and neither answer includes the reported member: PRD/14
 * keeps a DM report away from every club admin, and PRD/05 rule 10 keeps reporting invisible to
 * its subject.
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

  /*
   * The report row and the event that tells somebody about it, in ONE transaction.
   *
   * The whole reason the outbox exists rather than notifying from here: either both land or
   * neither does, so a report can never sit in the table with nobody told, and a notification
   * can never point at a report that was rolled back.
   *
   * Through `fileReport` rather than written here, because the content filter files reports too
   * and two copies of this would drift.
   */
  const created = await db.transaction((tx) =>
    fileReport(tx, {
      messageId: message.id,
      reporterId: ctx.userId,
      channelId: channel.id,
      seq,
    }),
  );

  return {
    ok: true,
    messageId: message.id,
    // Reported already. Still a success - the outcome the reporter wanted is true - but the
    // client can say "already reported" rather than implying a second one was filed.
    alreadyReported: !created,
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
  /** Their picture, so the queue draws the same face the channel does. */
  senderImage: string | null;
  /**
   * When the message itself was deleted, or null.
   *
   * `body` alone cannot answer this: it is also null for a photo, so a client reading "no body"
   * as "deleted" mislabels every reported photo as one an admin has already dealt with.
   */
  deletedAt: string | null;
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
    sender_image: string | null;
    deleted_at: string | null;
    dismissed_at: string | null;
    reporters: Array<{ userId: string; name: string; createdAt: string }>;
  }>(sql`
    SELECT m.id::text AS message_id,
           m.seq,
           m.body,
           m.sender_id::text AS sender_id,
           sender.full_name AS sender_name,
           sender.image AS sender_image,
           m.deleted_at::text AS deleted_at,
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
     GROUP BY m.id, m.seq, m.body, m.sender_id, sender.full_name, sender.image, m.deleted_at
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
      senderImage: row.sender_image,
      deletedAt: row.deleted_at === null ? null : new Date(row.deleted_at).toISOString(),
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
      /**
       * Whether this account is already suspended, and whether the message is already a
       * tombstone.
       *
       * Carried so the queue can say what has been done rather than offering an action that
       * silently changes nothing. Still metadata - neither reveals a word of what was said - so
       * the rule that this listing carries no content is intact.
       */
      senderSuspended: boolean;
      removed: boolean;
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
    sender_suspended: boolean;
    removed: boolean;
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
           (sender.signin_blocked_at IS NOT NULL) AS sender_suspended,
           (m.deleted_at IS NOT NULL) AS removed,
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
     GROUP BY m.id, c.id, c.scope_id, m.seq, m.sender_id, sender.full_name,
              sender.signin_blocked_at, m.deleted_at
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
      senderSuspended: row.sender_suspended === true,
      removed: row.removed === true,
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
  /**
   * Who sent the reported message, and what has already been done about them.
   *
   * Answered here rather than worked out by the screen from the window, for the reason every
   * other capability flag on a read is: the screen would be restating a rule, and the two
   * definitions would drift. It is also the difference between offering "Suspend" and offering
   * "Reinstate", which a screen must not guess at.
   */
  subjectUserId: string;
  subjectSuspended: boolean;
  /** Whether the reported message is already a tombstone. */
  removed: boolean;
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
  const located = await db.execute<{
    channel_id: string;
    seq: number;
    sender_id: string;
    sender_suspended: boolean;
    removed: boolean;
  }>(sql`
    SELECT m.channel_id::text AS channel_id, m.seq,
           m.sender_id::text AS sender_id,
           (u.signin_blocked_at IS NOT NULL) AS sender_suspended,
           (m.deleted_at IS NOT NULL) AS removed
      FROM message_reports r
      JOIN messages m ON m.id = r.message_id
      JOIN users u ON u.id = m.sender_id
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
      sender_image: string | null;
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
      reply_seq: number | null;
      reply_sender_id: string | null;
      reply_sender_name: string | null;
      reply_type: string | null;
      reply_body: string | null;
      reply_media_id: string | null;
      reply_document_name: string | null;
      reply_deleted: boolean | null;
      deleted_at: string | null;
      edited_at: string | null;
      created_at: string;
    }>(sql`
      SELECT m.id::text AS id, m.channel_id::text AS channel_id, m.seq,
             m.sender_id::text AS sender_id,
             -- Who said what. A moderation transcript without names is not evidence.
             u.full_name AS sender_name,
             u.image AS sender_image,
             m.type, m.body, m.client_msg_id::text AS client_msg_id, m.pinned,
             m.media_id::text AS media_id, m.document_name, m.document_size,
             m.linked_poll_id::text AS linked_poll_id,
             m.linked_event_id::text AS linked_event_id,
             m.linked_meeting_id::text AS linked_meeting_id,
             -- What a reply was answering. Loaded for the same reason reactions are: which
             -- message somebody was responding to changes what their words mean, and the
             -- quoted message can sit outside the window this read is allowed to return.
             q.seq AS reply_seq,
             q.sender_id::text AS reply_sender_id,
             qu.full_name AS reply_sender_name,
             q.type AS reply_type,
             q.body AS reply_body,
             q.media_id::text AS reply_media_id,
             q.document_name AS reply_document_name,
             (q.deleted_at IS NOT NULL) AS reply_deleted,
             m.deleted_at::text AS deleted_at,
             -- Whether it was corrected, which IS evidence, unlike the pin above. A moderator
             -- reading a reported message needs to know its text moved after it was said - the
             -- report may well be about words the window no longer contains.
             m.edited_at::text AS edited_at,
             m.created_at::text AS created_at
        FROM messages m
        LEFT JOIN users u ON u.id = m.sender_id
        -- Matched on the channel as well as the seq, which is the pair the foreign key uses.
        LEFT JOIN messages q ON q.channel_id = m.channel_id AND q.seq = m.reply_to_seq
        LEFT JOIN users qu ON qu.id = q.sender_id
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
    subjectUserId: target.sender_id,
    subjectSuspended: target.sender_suspended === true,
    removed: target.removed === true,
    messages: messages.map((row) => ({
      id: row.id,
      channelId: row.channel_id,
      seq: Number(row.seq),
      // The moderation window shows who said what: an unattributed transcript is not evidence.
      senderName: row.sender_name ?? null,
      senderImage: row.sender_image ?? null,
      senderId: row.sender_id,
      type: row.type as MessageType,
      body: row.body,
      clientMsgId: row.client_msg_id,
      pinned: row.pinned,
      // Not part of the moderation window: a pin is not evidence.
      pinnedAt: null,
      reactions: byMessage.get(row.id) ?? [],
      // Not loaded for the moderation window: a moderator is judging what was said, and a
      // highlighted name would be a profile link out of an audited read.
      mentions: [],
      mediaId: row.media_id,
      documentName: row.document_name,
      documentSize: row.document_size === null ? null : Number(row.document_size),
      linkedPollId: row.linked_poll_id,
      linkedEventId: row.linked_event_id,
      linkedMeetingId: row.linked_meeting_id,
      replyTo:
        row.reply_seq === null
          ? null
          : {
              seq: Number(row.reply_seq),
              senderId: row.reply_sender_id as string,
              senderName: row.reply_sender_name,
              type: row.reply_type as MessageType,
              preview: replyPreview(row.reply_body),
              mediaId: row.reply_media_id,
              documentName: row.reply_document_name,
              deleted: row.reply_deleted === true,
            },
      // Strings, not Dates: db.execute does not apply Drizzle's column coercion, so a row type
      // claiming Date here would typecheck and fail at the call site.
      deletedAt: row.deleted_at === null ? null : new Date(row.deleted_at).toISOString(),
      editedAt: row.edited_at === null ? null : new Date(row.edited_at).toISOString(),
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
// Acting on a report: ejecting the person, and removing what they said
// ---------------------------------------------------------------------------

/**
 * Suspend an account, or lift a suspension.
 *
 * > **The "ejecting the user" half of Apple's guideline 1.2.** Before this, a moderator could
 * > read a genuinely abusive conversation and then only dismiss the report - `signin_blocked_at`
 * > was written in exactly one place in the whole codebase, and that place was somebody deleting
 * > their own account.
 *
 * **Suspension is not deletion, and the difference is the point.** It writes the same
 * `signin_blocked_at` that every entry point already re-asks about, and it deliberately does not
 * anonymise: the profile, the memberships, the messages and any Owner row survive, so the action
 * is reversible and no club is damaged by it. Ejecting a club Owner by deleting them would breach
 * domain invariant 1; suspending one breaches nothing.
 *
 * **Both halves of revocation, because a per-request check is not a per-connection check.** The
 * column is what makes the next HTTP request 401 and what the gateway re-asks on every frame that
 * reloads the context. The outbox event is what drops a socket that is sitting there silently
 * receiving - a passive connection sends no frames and so re-asks nothing. Getting only the first
 * is the defect proved on 2026-08-08, where a shut-off account kept receiving club chat in real
 * time indefinitely.
 *
 * Through the outbox rather than an immediate publish, for ADR-0006's reason: the event commits
 * with the block, so no crash can leave an account suspended with its sockets still attached.
 *
 * **Nobody is notified.** They cannot sign in to read an inbox row, and naming a suspension in a
 * push is the confrontational shape ADR-0021 already rejected for bans. The door tells them.
 */
export async function setAccountSuspended(
  db: Db,
  ctx: AccessContext,
  subjectUserId: string,
  suspended: boolean,
  opts: { messageId?: string | undefined } = {},
): Promise<ModerationResult<{ suspended: boolean; changed: boolean }>> {
  const rows = await db.execute<{
    id: string;
    is_platform_moderator: boolean;
    anonymized: boolean;
    blocked: boolean;
  }>(sql`
    SELECT id::text AS id,
           is_platform_moderator,
           (anonymized_at IS NOT NULL) AS anonymized,
           (signin_blocked_at IS NOT NULL) AS blocked
      FROM users
     WHERE id = ${subjectUserId}
  `);
  const subject = rows.rows[0];
  if (!subject) return { ok: false, code: 'not_found' };

  const ref = {
    userId: subject.id,
    isPlatformModerator: subject.is_platform_moderator,
    isAnonymized: subject.anonymized,
  };

  /*
   * Two predicates, not one with a flag. Imposing follows a ladder and lifting deliberately does
   * not - the same asymmetry ADR-0021 chose for club bans, because a wrongful ejection has to be
   * cheaper to reverse than to perform.
   *
   * `not_found` rather than `forbidden` on refusal, matching every other refusal in this API: a
   * caller with no standing learns nothing, including whether the account exists.
   */
  const allowed = suspended
    ? canSuspendAccount(ctx, ref)
    : canReinstateAccount(ctx, ref);
  if (!allowed) return { ok: false, code: 'not_found' };

  // Already in the requested state. Reported rather than repeated, so the audit trail carries
  // acts rather than clicks.
  if (subject.blocked === suspended) {
    return { ok: true, suspended, changed: false };
  }

  /*
   * Every channel they can currently reach, captured BEFORE anything changes.
   *
   * Read through `accessibleChannelPredicate` rather than a hand-written join, because "which
   * channels can this person reach" has exactly one definition and writing a seventh copy of it
   * is the mistake that hid race chat for an entire phase (failure mode 9).
   */
  const reachable = suspended
    ? await db.execute<{ id: string }>(sql`
        SELECT c.id::text AS id FROM channels c WHERE ${accessibleChannelPredicate(subjectUserId)}
      `)
    : { rows: [] as Array<{ id: string }> };
  const channelIds = reachable.rows.map((row) => row.id);

  await db.transaction(async (tx) => {
    if (suspended) {
      if (channelIds.length > 0) {
        await tx.insert(outbox).values({
          partitionKey: subjectUserId,
          eventType: 'account.suspended',
          payload: { userId: subjectUserId, channelIds },
        });
      }
      await tx.execute(sql`
        UPDATE users SET signin_blocked_at = now() WHERE id = ${subjectUserId}
      `);
      /*
       * The sessions go too. The block alone is enough - `isSessionUsable` re-asks on every
       * request - but leaving rows in the table that look valid is the state that made the
       * 2026-08-08 defect so hard to see. Reinstatement means signing in again, which is the
       * honest outcome anyway.
       */
      await tx.execute(sql`DELETE FROM sessions WHERE user_id = ${subjectUserId}`);
    } else {
      await tx.execute(sql`
        UPDATE users SET signin_blocked_at = NULL WHERE id = ${subjectUserId}
      `);
    }

    await tx.insert(moderationActions).values({
      moderatorId: ctx.userId,
      action: suspended ? 'suspend' : 'reinstate',
      subjectUserId,
      // The report that prompted it, when there is one. Evidence in place of a free-text
      // reason - see the table's own note, and ADR-0021 for why prose was rejected.
      messageId: opts.messageId ?? null,
    });
  });

  return { ok: true, suspended, changed: true };
}

/**
 * Remove a reported message.
 *
 * > **The "removing the content" half of guideline 1.2**, and the only place in the product where
 * > somebody deletes a message they neither sent nor hold admin standing over.
 *
 * It is not the participant power `PRD/14` withholds. That matrix says no *participant* may delete
 * the other's message and it still says so; this is a platform action, gated on
 * `canRemoveReportedMessage`, scoped to `dm`, and resolved **through `message_reports`** so there
 * is no door to a conversation nobody complained about.
 *
 * A soft delete with a tombstone, exactly like every other delete in the product: domain invariant
 * 7, and the reason is the same one that makes it a tombstone for an admin - a message vanishing
 * from the middle of a conversation makes the replies unreadable. Reactions and pin state clear
 * with it, and the change travels on `msg.update` and bumps the channel revision so a client that
 * was offline learns about it rather than showing the words indefinitely.
 */
export async function removeReportedMessage(
  db: Db,
  ctx: AccessContext,
  messageId: string,
): Promise<ModerationResult<{ channelId: string; seq: number }>> {
  const located = await db.execute<{ channel_id: string; seq: number; deleted: boolean }>(sql`
    SELECT m.channel_id::text AS channel_id, m.seq, (m.deleted_at IS NOT NULL) AS deleted
      FROM message_reports r
      JOIN messages m ON m.id = r.message_id
     WHERE r.message_id = ${messageId}
     LIMIT 1
  `);
  const target = located.rows[0];
  // No such REPORT, not merely no such message. Same rule as `readReportedContext`.
  if (!target) return { ok: false, code: 'not_found' };

  const channel = await getChannelRef(db, target.channel_id);
  if (!channel || !canRemoveReportedMessage(ctx, channel)) {
    return { ok: false, code: 'not_found' };
  }

  const seq = Number(target.seq);
  // Already a tombstone. Answered as success because the outcome the moderator wanted is true,
  // and without a second audit row for an act that changed nothing.
  if (target.deleted) return { ok: true, channelId: channel.id, seq };

  /*
   * The tombstone and the audit row in ONE transaction, which is why `applySoftDelete` takes a
   * transaction rather than opening its own. An audit written afterwards can be skipped by a
   * failure between the two, and "the content was removed" with no record of who removed it is
   * the half that matters least.
   */
  const removed = await db.transaction(async (tx) => {
    const row = await applySoftDelete(tx, channel.id, seq, messageId);
    if (!row) return null;

    await tx.insert(moderationActions).values({
      moderatorId: ctx.userId,
      action: 'remove_message',
      subjectUserId: null,
      messageId,
    });
    return row;
  });

  if (!removed) return { ok: false, code: 'not_found' };
  return { ok: true, channelId: channel.id, seq };
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
