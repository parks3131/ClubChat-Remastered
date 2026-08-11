/**
 * The shapes the API returns.
 *
 * Hand-written rather than derived, and that is a deliberate cost. The server's response types
 * live in its domain modules, which the client cannot import - `@clubchat/shared` is the wire
 * contract that both sides depend on, and putting every read shape in it would make the shared
 * package a copy of the server's query layer.
 *
 * > **So these types are an assertion, not a check** - the same warning AGENTS.md failure mode 7
 * > makes about row types over raw SQL. A field renamed on the server typechecks cleanly here and
 * > fails at the call site. The route-level tests on the server are what actually pin the shapes;
 * > these exist so a screen is written against something.
 *
 * What IS imported from shared: anything that travels on the wire in both directions - message
 * envelopes, reactions, roles, join policies. Those must never be restated here.
 */

import type {
  ClubRole,
  JoinPolicy,
  MessageEnvelope,
  MessageReaction,
  NotificationTarget,
} from '@clubchat/shared';

// ---------------------------------------------------------------------------
// Clubs
// ---------------------------------------------------------------------------

export type ClubDetail = {
  id: string;
  name: string;
  sport: string;
  description: string | null;
  /** The club's picture, as a media id. Null falls back to its initial. */
  image: string | null;
  joinPolicy: JoinPolicy;
  memberCount: number;
  createdAt: string;
  mainChannelId?: string | null;
  channelId: string | null;
  /** Present only for somebody inside the space. Null is "you are not in it". */
  eboardId: string | null;
  /**
   * The Eboard's chat channel, for a member of the space.
   *
   * Lets the hub open the conversation directly rather than pushing a landing screen that
   * immediately redirects - two transitions for one tap. Gated exactly as `eboardId` is.
   */
  eboardChannelId: string | null;
  viewer: { role: ClubRole; isAdmin: boolean; isOwner: boolean };
  /** Admin tier only. The link is the only invite mechanism, so this is the club's front door. */
  inviteToken: string | null;
};

export type RosterEntry = {
  userId: string;
  name: string;
  image: string | null;
  role: ClubRole;
  joinedAt: string;
  /**
   * What this viewer may do to this member, decided by the server.
   *
   * > **The screen used to work these out**, from the target's role plus the viewer's own
   * > `isAdmin`/`isOwner` - a second copy of the removal ladder living in a component. Banning
   * > adds a third ladder that is asymmetric in the opposite direction, which is exactly when a
   * > restated rule starts drifting. Render these; do not re-derive them.
   */
  canRemove: boolean;
  canBan: boolean;
};

/** Somebody barred from the club, and who barred them. Admin-only. */
export type ClubBan = {
  userId: string;
  name: string;
  image: string | null;
  /** Null where that admin has since deleted their account - the ban outlives them on purpose. */
  bannedByName: string | null;
  createdAt: string;
};

export type JoinRequestEntry = {
  requestId: string;
  userId: string;
  name: string;
  /** Their picture. The queue draws the same person the roster below it will. */
  image: string | null;
  requestedAt: string;
};

/** `pendingRequests` is null for a non-admin: distinct from an empty queue, on purpose. */
export type ClubRoster = {
  members: RosterEntry[];
  pendingRequests: JoinRequestEntry[] | null;
};

export type ClubSearchResult = {
  id: string;
  name: string;
  sport: string;
  memberCount: number;
  joinPolicy: JoinPolicy;
  requestPending: boolean;
};

// ---------------------------------------------------------------------------
// Races
// ---------------------------------------------------------------------------

export type RaceListItem = {
  id: string;
  name: string;
  raceDate: string;
  /** The race's picture, as a media id. Null falls back to its initial. */
  image: string | null;
  pinned: boolean;
  /** This viewer has silenced the race's chat. Always false without access - no chat, no mute. */
  muted: boolean;
  /** A roster row. The ONLY proof of race access - never inferred from isManager. */
  hasAccess: boolean;
  /** Club-admin status: management authority, which is not access. */
  isManager: boolean;
  requestPending: boolean;
  memberCount: number;
  channelId: string | null;
};

