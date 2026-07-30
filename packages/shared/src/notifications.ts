/**
 * The notification catalogue.
 *
 * Each type declares the structured parameters its text and target are rendered from.
 * There is no stored body and no stored route: both are produced at read time. See
 * ADR-0013, and SPEC/PRD/12-notifications.md for the audience and clearing rules.
 *
 * `params` is a jsonb column, which means it is a contract with no database-level
 * shape. These schemas are that shape, validated when a notification is written, so a
 * malformed param fails at the write rather than surfacing as broken text in someone's
 * inbox months later.
 */

import { z } from 'zod';
import { ChannelScope, ClubRole, Uuid } from './domain.ts';

/**
 * The 19 types.
 *
 * Phase 1 emits the subset whose triggering feature exists. The rest are declared now
 * because the renderer is exhaustive over this union - adding a type is then a compile
 * error everywhere it must be handled, rather than a silently unrendered row.
 *
 * PRD/12's table lists 18. The nineteenth, `dm_message`, is **push-only** and is the one type
 * that never becomes a row in anybody's inbox - see its entry below and ADR-0015.
 */
export const notificationTypes = [
  // Join requests. These three are special: they never clear by opening the inbox.
  'club_join_request',
  'race_join_request',
  'eboard_join_request',
  // Decisions on the above.
  'request_approved',
  'request_denied',
  // Membership and role.
  'member_added',
  'member_removed',
  'role_changed',
  // Content created.
  'poll_created',
  'poll_closing_soon',
  'event_created',
  'race_created',
  'meeting_created',
  'news_post_created',
  // Chat.
  'announcement',
  'mentioned',
  /**
   * A direct message arrived. **Push only - never written to the inbox.**
   *
   * An ordinary message in club, race or Eboard chat produces no discrete notification at
   * all: its unread count is derived from the log. A DM is the one scope where an ordinary
   * message is inherently addressed to one person, so it has to buzz - and PRD/14's mute rule
   * ("no push notifications, unread count still accrues") is meaningless unless it does.
   *
   * It still writes no row, because the inbox representation of an unread DM is the same
   * computed chat-unread row every other scope gets. A row per message would flood the feed
   * and contradict "computed on read, never stored". See ADR-0015.
   */
  'dm_message',
  // Housekeeping.
  'car_group_incharge_left',
  'chat_caught_up',
] as const;

export const NotificationType = z.enum(notificationTypes);
export type NotificationType = z.infer<typeof NotificationType>;

/**
 * The three types that a glance at the inbox must NOT dismiss.
 *
 * "Only clears once you actually look": a row representing work waiting on you clears
 * when the relevant roster screen is opened, not when the inbox is. The founder lost
 * real join requests to the other behaviour.
 */
export const PENDING_REQUEST_TYPES: readonly NotificationType[] = [
  'club_join_request',
  'race_join_request',
  'eboard_join_request',
];

// ---------------------------------------------------------------------------
// Per-type parameters
// ---------------------------------------------------------------------------

const actor = z.object({ actorName: z.string() });
const club = z.object({ clubId: Uuid, clubName: z.string() });

