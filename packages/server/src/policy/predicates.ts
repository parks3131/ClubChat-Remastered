/**
 * The policy module. Every authorization predicate in the system, defined here and
 * nowhere else.
 *
 * The rule that makes this file worth having: **a predicate restated in many places
 * will eventually be restated wrongly**, and that is the single most reliable source
 * of authorization bugs. No handler may re-derive one of these inline, ever.
 *
 * See SPEC/TECH/05-authorization.md and SPEC/PRD/02-roles-and-permissions.md.
 */

import { ADMIN_TIER, type ClubRole } from '@clubchat/shared';
import type { AccessContext } from './context.ts';

/** Just enough of a channel to authorize against, without loading the whole row. */
export type ChannelRef = {
  readonly id: string;
  readonly scope: 'club' | 'race' | 'eboard' | 'dm';
  readonly clubId: string | null;
  /** club id, race id, eboard id, or dm conversation id, per scope. */
  readonly scopeId: string;
};

// ---------------------------------------------------------------------------
// Club tier
// ---------------------------------------------------------------------------

export const isClubMember = (ctx: AccessContext, clubId: string): boolean =>
  ctx.clubRole.has(clubId);

/**
 * The admin tier, and the single most important line in this file.
 *
 * Owner is a strict superset of Admin, so this must match BOTH. A check for "admin"
 * alone silently excludes a club whose only admin-tier member is the Owner - which
 * is every brand-new club. That exact bug shipped four separate times in v1, plus a
 * fifth instance found later in a helper, because the predicate was copy-pasted per
 * policy instead of existing once. It now exists once.
 */
export const isClubAdmin = (ctx: AccessContext, clubId: string): boolean => {
  const role = ctx.clubRole.get(clubId);
  return role !== undefined && ADMIN_TIER.includes(role);
};

export const isClubOwner = (ctx: AccessContext, clubId: string): boolean =>
  ctx.clubRole.get(clubId) === 'owner';

// ---------------------------------------------------------------------------
// Channel access - one implementation, four scopes
// ---------------------------------------------------------------------------

/**
 * May this user read and post in this channel?
 *
 * Note that the race branch consults the roster set and NOT club-admin status.
 * Management authority is not access: a club admin may manage every race in the club
 * and still have no right to open its chat. Nothing in this codebase may write
 * `isClubAdmin(ctx, race.clubId)` where race access is meant.
 */
export const isChannelMember = (ctx: AccessContext, ch: ChannelRef): boolean => {
  switch (ch.scope) {
    case 'club':
      return isClubMember(ctx, ch.scopeId);
    case 'eboard':
      return ctx.eboardMember.has(ch.scopeId);
    case 'race':
      return ctx.raceRoster.has(ch.scopeId);
    case 'dm':
      return ctx.dmThreads.has(ch.scopeId);
  }
};

/**
 * May this user pin, or post an announcement, in this channel?
 *
 * The `dm` branch returning false is the entire cost of adding direct messages to
 * the admin model (ADR-0009). Announcements, poll creation and admin-only pins are
 * each already gated on this one predicate, so all three fall away for DMs
 * automatically rather than needing a per-feature branch.
 *
 * The race branch requires BOTH a roster row and club-admin status. An admin who is
 * not on the roster cannot pin in a chat they cannot even open.
 */
export const isChannelAdmin = (ctx: AccessContext, ch: ChannelRef): boolean => {
  switch (ch.scope) {
    case 'club':
      return isClubAdmin(ctx, ch.scopeId);
    case 'eboard':
      // Every Eboard member is already a club admin, so there is no further role
      // distinction inside the space. Membership is the admin check.
      return ctx.eboardMember.has(ch.scopeId);
    case 'race':
      return ch.clubId !== null && ctx.raceRoster.has(ch.scopeId) && isClubAdmin(ctx, ch.clubId);
    case 'dm':
      return false;
  }
};

export const canPostInChannel = isChannelMember;
export const canPinInChannel = isChannelAdmin;
export const canAnnounceInChannel = isChannelAdmin;

/**
 * May this user delete this message?
 *
 * Its sender, or an admin of that space. In a DM `isChannelAdmin` is false for both
 * participants, so neither can delete the other's message - which is correct and
 * deliberate: the admin who would hold that power in club chat does not exist there,
 * and moderation in a DM is blocking plus reporting rather than deletion.
 */
export const canDeleteMessage = (
  ctx: AccessContext,
  ch: ChannelRef,
  message: { senderId: string },
): boolean => {
  if (!isChannelMember(ctx, ch)) return false;
  return message.senderId === ctx.userId || isChannelAdmin(ctx, ch);
};

