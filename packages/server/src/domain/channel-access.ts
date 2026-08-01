/**
 * "Which channels can this person reach", and "who can reach this channel", defined once.
 *
 * > **This module exists because the same predicate was restated four times and every copy
 * > was wrong in the same way.**
 * >
 * > `listAccessibleChannels`, `chatUnreadRows`, `badgeCount` and the notification audience
 * > each carried their own hand-written version of the membership join. Phase 2 shipped races
 * > with real chat channels and updated **none** of them, so a race member's chat never
 * > appeared in their channel list, never contributed an unread count or a badge, and an
 * > announcement in race chat notified nobody. Four separate places, one missing branch each,
 * > and no test could see it because every one of them was individually self-consistent.
 * >
 * > AGENTS.md states the rule this file enforces: *the same predicate restated in many places
 * > will eventually be restated wrongly*. Adding the `dm` scope to four copies would have been
 * > the same mistake a second time.
 *
 * Everything here is a fragment or a function over `channels`, and the SQL fragments assume
 * the table is aliased **`c`**. That is fixed rather than parameterised on purpose: splicing
 * an identifier into SQL to make it configurable would be a worse trade than one documented
 * convention, and all four call sites already used `c`.
 */

import { sql, type SQL } from 'drizzle-orm';
import { ADMIN_TIER } from '@clubchat/shared';
import type { Db } from '../db/client.ts';
import type { ChannelRef } from '../policy/predicates.ts';

/**
 * The read-access predicate, for every scope.
 *
 * The SQL twin of `isChannelMember`. It must stay in step with that predicate, and the pairing
 * is asserted directly in the Phase 3.5 suite: for a fabricated set of members, the rows this
 * returns and the users `isChannelMember` accepts have to be the same set.
 *
 * Note that the race branch reads `race_memberships` and does NOT union in club admins.
 * Management authority is not access, so an admin off the roster gets no channel, no unread
 * count and no notification for a chat they cannot open.
 */
export function accessibleChannelPredicate(userId: string): SQL {
  return sql`(
       (c.scope = 'club'
         AND c.club_id IN (SELECT club_id FROM club_memberships WHERE user_id = ${userId}))
    OR (c.scope = 'eboard'
         AND c.scope_id IN (SELECT eboard_id FROM eboard_memberships WHERE user_id = ${userId}))
    OR (c.scope = 'race'
         AND c.scope_id IN (SELECT race_id FROM race_memberships WHERE user_id = ${userId}))
    OR (c.scope = 'dm'
         AND c.scope_id IN (SELECT id FROM dm_conversations
                             WHERE user_a = ${userId} OR user_b = ${userId}))
  )`;
}

/**
 * The joins the display name needs. Pair with `channelDisplayName`.
 *
 * `peer` resolves the other participant of a DM, which is why this is parameterised by the
 * viewer: a conversation has no name of its own, only two people, and each of them sees the
 * other's.
 */
export function channelNameJoins(userId: string): SQL {
  return sql`
    LEFT JOIN clubs cl ON cl.id = c.club_id
    LEFT JOIN eboard_channels e ON c.scope = 'eboard' AND e.id = c.scope_id
    LEFT JOIN races r ON c.scope = 'race' AND r.id = c.scope_id
    LEFT JOIN dm_conversations d ON c.scope = 'dm' AND d.id = c.scope_id
    LEFT JOIN users peer
           ON peer.id = CASE WHEN d.user_a = ${userId} THEN d.user_b ELSE d.user_a END
  `;
}

/**
 * What to call a channel.
 *
 * > **The COALESCE order is load-bearing.** A race and an Eboard channel both carry a
 * > `club_id`, so `cl.name` is non-null for them too - putting the club first would title
 * > every race chat with the club's name, which is exactly what it did before this fragment
 * > existed. Most specific first.
 */
export function channelDisplayName(): SQL {
  return sql`COALESCE(peer.full_name, r.name, e.name, cl.name, 'ClubChat')`;
}

/**
 * What to show beside that name.
 *
 * > **A CASE on the scope, and emphatically NOT the COALESCE above.** This was written as a
 * > COALESCE first, to match its sibling, and it was wrong for a reason worth keeping: the names
 * > it coalesces are all `NOT NULL`, so the fall-through never fires - `r.name` always wins for a
 * > race. Pictures are nullable. A race with no picture of its own therefore fell straight through
 * > to `cl.image` and wore the club's face over its own name, which is the failure that looks most
 * > like success. Only a test with three DIFFERENT pictures, and a fourth case with none, tells
 * > the two apart.
 *
 * So the scope picks its own column and stops. `NULL` is a real answer here, meaning "no picture
 * set", and the client draws the initial of the name this pairs with - never the parent's face.
 */
export function channelDisplayImage(): SQL {
  return sql`
    CASE c.scope
      WHEN 'dm' THEN peer.image
      WHEN 'race' THEN r.image
      WHEN 'eboard' THEN e.image
      ELSE cl.image
    END`;
}