export type RaceDetail = {
  id: string;
  clubId: string;
  name: string;
  raceDate: string;
  image: string | null;
  meetDescription: string | null;
  meetLocationUrl: string | null;
  meetHotelUrl: string | null;
  meetPhotosUrl: string | null;
  meetResultsUrl: string | null;
  memberCount: number;
  viewer: {
    hasAccess: boolean;
    isManager: boolean;
    requestPending: boolean;
    pinned: boolean;
    channelId: string | null;
    /** The Owner's join-without-asking. Decided by the server, never inferred from a role. */
    canJoinDirectly: boolean;
  };
};

export type RaceRosterEntry = {
  userId: string;
  name: string;
  image: string | null;
  isManager: boolean;
  carGroupNumber: number | null;
};

export type RaceRoster = {
  members: RaceRosterEntry[];
  pendingRequests: JoinRequestEntry[] | null;
};

/** Somebody in a car, or waiting for a seat in one. Both halves of the read draw a face. */
export type CarGroupPerson = { userId: string; name: string; image: string | null };

export type CarGroup = {
  id: string;
  number: number;
  inchargeUserId: string | null;
  members: Array<CarGroupPerson & { isIncharge: boolean }>;
};

export type CarGroupsView = {
  groups: CarGroup[];
  /** On the roster and in no car. Exactly the add-to-group search (PRD/09 rule 16). */
  unassigned: CarGroupPerson[];
};

// ---------------------------------------------------------------------------
// Polls
// ---------------------------------------------------------------------------

export type PollSummary = {
  id: string;
  question: string;
  closed: boolean;
  votedByMe: boolean;
  /** Votes cast, not people: a multi-select poll counts one member several times. */
  voteCount: number;
  /** The deadline, for the countdown badge. Null on a poll that closes only by hand. */
  closesAt: string | null;
};

export type PollView = {
  id: string;
  question: string;
  scope: 'club' | 'race' | 'eboard';
  allowMultiple: boolean;
  isPrivate: boolean;
  closed: boolean;
  closesAt: string | null;
  isCreator: boolean;
  options: Array<{
    id: string;
    label: string;
    position: number;
    /** Always present: counts are public on every poll, including private ones. */
    voteCount: number;
    votedByMe: boolean;
    /** Null when the viewer may not see identities. Not the same as nobody voting. */
    voters: Array<{ userId: string; name: string; image: string | null }> | null;
  }>;
};

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

export type MeetingSummary = {
  id: string;
  title: string;
  startsAt: string;
  link: string | null;
  creatorId: string;
  creatorName: string;
  isCreator: boolean;
};

export type MeetingDetail = MeetingSummary & {
  description: string | null;
  eboardId: string;
  clubId: string;
};

export type NewsPost = {
  id: string;
  body: string | null;
  mediaId: string | null;
  authorId: string;
  authorName: string;
  authorImage: string | null;
  createdAt: string;
  /**
   * Never null: the column defaults to `now()` alongside `created_at`, so a post that has never
   * been edited carries the same value in both. "Edited" is therefore `updatedAt !== createdAt`,
   * not `updatedAt !== null` - which is what the feed said at first, and it labelled every post as
   * edited from the moment it was posted.
   */
  updatedAt: string;
  reactions: Array<{ emoji: string; count: number; mine: boolean }>;
};

export type ActivityType =
  | 'run'
  | 'trail_run'
  | 'bike'
  | 'swim'
  | 'strength'
  | 'hybrid_fitness'
  | 'indoor_climb'
  | 'bouldering'
  | 'xc_ski'
  | 'other';

export type RoutineDay = {
  date: string;
  workouts: Array<{
    id: string;
    activityType: ActivityType;
    title: string;
    description: string | null;
  }>;
  /** Rendered as "Rest day", never as an empty absence. */
  restDay: boolean;
};

export type EventType = 'race' | 'practice' | 'team_bonding' | 'volunteer' | 'other';

export type EventDetail = {
  id: string;
  clubId: string;
  type: EventType;
  title: string;
  startsAt: string;
  endsAt: string | null;
  location: string | null;
  description: string | null;
  /** Null once the creator's account is gone. The event outlives them. */
  creatorId: string | null;
  creatorName: string | null;
  /** **Any club admin**, not only the creator - the opposite of a poll, deliberately. */
  canManage: boolean;
};

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

