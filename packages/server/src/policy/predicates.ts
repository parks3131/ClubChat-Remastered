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
// The session itself
// ---------------------------------------------------------------------------

/**
 * May this session act at all?
 *
 * Asked at both entry points - the HTTP hook and the gateway's `auth` frame - because
 * **blocking an account does not invalidate a token it already holds**. Without a per-request
 * question, a deleted or shut-off account keeps working until its session expires.
 *
 * > It gets a name here, rather than staying an inline field read, because it had been written
 * > inline twice and was wrong in both places: each site asked better-auth's session user for
 * > `signinBlockedAt`, a property that object does not carry, so both checks read `undefined`
 * > and neither ever fired. One predicate over a context loaded from our own table has one
 * > behaviour, and a test can reach it.
 */
export const isSessionUsable = (ctx: AccessContext): boolean => !ctx.signinBlocked;

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
 * May this user READ this channel?
 *
 * Note that the race branch consults the roster set and NOT club-admin status.
 * Management authority is not access: a club admin may manage every race in the club
 * and still have no right to open its chat. Nothing in this codebase may write
 * `isClubAdmin(ctx, race.clubId)` where race access is meant.
 *
 * Read and post were the same question until DMs arrived, and this is the read half. See
 * `canPostInChannel` for why they had to separate: a blocked participant still reads.
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
 * Is this user an admin OF this space?
 *
 * The `dm` branch returning false is what removes announcements, poll creation and
 * admin-only pins from the scope automatically: each was already gated on this one
 * predicate, so none needed a per-feature branch (ADR-0009).
 *
 * **It is not, however, the whole cost of the scope.** Two capabilities turned out not to be
 * expressible through it - posting, because a DM participant can lose the right to send
 * without losing the right to read, and pinning, because PRD/14 grants it to both
 * participants. Both are named predicates of their own below rather than callers reaching for
 * this one and getting the wrong answer.
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

// ---------------------------------------------------------------------------
// Direct messages, and member safety
// ---------------------------------------------------------------------------

/**
 * A person this user might open a conversation with.
 *
 * Carries the candidate's club ids because `sharesAClub` has to be a **pure function** and
 * the intersection is a join. The caller loads the candidate; the rule stays here.
 */
export type DmCandidate = {
  readonly userId: string;
  readonly clubIds: readonly string[];
};

/** A participant in this conversation. The membership predicate for the fourth scope. */
export const isDmParticipant = (ctx: AccessContext, conversationId: string): boolean =>
  ctx.dmThreads.has(conversationId);

/**
 * The thread this user holds with that person, if any.
 *
 * There is exactly one thread per pair of people, ever (PRD/14 rule 2), so this is a lookup
 * and not a list. Scanning the map is fine: it is bounded by how many people someone talks to.
 */
export const dmThreadWith = (ctx: AccessContext, otherUserId: string) => {
  for (const thread of ctx.dmThreads.values()) {
    if (thread.otherUserId === otherUserId) return thread;
  }
  return undefined;
};

/**
 * Blocked in either direction.
 *
 * Symmetric by construction: the context collapsed both directions into one set when it
 * loaded, so there is no way to read only half of a block from here. That is deliberate -
 * a one-directional check is the shape of the bug, not of the feature.
 */
export const isBlocked = (ctx: AccessContext, otherUserId: string): boolean =>
  ctx.blockedEither.has(otherUserId);

/**
 * Share at least one club.
 *
 * The eligibility rule for the whole feature: a DM exists only between members who share a
 * club, and there is no global user search (PRD/14 rule 1). It is the same rule that makes
 * profiles visible, which is why ADR-0009 rejected global DMs.
 */
export const sharesAClub = (ctx: AccessContext, other: DmCandidate): boolean =>
  other.clubIds.some((clubId) => ctx.clubRole.has(clubId));

/**
 * May this user start, or be shown, a conversation with this person?
 *
 * Also the search filter: a blocked user must not appear in the blocker's results, and the
 * blocker must not appear in theirs - "no result, indistinguishable from no such member".
 */
export const canOpenDm = (ctx: AccessContext, other: DmCandidate): boolean =>
  other.userId !== ctx.userId && sharesAClub(ctx, other) && !isBlocked(ctx, other.userId);

/**
 * May this user send into an existing conversation?
 *
 * Three conditions, and each corresponds to one PRD/14 rule: participation, a surviving
 * shared club (rule 3), and no block in either direction (rule 6). Read access requires only
 * the first, which is what keeps history visible in both of the refusing cases.
 *
 * Re-evaluated on every send rather than inherited from the subscription, which is what makes
 * "their queued but unsent messages never arrive" true: the queued send is authorized when it
 * is finally attempted, and by then the block exists.
 */
