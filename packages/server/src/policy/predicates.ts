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
