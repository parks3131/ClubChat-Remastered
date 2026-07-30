/**
 * The authenticated fetch, and the shapes the DM screens read.
 *
 * Every screen previously loaded the token and assembled its own headers inline. That is the
 * same duplication the server's policy module exists to avoid, one layer up: a header the
 * next screen forgets is an unauthenticated request that reads as an empty list.
 *
 * Deliberately thin. It does NOT wrap the realtime path - `ChatClient` owns the socket, the
 * outbox and the local store, and a second opinion about sending would be a second source of
 * truth about what has been delivered.
 */

import type {
  Club,
  ClubRole,
  JoinPolicy,
  MessageEnvelope,
  MessageReaction,
  ReactionEmoji,
} from '@clubchat/shared';
import type {
  ActivityType,
  AroundWindow,
  CarGroupsView,
  ClubDetail,
  ClubRoster,
  ClubSearchResult,
  EboardDetail,
  EboardRoster,
  EventType,
  FeedItem,
  GalleryPage,
  HighlightPage,
  InboxPage,
  MeetingDetail,
  MeetingSummary,
  NewsPost,
  PollSummary,
  PollView,
  Profile,
  RaceDetail,
  RaceListItem,
  RaceRoster,
  ReportRow,
  RoutineDay,
} from './api-types.ts';
import { config } from './config.ts';
import { sessionStore } from './session.ts';

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}

/**
 * Call the API with the stored session token.
 *
 * Throws `ApiError` on a non-2xx, so a caller can distinguish "not found" from "offline" -
 * a thrown `TypeError` from fetch means the network, and every screen treats the two
 * differently.
 */
