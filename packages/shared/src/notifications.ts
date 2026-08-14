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
 * The 22 types.
 *
 * Phase 1 emits the subset whose triggering feature exists. The rest are declared now
 * because the renderer is exhaustive over this union - adding a type is then a compile
 * error everywhere it must be handled, rather than a silently unrendered row.
 *
 * PRD/12's table lists 18. Two of the rest are **push-only** - `dm_message` and
 * `chat_message` buzz a phone and never become a row in anybody's inbox (ADR-0015, ADR-0032);
 * the others are `message_reported` and `meetup_nudged`.
 *
 * **The count above is asserted by `notifications.test.ts`, which is the only reason to trust
 * it.** It read "19" from Phase 1 until 2026-08-14, by which point there were 21 - a number in
 * prose beside a list that grows is a comment that is wrong and cannot fail.
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
   * An ordinary message arrived in a group chat. **Push only - never written to the inbox.**
   *
   * > **This is what a member means by "notify me".** Until 2026-08-14 club, race and Eboard
   * > chat were silent on purpose: a message is addressed to a room, and the room's unread
   * > count was held to be the right granularity. The founder's answer, testing push on a real
   * > phone and getting nothing, was that a chat app which does not buzz when somebody talks to
   * > your club is not doing its job - which is what every product this replaces does. See
   * > ADR-0032.
   *
   * It writes no row, exactly like `dm_message` and for the identical reason: the inbox
   * representation of unread chat is the computed per-channel row, and one row per message
   * would flood the feed. **PRD/12 rule 8 is untouched** - it governs the BADGE, which still
   * counts one per channel and never a per-message sum. Only the buzz became per message.
   *
   * The two suppressions carry the whole design. A reader whose cursor has passed the message
   * gets nothing, so an open conversation never buzzes; and mute silences the buzz while the
   * unread count keeps climbing, which is what makes mute worth having on a busy club.
   */
  'chat_message',
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
  /**
   * An admin nudged a meetup: a push to the club about a meetup that already existed.
   *
   * **This is the one deliberate exception to the silence of Weekly Meetups.** Creating a meetup
   * notifies nobody (PRD/08 rule 11), and that silence is why the week is a separate surface from
   * the calendar rather than a view over it. A nudge does not weaken the rule - it turns it from a
   * wall into a default, because a person chose to send this one rather than the meetup sending
   * itself.
   *
   * Rate-limited to once an hour per CLUB, not per meetup and not per admin, by an exclusion
   * constraint rather than by a check in the handler - see ADR-0030.
   */
  'meetup_nudged',
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

/**
 * The id of the space whose FACE a row wears. Identity only, never a destination.
 *
 * **Deliberately not `scopeId`, and the distinct name is the whole point.** `member_removed` and
 * `request_denied` carry `scopeName` and no `scopeId` because the space they name is precisely the
 * one the reader can no longer open (`PRD/12` rule 6a) - the absence is a statement, and reusing
 * that field for a picture would quietly turn it into "here is somewhere to go".
 *
 * These two rows still point at the club, exactly as they did. What changed on 2026-08-12 is that
 * they no longer wear the club's *face* while naming a race: "Parks removed you from Cougars
 * Invitational" beside the running club's picture is the same false alarm rule 6a exists to
 * prevent, one layer up. Reported from the phone, the day the pictures shipped.
 *
 * Optional because rows written before that date have neither field, and must keep rendering
 * years later. Their fall-back is a glyph rather than a guess - see `notificationSubject`.
 */
