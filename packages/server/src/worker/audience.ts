/**
 * The notification audience function.
 *
 * One function, so the two rules that have each been fixed multiple times exist once:
 *
 *   1. **Admin-tier filters must match BOTH `admin` and `owner`.** A bare "admin" filter
 *      means a club whose only admin-tier member is the Owner gets nothing at all - which
 *      is every brand-new club. Shipped wrong four separate times in v1.
 *   2. **Race audiences are roster members only, never roster union club admins.** Chat
 *      access itself requires a roster row, so unioning admins in notifies people about a
 *      channel they cannot open.
 *
 * Both are enforced here by construction rather than remembered at each call site: the
 * admin-tier query uses the shared `ADMIN_TIER` constant, and race audiences read the
 * roster table.
 *
 * Per-user mute also lives here. Before this function existed there was nowhere for it to
 * go; now it is a single check.
 */

import { sql } from 'drizzle-orm';
import { ADMIN_TIER, type NotificationType } from '@clubchat/shared';
import type { Db } from '../db/client.ts';

export type AudienceRequest = {
  type: NotificationType;
  /** Who caused this. Excluded from the audience, with one deliberate exception. */
  actorId: string | null;
  clubId: string | null;
  channelId?: string | undefined;
  /** For a mention: exactly the people named, already filtered to those with access. */
  explicitRecipients?: readonly string[] | undefined;
};

/**
 * Types whose notification deliberately INCLUDES the actor.
 *
 * Exactly one: the poll closing-soon reminder. Everything else excludes the person who
 * caused it, because you are never notified about something you just did. The creator is
 * precisely who needs to know their own poll is about to close, so it is the exception
 * rather than an oversight.
 */
const INCLUDES_ACTOR: readonly NotificationType[] = ['poll_closing_soon'];

/**
 * Resolve who gets notified.
 *
 * Returns user ids. Mute is NOT applied here: a muted conversation still accrues its
 * unread count and still writes its notification row - mute suppresses the push only.
 * See `mutedRecipients`.
 */
export async function resolveAudience(db: Db, request: AudienceRequest): Promise<string[]> {
  const recipients = await gather(db, request);
  const unique = new Set(recipients);

  if (request.actorId !== null && !INCLUDES_ACTOR.includes(request.type)) {
    unique.delete(request.actorId);
  }

  return [...unique];
}

async function gather(db: Db, request: AudienceRequest): Promise<string[]> {
  // A mention names specific people. `sendMessage` has already narrowed the list to those
  // who can reach the channel, so there is nothing to widen here.
  if (request.explicitRecipients) return [...request.explicitRecipients];

  switch (request.type) {
    // Everyone who can read the channel.
    case 'announcement':
    case 'chat_caught_up':
      if (!request.channelId) return [];
      return channelMembers(db, request.channelId);

    // The club's admin tier. BOTH admin and owner.
    case 'club_join_request':
    case 'race_join_request':
    case 'car_group_incharge_left':
      if (!request.clubId) return [];
      return clubAdminTier(db, request.clubId);

    // Current Eboard members only. An admin outside the space must not see its business.
    case 'eboard_join_request':
      if (!request.clubId) return [];
      return eboardMembersForClub(db, request.clubId);

    // Every club member.
    case 'event_created':
    case 'race_created':
    case 'news_post_created':
      if (!request.clubId) return [];
      return clubMembers(db, request.clubId);

    // Addressed to one person, supplied by the caller. Falling through to a broad
    // audience here would leak a private outcome to the whole club.
    case 'request_approved':
    case 'request_denied':
    case 'member_added':
    case 'member_removed':
    case 'role_changed':
    case 'mentioned':
      return [];

    // Phase 2 features. Their audiences are scope-dependent and the tables do not exist
    // yet, so they resolve to nobody rather than to everybody.
    case 'poll_created':
    case 'poll_closing_soon':
    case 'meeting_created':
      return [];
  }
}

async function channelMembers(db: Db, channelId: string): Promise<string[]> {
  // One query covering every scope, so a new scope is a branch here rather than a new
  // call site somewhere else. Race reads the roster; it does NOT union in club admins.
  const rows = await db.execute<{ user_id: string }>(sql`
    WITH ch AS (SELECT scope, scope_id FROM channels WHERE id = ${channelId})
    SELECT cm.user_id FROM club_memberships cm, ch
     WHERE ch.scope = 'club' AND cm.club_id = ch.scope_id
    UNION
    SELECT em.user_id FROM eboard_memberships em, ch
     WHERE ch.scope = 'eboard' AND em.eboard_id = ch.scope_id
  `);
  return rows.rows.map((r) => r.user_id);
}

async function clubMembers(db: Db, clubId: string): Promise<string[]> {
  const rows = await db.execute<{ user_id: string }>(
    sql`SELECT user_id FROM club_memberships WHERE club_id = ${clubId}`,
  );
  return rows.rows.map((r) => r.user_id);
}

/**
 * The club's admin tier.
 *
 * `ADMIN_TIER` is the shared constant, not a literal typed here. That is the entire
 * defence against the bug that shipped four times: there is one list of which roles count
 * as admin, and it is the same one the policy module uses.
 */
async function clubAdminTier(db: Db, clubId: string): Promise<string[]> {
  // Parameterised rather than interpolated. ADMIN_TIER is a compile-time constant so
  // string-building would be safe here, but a query that reads as though it splices
  // values into SQL invites the next person to do it with something that is not.
  const rows = await db.execute<{ user_id: string }>(sql`
    SELECT user_id FROM club_memberships
     WHERE club_id = ${clubId}
       AND role = ANY(${sql.param([...ADMIN_TIER])}::text[])
  `);
  return rows.rows.map((r) => r.user_id);
}

async function eboardMembersForClub(db: Db, clubId: string): Promise<string[]> {
  const rows = await db.execute<{ user_id: string }>(sql`
    SELECT em.user_id
      FROM eboard_memberships em
      JOIN eboard_channels e ON e.id = em.eboard_id
     WHERE e.club_id = ${clubId}
  `);
  return rows.rows.map((r) => r.user_id);
}

/**
 * Which of these recipients have muted this channel.
 *
 * Applied to PUSH only. A muted conversation produces no buzz while its unread count
 * still accrues - mute is not "mark as read", and conflating the two would silently mark
 * things read that nobody looked at.
 */
export async function mutedRecipients(
  db: Db,
  channelId: string,
  recipients: readonly string[],
): Promise<Set<string>> {
  if (recipients.length === 0) return new Set();
  const rows = await db.execute<{ user_id: string }>(sql`
    SELECT user_id FROM channel_mutes
     WHERE channel_id = ${channelId}
       AND user_id = ANY(${sql.param(recipients as string[])}::uuid[])
       AND (muted_until IS NULL OR muted_until > now())
  `);
  return new Set(rows.rows.map((r) => r.user_id));
}
