/**
 * Direct messages, and the safety tooling that ships with them.
 *
 * The conversation itself is thin, and that is the point: a DM is `scope = 'dm'` on the
 * existing channel abstraction, so sequencing, sync, cursors, unread counts, pins, reactions,
 * the gallery, media and push fan-out all carry over untouched (ADR-0009). What is genuinely
 * new is only what this file holds - the pair table, the eligibility rule, blocking, and mute.
 *
 * > **Blocking, mute and the report queue ship in the same release as DMs, not after it.**
 * >
 * > ADR-0009 records that as a safety decision rather than a scheduling preference: a private
 * > one-to-one channel with no admin party to it, no block, and nowhere for a report to go is a
 * > materially different risk class in a product that will include minors. The window between
 * > shipping DMs and shipping blocking is precisely when that risk exists, and there is no way
 * > to know in advance how long that window lasts.
 */

import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { channelMutes, memberBlocks } from '../db/schema.ts';
import { channelDisplayName, channelNameJoins } from './channel-access.ts';
import type { AccessContext } from '../policy/context.ts';
import {
  canBlock,
  canMuteChannel,
  canOpenDm,
  canPinInChannel,
  canReadReports,
  canPostInChannel,
  canUnblock,
  dmThreadWith,
  isChannelMember,
  type ChannelRef,
  type DmCandidate,
} from '../policy/predicates.ts';

/** Just the surface the upsert helper needs, so it takes a transaction as readily as a pool. */
type Executor = Pick<Db, 'execute'>;

export type DmRefusal = { ok: false; code: 'forbidden' | 'not_found' | 'invalid' };
export type DmResult<T> = ({ ok: true } & T) | DmRefusal;

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

/**
 * Load a person as a DM candidate: do they exist, and which clubs are they in?
 *
 * Returns null for a user who does not exist **or** has been anonymised. A deleted account's
 * history stays readable, but nobody may start a new conversation with it.
 */
async function loadCandidate(db: Db, userId: string): Promise<DmCandidate | null> {
  const rows = await db.execute<{ id: string; club_ids: string[] | null }>(sql`
    SELECT u.id::text AS id,
           ARRAY(
             SELECT cm.club_id::text FROM club_memberships cm WHERE cm.user_id = u.id
           ) AS club_ids
      FROM users u
     WHERE u.id = ${userId}
       AND u.anonymized_at IS NULL
  `);
  const row = rows.rows[0];
  if (!row) return null;
  return { userId: row.id, clubIds: row.club_ids ?? [] };
}

/**
 * People this member may open a conversation with, filtered by name.
 *
 * > **Search is UX; `openDm` is enforcement.** This query exists so the picker offers the
 * > right people, and `openDm` re-checks `canOpenDm` on the actual attempt. A client that
 * > edited the payload to name somebody outside its clubs gets refused there, not here.
 *
 * The shared-club join IS the eligibility rule and has no other SQL home - there is
 * deliberately **no global user search** (PRD/14 rule 1), so this is not a general people
 * search with a filter bolted on. The block exclusion, by contrast, reuses the symmetric set
 * the access context already loaded rather than restating the two-directional join, so there
 * is still exactly one definition of "blocked".
 */
