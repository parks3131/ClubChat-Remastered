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
   * Somebody reported a message, and this is the work landing on whoever reviews it.
   *
   * > **Deliberately absent until 2026-08-01**, when the founder asked why reporting was silent.
   * > The note in `domain/moderation.ts` said adding it "would need an audience rule for platform
   * > moderators, who are not members of any club" - and that is exactly what it needed, because
   * > the reviewer of a DM report is not an admin of anything. See
   * > `channelModerationAudienceById`.
   *
   * Goes to the REVIEWERS, never to the reported member: PRD/05 rule 10 and PRD/14 rule 7 both
   * require reporting to be invisible to the person reported, and a notification is the loudest
   * possible way to break that.
   */
  'message_reported',
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

/**
 * The outcome, stamped onto a pending request row once somebody decides it.
 *
 * **Optional because a row is written without it and gains it later.** A request notification
 * goes to every admin who could act on it, and exactly one of them acts - so the other rows
 * are describing work that no longer exists the moment the first admin approves. Leaving them
 * saying "X asked to join" is a row lying about the present, and clearing them outright loses
 * the record `PRD/12` rule 5 exists to keep. Stamping the outcome resolves them in place.
 *
 * This is structured data rather than a rendered artefact, so it is what ADR-0013 asks for:
 * `renderNotification` still produces every word at read time, and a resolved row is one more
 * branch in that one function rather than a second stored sentence.
 *
 * `decidedByName` is a denormalised copy of the decider's name for the same reason every other
 * `actorName` in this file is: the row must render without a join, and it is a record of who
 * decided at the time, not a live pointer at their current profile.
 */
const decided = {
  decision: z.enum(['approved', 'denied']).optional(),
  decidedByName: z.string().optional(),
};

export const notificationParams = {
  club_join_request: club.extend({ requesterName: z.string(), requesterId: Uuid, ...decided }),
  race_join_request: club.extend({
    raceId: Uuid,
    raceName: z.string(),
    requesterName: z.string(),
    requesterId: Uuid,
    ...decided,
  }),
  eboard_join_request: club.extend({
    eboardId: Uuid,
    requesterName: z.string(),
    requesterId: Uuid,
    ...decided,
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
   * A report waiting to be reviewed.
   *
   * `clubId` is nullable because a DM report belongs to no club - it goes to the platform queue,
   * and the recipients are moderators rather than members of anything.
   *
   * **Carries no preview of the reported message**, unlike `announcement` and `mentioned`. A
   * notification is a pointer to work, and the content of a report belongs behind the audited
   * read that the Reports tab and the DM queue perform - putting it in a push payload would put
   * it on a lock screen instead.
   */
  message_reported: z
    .object({
      clubId: Uuid.nullable(),
      channelId: Uuid,
      channelName: z.string(),
      seq: z.number().int().positive(),
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

/**
 * The outcome of a request row, if it has been decided.
 *
 * The one place that knows a decision lives under `params.decision`, so the inbox can tag a
 * row without reaching into the jsonb itself. Returns undefined for every other type and for
 * a request still waiting on somebody.
 */
export function requestDecision(n: {
  type: NotificationType;
  params: Record<string, unknown>;
}): 'approved' | 'denied' | undefined {
  if (!PENDING_REQUEST_TYPES.includes(n.type)) return undefined;
  const decision = n.params['decision'];
  return decision === 'approved' || decision === 'denied' ? decision : undefined;
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
  /**
   * The Reports tab of a channel's Highlights, which is where a group-scope report is worked.
   *
   * Its own kind rather than `chat` with a seq: the reviewer's job is the queue, not the
   * message, and landing them in the conversation would leave them to find the tab themselves.
   */
  | { kind: 'chat_reports'; channelId: string }
  /** The platform moderation queue, where a DM report goes. No club admin can reach it. */
  | { kind: 'platform_moderation' }
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

    /*
     * Two destinations for one type, decided by whether the channel belongs to a club.
     *
     * A group-scope report is reviewed by that space's admins in its Reports tab. A DM report
     * has no club and no admin - it is reviewed by platform moderators in their own queue, and
     * routing it to a club screen would send somebody to a page they cannot open.
     */
    case 'message_reported':
      return p['clubId'] === null
        ? { kind: 'platform_moderation' }
        : { kind: 'chat_reports', channelId: p['channelId']! };

    case 'car_group_incharge_left':
      return { kind: 'race_car_groups', raceId: p['raceId']! };
    case 'chat_caught_up':
      return { kind: 'chat', channelId: p['channelId']! };
  }
}

/**
 * A request row's body, in whichever of its two states it is in.
 *
 * **The same row says two different things over its life**, which is the whole point: while it
 * is waiting it names the work, and once it is decided it names the outcome and who reached it.
 * "Approved" alone tells an admin arriving late that it is handled; naming the decider tells
 * them who to go and ask, which is the question they actually have.
 *
 * `decidedByName` falls back rather than throwing, because a row stamped by an older build, or
 * by a decider whose account has since gone, must still render - PRD/12 rule 6.
 */
function requestBody(p: Record<string, string>, joining: string): string {
  if (!p['decision']) return `${p['requesterName']} asked to join ${joining}`;
  const verb = p['decision'] === 'approved' ? 'approved' : 'denied';
  return `${p['decidedByName'] ?? 'An admin'} ${verb} ${p['requesterName']}'s request to join ${joining}`;
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
      return { title: p['clubName']!, body: requestBody(p, p['clubName']!) };
    case 'race_join_request':
      return { title: p['raceName']!, body: requestBody(p, p['raceName']!) };
    case 'eboard_join_request':
      return { title: p['clubName']!, body: requestBody(p, 'the Eboard space') };
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
      /*
       * The Eboard consequence is stated, not left to be discovered.
       *
       * A role change silently adds or removes the member from Eboard & Council, in the same
       * transaction - see `changeRole`. Losing access to a private space is the part of a demotion
       * somebody actually notices, and a notification that mentions only the role leaves them to
       * work out on their own why a whole conversation vanished. Naming who did it matters for the
       * same reason: a demotion is somebody's decision, not a system event.
       */
      return {
        title: p['clubName']!,
        body:
          p['newRole'] === 'member'
            ? `${p['actorName']} changed your role in ${p['clubName']} to member, and removed you from Eboard & Council`
            : `${p['actorName']} made you ${p['newRole'] === 'owner' ? 'the owner' : 'an admin'} of ${p['clubName']}, with access to Eboard & Council`,
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
    /*
     * Says who reported and where, and NOT what was said or who said it.
     *
     * The reported member is never named, because this text can land on a lock screen and an
     * accusation is not a thing to broadcast before anybody has looked at it. The reviewer opens
     * the queue to see the message, which is the read that is access-checked and, for a DM,
     * audited.
     */
    case 'message_reported':
      return {
        title: p['channelName']!,
        body: `${p['actorName']} reported a message for review`,
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
        // Copy deck: "Caught up on {N} messages in {Club} chat". The trailing "chat" matters -
        // it is what makes this row read as the settled twin of the live "{N} unread messages in
        // {Club} chat" it replaces, which is the whole point of writing it.
        body: `Caught up on ${count} message${count === 1 ? '' : 's'} in ${p['channelName']} chat`,
      };
    }
  }
}