export const canPostInDm = (ctx: AccessContext, conversationId: string): boolean => {
  const thread = ctx.dmThreads.get(conversationId);
  if (!thread) return false;
  return thread.sharesClub && !isBlocked(ctx, thread.otherUserId);
};

/**
 * May this user block that one?
 *
 * Anyone who could otherwise reach them: a person they share a club with, or a person they
 * already hold a thread with. The second half matters because losing the last shared club
 * must not strip the ability to block someone whose messages are still sitting in history.
 *
 * **Blocking is never gated on a review and never on a thread existing yet.** A member
 * protecting themselves must not have to wait, and must not have to be messaged first.
 */
export const canBlock = (
  ctx: AccessContext,
  other: DmCandidate & { hasThreadWith?: boolean },
): boolean => {
  if (other.userId === ctx.userId) return false;
  return sharesAClub(ctx, other) || other.hasThreadWith === true;
};

/**
 * Unblocking is always allowed.
 *
 * Deleting your own block row needs no further authority, and gating it on a surviving shared
 * club would leave someone permanently blocked with no way to undo it.
 */
export const canUnblock = (ctx: AccessContext, otherUserId: string): boolean =>
  otherUserId !== ctx.userId;

/** Muting is per member and applies to every scope. Reading the chat is the whole check. */
export const canMuteChannel = isChannelMember;

/**
 * May this user pin this conversation to the top of their own list?
 *
 * Reading it is the whole check, because a **conversation** pin is personal and unobservable by
 * anybody else. Note this is emphatically not `canPinInChannel`, which is about pinning a
 * **message** - an act of authority in a shared room that an admin performs and everybody sees.
 * The two share a word and nothing else, and giving this its own name is the mitigation for the
 * alias trap in AGENTS.md failure mode 10: the day somebody restricts message pinning, this must
 * not move with it.
 */
export const canPinChannel = isChannelMember;

/**
 * May this user clear their own view of this conversation?
 *
 * **Direct messages only, and that is a product decision rather than a technical limit.** The
 * clear floor is scope-agnostic and would work identically on a club chat; "Delete chat" is
 * offered only on a DM, and a capability reachable over HTTP but offered nowhere is the shape
 * Phase 2 shipped a whole domain in. If clubs ever want it, this is one branch.
 */
export const canClearChannel = (ctx: AccessContext, channel: ChannelRef): boolean =>
  channel.scope === 'dm' && isChannelMember(ctx, channel);

/**
 * May this user post here **now**?
 *
 * > **This is the one place where posting stopped being the same thing as membership.**
 * >
 * > For club, race and Eboard it still is: if you can read it you can post in it. A DM adds
 * > two ways to be a participant who may not send - the pair no longer shares a club
 * > (PRD/14 rule 3, read-only rather than deleted) or one of them has blocked the other
 * > (rule 6). Both leave history fully readable, so they cannot be expressed by taking
 * > membership away.
 *
 * Keeping `canPostInChannel` an alias of `isChannelMember` would have silently granted a
 * blocked member the right to send, since `isChannelMember` is what the subscription and the
 * history read are gated on and both must keep saying yes.
 */
export const canPostInChannel = (ctx: AccessContext, ch: ChannelRef): boolean => {
  if (!isChannelMember(ctx, ch)) return false;
  if (ch.scope === 'dm') return canPostInDm(ctx, ch.scopeId);
  return true;
};

/**
 * May this user pin a message here?
 *
 * Admin of the space in the three group scopes - and **either participant in a DM**, which is
 * the one place pinning parts company from `isChannelAdmin`. PRD/14 rule 4 says a DM has no
 * admins and *also* that either participant may pin an ordinary message for reference, so
 * "no admins" removes pinning-as-authority, not pinning.
 *
 * That distinction is only expressible because PRD/05 rule 6 already separates the two: a pin
 * is reference and notifies nobody, an announcement is interruption and notifies everyone. So
 * `canAnnounceInChannel` stays `isChannelAdmin` and is constant-false in a DM, while this one
 * is not.
 */
export const canPinInChannel = (ctx: AccessContext, ch: ChannelRef): boolean =>
  ch.scope === 'dm' ? isDmParticipant(ctx, ch.scopeId) : isChannelAdmin(ctx, ch);

export const canAnnounceInChannel = isChannelAdmin;

