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
import { muteInForce } from '../db/sql-helpers.ts';
import {
  channelAudienceById,
  channelModerationAudienceById,
  platformModerators,
} from '../domain/channel-access.ts';

export type AudienceRequest = {
  type: NotificationType;
  /** Who caused this. Excluded from the audience, with one deliberate exception. */
  actorId: string | null;
  clubId: string | null;
  channelId?: string | undefined;
  /** Required by the two race-scoped types, which resolve against that race's roster. */
  raceId?: string | undefined;
  /** For a mention: exactly the people named, already filtered to those with access. */
  explicitRecipients?: readonly string[] | undefined;
};

/**
 * Types whose notification deliberately INCLUDES the actor.
 *
 * Two. Everything else excludes the person who caused it, because you are never notified about
 * something you just did.
 *
 *  - `poll_closing_soon` - the creator is precisely who needs to know their own poll is closing.
 *  - `meetup_nudged` - **a nudge is a broadcast, and the sender is in the room.** An admin who
 *    rings the bell and receives nothing cannot tell whether it went out at all, and the only
 *    other evidence is asking a member. Reported from the device on 2026-08-14 in exactly those
 *    terms. It is also the one notification whose whole purpose is to be seen arriving.
 */
const INCLUDES_ACTOR: readonly NotificationType[] = ['poll_closing_soon', 'meetup_nudged'];

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
    /*
     * Everyone who can read the channel. For a dm that is exactly two people, and the actor
     * is removed above - so a dm_message resolves to the single recipient without needing a
     * scope-specific branch.
     *
     * `chat_message` sits here rather than with the club-wide types, and the distinction is
     * load-bearing for the two non-club scopes: a race channel's audience is its ROSTER and the
     * Eboard's is its members, neither of which is "the club". Resolving a race chat message
     * against `clubMembers` would buzz every member of the club about a conversation they
     * cannot open - which is rule 2 at the top of this file, and the reason that rule is
     * enforced by which function a case calls rather than by remembering it.
     */
    case 'announcement':
    case 'chat_caught_up':
    case 'dm_message':
    case 'chat_message':
      if (!request.channelId) return [];
      return channelAudienceById(db, request.channelId);

    /*
     * Whoever reviews reports in that channel.
     *
     * NOT `clubAdminTier`, even though it is the same people for a club channel: a race channel
     * is reviewed by roster members who are also club admins, and a DM has no admin at all - its
     * reviewers are platform moderators, who belong to no club and could never be reached by a
     * club query. One function answers all four, and it is the list form of the same predicate
     * that decides who may open the queue. See `channelModerationAudienceById`.
     */
    case 'message_reported':
      if (!request.channelId) return [];
      return channelModerationAudienceById(db, request.channelId);

    /*
     * Every platform moderator, with no channel to narrow it and no club to widen it.
     *
     * The type above resolves through a scope switch because a message belongs to a room; a person
     * belongs to none, and the club the reporter happened to be looking at is not a routing key -
     * a report filed from a direct message would land on a club admin's desk, which PRD/14 rule 7
     * refuses. One audience, always. See ADR-0035.
     *
     * The reporter is dropped by `resolveAudience` like every other actor, which is what handles a
     * moderator reporting somebody themselves.
     */
    case 'user_reported':
      return platformModerators(db);

    // The club's admin tier. BOTH admin and owner.
    case 'club_join_request':
      if (!request.clubId) return [];
      return clubAdminTier(db, request.clubId);

    /*
     * The admins ON that race's roster, which is narrower than the club's admin tier and
     * deliberately so.
     *
     * Rule 2 at the top of this file already said race audiences are roster members only; these
     * two types were the ones still resolving to every club admin, so an owner running none of
     * the races got every race's join requests and every stranded car group in the club.
     *
     * **Since 2026-08-12 this is also exactly who may decide.** `canManageRace` used to be every
     * club admin, so this audience was narrower than the permission and an off-roster admin could
     * approve a request nothing had paged them about. Management is now roster-gated too
     * (`isRaceManager`), and the two finally describe the same set of people.
     *
     * When a roster has no admin left on it this resolves to nobody, and the request waits rather
     * than widening to people who are not involved. That is the founder's call, and the way out is
     * the Owner walking onto the roster (`canJoinRaceDirectly`) and sorting it out. Recorded here
     * because "notifies nobody" looks like a bug to anyone reading it cold.
     */
    case 'race_join_request':
    case 'car_group_incharge_left':
      if (!request.raceId) return [];
      return raceRosterAdmins(db, request.raceId);

    // Current Eboard members only. An admin outside the space must not see its business.
    case 'eboard_join_request':
      if (!request.clubId) return [];
      return eboardMembersForClub(db, request.clubId);

    // Every club member.
    //
    // `meetup_nudged` sits here rather than anywhere narrower on purpose: a nudge is an admin
    // telling the CLUB about a meetup, so its audience is the club. The actor is removed above
    // with everybody else's - you are not notified about something you just did.
    case 'event_created':
    case 'race_created':
    case 'news_post_created':
    /*
     * `news_post_tagged` names specific people, so it looks like it belongs in the
     * explicit-recipients group below. It is here because the caller does NOT use it as the
     * audience: it intersects the named list with this one, which is what removes somebody who
     * was named and has since left the club. Returning `[]` here would make that intersection
     * empty and silently notify nobody.
     */
    case 'news_post_tagged':
    case 'meetup_nudged':
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

/**
 * The admin-tier members who hold a roster row on this race.
 *
 * The intersection of two facts, and it has to be a join rather than two queries and a filter:
 * roster membership lives on the race, admin-tier lives on the club, and the race knows which
 * club it belongs to. Uses the same `ADMIN_TIER` constant as `clubAdminTier` for the same
 * reason - one list of which roles count as admin, not two that can drift apart.
 */
async function raceRosterAdmins(db: Db, raceId: string): Promise<string[]> {
  const rows = await db.execute<{ user_id: string }>(sql`
    SELECT rm.user_id
      FROM race_memberships rm
      JOIN races r ON r.id = rm.race_id
      JOIN club_memberships cm ON cm.club_id = r.club_id AND cm.user_id = rm.user_id
     WHERE rm.race_id = ${raceId}::uuid
       AND cm.role = ANY(${sql.param([...ADMIN_TIER])}::text[])
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
       AND ${muteInForce()}
  `);
  return new Set(rows.rows.map((r) => r.user_id));
}