export async function searchDmCandidates(
  db: Db,
  ctx: AccessContext,
  opts: { query?: string | undefined; limit?: number | undefined } = {},
): Promise<Array<{ userId: string; name: string }>> {
  const limit = Math.min(opts.limit ?? 25, 100);
  const query = (opts.query ?? '').trim();
  const blocked = [...ctx.blockedEither];

  const rows = await db.execute<{ id: string; full_name: string }>(sql`
    SELECT DISTINCT u.id::text AS id, u.full_name
      FROM users u
      JOIN club_memberships theirs ON theirs.user_id = u.id
     WHERE theirs.club_id IN (SELECT club_id FROM club_memberships WHERE user_id = ${ctx.userId})
       AND u.id <> ${ctx.userId}
       AND u.anonymized_at IS NULL
       ${query.length > 0 ? sql`AND u.full_name ILIKE ${'%' + query + '%'}` : sql``}
       -- A blocked member is absent from the blocker's results AND the blocker is absent from
       -- theirs: "no result, indistinguishable from no such member". The parameter is the same
       -- symmetric set every predicate reads.
       ${blocked.length > 0 ? sql`AND u.id <> ALL(${sql.param(blocked)}::uuid[])` : sql``}
     ORDER BY u.full_name
     LIMIT ${limit}
  `);

  return rows.rows.map((row) => ({ userId: row.id, name: row.full_name }));
}

// ---------------------------------------------------------------------------
// Opening a thread
// ---------------------------------------------------------------------------

/**
 * Sort a pair into the canonical order the database insists on.
 *
 * `dm_conversations` carries `CHECK (user_a < user_b)` so that `(alice, bob)` and
 * `(bob, alice)` cannot both exist and defeat the unique constraint. Postgres compares `uuid`
 * as its 16 raw bytes; lowercase hex compares identically byte for byte, because the digits
 * `0-9` and letters `a-f` sort in the same order as the values they denote. **Lowercasing
 * first is therefore not cosmetic** - an uppercase input would sort before every lowercase one
 * and produce a pair the check rejects.
 */
export function canonicalPair(x: string, y: string): [string, string] {
  const a = x.toLowerCase();
  const b = y.toLowerCase();
  return a < b ? [a, b] : [b, a];
}

/**
 * Open, or re-open, the conversation with someone.
 *
 * **Idempotent.** There is exactly one thread per pair of people, ever, so calling this twice
 * returns the same conversation and the same channel rather than erroring - which also means
 * the client never has to ask "do we already have a thread" before navigating.
 *
 * > **Every refusal is `not_found`, and that is the security requirement rather than
 * > laziness.** A blocked member searching for the person who blocked them must get "no
 * > result, indistinguishable from no such member" (PRD/14 edge case). If blocking returned a
 * > distinguishable code, the block would be detectable by anyone willing to call the endpoint,
 * > which defeats the whole point of hiding it. Nonexistent, ineligible and blocked all look
 * > identical from outside.
 *
 * No system message and no notification. PRD/14 rule 4 removes system messages from the
 * scope, and opening a thread is not itself a message - the first thing the other person
 * hears about it is the first thing actually said.
 */
export async function openDm(
  db: Db,
  ctx: AccessContext,
  otherUserId: string,
): Promise<DmResult<{ conversationId: string; channelId: string; otherUserId: string }>> {
  if (otherUserId === ctx.userId) return { ok: false, code: 'invalid' };

  const candidate = await loadCandidate(db, otherUserId);
  if (!candidate || !canOpenDm(ctx, candidate)) return { ok: false, code: 'not_found' };

  const [userA, userB] = canonicalPair(ctx.userId, otherUserId);

  const created = await db.transaction(async (tx) => {
    const conversationId = await upsertReturningId(
      tx,
      sql`
        INSERT INTO dm_conversations (user_a, user_b) VALUES (${userA}, ${userB})
        ON CONFLICT (user_a, user_b) DO NOTHING
        RETURNING id::text AS id
      `,
      sql`SELECT id::text AS id FROM dm_conversations
           WHERE user_a = ${userA} AND user_b = ${userB}`,
    );

    // club_id is NULL, which `CHECK ((club_id IS NULL) = (scope = 'dm'))` requires: two people
    // who share two clubs must get one thread, so a DM cannot belong to a club.
    const channelId = await upsertReturningId(
      tx,
      sql`
        INSERT INTO channels (club_id, scope, scope_id)
        VALUES (NULL, 'dm', ${conversationId})
        ON CONFLICT (scope, scope_id) DO NOTHING
        RETURNING id::text AS id
      `,
      sql`SELECT id::text AS id FROM channels
           WHERE scope = 'dm' AND scope_id = ${conversationId}`,
    );

    return { conversationId, channelId };
  });

  return { ok: true, ...created, otherUserId };
}