export type FeedItem = {
  kind: 'event' | 'race' | 'meeting' | 'poll';
  id: string;
  clubId: string;
  clubName: string;
  title: string;
  /**
   * Null for a poll with no deadline, which is why polls sort last and are off the grid.
   *
   * An ISO instant, or a date-only `YYYY-MM-DD` when `allDay`. Never parse it without checking
   * which - that is the whole point of the flag beside it.
   */
  at: string | null;
  /** True when `at` is a day rather than a moment, which today means a race. */
  allDay: boolean;
  upcoming: boolean;
  open?: boolean;
  /** False for a race the viewer can see but not enter. Still shown.  */
  accessible: boolean;
};

// ---------------------------------------------------------------------------
// Eboard
// ---------------------------------------------------------------------------

export type EboardDetail = {
  id: string;
  clubId: string;
  name: string;
  description: string | null;
  image: string | null;
  memberCount: number;
  channelId: string | null;
  viewer: {
    isMember: boolean;
    isClubAdmin: boolean;
    isOwner: boolean;
    requestPending: boolean;
  };
};

export type EboardRoster = {
  members: Array<{
    userId: string;
    name: string;
    image: string | null;
    role: string;
    joinedAt: string;
  }>;
  pendingRequests: JoinRequestEntry[];
};

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/**
 * An inbox row.
 *
 * > **A discriminated union, mirroring the server's exactly - including `target`, which is imported
 * > from `@clubchat/shared` rather than restated.** That import is the point: `notificationTarget`
 * > is exhaustive over the type union on the server, so a new notification type that nothing routes
 * > is a compile error there. Restating the shape here would throw that away and turn it into a
 * > runtime surprise.
 *
 * This type was first written from a guess - `params: Record<string, unknown>`, a nullable `body`,
 * `readAt` instead of `read` - and the screen crashed on `row.params.approved` the first time it
 * rendered a real row. Which is precisely the warning at the top of this file: a hand-written type
 * over somebody else's response is an assertion, not a check.
 */
export type InboxRow =
  | {
      kind: 'notification';
      id: string;
      type: string;
      title: string;
      body: string;
      target: NotificationTarget;
      read: boolean;
      /** Present on a decided request, so the admin keeps a record of what they decided. */
      decision?: 'approved' | 'denied';
      createdAt: string;
    }
  | {
      kind: 'chat_unread';
      /** Synthetic and stable, since there is no row to have an id. */
      id: string;
      channelId: string;
      channelName: string;
      count: number;
      target: NotificationTarget;
      createdAt: string;
    };

export type InboxPage = { rows: InboxRow[]; nextCursor: string | null };

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export type Profile = {
  userId: string;
  name: string;
  image: string | null;
  bio: string | null;
  city: string | null;
  school: string | null;
  /** Present only on your own profile. Absent is the server withholding it, not an empty value. */
  dob?: string | null;
  createdAt: string;
};

/**
 * What the viewer may do to this person in one club.
 *
 * Present only when the profile was asked for with a `clubId`, because banning is a club-scoped
 * authority and a profile card is not: the same person is bannable by you in one club and
 * untouchable in another. Absent means "no club context", never "not allowed".
 */
export type ProfileClubActions = {
  clubId: string;
  canRemove: boolean;
  canBan: boolean;
  banned: boolean;
  canLiftBan: boolean;
};

// ---------------------------------------------------------------------------
// Chat reads that the Highlights and jump-to-message screens use
// ---------------------------------------------------------------------------

export type HighlightPage = { messages: MessageEnvelope[]; hasMore: boolean };

export type AroundWindow = {
  messages: MessageEnvelope[];
  hasBefore: boolean;
  hasAfter: boolean;
};