/**
 * May this user react to a message here?
 *
 * The same answer as posting, and **deliberately its own name rather than an alias**. A
 * reaction is a write into the conversation that everyone can see, so a participant who may
 * not send may not react either - reacting into a thread you have been blocked from is
 * sending a signal into it. PRD/14's matrix groups "React, attach media, mention" on one row
 * for exactly that reason.
 *
 * Named separately because AGENTS.md failure mode 10 was learned one predicate ago: an alias
 * is a claim that two capabilities will never diverge, and it is invisible to any audit that
 * counts predicates. "React" has its own name in the spec, so it gets its own predicate even
 * though the body is one call.
 */
export const canReactInChannel = (ctx: AccessContext, ch: ChannelRef): boolean =>
  canPostInChannel(ctx, ch);

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
  return message.senderId === ctx.userId || canDeleteOthersMessages(ctx, ch);
};

/**
 * The channel-level half of `canDeleteMessage`: may this user delete somebody ELSE's message?
 *
 * Its own predicate rather than an inlined `isChannelAdmin`, because the client has to answer
 * "should this bubble offer Delete?" before it has a message in hand, and the only way to do
 * that without shipping raw admin-ness to the screen is to name the capability. Failure mode 10
 * in `AGENTS.md`: a capability that has its own name in the spec gets its own predicate, even
 * when the body is one word - an alias is a claim that two things will never diverge.
 *
 * Constant-false in a DM, which is the point: neither participant can delete the other's
 * message, and moderation there is blocking plus reporting instead.
 */
export const canDeleteOthersMessages = isChannelAdmin;

/**
 * Anyone with access may report a message they did not send.
 *
 * Gated on `isChannelMember` and not on `canPostInChannel`, deliberately: a member who has
 * just blocked someone, or whose thread went read-only, must still be able to report what was
 * said to them. Tying reporting to the ability to send would take the reporting path away at
 * exactly the moment it is needed.
 */
export const canReportMessage = (
  ctx: AccessContext,
  ch: ChannelRef,
  message: { senderId: string },
): boolean =>
  canReportInChannel(ctx, ch) && message.senderId !== ctx.userId;

/**
 * The channel-level half: may this person report anything here at all?
 *
 * Split out from `canReportMessage` so the channel meta can answer "offer the Report control?"
 * without a message in hand, and so both answers come from ONE definition rather than the screen
 * restating the scope rule.
 *
 * > **Eboard chat has no reporting, by decision on 2026-08-01.** Every member of that space is
 * > already admin-tier, so a report would be filed by the same set of people who would review it -
 * > a queue you raise work into for yourself. They can delete the message directly, which is the
 * > action reporting would have led to anyway.
 *
 * Gated on reading the channel rather than on posting in it: a member who has just blocked
 * somebody, or whose thread went read-only, must still be able to report what was said to them.
 */
export const canReportInChannel = (ctx: AccessContext, ch: ChannelRef): boolean =>
  ch.scope !== 'eboard' && isChannelMember(ctx, ch);

/**
 * Who may READ the reports raised in a channel.
 *
 * > **One table, three answers, selected by the reported message's channel scope.**
 * >
 * > | Channel scope | Report visible to |
 * > |---|---|
 * > | club / race | admins of that space, in the Highlights Reports tab |
 * > | **eboard** | **nobody - reporting does not exist there.** See `canReportInChannel` |
 * > | **dm** | **platform moderators, in a separate queue** |
 *
 * The branches are mutually exclusive on purpose, in both directions. A club admin never sees a
 * DM report - PRD/14 rule 7 is explicit that no club admin ever sees the contents of a DM - and a
 * platform moderator gets nothing extra in club or race chat, where the space's own admins are
 * the right readers and the moderator has no standing at all.
 *
 * **Eboard returns false rather than being left as admins-see-everything**, and that is the point
 * of writing it out: the tab must be absent there, not empty. A space where reporting cannot
 * happen and a tab that lists no reports look identical on screen and are not the same claim.
 */
export const canReadReports = (ctx: AccessContext, ch: ChannelRef): boolean => {
  if (ch.scope === 'dm') return ctx.isPlatformModerator;
  if (ch.scope === 'eboard') return false;
  return isChannelAdmin(ctx, ch);
};

/**
 * Dismissing a report, and deleting the reported message, are the two actions the Reports tab
 * offers. Dismissal follows the same reader rule; deletion goes through `canDeleteMessage`,
 * which is why a platform moderator cannot delete a DM message - moderation there is blocking
 * plus reporting, and nobody deletes anyone else's message in a DM.
 */
export const canDismissReport = canReadReports;

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
 * Approving a request, or adding an admin directly. **Existing members of the space only.**
 *
 * Deliberately `isEboardMember` and not `isClubAdmin`, and this is the one predicate in the
 * file where that substitution would not merely be wrong but self-defeating: letting any club
 * admin approve would let an admin outside the space **approve their own way in**, which is the
 * privacy boundary the space consists of. PRD/10 lists that as an explicitly rejected
 * alternative.
 *
 * Its own name rather than an alias of `isEboardMember`, because "who may let somebody in" and
 * "who is in" are two capabilities the spec names separately - failure mode 10.
 */