/**
 * Insert-if-absent, then read back the id.
 *
 * > **Two statements, deliberately, rather than one clever CTE.**
 * >
 * > The tempting one-statement form wraps the insert in a CTE and `UNION ALL`s it with a
 * > select of the existing row. It is subtly wrong: a statement holds ONE snapshot, so if a
 * > concurrent transaction inserts the row and commits, `ON CONFLICT DO NOTHING` waits for it
 * > and returns nothing while the select half still cannot see the newly committed row - and
 * > the whole statement yields no id at all. Two statements each take a fresh snapshot under
 * > READ COMMITTED, so the second one sees what the first one collided with.
 */
async function upsertReturningId(
  tx: Executor,
  insert: SQL,
  select: SQL,
): Promise<string> {
  const inserted = await tx.execute<{ id: string }>(insert);
  const fresh = inserted.rows[0]?.id;
  if (fresh) return fresh;

  const existing = await tx.execute<{ id: string }>(select);
  const id = existing.rows[0]?.id;
  if (!id) throw new Error('upsert produced neither an inserted nor an existing row');
  return id;
}

// ---------------------------------------------------------------------------
// The thread list
// ---------------------------------------------------------------------------

export type DmThreadSummary = {
  conversationId: string;
  channelId: string;
  otherUserId: string;
  otherName: string;
  unread: number;
  /** Writable now: still share a club, and no block in either direction. */
  canPost: boolean;
  muted: boolean;
  lastMessage: { body: string | null; seq: number; createdAt: string } | null;
};

/**
 * This member's conversations, most recently active first.
 *
 * A blocked thread and a read-only thread both still appear here, with `canPost: false`.
 * Blocking does not delete the conversation and losing the last shared club does not either -
 * history stays readable in both cases, which is the same principle as a message never being
 * hard-deleted.
 */
export async function listDmThreads(db: Db, ctx: AccessContext): Promise<DmThreadSummary[]> {
  const rows = await db.execute<{
    conversation_id: string;
    channel_id: string;
    other_user_id: string;
    other_name: string;
    unread: number;
    muted: boolean;
    last_body: string | null;
    last_seq: number | null;
    last_at: string | null;
  }>(sql`
    SELECT d.id::text AS conversation_id,
           ch.id::text AS channel_id,
           peer.id::text AS other_user_id,
           peer.full_name AS other_name,
           GREATEST(ch.last_seq - COALESCE(rc.last_read_seq, 0), 0) AS unread,
           (mute.user_id IS NOT NULL) AS muted,
           last.body AS last_body,
           last.seq AS last_seq,
           last.created_at::text AS last_at
      FROM dm_conversations d
      JOIN channels ch ON ch.scope = 'dm' AND ch.scope_id = d.id
      JOIN users peer
        ON peer.id = CASE WHEN d.user_a = ${ctx.userId} THEN d.user_b ELSE d.user_a END
      LEFT JOIN read_cursors rc ON rc.channel_id = ch.id AND rc.user_id = ${ctx.userId}
      LEFT JOIN channel_mutes mute
             ON mute.channel_id = ch.id
            AND mute.user_id = ${ctx.userId}
            AND (mute.muted_until IS NULL OR mute.muted_until > now())
      LEFT JOIN LATERAL (
        SELECT m.body, m.seq, m.created_at
          FROM messages m
         WHERE m.channel_id = ch.id
         ORDER BY m.seq DESC
         LIMIT 1
      ) last ON true
     WHERE d.user_a = ${ctx.userId} OR d.user_b = ${ctx.userId}
     ORDER BY COALESCE(last.created_at, d.created_at) DESC
  `);

  return rows.rows.map((row) => ({
    conversationId: row.conversation_id,
    channelId: row.channel_id,
    otherUserId: row.other_user_id,
    otherName: row.other_name,
    unread: Number(row.unread),
    // From the policy module, not recomputed in SQL. The context already knows whether the
    // pair shares a club and whether either has blocked the other.
    canPost: canPostInChannel(ctx, {
      id: row.channel_id,
      scope: 'dm',
      clubId: null,
      scopeId: row.conversation_id,
    }),
    muted: row.muted,
    lastMessage:
      row.last_seq === null
        ? null
        : {
            // Null for a soft-deleted message, because deletion nulls the body. A thread list
            // must not resurrect the text of something that was deleted.
            body: row.last_body,
            seq: Number(row.last_seq),
            createdAt: new Date(row.last_at ?? '').toISOString(),
          },
  }));
}