export const notificationParams = {
  club_join_request: club.extend({ requesterName: z.string(), requesterId: Uuid }),
  race_join_request: club.extend({
    raceId: Uuid,
    raceName: z.string(),
    requesterName: z.string(),
    requesterId: Uuid,
  }),
  eboard_join_request: club.extend({
    eboardId: Uuid,
    requesterName: z.string(),
    requesterId: Uuid,
  }),

  request_approved: club.merge(actor).extend({
    scope: ChannelScope,
    scopeName: z.string(),
    scopeId: Uuid,
  }),
  request_denied: club.merge(actor).extend({
    scope: ChannelScope,
    scopeName: z.string(),
  }),

  member_added: club.merge(actor).extend({
    scope: ChannelScope,
    scopeName: z.string(),
    scopeId: Uuid,
  }),
  member_removed: club.merge(actor),
  role_changed: club.merge(actor).extend({ newRole: ClubRole }),

  poll_created: club.merge(actor).extend({ pollId: Uuid, question: z.string() }),
  poll_closing_soon: club.extend({ pollId: Uuid, question: z.string() }),
  event_created: club.merge(actor).extend({ eventId: Uuid, title: z.string() }),
  race_created: club.merge(actor).extend({ raceId: Uuid, raceName: z.string() }),
  meeting_created: club.merge(actor).extend({
    eboardId: Uuid,
    meetingId: Uuid,
    title: z.string(),
  }),
  news_post_created: club.merge(actor).extend({ postId: Uuid }),

  announcement: z
    .object({
      clubId: Uuid.nullable(),
      channelId: Uuid,
      channelName: z.string(),
      seq: z.number().int().positive(),
      preview: z.string(),
    })
    .merge(actor),
  mentioned: z
    .object({
      clubId: Uuid.nullable(),
      channelId: Uuid,
      channelName: z.string(),
      seq: z.number().int().positive(),
      preview: z.string(),
    })
    .merge(actor),

  /**
   * `clubId` is fixed at null rather than nullable, and that is the type-level statement of
   * the rule: a DM belongs to no club, ever, because two people who share two clubs must get
   * one thread. `channelName` is the sender's name - a conversation has no name of its own,
   * only two people, and the recipient is always the other one.
   */
  dm_message: z
    .object({
      clubId: z.null(),
      channelId: Uuid,
      conversationId: Uuid,
      channelName: z.string(),
      seq: z.number().int().positive(),
      preview: z.string(),
    })
    .merge(actor),

  car_group_incharge_left: club.extend({
    raceId: Uuid,
    raceName: z.string(),
    groupNumber: z.number().int().positive(),
    departedName: z.string(),
  }),

  /**
   * Recorded when a member opens a chat that had unread messages, so the history of
   * having caught up survives even though the live count is gone.
   */
  chat_caught_up: z.object({
    clubId: Uuid.nullable(),
    channelId: Uuid,
    channelName: z.string(),
    count: z.number().int().positive(),
  }),
} as const satisfies Record<NotificationType, z.ZodType>;

export type NotificationParams = {
  [K in NotificationType]: z.infer<(typeof notificationParams)[K]>;
};

/** A notification of a known type, with its params narrowed to that type. */
export type Notification = {
  [K in NotificationType]: {
    id: string;
    type: K;
    params: NotificationParams[K];
    actorId: string | null;
    clubId: string | null;
    readAt: string | null;
    createdAt: string;
  };
}[NotificationType];