/**
 * One reported message, grouped by message rather than by report.
 *
 * > **This type used to describe a response the server has never sent.** It declared a
 * > `reportId`, a `reporterName` and a nested `message` object; `GET /channels/:id/reports`
 * > returns a `messageId`, a `reporters` array and the message's fields inline. Every field the
 * > Reports tab read was therefore `undefined` at runtime - so every card rendered "Unknown
 * > sender" over "This message was deleted", and Dismiss posted to
 * > `/moderation/reports/undefined/dismiss` and 404'd. It typechecked perfectly the whole time,
 * > which is failure mode 12: the client restating a server type instead of being handed one.
 *
 * Grouped by message is the server's shape and the right one: three people reporting the same
 * message is one decision for an admin, not three.
 */
/**
 * One reported direct message, as the platform queue lists it.
 *
 * **Carries no message body, deliberately.** If the list showed content, either every refresh
 * would write an audit row per report or private messages would be read with no log at all - the
 * second silently defeats the rule the log exists for. So the list is metadata and the context
 * read is the single logged door to what was actually said.
 */
export type DmReportRow = {
  /** What dismiss and context both take. The routes call it `:id`; it is a message id. */
  messageId: string;
  channelId: string;
  conversationId: string;
  seq: number;
  senderId: string;
  senderName: string;
  /**
   * What has already been done about this report.
   *
   * Both are metadata, so carrying them does not turn the listing into a content surface - the
   * rule that reading what was said is a separate, logged act is intact. They exist so the queue
   * can say "removed" and "suspended" instead of offering an action that would change nothing.
   */
  senderSuspended: boolean;
  removed: boolean;
  /** Ordered oldest first, and never empty: a row exists because somebody reported it. */
  reporters: Array<{ userId: string; name: string; createdAt: string }>;
  dismissedAt: string | null;
  createdAt: string;
};

/**
 * The reported message and the few either side of it.
 *
 * The window is fixed server-side and there is no parameter to widen it. **Opening this writes an
 * audit row** naming the moderator, the report and the window actually served - so this type is
 * not something to fetch speculatively or prefetch. Ask for it when somebody has chosen to look.
 */
export type ModerationContext = {
  messageId: string;
  channelId: string;
  reportedSeq: number;
  fromSeq: number;
  toSeq: number;
  /**
   * Who sent the reported message, and what has already been done about them.
   *
   * From the server rather than worked out here from the window: whether to offer "Suspend" or
   * "Reinstate" is a rule, and a screen restating one is how two definitions drift apart.
   */
  subjectUserId: string;
  subjectSuspended: boolean;
  removed: boolean;
  messages: Array<{
    seq: number;
    body: string | null;
    senderId: string;
    senderName?: string | null;
    createdAt: string;
    deletedAt?: string | null;
    type?: string;
  }>;
};

export type ReportRow = {
  /** What `dismissReport` takes. The route calls it `:id`; it is a message id. */
  messageId: string;
  channelId: string;
  seq: number;
  /** Null for a deleted message AND for a photo - read `deletedAt` to tell them apart. */
  body: string | null;
  senderId: string;
  senderName: string;
  senderImage: string | null;
  deletedAt: string | null;
  /** Ordered oldest first, and never empty: a row exists because somebody reported it. */
  reporters: Array<{ userId: string; name: string; createdAt: string }>;
  dismissedAt: string | null;
};

export type GalleryEntry = {
  mediaId: string;
  seq: number;
  /**
   * The server's stable, permanent URLs - **which a web client cannot use directly.**
   *
   * They point at `GET /media/:id`, which answers 302 behind an `Authorization` header. `<img src>`
   * sends no custom headers and react-native-web renders every `Image` as an `<img>`, so these are
   * unusable exactly where this project develops and tests. The gallery therefore renders from
   * `mediaId` through `resolveMediaUrl`, the JSON sibling of the same authorized hop - see the
   * Phase 3 entry in HISTORY.md, where this cost an afternoon the first time.
   *
   * Kept in the type because they are on the wire and a native client CAN follow them.
   */
  url: string;
  thumbUrl: string;
  createdAt: string;
  /** Who posted it. The grid does not draw this; the full-screen viewer's header does. */
  senderId: string;
  senderName: string | null;
  senderImage: string | null;
};

export type GalleryPage = { entries: GalleryEntry[]; nextCursor: number | null };

export type { MessageEnvelope, MessageReaction, NotificationTarget };