/** Anyone with access may report a message they did not send. */
export const canReportMessage = (
  ctx: AccessContext,
  ch: ChannelRef,
  message: { senderId: string },
): boolean => isChannelMember(ctx, ch) && message.senderId !== ctx.userId;

// ---------------------------------------------------------------------------
// Club administration
// ---------------------------------------------------------------------------

export const canEditClub = isClubAdmin;
export const canShareInviteLink = isClubAdmin;
export const canRotateInviteToken = isClubAdmin;
export const canManageJoinRequests = isClubAdmin;
export const canAddMemberDirectly = isClubAdmin;
export const canDeleteClub = isClubOwner;
export const canTransferOwnership = isClubOwner;

/**
 * Promote a Member to Admin, or demote an Admin to Member. Any admin may do this.
 *
 * Deliberately asymmetric with `canRemoveMember` below: admins policing each other's
 * role is normal, but ejecting each other is not. The Owner's role is never writable
 * this way - it moves only through the ownership-transfer path.
 */
export const canChangeRole = (
  ctx: AccessContext,
  clubId: string,
  target: { role: ClubRole },
): boolean => isClubAdmin(ctx, clubId) && target.role !== 'owner';

/**
 * Remove someone from the club.
 *
 * Any admin may remove a plain Member. Removing an Admin is **Owner-only**. The
 * Owner can never be removed at all - transfer is the only path, because an
 * ownerless club has no recovery path.
 */
export const canRemoveMember = (
  ctx: AccessContext,
  clubId: string,
  target: { role: ClubRole; userId: string },
): boolean => {
  if (target.role === 'owner') return false;
  if (target.userId === ctx.userId) return false; // that is leaving, not removing
  if (target.role === 'admin') return isClubOwner(ctx, clubId);
  return isClubAdmin(ctx, clubId);
};

/**
 * Leave the club.
 *
 * The Owner cannot leave their own club, and per PRD/04 the Leave action is not even
 * rendered for them. Enforced here as well, because a hidden button is UX and never
 * enforcement.
 */
export const canLeaveClub = (ctx: AccessContext, clubId: string): boolean =>
  isClubMember(ctx, clubId) && !isClubOwner(ctx, clubId);

// ---------------------------------------------------------------------------
// Eboard
// ---------------------------------------------------------------------------

export const isEboardMember = (ctx: AccessContext, eboardId: string): boolean =>
  ctx.eboardMember.has(eboardId);

// ---------------------------------------------------------------------------
// Races: the authority-versus-access boundary
// ---------------------------------------------------------------------------

/** Just enough of a race to authorize against. */
export type RaceRef = { readonly id: string; readonly clubId: string };

/**
 * On the roster. **The only proof of race access.**
 *
 * Reads `raceRoster` and nothing else. Nothing in this codebase may write
 * `isClubAdmin(ctx, race.clubId)` where race ACCESS is meant - that substitution was wrong
 * in five separate places in v1, and the two predicates are named differently precisely so
 * the distinction cannot be collapsed by accident.
 */
export const isRaceMember = (ctx: AccessContext, race: RaceRef): boolean =>
  ctx.raceRoster.has(race.id);

/**
 * A manager of the race: any admin of its club.
 *
 * **Management authority, not access.** A manager may approve and add roster members, edit
 * Meet Information, manage car groups and delete the race - and may not read its chat, vote
 * in its polls, or be assigned to a car group. Auto-joining every admin to every race was
 * built in v1 and then reversed, because an admin auto-added to 30 races drowns in chat for
 * races they are not running.
 */
export const isRaceManager = (ctx: AccessContext, race: RaceRef): boolean =>
  isClubAdmin(ctx, race.clubId);

/** Reading and posting in race chat requires a roster row. Managers included. */
export const canPostInRace = isRaceMember;

/** Pinning or announcing in race chat requires BOTH a roster row and club-admin status. */
export const canPinInRace = (ctx: AccessContext, race: RaceRef): boolean =>
  isRaceMember(ctx, race) && isClubAdmin(ctx, race.clubId);

/** Approving, adding, removing, editing Meet Information, deleting the race. */
export const canManageRace = isRaceManager;

/**
 * Meet Information is readable by **any club member**, including those with no race access.
 *
 * Deliberate: it is exactly the information someone needs in order to decide whether to ask
 * to go. Hiding it would make the request-to-join decision uninformed.
 */
export const canReadMeetInformation = (ctx: AccessContext, race: RaceRef): boolean =>
  isClubMember(ctx, race.clubId);

/** Every club member can see that a race exists, whether or not they can enter it. */
export const canSeeRace = canReadMeetInformation;

/** Requesting to join. Any club member not already on the roster, managers included. */
export const canRequestRaceAccess = (ctx: AccessContext, race: RaceRef): boolean =>
  isClubMember(ctx, race.clubId) && !isRaceMember(ctx, race);