// ---------------------------------------------------------------------------
// Channel metadata: what to call it, and whether the composer is live
// ---------------------------------------------------------------------------

/**
 * Why the composer is disabled.
 *
 * > **`unavailable` deliberately conflates "they blocked you" with "you no longer share a
 * > club", and that resolves an open question in PRD/14 in the non-disclosing direction.**
 * >
 * > The PRD asks whether blocking should be reciprocal-visible or silent to the blocked party,
 * > while also requiring that a disabled composer state its reason. Both hold if the stated
 * > reason does not identify which of the two happened: the member learns they cannot send,
 * > which is what they need, and not that they were specifically blocked, which is what rule 6
 * > keeps quiet everywhere else (search, notifications).
 * >
 * > `you_blocked_them` is safe to distinguish because it reports the viewer's own action back
 * > to them, and it has to be distinguished - "unblock to send" is not an offer the neutral
 * > message can make.
 */
export type PostDeniedReason = 'you_blocked_them' | 'unavailable';

export type ChannelMeta = {
  channelId: string;
  scope: ChannelRef['scope'];
  name: string;
  /**
   * The scope this channel belongs to, and the club that owns it.
   *
   * > **Returned so the chat screen's header quick-nav can exist at all.** PRD/15 hangs Members,
   * > Polls, Meet Information and Meetings off chat's header, because chat is the home screen of a
   * > race and of an Eboard space - and every one of those is addressed by the SCOPE, not by the
   * > channel. Without these two ids the client would have to keep a channel-to-scope map of its
   * > own, which is a second copy of a fact the channel row already holds.
   *
   * `clubId` is null for a dm, which is the one scope that belongs to no club.
   */
  scopeId: string;
  clubId: string | null;
  canPost: boolean;
  postDeniedReason: PostDeniedReason | null;
  canPin: boolean;
  /**
   * May this viewer read the reports raised here?
   *
   * Carried so the Highlights screen can decide whether to OFFER the Reports tab, rather than
   * offering it and letting the read fail. A tab that always errors is not a leak - the refusal
   * still holds - but it tells a member a thing exists that they will never see, and PRD/18 says
   * reports reach only admins.
   *
   * `canReadReports`, not a re-derivation: it is false for a club member, true for that space's
   * admins, and for a **dm** it is the platform-moderator bit rather than either participant -
   * which is precisely why the client must not compute it from `canPin`.
   */
  canReadReports: boolean;
  muted: boolean;
  /** Present for a dm, so the client can offer block, unblock and report. */
  peer: { userId: string; name: string; blockedByMe: boolean } | null;
};

/**
 * Everything a chat screen needs before it renders: a title, and whether to enable the
 * composer.
 *
 * One endpoint for all four scopes rather than a DM-specific one, so the chat screen stays a
 * single implementation - PRD/05 rule 1, which DMs must not fork.
 */