const subjectPicture = { subjectId: Uuid.optional() };

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
    ...subjectPicture,
  }),

  member_added: club.merge(actor).extend({
    scope: ChannelScope,
    scopeName: z.string(),
    scopeId: Uuid,
  }),
  /**
   * Taken off a roster by somebody else.
   *
   * **`scopeName` is the space that was actually lost, and naming it is the difference between
   * an accurate line and a false alarm.** Rendering only `clubName` tells a member removed from
   * one race that they were removed from the club - while they still hold their club membership,
   * their club chat and every other race in it.
   *
   * Carries no `scopeId`, unlike its `member_added` twin, and that asymmetry is the point: the
   * space it names is precisely the one the reader can no longer open, so the row points at the
   * club instead (PRD/12 line 33). `request_denied` is shaped this way for the same reason.
   *
   * Both fields are optional because rows written before 2026-08-05 carry neither and must keep
   * rendering years later (PRD/12 rule 6) - `renderNotification` falls back to the club, which
   * is what those rows always said. Every writer supplies them.
   */
  member_removed: club.merge(actor).extend({
    scope: ChannelScope.optional(),
    scopeName: z.string().optional(),
    ...subjectPicture,
  }),
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
  /**
   * Where and when, carried as params rather than as a sentence.
   *
   * The place and time are copied in rather than joined at read time, for the same reason every
   * `actorName` here is denormalised: the row must render without a join, and it is a record of
   * what the club was told at the time. A meetup edited afterwards does not silently rewrite the
   * notification that went out about it.
   */
  meetup_nudged: club.merge(actor).extend({
    meetupId: Uuid,
    /** `YYYY-MM-DD`. */
    meetupDate: z.string(),
    /** `HH:MM`, wall-clock in the club's own day. */
    meetupTime: z.string(),
    location: z.string(),
  }),

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
   * The same shape as `announcement`, because it is the same fact at a lower volume: somebody
   * said something in a room you are in.
   *
   * `clubId` is nullable rather than fixed, unlike `dm_message` below - a race and the Eboard
   * space both belong to a club, and this type covers all three group scopes.
   */
  chat_message: z
    .object({
      clubId: Uuid.nullable(),
      channelId: Uuid,
      channelName: z.string(),
      seq: z.number().int().positive(),
      /**
       * What to show on a lock screen.
       *
       * Never empty: a photo or a document with no caption has no words of its own, and the
       * worker substitutes a description rather than letting the push render as a name, a
       * colon and nothing. See `previewForPush`.
       */
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
  /** The club's week. A nudge is about one meetup, but the week is where a meetup is read. */
  | { kind: 'meetups'; clubId: string }
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
    case 'meetup_nudged':
      return { kind: 'meetups', clubId: p['clubId']! };

    // Straight to the message, which is what makes a push deep-link land on the right
    // one rather than merely opening the conversation.
    case 'announcement':
    case 'mentioned':
      return { kind: 'chat', channelId: p['channelId']!, seq: p['seq']! };

    /*
     * Both deliberately WITHOUT a seq, unlike the two above.
     *
     * Tapping one of these should open the conversation on the first UNREAD message, which is
     * what chat already does on its own. Pinning the deep link to this message's seq would land
     * you past everything that arrived while the phone was in your pocket - and for an ordinary
     * chat message that is the normal case rather than the edge one, since the whole point of
     * the type is that it fires on every message. An announcement or a mention is about one
     * specific message, so those two keep their seq.
     */
    case 'dm_message':
    case 'chat_message':
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
 * Whose face a notification wears, or `null` for the ones that keep a glyph.
 *
 * `PRD/12` rule 2c: **a row shows the picture of what it is about when that is a place or a
 * person, and a glyph when it is about a thing that happened.** A club's face belongs on "100
 * unread in Paper Running Club" and would be wrong on "new poll", because the second is an object
 * somebody made rather than a room you can walk into.
 *
 * > **This lives beside `notificationTarget` on purpose, and it is deliberately a second function
 * > rather than a field on the first.** They answer different questions - where a tap goes, and
 * > whose face is drawn - and they disagree more often than they agree. A join request points at
 * > the *roster* and shows the *requester*; a report points at the reports *tab* and shows the
 * > *channel*. Deriving one from the other would be right about half the catalogue and silently
 * > wrong about the rest.
 *
 * The server resolves this to a picture at read time and the client draws it. **Both ends read
 * this one mapping** rather than each carrying its own copy of "which types get a face", which is
 * the hand-copied-predicate class (`AGENTS.md` failure mode 9) closed before the second copy
 * exists.
 *
 * Exhaustive over the union with no `default`, so adding a nineteenth type is a compile error here
 * rather than a row that silently draws a blank circle.
 */
export type NotificationSubject =
  | { kind: 'channel'; channelId: string }
  | { kind: 'club'; clubId: string }
  | { kind: 'race'; raceId: string }
  | { kind: 'eboard'; eboardId: string }
  | { kind: 'user'; userId: string };

export function notificationSubject(n: {
  type: NotificationType;
  params: Record<string, unknown>;
}): NotificationSubject | null {
  const p = n.params as Record<string, string & number>;
  switch (n.type) {
    /*
     * The person, not the room.
     *
     * You are deciding about somebody, so their face is the useful thing on the row - and it is
     * what makes the three request types visually distinct from everything else in the list,
     * which suits the one row type a glance must not dismiss (rule 4).
     */
    case 'club_join_request':
    case 'race_join_request':
    case 'eboard_join_request':
      return { kind: 'user', userId: p['requesterId']! };

    // The space you got into, or were added to. Same scope switch as the target above, because
    // here the two genuinely do agree: the row is about the space, and it opens it.
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

    case 'role_changed':
      return { kind: 'club', clubId: p['clubId']! };

    /*
     * These two name a space they cannot OPEN, and the face has to match the words anyway.
     *
     * They carry no `scopeId` on purpose (rule 6a) - the absence says there is nowhere to go, and
     * the row still points at the club. But wearing the club's picture while the sentence says
     * "removed you from Cougars Invitational" is a second false alarm on top of the one that rule
     * exists to prevent: the reader is told, in pictures, that they lost the club. So identity
     * comes from `subjectId`, which is not a destination and is named so it cannot become one.
     *
     * Three cases, and the last is the one worth being careful about:
     *
     * - **the club itself** - `clubId` is the right picture and always present;
     * - **a race or the board, with a `subjectId`** - that space's own face;
     * - **a race or the board, with none** - a row written before 2026-08-12. **A glyph, not the
     *   club.** The whole complaint was a picture that disagreed with the sentence, and an old row
     *   guessing the club would reproduce it exactly; a glyph says nothing rather than something
     *   wrong.
     */
    case 'request_denied':
    case 'member_removed': {
      const scope = p['scope'] as unknown as string | undefined;
      if (scope === 'race') return p['subjectId'] ? { kind: 'race', raceId: p['subjectId'] } : null;
      if (scope === 'eboard') {
        return p['subjectId'] ? { kind: 'eboard', eboardId: p['subjectId'] } : null;
      }
      // Undefined scope is a row from before 2026-08-05, which always meant the club.
      return { kind: 'club', clubId: p['clubId']! };
    }

    case 'race_created':
      return { kind: 'race', raceId: p['raceId']! };

    /*
     * The conversation's own picture - the club's, the race's, the board's, or in a DM the other
     * person's. Resolved from the CHANNEL rather than from the club, because those four are
     * different pictures and only the channel knows which one this is.
     */
    case 'announcement':
    case 'mentioned':
    case 'chat_caught_up':
    case 'dm_message':
    case 'chat_message':
      return { kind: 'channel', channelId: p['channelId']! };

    /*
     * The channel's picture, and **never the reported member's**.
     *
     * The row already withholds their name and the text of what they said, because it can land on
     * a lock screen before anybody has looked at it (`PRD/05` rule 10). A face would hand back
     * exactly what the words are withholding.
     */
    case 'message_reported':
      return { kind: 'channel', channelId: p['channelId']! };

    /*
     * The glyph tier: a thing that happened rather than a place or a person. A poll, an event, a
     * meeting, a post, a nudged meetup, and a car group that needs a new Incharge - which is about
     * a car inside a race, and keeps the car.
     */
    case 'poll_created':
    case 'poll_closing_soon':
    case 'event_created':
    case 'meeting_created':
    case 'news_post_created':
    case 'meetup_nudged':
    case 'car_group_incharge_left':
      return null;
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
    /*
     * The body names the space; the title stays the club.
     *
     * That split is deliberate and matches `request_denied`: the row navigates to the club,
     * because the race or Eboard the sentence is about is exactly what the reader has just
     * lost access to. Titling it with a space they cannot open would promise a destination
     * the tap does not go to.
     *
     * The fallback carries rows written before this type knew about scopes.
     */
    case 'member_removed':
      return {
        title: p['clubName']!,
        body: `${p['actorName']} removed you from ${p['scopeName'] ?? p['clubName']}`,
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
    /*
     * Where and when, in that order, because they are what the reader needs off a lock screen.
     *
     * The actor is named for the same reason every other line here names one: a push that says
     * only "6:30 PM at the Track" reads like the app deciding to buzz, and a nudge is somebody
     * choosing to. The day is the raw date rather than a weekday - this function is pure and
     * locale-free by design (see the note above about a second locale being another
     * implementation, not a migration), and the client formats it when it draws the row.
     */
    case 'meetup_nudged':
      return {
        title: p['clubName']!,
        body: `${p['actorName']} nudged: ${p['meetupTime']} at ${p['location']}`,
      };
    /*
     * The room is the title and the speaker is in the body, which is the opposite of `dm_message`
     * below and is the right way round for each.
     *
     * In a one-to-one conversation the sender IS the room, so naming them twice reads as a bug.
     * In a group the room is what tells you whether this matters before you have read a word, and
     * the speaker is the first thing you want after that - "Binghamton Running Club / Alice: are
     * we still on for six".
     */
    case 'announcement':
    case 'chat_message':
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