/** Validate params for a type. Called at write time; throws on a malformed param. */
export function parseNotificationParams<K extends NotificationType>(
  type: K,
  params: unknown,
): NotificationParams[K] {
  return notificationParams[type].parse(params) as NotificationParams[K];
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Where a notification points.
 *
 * A structured destination rather than a route string. Pitfall 8: a stored route means
 * every function matching on it has to change together, and changing one literal left
 * approvals permanently unresolved for eight migrations. This is one mapping, in one
 * place, that the client turns into whatever its navigation shape happens to be - so a
 * navigation change never touches stored data.
 */
export type NotificationTarget =
  | { kind: 'chat'; channelId: string; seq?: number }
  | { kind: 'club'; clubId: string }
  | { kind: 'club_members'; clubId: string }
  | { kind: 'race'; raceId: string }
  | { kind: 'race_roster'; raceId: string }
  | { kind: 'race_car_groups'; raceId: string }
  | { kind: 'eboard'; eboardId: string }
  | { kind: 'eboard_roster'; eboardId: string }
  | { kind: 'poll'; pollId: string }
  | { kind: 'event'; eventId: string }
  | { kind: 'meeting'; meetingId: string }
  | { kind: 'news'; clubId: string }
  | { kind: 'inbox' };

/**
 * Derive the destination. Exhaustive over the type union, so adding a type without
 * routing it is a compile error rather than a row that navigates nowhere.
 */
export function notificationTarget(n: {
  type: NotificationType;
  params: Record<string, unknown>;
}): NotificationTarget {
  const p = n.params as Record<string, string & number>;
  switch (n.type) {
    // A pending request points at the roster where the work gets done, which is also
    // the screen whose opening clears it.
    case 'club_join_request':
      return { kind: 'club_members', clubId: p['clubId']! };
    case 'race_join_request':
      return { kind: 'race_roster', raceId: p['raceId']! };
    case 'eboard_join_request':
      return { kind: 'eboard_roster', eboardId: p['eboardId']! };

    case 'request_approved':
    case 'member_added':
      switch (p['scope'] as unknown as string) {
        case 'race':
          return { kind: 'race', raceId: p['scopeId']! };
        case 'eboard':
          return { kind: 'eboard', eboardId: p['scopeId']! };
        default:
          return { kind: 'club', clubId: p['clubId']! };
      }
    case 'request_denied':
    case 'member_removed':
    case 'role_changed':
      return { kind: 'club', clubId: p['clubId']! };

    case 'poll_created':
    case 'poll_closing_soon':
      return { kind: 'poll', pollId: p['pollId']! };
    case 'event_created':
      return { kind: 'event', eventId: p['eventId']! };
    case 'race_created':
      return { kind: 'race', raceId: p['raceId']! };
    case 'meeting_created':
      return { kind: 'meeting', meetingId: p['meetingId']! };
    case 'news_post_created':
      return { kind: 'news', clubId: p['clubId']! };

    // Straight to the message, which is what makes a push deep-link land on the right
    // one rather than merely opening the conversation.
    case 'announcement':
    case 'mentioned':
      return { kind: 'chat', channelId: p['channelId']!, seq: p['seq']! };

    // Deliberately WITHOUT a seq. Tapping a DM push should open the conversation on the first
    // unread message, which is what chat already does on its own; pinning the deep link to one
    // seq would land past anything that arrived after the push was built.
    case 'dm_message':
      return { kind: 'chat', channelId: p['channelId']! };

    case 'car_group_incharge_left':
      return { kind: 'race_car_groups', raceId: p['raceId']! };
    case 'chat_caught_up':
      return { kind: 'chat', channelId: p['channelId']! };
  }
}

/**
 * Render a notification's text.
 *
 * English only for now, but the point is that this is a pure function over structured
 * data rather than a string frozen into a row - so a second locale is another
 * implementation of this function, not a migration over every historical row.
 */
export function renderNotification(n: {
  type: NotificationType;
  params: Record<string, unknown>;
}): { title: string; body: string } {
  const p = n.params as Record<string, string>;
  switch (n.type) {
    case 'club_join_request':
      return {
        title: p['clubName']!,
        body: `${p['requesterName']} asked to join ${p['clubName']}`,
      };
    case 'race_join_request':
      return {
        title: p['raceName']!,
        body: `${p['requesterName']} asked to join ${p['raceName']}`,
      };
    case 'eboard_join_request':
      return {
        title: p['clubName']!,
        body: `${p['requesterName']} asked to join the Eboard space`,
      };
    case 'request_approved':
      return {
        title: p['scopeName']!,
        body: `${p['actorName']} approved your request to join ${p['scopeName']}`,
      };
    case 'request_denied':
      return {
        title: p['clubName']!,
        body: `Your request to join ${p['scopeName']} was not approved`,
      };
    case 'member_added':
      return {
        title: p['scopeName']!,
        body: `${p['actorName']} added you to ${p['scopeName']}`,
      };
    case 'member_removed':
      return {
        title: p['clubName']!,
        body: `${p['actorName']} removed you from ${p['clubName']}`,
      };
    case 'role_changed':
      return {
        title: p['clubName']!,
        body:
          p['newRole'] === 'member'
            ? `${p['actorName']} changed your role in ${p['clubName']} to member`
            : `${p['actorName']} made you ${p['newRole'] === 'owner' ? 'the owner' : 'an admin'} of ${p['clubName']}`,
      };
    case 'poll_created':
      return { title: p['clubName']!, body: `${p['actorName']} created a poll: ${p['question']}` };
    case 'poll_closing_soon':
      return { title: p['clubName']!, body: `Poll closes in 10 minutes: ${p['question']}` };
    case 'event_created':
      return { title: p['clubName']!, body: `${p['actorName']} added an event: ${p['title']}` };
    case 'race_created':
      return { title: p['clubName']!, body: `${p['actorName']} created ${p['raceName']}` };
    case 'meeting_created':
      return { title: p['clubName']!, body: `${p['actorName']} scheduled ${p['title']}` };
    case 'news_post_created':
      return { title: p['clubName']!, body: `${p['actorName']} posted club news` };
    case 'announcement':
      return { title: p['channelName']!, body: `${p['actorName']}: ${p['preview']}` };
    case 'mentioned':
      return {
        title: p['channelName']!,
        body: `${p['actorName']} mentioned you: ${p['preview']}`,
      };
    // The title is the sender's name and the body is what they said, with no "X said:" prefix -
    // in a one-to-one conversation the sender is already the title, so repeating them reads as
    // a bug on a lock screen.
    case 'dm_message':
      return { title: p['actorName']!, body: p['preview']! };
    case 'car_group_incharge_left':
      return {
        title: p['raceName']!,
        body: `Group ${p['groupNumber']} needs a new Incharge - ${p['departedName']} left`,
      };
    case 'chat_caught_up': {
      const count = Number(p['count']);
      return {
        title: p['channelName']!,
        body: `Caught up on ${count} message${count === 1 ? '' : 's'} in ${p['channelName']}`,
      };
    }
  }
}