export async function readChannelMeta(
  db: Db,
  ctx: AccessContext,
  channelId: string,
): Promise<DmResult<ChannelMeta>> {
  const rows = await db.execute<{
    id: string;
    scope: string;
    club_id: string | null;
    scope_id: string;
    name: string;
    muted: boolean;
    peer_id: string | null;
    peer_name: string | null;
    blocked_by_me: boolean;
  }>(sql`
    SELECT c.id::text AS id,
           c.scope,
           c.club_id::text AS club_id,
           c.scope_id::text AS scope_id,
           -- The shared fragments, not a fifth hand-written copy. Writing one here is how the
           -- COALESCE ordering bug got into four places to begin with.
           ${channelDisplayName()} AS name,
           (mute.user_id IS NOT NULL) AS muted,
           peer.id::text AS peer_id,
           peer.full_name AS peer_name,
           -- Asymmetric ON PURPOSE, and read here rather than from the access context. The
           -- context's block set is symmetric because every PREDICATE must treat both
           -- directions alike; this is a display fact ("you blocked them, so you can unblock
           -- them") and never feeds an authorization decision.
           EXISTS (
             SELECT 1 FROM member_blocks b
              WHERE b.blocker_id = ${ctx.userId} AND b.blocked_id = peer.id
           ) AS blocked_by_me
      FROM channels c
      ${channelNameJoins(ctx.userId)}
      LEFT JOIN channel_mutes mute
             ON mute.channel_id = c.id
            AND mute.user_id = ${ctx.userId}
            AND (mute.muted_until IS NULL OR mute.muted_until > now())
     WHERE c.id = ${channelId}
  `);

  const row = rows.rows[0];
  if (!row) return { ok: false, code: 'not_found' };

  const channel: ChannelRef = {
    id: row.id,
    scope: row.scope as ChannelRef['scope'],
    clubId: row.club_id,
    scopeId: row.scope_id,
  };

  // Nothing back for a channel this member cannot read, including whether it exists.
  if (!isChannelMember(ctx, channel)) return { ok: false, code: 'not_found' };

  const canPost = canPostInChannel(ctx, channel);

  return {
    ok: true,
    channelId: row.id,
    scope: channel.scope,
    name: row.name,
    scopeId: channel.scopeId,
    clubId: channel.clubId,
    canPost,
    postDeniedReason: canPost ? null : row.blocked_by_me ? 'you_blocked_them' : 'unavailable',
    canPin: canPinInChannel(ctx, channel),
    canReadReports: canReadReports(ctx, channel),
    muted: row.muted,
    peer:
      row.peer_id === null
        ? null
        : {
            userId: row.peer_id,
            name: row.peer_name ?? 'Someone',
            blockedByMe: row.blocked_by_me,
          },
  };
}

// ---------------------------------------------------------------------------
// Blocking
// ---------------------------------------------------------------------------

/**
 * Block someone.
 *
 * > **Instant, self-service, and needs no review.** The blocking path is deliberately separate
 * > from the reporting path: a member protecting themselves must never have to wait on a
 * > moderator (TECH/05).
 *
 * Writes no notification and emits no event. Two reasons, and both are requirements rather
 * than omissions:
 *
 *  - **The blocked party is not told.** PRD/14 rule 6 hides the block from search and stops
 *    notifications; announcing it would be the loudest possible disclosure.
 *  - **No subscription is revoked.** A block leaves history readable to both parties, so the
 *    live subscription stays valid - and since neither can send, there are no new messages for
 *    it to deliver. That is the opposite of the club-removal cascade, which must revoke
 *    because read access genuinely ends there.
 */