/**
 * Being assigned to a car group requires real race access.
 *
 * So an admin who is not on the roster cannot be put in a car, **even though they manage
 * the groups**. That asymmetry is the clearest expression of authority not being access.
 */
export const canBeInCarGroup = isRaceMember;

/** Viewing the groups. Any race member, read-only unless they also manage. */
export const canViewCarGroups = isRaceMember;

/** Creating, deleting, assigning, and setting the Incharge. Managers only. */
export const canManageCarGroups = isRaceManager;

/**
 * Pinning a race is personal and is **not** admin-gated.
 *
 * Any member can pin any race they can see. Club-wide admin pins were built in v1 and then
 * corrected.
 */
export const canPinRace = canSeeRace;

// ---------------------------------------------------------------------------
// Polls
// ---------------------------------------------------------------------------

export type PollRef = {
  readonly id: string;
  readonly clubId: string;
  readonly scope: 'club' | 'race' | 'eboard';
  readonly scopeId: string;
  readonly creatorId: string;
  readonly isPrivate: boolean;
};

/**
 * Seeing and voting in a poll.
 *
 * Scope determines the audience, and the race branch is the one that matters: **only race
 * roster members**, never roster union club admins. A race poll must be invisible to an
 * admin without a roster row, including by direct URL.
 */
export const canAccessPoll = (ctx: AccessContext, poll: PollRef): boolean => {
  switch (poll.scope) {
    case 'club':
      return isClubMember(ctx, poll.clubId);
    case 'race':
      return ctx.raceRoster.has(poll.scopeId);
    case 'eboard':
      return ctx.eboardMember.has(poll.scopeId);
  }
};

/**
 * Creating a poll.
 *
 * Club: any club admin. Race: **both** a club admin AND on the roster. Eboard: any member
 * of the space, with no further role distinction inside.
 */
export const canCreatePoll = (
  ctx: AccessContext,
  scope: { scope: 'club' | 'race' | 'eboard'; clubId: string; scopeId: string },
): boolean => {
  switch (scope.scope) {
    case 'club':
      return isClubAdmin(ctx, scope.clubId);
    case 'race':
      return ctx.raceRoster.has(scope.scopeId) && isClubAdmin(ctx, scope.clubId);
    case 'eboard':
      return ctx.eboardMember.has(scope.scopeId);
  }
};

/**
 * Closing, reopening or deleting a poll: **the creator only**.
 *
 * In every scope, including a club poll created by another admin. An admin who did not
 * create it cannot close it, which is why this reads `creatorId` and never a role.
 */
export const canManagePoll = (ctx: AccessContext, poll: PollRef): boolean =>
  poll.creatorId === ctx.userId;

/** Voting requires access and an open poll. Closed-ness is the caller's read-time check. */
export const canVoteInPoll = canAccessPoll;

/**
 * Seeing WHO voted for what.
 *
 * Counts are always public, on every poll including private ones. Identity is gated: on a
 * public poll everyone eligible can see it, on a private poll **only the creator** can. A
 * voter always sees their own vote either way, which is the caller's concern rather than
 * this predicate's.
 */
export const canSeePollVoters = (ctx: AccessContext, poll: PollRef): boolean => {
  if (!canAccessPoll(ctx, poll)) return false;
  return !poll.isPrivate || poll.creatorId === ctx.userId;
};

// ---------------------------------------------------------------------------
// Meetings, and club content
// ---------------------------------------------------------------------------

/** Any Eboard member creates a meeting. No further role distinction inside the space. */
export const canCreateMeeting = isEboardMember;

/** Only the meeting's creator edits or deletes it. Everyone else is view-only. */
export const canManageMeeting = (
  ctx: AccessContext,
  meeting: { creatorId: string },
): boolean => meeting.creatorId === ctx.userId;

/** Calendar events, routines and news: any club admin, any item. Not only its author. */
export const canManageClubContent = isClubAdmin;

/** Every club member reads club content and reacts to news. */
export const canReadClubContent = isClubMember;

/**
 * Only club admins can even see that the Eboard space exists. Ordinary members have
 * no visibility of it, its chat, its meetings or its polls.
 */
export const canSeeEboardExists = isClubAdmin;

/** Approving requests and adding members is restricted to existing members. */
export const canManageEboardMembers = isEboardMember;

/** Removing another Eboard member is the club Owner's call alone. */
export const canRemoveEboardMember = (
  ctx: AccessContext,
  clubId: string,
  eboardId: string,
  target: { userId: string },
): boolean =>
  isClubOwner(ctx, clubId) && isEboardMember(ctx, eboardId) && target.userId !== ctx.userId;