/**
 * Everyone who can read a channel.
 *
 * The inverse of `accessibleChannelPredicate` and the single definition of "who is in this
 * conversation", used by mention filtering and by the notification audience. One query
 * covering every scope, so a fifth scope is a branch here rather than a new call site
 * somewhere else.
 *
 * A DM resolves to exactly two people, and **blocking does not remove either of them**. That
 * is deliberate: a block stops new messages, and the audience of an existing message is still
 * both participants - the person who was blocked keeps their unread count and their history.
 */
export async function channelAudienceById(db: Db, channelId: string): Promise<string[]> {
  const rows = await db.execute<{ user_id: string }>(sql`
    WITH ch AS (SELECT scope, scope_id FROM channels WHERE id = ${channelId})
    SELECT cm.user_id FROM club_memberships cm, ch
     WHERE ch.scope = 'club' AND cm.club_id = ch.scope_id
    UNION
    SELECT em.user_id FROM eboard_memberships em, ch
     WHERE ch.scope = 'eboard' AND em.eboard_id = ch.scope_id
    UNION
    SELECT rm.user_id FROM race_memberships rm, ch
     WHERE ch.scope = 'race' AND rm.race_id = ch.scope_id
    UNION
    SELECT d.user_a FROM dm_conversations d, ch
     WHERE ch.scope = 'dm' AND d.id = ch.scope_id
    UNION
    SELECT d.user_b FROM dm_conversations d, ch
     WHERE ch.scope = 'dm' AND d.id = ch.scope_id
  `);
  return rows.rows.map((r) => r.user_id);
}

/** The same thing, when the caller already holds the channel. */
export const channelAudience = (db: Db, channel: ChannelRef): Promise<string[]> =>
  channelAudienceById(db, channel.id);

/**
 * Who reviews a report in this channel.
 *
 * The list form of `isChannelAdmin`, plus the one case that predicate answers `false` to. A DM
 * has no admin - PRD/14 rule 7 routes its reports to **platform moderators**, who are not members
 * of any club and could never be found by any membership query. That single fact is why this
 * notification did not exist until 2026-08-01: the comment on `reportMessage` named "an audience
 * rule for platform moderators" as the missing piece, and this is it.
 *
 * > **Deliberately built to mirror `isChannelAdmin` scope for scope**, because the two must agree:
 * > this decides who is *told* about a report and that decides who may *read* it, and somebody
 * > notified about a queue they cannot open is worse than not being notified. Race is the case
 * > that catches a careless version - a roster member is not enough, they must ALSO be a club
 * > admin, which is why the club id is joined rather than the race alone.
 */
export async function channelModerationAudienceById(
  db: Db,
  channelId: string,
): Promise<string[]> {
  /*
   * The admin tier comes from the shared constant, never from role literals typed here. That is
   * the defence against the bug that shipped four times in v1: a bare `role = 'admin'` filter
   * silently excludes a club whose only admin-tier member is its Owner, which is every brand-new
   * club. `clubAdminTier` in the worker's audience module binds it the same way.
   */
  const adminTier = sql.param([...ADMIN_TIER]);
  const rows = await db.execute<{ user_id: string }>(sql`
    WITH ch AS (SELECT scope, scope_id, club_id FROM channels WHERE id = ${channelId})
    -- Club: the admin tier of that club.
    SELECT cm.user_id FROM club_memberships cm, ch
     WHERE ch.scope = 'club' AND cm.club_id = ch.scope_id
       AND cm.role = ANY(${adminTier}::text[])
    UNION
    /*
      No eboard branch, deliberately.

      Reporting does not exist in that scope - see canReportInChannel - so there is nothing to
      review and nobody to tell. An eboard channel reaching here at all would mean a report was
      filed somewhere the policy refuses one, and answering with a list of recipients would paper
      over that rather than leaving it visible as a report nobody was notified about.
    */
    /*
      Race: on the roster AND a club admin. Either alone is the wrong answer.

      Written as explicit JOINs starting FROM ch, rather than mixing a comma with a JOIN. A comma
      is a cross join and binds looser than JOIN, so an ON clause cannot see the table on the far
      side of one - referring to ch.club_id there is "invalid reference to FROM-clause entry",
      which is how the first version of this failed. Note that no comment inside this template
      may contain a backtick: it would end the string.
    */
    SELECT rm.user_id
      FROM ch
      JOIN race_memberships rm ON ch.scope = 'race' AND rm.race_id = ch.scope_id
      JOIN club_memberships cm ON cm.user_id = rm.user_id
                              AND cm.club_id = ch.club_id
                              AND cm.role = ANY(${adminTier}::text[])
    UNION
    -- DM: nobody in the conversation reviews it. Platform moderators do.
    SELECT u.id FROM users u, ch
     WHERE ch.scope = 'dm' AND u.is_platform_moderator
  `);
  return rows.rows.map((r) => r.user_id);
}