export async function blockMember(
  db: Db,
  ctx: AccessContext,
  otherUserId: string,
): Promise<DmResult<{ blocked: true }>> {
  if (otherUserId === ctx.userId) return { ok: false, code: 'invalid' };

  const candidate = await loadCandidate(db, otherUserId);
  // A thread with somebody counts even if no club is shared any more: their messages are still
  // sitting in history, so the ability to block them must not have lapsed with the club.
  const hasThreadWith = dmThreadWith(ctx, otherUserId) !== undefined;

  if (!candidate) {
    // No such user at all. Nothing to block, and nothing to disclose either.
    return { ok: false, code: 'not_found' };
  }
  if (!canBlock(ctx, { ...candidate, hasThreadWith })) return { ok: false, code: 'not_found' };

  await db
    .insert(memberBlocks)
    .values({ blockerId: ctx.userId, blockedId: otherUserId })
    // Blocking twice is a no-op. The button is idempotent because a double tap must not error.
    .onConflictDoNothing();

  return { ok: true, blocked: true };
}

/**
 * Unblock someone.
 *
 * The thread becomes writable again and **nothing is retroactively delivered** - anything the
 * other party tried to send while blocked was refused at the time, not held.
 */
export async function unblockMember(
  db: Db,
  ctx: AccessContext,
  otherUserId: string,
): Promise<DmResult<{ unblocked: true }>> {
  if (!canUnblock(ctx, otherUserId)) return { ok: false, code: 'invalid' };

  await db.execute(sql`
    DELETE FROM member_blocks
     WHERE blocker_id = ${ctx.userId} AND blocked_id = ${otherUserId}
  `);

  // Idempotent: unblocking somebody who was not blocked is a no-op, not an error.
  return { ok: true, unblocked: true };
}

/**
 * Who this member has blocked.
 *
 * **Their own blocks only, never the symmetric set.** Returning "people who have blocked you"
 * would hand the blocked party exactly the disclosure rule 6 exists to prevent.
 */
export async function listBlocks(
  db: Db,
  ctx: AccessContext,
): Promise<Array<{ userId: string; name: string; createdAt: string }>> {
  const rows = await db.execute<{ id: string; full_name: string; created_at: string }>(sql`
    SELECT u.id::text AS id, u.full_name, b.created_at::text AS created_at
      FROM member_blocks b
      JOIN users u ON u.id = b.blocked_id
     WHERE b.blocker_id = ${ctx.userId}
     ORDER BY b.created_at DESC
  `);
  return rows.rows.map((row) => ({
    userId: row.id,
    name: row.full_name,
    createdAt: new Date(row.created_at).toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// Mute
// ---------------------------------------------------------------------------

/**
 * Mute a conversation.
 *
 * > **Mute is not "mark as read".** No push notification, and the unread count still accrues.
 * > Conflating the two would silently mark things read that nobody looked at, and the whole
 * > reason someone mutes a busy conversation is to read it later on their own terms.
 *
 * Applies to **every** scope and not only to DMs. `channel_mutes` has existed since Phase 1
 * precisely so per-user mute had somewhere to live once the audience function existed; this is
 * the command that finally writes to it.
 */
export async function muteChannel(
  db: Db,
  ctx: AccessContext,
  channel: ChannelRef,
  until: Date | null,
): Promise<DmResult<{ muted: true; mutedUntil: string | null }>> {
  if (!canMuteChannel(ctx, channel)) return { ok: false, code: 'not_found' };

  await db
    .insert(channelMutes)
    .values({ userId: ctx.userId, channelId: channel.id, mutedUntil: until })
    .onConflictDoUpdate({
      target: [channelMutes.userId, channelMutes.channelId],
      // Re-muting with a new expiry replaces the old one rather than being ignored.
      set: { mutedUntil: until },
    });

  return { ok: true, muted: true, mutedUntil: until?.toISOString() ?? null };
}

export async function unmuteChannel(
  db: Db,
  ctx: AccessContext,
  channel: ChannelRef,
): Promise<DmResult<{ muted: false }>> {
  if (!canMuteChannel(ctx, channel)) return { ok: false, code: 'not_found' };

  await db.execute(sql`
    DELETE FROM channel_mutes
     WHERE user_id = ${ctx.userId} AND channel_id = ${channel.id}
  `);

  return { ok: true, muted: false };
}