export const canApproveEboardRequest = (ctx: AccessContext, eboardId: string): boolean =>
  isEboardMember(ctx, eboardId);

/**
 * Asking to rejoin: admin-tier in the club, and not already inside.
 *
 * The club-admin half is checked by the caller against the space's own club, because a
 * predicate stays a pure function and the space-to-club mapping is a row.
 */
export const canRequestEboardAccess = (ctx: AccessContext, eboardId: string): boolean =>
  !isEboardMember(ctx, eboardId);

/**
 * Removing somebody else from the space: **the club Owner, and nobody else.**
 *
 * The strictest removal rule in the product. Mutual removal between admins was rejected
 * outright - this is the highest-trust space in it, and two admins able to eject each other is
 * a governance problem rather than a feature. Leaving is separate and needs no authority.
 */
export const canRemoveFromEboard = (
  ctx: AccessContext,
  eboard: { id: string; clubId: string },
): boolean => isEboardMember(ctx, eboard.id) && isClubOwner(ctx, eboard.clubId);

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
 * Walking onto a roster with no request, and **the Owner alone can do it**.
 *
 * The single exception to "access is always by request" (PRD/09 rule 3), and it exists for the
 * case where a roster has no admin left on it: whoever created the race left, so a join request
 * now notifies nobody, and the way back in must not itself require somebody to approve it.
 *
 * Deliberately not the admin tier. An admin who could walk into any race in the club would make
 * rule 4's "management authority is not access" true only until they chose otherwise, and the
 * whole point of that rule is that an admin is not silently on 30 rosters. The Owner is one
 * person, and this is their escape hatch rather than a second way in.
 *
 * > Until 2026-08-05 `addRaceMember` allowed exactly this to **every** admin, by never checking
 * > that the person being added was somebody else. That was an oversight rather than a decision;
 * > this predicate is the decision, and `addRaceMember` now refuses a self-target.
 */
export const canJoinRaceDirectly = (ctx: AccessContext, race: RaceRef): boolean =>
  isClubOwner(ctx, race.clubId) && !isRaceMember(ctx, race);

/**
 * Being assigned to a car group requires real race access.
 *
 * So an admin who is not on the roster cannot be put in a car, **even though they manage
 * the groups**. That asymmetry is the clearest expression of authority not being access.
 */
export const canBeInCarGroup = isRaceMember;

/**
 * Reading the roster. A race member, **or** a manager with no roster row.
 *
 * The only race read where management authority does grant sight, and the only union of
 * `isRaceMember` and `isRaceManager` in this file. PRD/09 rule 5 gives a manager who is not on
 * the roster exactly one thing - "a way into the roster to manage others" - so this is neither
 * of the two predicates it is built from, and takes its own name rather than a caller reaching
 * for whichever one looks close (failure mode 10).
 *
 * Note what it deliberately does not cover: the roster's **pending requests** go through
 * `canManageRace`, because who is waiting to be let in is decision-making data rather than
 * roster data, and a plain race member has no decision to make.
 */
export const canReadRaceRoster = (ctx: AccessContext, race: RaceRef): boolean =>
  isRaceMember(ctx, race) || isRaceManager(ctx, race);

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

/**
 * **Only the meeting's creator EDITS it.** Everyone else in the space is view-only.
 *
 * Not an accident and not symmetrical with cancelling below. Meetings first shipped as
 * any-member editable and two explicit founder follow-ups took that away, which is why
 * `creatorId` is the authorization subject here rather than audit metadata. PRD/10 rule 7.
 */
export const canEditMeeting = (
  ctx: AccessContext,
  meeting: { creatorId: string },
): boolean => meeting.creatorId === ctx.userId;

/**
 * **Any member of the space CANCELS a meeting, not only the one who scheduled it.**
 *
 * The deliberate asymmetry with editing above, and the pair only looks inconsistent until you
 * ask what each one is for. Editing rewrites somebody's record of what they called; cancelling
 * says a thing is not happening, which is a fact about the board's week rather than about its
 * author. A meeting nobody but one absent member can call off is the failure this avoids.
 *
 * What makes it safe to open is that cancelling is **narrated**: deleting posts "X cancelled
 * <title>" into board chat, so the space sees who did it. An unaccountable open delete is a
 * different proposition, and is not what this is.
 */
export const canCancelMeeting = isEboardMember;

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