export async function apiFetch<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const token = await sessionStore.load();
  const response = await fetch(`${config.apiUrl}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${token ?? ''}`,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

  if (!response.ok) {
    let message = `request failed (${response.status})`;
    try {
      const parsed = (await response.json()) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch {
      /* a non-JSON body is still a failure, just an unhelpful one */
    }
    throw new ApiError(response.status, message);
  }

  // 204 and an empty body are legitimate for a delete.
  const text = await response.text();
  return (text.length > 0 ? JSON.parse(text) : {}) as T;
}

// ---------------------------------------------------------------------------
// Direct messages
// ---------------------------------------------------------------------------

export type DmThread = {
  conversationId: string;
  channelId: string;
  otherUserId: string;
  otherName: string;
  unread: number;
  canPost: boolean;
  muted: boolean;
  lastMessage: { body: string | null; seq: number; createdAt: string } | null;
};

export type DmCandidate = { userId: string; name: string };

/**
 * Somebody who could be added to a roster.
 *
 * Same shape for all three scopes, because the server answers all three from one query - the
 * pool and the exclusion differ, the row does not.
 */
export type MemberCandidate = { userId: string; name: string };

/**
 * Whether the composer is live, and why not.
 *
 * `unavailable` covers both "they blocked you" and "you no longer share a club", and does not
 * say which. That is the non-disclosing resolution of PRD/14's open question: the member learns
 * they cannot send, which is what they need, without learning they were specifically blocked,
 * which rule 6 keeps quiet in search and in notifications too.
 */
export type PostDeniedReason = 'you_blocked_them' | 'unavailable';

export type ChannelMeta = {
  channelId: string;
  scope: 'club' | 'race' | 'eboard' | 'dm';
  name: string;
  /** The SCOPE's own picture - a race's, the space's, the peer's - never the club's stand-in. */
  image: string | null;
  /** The scope the header quick-nav links into. `clubId` is null only for a dm. */
  scopeId: string;
  clubId: string | null;
  canPost: boolean;
  postDeniedReason: PostDeniedReason | null;
  canPin: boolean;
  /** Whether to OFFER the Reports tab. Never computed from canPin - see the server's note. */
  canReadReports: boolean;
  /**
   * Whether to offer the announcement toggle.
   *
   * **Never computed from `canPin`.** The two come apart in race chat, where pinning
   * additionally requires a roster row - so deriving one from the other offers the control to
   * the wrong set of people in exactly one scope, which is the kind of bug nothing catches.
   */
  canAnnounce: boolean;
  /** Whether to offer Delete on somebody else's message. Own messages never need it. */
  canDeleteAnyMessage: boolean;
  muted: boolean;
  peer: { userId: string; name: string; blockedByMe: boolean } | null;
};

export const dmApi = {
  threads: () => apiFetch<{ threads: DmThread[] }>('/dm/threads'),

  candidates: (query: string) =>
    apiFetch<{ candidates: DmCandidate[] }>(
      `/dm/candidates${query.trim().length > 0 ? `?q=${encodeURIComponent(query.trim())}` : ''}`,
    ),

  open: (userId: string) =>
    apiFetch<{ conversationId: string; channelId: string }>('/dm/threads', {
      method: 'POST',
      body: { userId },
    }),

  meta: (channelId: string) => apiFetch<ChannelMeta>(`/channels/${channelId}`),

  block: (userId: string) => apiFetch<unknown>('/blocks', { method: 'POST', body: { userId } }),

  unblock: (userId: string) => apiFetch<unknown>(`/blocks/${userId}`, { method: 'DELETE' }),

  mute: (channelId: string) =>
    apiFetch<unknown>(`/channels/${channelId}/mute`, { method: 'POST', body: {} }),

  unmute: (channelId: string) =>
    apiFetch<unknown>(`/channels/${channelId}/mute`, { method: 'DELETE' }),

  report: (channelId: string, seq: number) =>
    apiFetch<{ alreadyReported: boolean }>(`/channels/${channelId}/messages/${seq}/report`, {
      method: 'POST',
      body: {},
    }),

  /**
   * Toggle a reaction, returning the FULL resulting set rather than the delta.
   *
   * One endpoint for on and off. Deciding which to call in the client would be a
   * read-then-write across the network, racing the other device the same member is holding -
   * and the server's own toggle is a keyed delete-or-insert precisely so it cannot.
   */
  reactionToggle: (channelId: string, seq: number, emoji: ReactionEmoji) =>
    apiFetch<{ added: boolean; reactions: MessageReaction[] }>(
      `/channels/${channelId}/messages/${seq}/reactions`,
      { method: 'POST', body: { emoji } },
    ),

  /** Who reacted, for a who-reacted sheet. Reactions are visible to everyone with access. */
  reactionsFor: (channelId: string, seq: number) =>
    apiFetch<{ reactions: MessageReaction[] }>(
      `/channels/${channelId}/messages/${seq}/reactions`,
    ),
};

// ---------------------------------------------------------------------------
// Everything else
// ---------------------------------------------------------------------------
//
// One binding per route, grouped the way the routes are. The point is not brevity: it is that a
// screen never assembles a URL or a header, so a path that changes on the server changes in one
// place here. `clubs/index.tsx` used to build its own `fetch` with its own headers, which is the
// duplication this module exists to prevent - one screen forgetting the header is an
// unauthenticated request that reads as an empty list.

const query = (params: Record<string, string | number | undefined>): string => {
  const pairs = Object.entries(params).filter(([, v]) => v !== undefined && v !== '');
  return pairs.length === 0
    ? ''
    : `?${pairs.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')}`;
};

export const clubApi = {
  mine: () => apiFetch<{ clubs: Club[] }>('/clubs'),

  create: (body: { name: string; sport: string; description?: string; joinPolicy?: JoinPolicy }) =>
    apiFetch<{ clubId: string; mainChannelId: string; eboardId: string; inviteToken: string }>(
      '/clubs',
      { method: 'POST', body },
    ),

  detail: (clubId: string) => apiFetch<{ club: ClubDetail }>(`/clubs/${clubId}`),

  roster: (clubId: string) => apiFetch<ClubRoster>(`/clubs/${clubId}/members`),

  /** Clears that club's pending join-request notifications. Only opening the roster does. */
  rosterSeen: (clubId: string) =>
    apiFetch<{ cleared: number }>(`/clubs/${clubId}/members/seen`, { method: 'POST', body: {} }),

  search: (q: string) => apiFetch<{ clubs: ClubSearchResult[] }>(`/clubs/search${query({ q })}`),

  join: (clubId: string) =>
    apiFetch<{ status: 'joined' | 'requested'; role?: ClubRole }>(`/clubs/${clubId}/join`, {
      method: 'POST',
      body: {},
    }),

  redeemInvite: (token: string) =>
    apiFetch<{ status: 'joined' | 'requested' }>(`/invites/${token}/redeem`, {
      method: 'POST',
      body: {},
    }),

  rotateInvite: (clubId: string) =>
    apiFetch<{ inviteToken: string }>(`/clubs/${clubId}/invite-token/rotate`, {
      method: 'POST',
      body: {},
    }),

  setJoinPolicy: (clubId: string, joinPolicy: JoinPolicy) =>
    apiFetch<unknown>(`/clubs/${clubId}`, { method: 'PATCH', body: { joinPolicy } }),

  /**
   * Edit the club's identity, and optionally its join policy in the same request.
   *
   * An omitted field is left alone and an explicit null clears it - the two are different
   * instructions, which is why this takes `null` rather than treating an empty string as "remove".
   */
  update: (
    clubId: string,
    body: {
      name?: string;
      description?: string | null;
      image?: string | null;
      joinPolicy?: JoinPolicy;
    },
  ) => apiFetch<unknown>(`/clubs/${clubId}`, { method: 'PATCH', body }),

  /**
   * Who this club could add.
   *
   * People the caller already shares a club with, minus this club's current members - never a
   * global user directory. A stranger is reached with the invite link instead, which ADR-0010
   * makes the only front door anyway.
   */
  memberCandidates: (clubId: string, q: string) =>
    apiFetch<{ candidates: MemberCandidate[] }>(
      `/clubs/${clubId}/member-candidates${query({ q })}`,
    ),

  addMember: (clubId: string, userId: string) =>
    apiFetch<unknown>(`/clubs/${clubId}/members`, { method: 'POST', body: { userId } }),

  changeRole: (clubId: string, userId: string, role: 'admin' | 'member') =>
    apiFetch<unknown>(`/clubs/${clubId}/members/${userId}/role`, { method: 'PATCH', body: { role } }),

  removeMember: (clubId: string, userId: string) =>
    apiFetch<unknown>(`/clubs/${clubId}/members/${userId}`, { method: 'DELETE' }),

  leave: (clubId: string) =>
    apiFetch<unknown>(`/clubs/${clubId}/leave`, { method: 'POST', body: {} }),

  transferOwnership: (clubId: string, toUserId: string) =>
    apiFetch<unknown>(`/clubs/${clubId}/transfer-ownership`, { method: 'POST', body: { toUserId } }),

  remove: (clubId: string) => apiFetch<{ deleted: boolean }>(`/clubs/${clubId}`, { method: 'DELETE' }),

  decideRequest: (requestId: string, approve: boolean) =>
    apiFetch<unknown>(`/join-requests/${requestId}/${approve ? 'approve' : 'deny'}`, {
      method: 'POST',
      body: {},
    }),
};

export const raceApi = {
  list: (clubId: string, q?: string) =>
    apiFetch<{ races: RaceListItem[] }>(`/clubs/${clubId}/races${query({ q })}`),

  detail: (raceId: string) => apiFetch<{ race: RaceDetail }>(`/races/${raceId}`),

  create: (clubId: string, body: { name: string; raceDate: string }) =>
    apiFetch<{ raceId: string; channelId: string }>(`/clubs/${clubId}/races`, {
      method: 'POST',
      body,
    }),

  remove: (raceId: string) => apiFetch<unknown>(`/races/${raceId}`, { method: 'DELETE' }),

  /**
   * The race's own identity. An omitted field is left alone; an explicit null clears it.
   *
   * The opposite rule to `saveMeetInformation` below, which treats an omitted field as cleared -
   * the two are one form saved whole versus three facts touched from two different controls.
   */
  update: (
    raceId: string,
    body: { name?: string; raceDate?: string; image?: string | null },
  ) => apiFetch<unknown>(`/races/${raceId}`, { method: 'PATCH', body }),

  /** All five fields as one form: an absent field is cleared, not kept. */
  saveMeetInformation: (
    raceId: string,
    body: {
      meetDescription?: string | null;
      meetLocationUrl?: string | null;
      meetHotelUrl?: string | null;
      meetPhotosUrl?: string | null;
      meetResultsUrl?: string | null;
    },
  ) => apiFetch<unknown>(`/races/${raceId}/meet-information`, { method: 'PATCH', body }),

  /** Personal. Affects only the pinner's own hub, never anybody else's. */
  setPin: (raceId: string, pinned: boolean) =>
    apiFetch<{ pinned: boolean }>(`/races/${raceId}/pin`, { method: 'POST', body: { pinned } }),

  roster: (raceId: string) => apiFetch<RaceRoster>(`/races/${raceId}/members`),

  rosterSeen: (raceId: string) =>
    apiFetch<{ cleared: number }>(`/races/${raceId}/members/seen`, { method: 'POST', body: {} }),

  requestAccess: (raceId: string) =>
    apiFetch<{ status: 'requested' }>(`/races/${raceId}/join-requests`, {
      method: 'POST',
      body: {},
    }),

  decideRequest: (requestId: string, approve: boolean) =>
    apiFetch<unknown>(`/race-join-requests/${requestId}/${approve ? 'approve' : 'deny'}`, {
      method: 'POST',
      body: {},
    }),

  /** Members of this race's own club who are not already on the roster. */
  memberCandidates: (raceId: string, q: string) =>
    apiFetch<{ candidates: MemberCandidate[] }>(
      `/races/${raceId}/member-candidates${query({ q })}`,
    ),

  addMember: (raceId: string, userId: string) =>
    apiFetch<unknown>(`/races/${raceId}/members`, { method: 'POST', body: { userId } }),

  removeMember: (raceId: string, userId: string) =>
    apiFetch<unknown>(`/races/${raceId}/members/${userId}`, { method: 'DELETE' }),

  carGroups: (raceId: string) => apiFetch<CarGroupsView>(`/races/${raceId}/car-groups`),

  createCarGroup: (raceId: string) =>
    apiFetch<{ groupId: string; number: number }>(`/races/${raceId}/car-groups`, {
      method: 'POST',
      body: {},
    }),

  assignToCarGroup: (groupId: string, userId: string) =>
    apiFetch<unknown>(`/car-groups/${groupId}/members`, { method: 'POST', body: { userId } }),

  /** Null clears it. The Incharge must be a current member of that group. */
  setIncharge: (groupId: string, userId: string | null) =>
    apiFetch<{ inchargeUserId: string | null }>(`/car-groups/${groupId}/incharge`, {
      method: 'PATCH',
      body: { userId },
    }),

  leaveCarGroup: (raceId: string, userId: string) =>
    apiFetch<unknown>(`/races/${raceId}/car-group-members/${userId}`, { method: 'DELETE' }),
};

/** The scope a poll belongs to. The path names it; there is no body field for it. */
export type PollScope = 'clubs' | 'races' | 'eboards';

export const pollApi = {
  list: (scope: PollScope, scopeId: string) =>
    apiFetch<{ polls: PollSummary[] }>(`/${scope}/${scopeId}/polls`),

  create: (
    scope: PollScope,
    scopeId: string,
    body: {
      question: string;
      options: string[];
      allowMultiple?: boolean;
      isPrivate?: boolean;
      closesInMinutes?: number | null;
    },
  ) => apiFetch<{ pollId: string }>(`/${scope}/${scopeId}/polls`, { method: 'POST', body }),

  detail: (pollId: string) => apiFetch<{ poll: PollView }>(`/polls/${pollId}`),

  /** Cast, move or withdraw - one gesture. Addressed by option, which identifies its poll. */
  vote: (optionId: string) =>
    apiFetch<{ action: 'cast' | 'withdrawn' | 'moved' }>(`/poll-options/${optionId}/vote`, {
      method: 'POST',
      body: {},
    }),

  setClosed: (pollId: string, closed: boolean) =>
    apiFetch<{ closed: boolean }>(`/polls/${pollId}/closed`, { method: 'POST', body: { closed } }),

  remove: (pollId: string) => apiFetch<unknown>(`/polls/${pollId}`, { method: 'DELETE' }),
};

export const contentApi = {
  meetings: (eboardId: string, when: 'upcoming' | 'past') =>
    apiFetch<{ meetings: MeetingSummary[] }>(`/eboards/${eboardId}/meetings${query({ when })}`),

  meeting: (meetingId: string) => apiFetch<{ meeting: MeetingDetail }>(`/meetings/${meetingId}`),

  createMeeting: (
    eboardId: string,
    body: { title: string; description?: string | null; startsAt: string; link?: string | null },
  ) => apiFetch<{ meetingId: string }>(`/eboards/${eboardId}/meetings`, { method: 'POST', body }),

  updateMeeting: (
    meetingId: string,
    body: { title?: string; description?: string | null; startsAt?: string; link?: string | null },
  ) => apiFetch<unknown>(`/meetings/${meetingId}`, { method: 'PATCH', body }),

  deleteMeeting: (meetingId: string) =>
    apiFetch<unknown>(`/meetings/${meetingId}`, { method: 'DELETE' }),

  createEvent: (
    clubId: string,
    body: {
      type: EventType;
      title: string;
      startsAt: string;
      endsAt?: string | null;
      location?: string | null;
      description?: string | null;
    },
  ) => apiFetch<{ eventId: string }>(`/clubs/${clubId}/events`, { method: 'POST', body }),

  deleteEvent: (eventId: string) => apiFetch<unknown>(`/events/${eventId}`, { method: 'DELETE' }),

  /** The Monday is required: "this week" is a question about the caller's timezone. */
  routines: (clubId: string, monday: string) =>
    apiFetch<{ days: RoutineDay[] }>(`/clubs/${clubId}/routines${query({ monday })}`),

  createWorkout: (
    clubId: string,
    body: {
      workoutDate: string;
      activityType: ActivityType;
      title: string;
      description?: string | null;
    },
  ) => apiFetch<{ workoutId: string }>(`/clubs/${clubId}/workouts`, { method: 'POST', body }),

  deleteWorkout: (workoutId: string) =>
    apiFetch<unknown>(`/workouts/${workoutId}`, { method: 'DELETE' }),

  news: (clubId: string, before?: string) =>
    apiFetch<{ posts: NewsPost[]; hasMore: boolean }>(`/clubs/${clubId}/news${query({ before })}`),

  newsPost: (postId: string) => apiFetch<{ post: NewsPost }>(`/news/${postId}`),

  createNews: (clubId: string, body: { body?: string | null; mediaId?: string | null }) =>
    apiFetch<{ postId: string }>(`/clubs/${clubId}/news`, { method: 'POST', body }),

  updateNews: (postId: string, body: { body?: string | null; mediaId?: string | null }) =>
    apiFetch<unknown>(`/news/${postId}`, { method: 'PATCH', body }),

  deleteNews: (postId: string) => apiFetch<unknown>(`/news/${postId}`, { method: 'DELETE' }),

  /** The same emoji set as chat, which a check constraint on the column also enforces. */
  toggleNewsReaction: (postId: string, emoji: ReactionEmoji) =>
    apiFetch<{ reacted: boolean }>(`/news/${postId}/reactions`, { method: 'POST', body: { emoji } }),
};

export const calendarApi = {
  /** Omit `club` for the cross-club view, which tags each row and offers no create action. */
  feed: (opts: { club?: string; when?: 'upcoming' | 'past' | 'all' } = {}) =>
    apiFetch<{ items: FeedItem[] }>(`/calendar${query({ club: opts.club, when: opts.when })}`),

  markers: (opts: { club?: string; year: number; month: number }) =>
    apiFetch<{ days: string[] }>(`/calendar/markers${query(opts)}`),
};

export const eboardApi = {
  detail: (eboardId: string) => apiFetch<{ eboard: EboardDetail }>(`/eboards/${eboardId}`),

  /** Members only. A club admin outside the space can read it but not rename it. */
  update: (
    eboardId: string,
    body: { name?: string; description?: string | null; image?: string | null },
  ) => apiFetch<unknown>(`/eboards/${eboardId}`, { method: 'PATCH', body }),

  roster: (eboardId: string) => apiFetch<EboardRoster>(`/eboards/${eboardId}/members`),

  rosterSeen: (eboardId: string) =>
    apiFetch<{ cleared: number }>(`/eboards/${eboardId}/members/seen`, {
      method: 'POST',
      body: {},
    }),

  /** The path nobody uses in normal operation: an admin who deliberately left. */
  requestAccess: (eboardId: string) =>
    apiFetch<{ status: 'requested' }>(`/eboards/${eboardId}/join-requests`, {
      method: 'POST',
      body: {},
    }),

  decideRequest: (requestId: string, approve: boolean) =>
    apiFetch<unknown>(`/eboard-join-requests/${requestId}/${approve ? 'approve' : 'deny'}`, {
      method: 'POST',
      body: {},
    }),

  /**
   * The club's admin tier, minus those already in the space.
   *
   * Narrower than the other two on purpose: `addEboardMember` refuses a plain member, so
   * offering one here would be a search result that fails on tap.
   */
  memberCandidates: (eboardId: string, q: string) =>
    apiFetch<{ candidates: MemberCandidate[] }>(
      `/eboards/${eboardId}/member-candidates${query({ q })}`,
    ),

  addMember: (eboardId: string, userId: string) =>
    apiFetch<unknown>(`/eboards/${eboardId}/members`, { method: 'POST', body: { userId } }),

  removeMember: (eboardId: string, userId: string) =>
    apiFetch<unknown>(`/eboards/${eboardId}/members/${userId}`, { method: 'DELETE' }),
};

export const inboxApi = {
  page: (cursor?: string) => apiFetch<InboxPage>(`/notifications${query({ cursor })}`),

  badge: () => apiFetch<{ count: number }>('/notifications/badge'),

  /**
   * Opening the inbox.
   *
   * Clears the badge and NOT the chat-unread rows (only opening that chat does) and NOT the
   * pending join requests (only opening the relevant roster does).
   */
  markRead: () =>
    apiFetch<{ cleared: number; badge: number }>('/notifications/read', {
      method: 'POST',
      body: {},
    }),
};

export const accountApi = {
  /**
   * The signed-in identity.
   *
   * **The only read that carries an email.** A profile read never does, in either shape - see the
   * server's note on `readIdentity`. So a screen wanting to show the viewer their own address asks
   * here rather than reaching into a profile for it.
   */
  me: () =>
    apiFetch<{ userId: string; email: string; clubs: Array<{ clubId: string; role: ClubRole }> }>(
      '/me',
    ),

  profile: (userId: string) => apiFetch<{ profile: Profile }>(`/users/${userId}`),

  /** Self only. There is deliberately no route that takes somebody else's id. */
  saveProfile: (body: {
    name?: string;
    bio?: string | null;
    city?: string | null;
    school?: string | null;
    dob?: string | null;
    image?: string | null;
  }) => apiFetch<{ profile: Profile }>('/me/profile', { method: 'PATCH', body }),

  /** 409 `owns_clubs` until every owned club is transferred or deleted. */
  deleteAccount: () => apiFetch<{ deleted: true }>('/me', { method: 'DELETE' }),
};

export const channelApi = {
  meta: (channelId: string) => apiFetch<ChannelMeta>(`/channels/${channelId}`),

  /** Highlights: over the whole channel, so a pin past the loaded page is still found. */
  pinned: (channelId: string, before?: number) =>
    apiFetch<HighlightPage>(`/channels/${channelId}/pinned${query({ before })}`),

  announcements: (channelId: string, before?: number) =>
    apiFetch<HighlightPage>(`/channels/${channelId}/announcements${query({ before })}`),

  reports: (channelId: string) =>
    apiFetch<{ reports: ReportRow[] }>(`/channels/${channelId}/reports`),

  /**
   * Clear a report without touching the message.
   *
   * The two resolutions are deliberately separate: dismissing says "I looked, this is fine", and
   * deleting says "this had to go". Deleting is the harsher one and does NOT imply the other, so
   * a screen that deletes should dismiss too, or the report sits in the queue forever with
   * nothing left to act on.
   */
  dismissReport: (reportId: string) =>
    apiFetch<unknown>(`/moderation/reports/${reportId}/dismiss`, { method: 'POST', body: {} }),

  /** The window jump-to-message needs. Paging back from the tail cannot do it in one tap. */
  around: (channelId: string, around: number, radius?: number) =>
    apiFetch<AroundWindow>(`/channels/${channelId}/messages/around${query({ around, radius })}`),

  gallery: (channelId: string, before?: number) =>
    apiFetch<GalleryPage>(`/channels/${channelId}/gallery${query({ before })}`),

  setPinned: (channelId: string, seq: number, pinned: boolean) =>
    apiFetch<{ message: MessageEnvelope }>(`/channels/${channelId}/messages/${seq}/pinned`, {
      method: 'POST',
      body: { pinned },
    }),

  deleteMessage: (channelId: string, seq: number) =>
    apiFetch<{ message: MessageEnvelope }>(`/channels/${channelId}/messages/${seq}`, {
      method: 'DELETE',
    }),
};

// ---------------------------------------------------------------------------
// Media URLs
// ---------------------------------------------------------------------------

/**
 * Resolved media URLs, memoized in process.
 *
 * > **The memo is sound because of the hour alignment, not in spite of it.** The signed URL is
 * > byte-identical for every viewer inside a window, which is exactly what makes it safe to hold
 * > and share - the same property that turns 300 members looking at one photo into one CDN cache
 * > entry instead of 300 origin fetches.
 *
 * Keyed by media id and variant. Dropped once past its expiry, so a client that stays open
 * across the hour boundary re-resolves rather than rendering a broken image.
 */
const mediaUrlMemo = new Map<string, { url: string; expiresAt: number }>();

export type MediaVariant = 'original' | 'display' | 'thumb';

/**
 * Turn a media id into a fetchable URL, through the authorized hop.
 *
 * Every resolve is an authorization decision re-evaluated server-side, which is why this is a
 * request and not a string template. The result is only a URL for bytes whose key is already
 * unguessable - it grants fetchability, never access.
 */
export async function resolveMediaUrl(
  mediaId: string,
  variant: MediaVariant = 'display',
): Promise<string> {
  const key = `${mediaId}:${variant}`;
  const held = mediaUrlMemo.get(key);
  // A minute of headroom, so a URL is never handed out with less life left than the request
  // that uses it might take.
  if (held && held.expiresAt - Date.now() > 60_000) return held.url;

  const resolved = await apiFetch<{ url: string; expiresAt: string }>(
    `/media/${mediaId}/url?variant=${variant}`,
  );
  mediaUrlMemo.set(key, {
    url: resolved.url,
    expiresAt: new Date(resolved.expiresAt).getTime(),
  });
  return resolved.url;
}
