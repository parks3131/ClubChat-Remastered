/**
 * THE PHASE 2 EXIT GATE.
 *
 * SPEC/TECH/16-build-phases.md: *"Done when: the permission-matrix test suite covers every
 * cell of the three matrices in Roles and permissions."*
 *
 * `PRD/17` records that in v1 the matrix was "verified by hand". This is the file that ends
 * that. Every cell asserts both directions, because **asserting deny is the half that
 * matters**: a predicate returning true for everybody passes every allow-only test ever
 * written.
 *
 * The Race matrix is the one to read carefully. Its whole point is that **management
 * authority is not access** - a club admin manages every race in the club and still cannot
 * open its chat, vote in its polls, or be put in a car. That distinction was wrong in five
 * separate places in v1, so most of the interesting cells here are the ones that say "no".
 */

import { describe, expect, it } from 'vitest';
import { accessContextOf, type AccessContext } from './context.ts';
import {
  canAccessPoll,
  canAnnounceInChannel,
  canBeInCarGroup,
  canBlock,
  canCreateMeeting,
  canCreatePoll,
  canDeleteClub,
  canDeleteMessage,
  canEditClub,
  canLeaveClub,
  canMuteChannel,
  canOpenDm,
  canViewProfile,
  canReadReports,
  canReportMessage,
  dmThreadWith,
  isChannelMember,
  sharesAClub,
  canManageCarGroups,
  canCreateRace,
  canJoinRaceDirectly,
  canManageClubContent,
  canManageEboardMembers,
  canManageJoinRequests,
  canCancelMeeting,
  canEditMeeting,
  canManagePoll,
  canManageRace,
  canPinInChannel,
  canPinInRace,
  canPinRace,
  canPostInChannel,
  canPostInRace,
  canReadClubContent,
  canReadMeetInformation,
  canReadRaceRoster,
  canRemoveEboardMember,
  canRemoveMember,
  canRequestRaceAccess,
  canSeeEboardExists,
  canSeePollVoters,
  canSeeRace,
  canShareInviteLink,
  canTransferOwnership,
  canViewCarGroups,
  isRaceMember,
  type ChannelRef,
  type PollRef,
  type RaceRef,
} from './predicates.ts';

const CLUB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RACE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const EBOARD = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const OWNER = 'u-owner';
const ADMIN = 'u-admin';
const MEMBER = 'u-member';
const OUTSIDER = 'u-outsider';

const race: RaceRef = { id: RACE, clubId: CLUB };
const clubChannel: ChannelRef = { id: 'ch-club', scope: 'club', clubId: CLUB, scopeId: CLUB };
const raceChannel: ChannelRef = { id: 'ch-race', scope: 'race', clubId: CLUB, scopeId: RACE };
const eboardChannel: ChannelRef = {
  id: 'ch-eboard',
  scope: 'eboard',
  clubId: CLUB,
  scopeId: EBOARD,
};

// ===========================================================================
// PRD/02 - "Club content"
// ===========================================================================

type ContentActor = 'owner' | 'admin' | 'member';

const contentActors: Record<ContentActor, AccessContext> = {
  owner: accessContextOf({ userId: OWNER, clubRole: [[CLUB, 'owner']] }),
  admin: accessContextOf({ userId: ADMIN, clubRole: [[CLUB, 'admin']] }),
  member: accessContextOf({ userId: MEMBER, clubRole: [[CLUB, 'member']] }),
};

type ContentRow = {
  action: string;
  run: (c: AccessContext) => boolean;
  owner: boolean;
  admin: boolean;
  member: boolean;
};

/** A club poll created by somebody else, for the creator-only rows. */
const clubPollByOther: PollRef = {
  id: 'poll-1',
  clubId: CLUB,
  scope: 'club',
  scopeId: CLUB,
  creatorId: 'somebody-else',
  isPrivate: false,
};

const contentMatrix: ContentRow[] = [
  {
    action: 'Create/edit/delete a calendar event',
    run: (c) => canManageClubContent(c, CLUB),
    owner: true,
    admin: true,
    member: false,
  },
  {
    action: 'Create/edit/delete a meetup (any admin, any meetup)',
    run: (c) => canManageClubContent(c, CLUB),
    owner: true,
    admin: true,
    member: false,
  },
  {
    action: 'Create/edit/delete any news post',
    run: (c) => canManageClubContent(c, CLUB),
    owner: true,
    admin: true,
    member: false,
  },
  {
    action: 'React to a news post',
    run: (c) => canReadClubContent(c, CLUB),
    owner: true,
    admin: true,
    member: true,
  },
  {
    action: 'Create a club poll',
    run: (c) => canCreatePoll(c, { scope: 'club', clubId: CLUB, scopeId: CLUB }),
    owner: true,
    admin: true,
    member: false,
  },
  {
    action: 'Vote in a club poll',
    run: (c) => canAccessPoll(c, clubPollByOther),
    owner: true,
    admin: true,
    member: true,
  },
  {
    // Creator only, in every scope - including a club poll created by another admin. An
    // Owner who did not create it still cannot close it.
    action: 'Close / reopen / delete a poll (creator only)',
    run: (c) => canManagePoll(c, clubPollByOther),
    owner: false,
    admin: false,
    member: false,
  },
];

describe('PRD/02 matrix: Club content', () => {
  for (const row of contentMatrix) {
    for (const actor of ['owner', 'admin', 'member'] as ContentActor[]) {
      const expected = row[actor];
      it(`${row.action}: ${actor} -> ${expected ? 'allow' : 'deny'}`, () => {
        expect(row.run(contentActors[actor])).toBe(expected);
      });
    }
  }

  it('covers every row of the spec table', () => {
    expect(contentMatrix).toHaveLength(7);
  });

  it('lets a poll creator manage their own poll in any scope', () => {
    // The other side of the creator-only rule: it is a restriction on non-creators, not an
    // inability for anyone to close a poll.
    for (const scope of ['club', 'race', 'eboard'] as const) {
      const mine: PollRef = {
        id: 'p',
        clubId: CLUB,
        scope,
        scopeId: scope === 'race' ? RACE : scope === 'eboard' ? EBOARD : CLUB,
        creatorId: MEMBER,
        isPrivate: false,
      };
      expect(canManagePoll(contentActors.member, mine), `scope ${scope}`).toBe(true);
    }
  });
});

// ===========================================================================
// PRD/02 - "Race"
// ===========================================================================

/**
 * The three race actors from the spec's columns.
 *
 * `manager` is a club admin who is NOT on the roster - which is the whole point of the
 * matrix. `rosteredManager` is added because several cells read "only if also on the
 * roster" and need a fourth actor to express.
 */
const raceActors = {
  manager: accessContextOf({ userId: ADMIN, clubRole: [[CLUB, 'admin']] }),
  rosteredManager: accessContextOf({
    userId: ADMIN,
    clubRole: [[CLUB, 'admin']],
    raceRoster: [RACE],
  }),
  raceMember: accessContextOf({
    userId: MEMBER,
    clubRole: [[CLUB, 'member']],
    raceRoster: [RACE],
  }),
  clubMemberOffRoster: accessContextOf({ userId: 'u-off', clubRole: [[CLUB, 'member']] }),
  outsider: accessContextOf({ userId: OUTSIDER }),
};

type RaceActor = keyof typeof raceActors;

type RaceRow = {
  action: string;
  run: (c: AccessContext) => boolean;
  manager: boolean;
  rosteredManager: boolean;
  raceMember: boolean;
  clubMemberOffRoster: boolean;
  outsider: boolean;
};

const raceMatrix: RaceRow[] = [
  {
    /*
     * The one race capability an off-roster admin keeps, and it has to be modelled with its own
     * predicate rather than with `canManageRace`. A race that does not exist has no roster, so
     * asking the roster-gated predicate here would assert that nobody can create one.
     */
    action: 'Create a race',
    run: (c) => canCreateRace(c, CLUB),
    manager: true,
    rosteredManager: true,
    raceMember: false,
    clubMemberOffRoster: false,
    outsider: false,
  },
  {
    // Every club member can see every race exists - they need to know in order to ask.
    action: 'See the race in lists; preview name, date, Meet Information',
    run: (c) => canSeeRace(c, race),
    manager: true,
    rosteredManager: true,
    raceMember: true,
    clubMemberOffRoster: true,
    outsider: false,
  },
  {
    action: 'Read Meet Information',
    run: (c) => canReadMeetInformation(c, race),
    manager: true,
    rosteredManager: true,
    raceMember: true,
    clubMemberOffRoster: true,
    outsider: false,
  },
  {
    action: 'Request to join',
    run: (c) => canRequestRaceAccess(c, race),
    manager: true,
    // Already on it, so there is nothing to request.
    rosteredManager: false,
    raceMember: false,
    clubMemberOffRoster: true,
    outsider: false,
  },
  {
    action: 'Approve/deny requests, add or remove roster members',
    run: (c) => canManageRace(c, race),
    // Roster-gated since 2026-08-12: you run the races you are in.
    manager: false,
    rosteredManager: true,
    raceMember: false,
    clubMemberOffRoster: false,
    outsider: false,
  },
  {
    // THE CELL THAT MATTERS. A manager with no roster row cannot read the chat they manage.
    action: 'Read/post in race chat (roster row required)',
    run: (c) => canPostInRace(c, race),
    manager: false,
    rosteredManager: true,
    raceMember: true,
    clubMemberOffRoster: false,
    outsider: false,
  },
  {
    action: 'Pin / announce in race chat (roster row AND admin)',
    run: (c) => canPinInRace(c, race),
    manager: false,
    rosteredManager: true,
    // A plain race member is not an admin of the space.
    raceMember: false,
    clubMemberOffRoster: false,
    outsider: false,
  },
  {
    // Readable by every club member (above), editable only from inside the race.
    action: 'Edit Meet Information',
    run: (c) => canManageRace(c, race),
    manager: false,
    rosteredManager: true,
    raceMember: false,
    clubMemberOffRoster: false,
    outsider: false,
  },
  {
    action: 'Create/delete car groups, assign members, set Incharge',
    run: (c) => canManageCarGroups(c, race),
    manager: false,
    rosteredManager: true,
    raceMember: false,
    clubMemberOffRoster: false,
    outsider: false,
  },
  {
    // An admin not on the roster cannot be put in a car, even though they manage the groups.
    action: 'Be assigned to a car group (roster row required)',
    run: (c) => canBeInCarGroup(c, race),
    manager: false,
    rosteredManager: true,
    raceMember: true,
    clubMemberOffRoster: false,
    outsider: false,
  },
  {
    action: 'View car groups',
    run: (c) => canViewCarGroups(c, race),
    manager: false,
    rosteredManager: true,
    raceMember: true,
    clubMemberOffRoster: false,
    outsider: false,
  },
  {
    action: 'Create a race poll (roster row AND admin)',
    run: (c) => canCreatePoll(c, { scope: 'race', clubId: CLUB, scopeId: RACE }),
    manager: false,
    rosteredManager: true,
    raceMember: false,
    clubMemberOffRoster: false,
    outsider: false,
  },
  {
    action: 'See/vote in a race poll (roster only)',
    run: (c) =>
      canAccessPoll(c, {
        id: 'rp',
        clubId: CLUB,
        scope: 'race',
        scopeId: RACE,
        creatorId: 'other',
        isPrivate: false,
      }),
    manager: false,
    rosteredManager: true,
    raceMember: true,
    clubMemberOffRoster: false,
    outsider: false,
  },
  {
    // Personal, and not admin-gated: anyone who can see a race can pin it for themselves.
    action: 'Pin the race to their own hub',
    run: (c) => canPinRace(c, race),
    manager: true,
    rosteredManager: true,
    raceMember: true,
    clubMemberOffRoster: true,
    outsider: false,
  },
];

const RACE_ACTORS: RaceActor[] = [
  'manager',
  'rosteredManager',
  'raceMember',
  'clubMemberOffRoster',
  'outsider',
];

describe('PRD/02 matrix: Race', () => {
  for (const row of raceMatrix) {
    for (const actor of RACE_ACTORS) {
      const expected = row[actor];
      it(`${row.action}: ${actor} -> ${expected ? 'allow' : 'deny'}`, () => {
        expect(row.run(raceActors[actor])).toBe(expected);
      });
    }
  }

  it('covers every row of the spec table', () => {
    expect(raceMatrix).toHaveLength(14);
  });
});

describe('you run the races you are in', () => {
  /**
   * **This block asserted the opposite property until 2026-08-12**, and the inversion is the
   * point rather than a rename.
   *
   * The old rule: a club admin managed every race in the club from outside it, and only *access*
   * needed a roster row. `PRD/02` called that the most-misunderstood part of the model. The new
   * rule is simply that management needs a roster row too - an admin outside a race gets what any
   * club member gets.
   *
   * What survives unchanged is the half that mattered: an admin is still not silently on thirty
   * rosters, because joining is still by request. What goes is authority reaching into a space its
   * holder is not part of.
   *
   * Asserted as a property here rather than row by row, because the five places v1 got the old
   * rule wrong were all places somebody reached for the predicate that looked close.
   */
  it('every roster-gated race capability is denied to an admin off the roster', () => {
    const accessGated: Array<[string, (c: AccessContext) => boolean]> = [
      ['read/post in race chat', (c) => canPostInRace(c, race)],
      ['pin in race chat', (c) => canPinInRace(c, race)],
      ['be in a car group', (c) => canBeInCarGroup(c, race)],
      ['view car groups', (c) => canViewCarGroups(c, race)],
      ['create a race poll', (c) => canCreatePoll(c, { scope: 'race', clubId: CLUB, scopeId: RACE })],
      [
        'see a race poll',
        (c) =>
          canAccessPoll(c, {
            id: 'rp',
            clubId: CLUB,
            scope: 'race',
            scopeId: RACE,
            creatorId: 'x',
            isPrivate: false,
          }),
      ],
      ['post in the race channel', (c) => canPostInChannel(c, raceChannel)],
      // The four that moved under this rule on 2026-08-12.
      ['manage the race', (c) => canManageRace(c, race)],
      ['manage car groups', (c) => canManageCarGroups(c, race)],
      ['approve a join request', (c) => canManageRace(c, race)],
      ['edit Meet Information', (c) => canManageRace(c, race)],
    ];

    for (const [label, run] of accessGated) {
      expect(run(raceActors.manager), `admin off roster was allowed to ${label}`).toBe(false);
      expect(run(raceActors.rosteredManager), `rostered admin was denied ${label}`).toBe(true);
    }
  });

  it('an admin off the roster keeps exactly the club-level capabilities, and no more', () => {
    /*
     * The converse, and it is what stops this becoming "an off-roster admin can do nothing".
     * Each of these is a club act rather than a race act, and each was decided deliberately:
     *
     * - seeing a race and reading its Meet Information is how somebody decides whether to ask
     *   to go, so hiding it would make the request uninformed (PRD/09 rule 13);
     * - reading the ROSTER is the founder's explicit call - an admin fielding "who is driving
     *   to Cougars" can answer without joining a race they are not going to;
     * - creating a race cannot need a roster row on a race that does not exist yet;
     * - pinning is personal and was never admin-gated at all.
     */
    const keeps: Array<[string, (c: AccessContext) => boolean]> = [
      ['see the race exists', (c) => canSeeRace(c, race)],
      ['read Meet Information', (c) => canReadMeetInformation(c, race)],
      ['read the roster', (c) => canReadRaceRoster(c, race)],
      ['request to join', (c) => canRequestRaceAccess(c, race)],
      ['create a race', (c) => canCreateRace(c, CLUB)],
      ['pin the race to their own hub', (c) => canPinRace(c, race)],
    ];
    for (const [label, run] of keeps) {
      expect(run(raceActors.manager), `admin off roster was denied ${label}`).toBe(true);
    }
  });

  it('reading the roster does not leak the pending queue', () => {
    // canReadRaceRoster is deliberately wider than canManageRace: an off-roster admin sees who
    // is going and not who is waiting, because they have no decision to make about either.
    expect(canReadRaceRoster(raceActors.manager, race)).toBe(true);
    expect(canManageRace(raceActors.manager, race)).toBe(false);
  });

  it('the Owner has no authority over a race from outside it either', () => {
    /*
     * The rule has no rank exemption: the Owner's route in is `canJoinRaceDirectly`, which is
     * theirs alone and is the escape hatch for a roster with no admin left on it. Managing from
     * outside would have kept the old model alive for one person and left the spec describing
     * two rules.
     */
    const owner = accessContextOf({ userId: 'u-owner', clubRole: [[CLUB, 'owner']] });
    expect(canManageRace(owner, race)).toBe(false);
    expect(canManageCarGroups(owner, race)).toBe(false);
    // But they can walk straight onto the roster, which nobody else can.
    expect(canJoinRaceDirectly(owner, race)).toBe(true);
    expect(canJoinRaceDirectly(raceActors.manager, race)).toBe(false);
  });

  it('a race member is not thereby a club admin', () => {
    expect(canManageRace(raceActors.raceMember, race)).toBe(false);
    expect(canManageCarGroups(raceActors.raceMember, race)).toBe(false);
  });
});

// ===========================================================================
// PRD/02 - "Eboard and Council"
// ===========================================================================

const eboardActors = {
  eboardMember: accessContextOf({
    userId: ADMIN,
    clubRole: [[CLUB, 'admin']],
    eboardMember: [EBOARD],
  }),
  ownerInside: accessContextOf({
    userId: OWNER,
    clubRole: [[CLUB, 'owner']],
    eboardMember: [EBOARD],
  }),
  adminOutside: accessContextOf({ userId: 'u-admin2', clubRole: [[CLUB, 'admin']] }),
  clubMember: accessContextOf({ userId: MEMBER, clubRole: [[CLUB, 'member']] }),
};

type EboardActor = keyof typeof eboardActors;

type EboardRow = {
  action: string;
  run: (c: AccessContext) => boolean;
  eboardMember: boolean;
  ownerInside: boolean;
  adminOutside: boolean;
  clubMember: boolean;
};

const meetingByOther = { creatorId: 'somebody-else' };

const eboardMatrix: EboardRow[] = [
  {
    // Only club admins can see the space exists. Ordinary members have no visibility of it.
    action: 'See that the space exists',
    run: (c) => canSeeEboardExists(c, CLUB),
    eboardMember: true,
    ownerInside: true,
    adminOutside: true,
    clubMember: false,
  },
  {
    action: 'Read/post in Eboard chat',
    run: (c) => canPostInChannel(c, eboardChannel),
    eboardMember: true,
    ownerInside: true,
    // An admin who left the space must request or be re-added; admin status alone does not
    // re-admit them.
    adminOutside: false,
    clubMember: false,
  },
  {
    action: 'Pin / announce in Eboard chat',
    run: (c) => canPinInChannel(c, eboardChannel),
    // Every Eboard member is already a club admin, so there is no further distinction and
    // membership IS the admin check inside the space.
    eboardMember: true,
    ownerInside: true,
    adminOutside: false,
    clubMember: false,
  },
  {
    action: 'Approve requests, add members',
    run: (c) => canManageEboardMembers(c, EBOARD),
    eboardMember: true,
    ownerInside: true,
    // Letting any club admin approve would let an admin outside the space add themselves
    // in, defeating the privacy boundary entirely.
    adminOutside: false,
    clubMember: false,
  },
  {
    action: 'Create a meeting',
    run: (c) => canCreateMeeting(c, EBOARD),
    eboardMember: true,
    ownerInside: true,
    adminOutside: false,
    clubMember: false,
  },
  {
    action: 'Create an Eboard poll',
    run: (c) => canCreatePoll(c, { scope: 'eboard', clubId: CLUB, scopeId: EBOARD }),
    eboardMember: true,
    ownerInside: true,
    adminOutside: false,
    clubMember: false,
  },
  {
    action: 'See/vote in an Eboard poll',
    run: (c) =>
      canAccessPoll(c, {
        id: 'ep',
        clubId: CLUB,
        scope: 'eboard',
        scopeId: EBOARD,
        creatorId: 'x',
        isPrivate: false,
      }),
    eboardMember: true,
    ownerInside: true,
    adminOutside: false,
    clubMember: false,
  },
  {
    action: "Edit somebody else's meeting (creator only)",
    run: (c) => canEditMeeting(c, meetingByOther),
    eboardMember: false,
    ownerInside: false,
    adminOutside: false,
    clubMember: false,
  },
  {
    /*
     * The deliberate asymmetry with the row above, and the reason both rows exist rather than
     * one: cancelling is open to the whole space where editing is not. A meeting only its
     * absent author could call off is the failure that buys. The cancellation is narrated into
     * board chat by name, which is what keeps an open delete accountable.
     */
    action: "Cancel somebody else's meeting (any member of the space)",
    run: (c) => canCancelMeeting(c, EBOARD),
    eboardMember: true,
    ownerInside: true,
    adminOutside: false,
    clubMember: false,
  },
  {
    // The highest-trust space in the product, so mutual removal is out.
    action: 'Remove another Eboard member (Owner only)',
    run: (c) => canRemoveEboardMember(c, CLUB, EBOARD, { userId: 'someone' }),
    eboardMember: false,
    ownerInside: true,
    adminOutside: false,
    clubMember: false,
  },
  {
    action: 'Delete the space (existing members only)',
    run: (c) => canManageEboardMembers(c, EBOARD),
    eboardMember: true,
    ownerInside: true,
    adminOutside: false,
    clubMember: false,
  },
];

const EBOARD_ACTORS: EboardActor[] = ['eboardMember', 'ownerInside', 'adminOutside', 'clubMember'];

describe('PRD/02 matrix: Eboard and Council', () => {
  for (const row of eboardMatrix) {
    for (const actor of EBOARD_ACTORS) {
      const expected = row[actor];
      it(`${row.action}: ${actor} -> ${expected ? 'allow' : 'deny'}`, () => {
        expect(row.run(eboardActors[actor])).toBe(expected);
      });
    }
  }

  it('covers every row of the spec table', () => {
    expect(eboardMatrix).toHaveLength(11);
  });

  it('lets a meeting creator edit their own meeting', () => {
    expect(canEditMeeting(eboardActors.eboardMember, { creatorId: ADMIN })).toBe(true);
  });

  it('how Eboard differs from Race, stated as a test', () => {
    /*
     * Both are mini-clubs nested under a club, and **since 2026-08-12 they agree about
     * authority**: in neither can an admin outside the space manage it. This test used to assert
     * the opposite for a race, which was the whole distinction between the two.
     *
     * What still differs is how you get IN, and that is now the only difference: Eboard
     * membership follows the admin tier automatically, while a race roster is joined by request.
     * So an admin is inside every Eboard by construction and inside only the races they asked to
     * be in - which is why the same rule produces very different reach in the two spaces.
     */
    const adminNoRoster = accessContextOf({ userId: ADMIN, clubRole: [[CLUB, 'admin']] });
    expect(canManageRace(adminNoRoster, race)).toBe(false);
    expect(isRaceMember(adminNoRoster, race)).toBe(false);
    expect(canManageEboardMembers(adminNoRoster, EBOARD)).toBe(false);
  });
});

// ===========================================================================
// PRD/14 - "Direct messages"
// ===========================================================================

/**
 * The fourth matrix, added with the fourth scope.
 *
 * Two of its rows are the ones that could not be expressed through `isChannelAdmin` and so
 * needed predicates of their own - **pinning**, which PRD/14 grants to both participants in a
 * space that has no admins, and **posting**, which a participant can lose while keeping the
 * right to read. Both are the cells to read carefully here.
 *
 * `blocked` is a fourth actor for the same reason the race matrix needed `rosteredManager`:
 * several cells read "unless blocked" and there is no way to state that with three columns.
 */
const DM = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const PEER = 'u-peer';

const dmChannel: ChannelRef = { id: 'ch-dm', scope: 'dm', clubId: null, scopeId: DM };

const dmActors = {
  participant: accessContextOf({
    userId: MEMBER,
    clubRole: [[CLUB, 'member']],
    dmThreads: [{ conversationId: DM, otherUserId: PEER }],
  }),
  otherParticipant: accessContextOf({
    userId: PEER,
    clubRole: [[CLUB, 'member']],
    dmThreads: [{ conversationId: DM, otherUserId: MEMBER }],
  }),
  /** A participant who has blocked, or been blocked by, the other one. */
  blocked: accessContextOf({
    userId: MEMBER,
    clubRole: [[CLUB, 'member']],
    dmThreads: [{ conversationId: DM, otherUserId: PEER }],
    blockedEither: [PEER],
  }),
  /** In no club at all, which is the only way to be "anyone else" to a conversation. */
  outsider: accessContextOf({ userId: OUTSIDER }),
};

type DmActor = keyof typeof dmActors;

type DmRow = {
  action: string;
  run: (c: AccessContext) => boolean;
  participant: boolean;
  otherParticipant: boolean;
  blocked: boolean;
  outsider: boolean;
};

/**
 * The peer as a block candidate, with `hasThreadWith` derived from the ACTOR rather than
 * hardcoded.
 *
 * Hardcoding it to true was wrong and the matrix caught it: "do I already hold a thread with
 * this person" is a fact about the actor's own context, so a fixed `true` made an outsider look
 * like somebody with a conversation to protect. This is also exactly how the real caller
 * composes it.
 */
const peerCandidateFor = (c: AccessContext) => ({
  userId: PEER,
  clubIds: [CLUB],
  hasThreadWith: dmThreadWith(c, PEER) !== undefined,
});

const dmMatrix: DmRow[] = [
  {
    action: 'Read the conversation',
    run: (c) => isChannelMember(c, dmChannel),
    participant: true,
    otherParticipant: true,
    // The cell that makes blocking read-only rather than a deletion. History stays visible.
    blocked: true,
    outsider: false,
  },
  {
    action: 'Post a message',
    run: (c) => canPostInChannel(c, dmChannel),
    participant: true,
    otherParticipant: true,
    // THE CELL THAT MATTERS. Read is true and post is false for the same actor, which is why
    // canPostInChannel could not stay an alias of isChannelMember.
    blocked: false,
    outsider: false,
  },
  {
    action: 'Pin a message',
    run: (c) => canPinInChannel(c, dmChannel),
    // THE OTHER CELL THAT MATTERS. A DM has no admins and both participants may still pin, so
    // this is not isChannelAdmin.
    participant: true,
    otherParticipant: true,
    blocked: true,
    outsider: false,
  },
  {
    action: 'Post an announcement or create a poll',
    run: (c) => canAnnounceInChannel(c, dmChannel),
    participant: false,
    otherParticipant: false,
    blocked: false,
    outsider: false,
  },
  {
    action: 'Delete own message',
    run: (c) => canDeleteMessage(c, dmChannel, { senderId: c.userId }),
    participant: true,
    otherParticipant: true,
    blocked: true,
    outsider: false,
  },
  {
    // The row that differs from every other scope: nobody deletes anybody else's message in a
    // DM, because the admin who would hold that power in club chat does not exist here.
    action: "Delete the other participant's message",
    run: (c) => canDeleteMessage(c, dmChannel, { senderId: 'somebody-else' }),
    participant: false,
    otherParticipant: false,
    blocked: false,
    outsider: false,
  },
  {
    action: "Report the other participant's message",
    run: (c) => canReportMessage(c, dmChannel, { senderId: 'somebody-else' }),
    participant: true,
    otherParticipant: true,
    // Gated on reading rather than on posting, deliberately: a member who has just blocked
    // somebody must still be able to report what was said to them.
    blocked: true,
    outsider: false,
  },
  {
    action: 'Report own message',
    run: (c) => canReportMessage(c, dmChannel, { senderId: c.userId }),
    participant: false,
    otherParticipant: false,
    blocked: false,
    outsider: false,
  },
  {
    action: 'Mute the conversation',
    run: (c) => canMuteChannel(c, dmChannel),
    participant: true,
    otherParticipant: true,
    blocked: true,
    outsider: false,
  },
  {
    action: 'Block the other participant',
    run: (c) => canBlock(c, peerCandidateFor(c)),
    participant: true,
    // Blocking the person whose id this actor holds would be blocking themselves.
    otherParticipant: false,
    // Already blocked, and re-blocking is a no-op rather than a refusal.
    blocked: true,
    // The PRD's dash: an outsider shares no club and holds no thread, so there is nobody to
    // block.
    outsider: false,
  },
  {
    action: 'Read the reports raised in this conversation',
    run: (c) => canReadReports(c, dmChannel),
    // Nobody in the conversation, either. A DM report goes to platform moderators, and being
    // a participant is not that.
    participant: false,
    otherParticipant: false,
    blocked: false,
    outsider: false,
  },
];

const DM_ACTORS: DmActor[] = ['participant', 'otherParticipant', 'blocked', 'outsider'];

describe('PRD/14 matrix: Direct messages', () => {
  for (const row of dmMatrix) {
    for (const actor of DM_ACTORS) {
      const expected = row[actor];
      it(`${row.action}: ${actor} -> ${expected ? 'allow' : 'deny'}`, () => {
        expect(row.run(dmActors[actor])).toBe(expected);
      });
    }
  }

  it('covers every row of the spec table', () => {
    expect(dmMatrix).toHaveLength(11);
  });

  it('grants report-reading to a platform moderator and to nobody else', () => {
    const moderator = accessContextOf({ userId: 'u-mod', isPlatformModerator: true });
    expect(canReadReports(moderator, dmChannel)).toBe(true);
    // And it buys them nothing in a club, a race or an Eboard space. It is one capability,
    // not a tier above Owner.
    expect(canReadReports(moderator, clubChannel)).toBe(false);
    expect(canReadReports(moderator, raceChannel)).toBe(false);
    expect(canReadReports(moderator, eboardChannel)).toBe(false);
    expect(isChannelMember(moderator, dmChannel)).toBe(false);
    // The converse: a club admin reads their own space's reports and never a DM's.
    const admin = accessContextOf({ userId: ADMIN, clubRole: [[CLUB, 'admin']] });
    expect(canReadReports(admin, clubChannel)).toBe(true);
    expect(canReadReports(admin, dmChannel)).toBe(false);
  });

  it('makes eligibility a shared club, and blocking symmetric within it', () => {
    const inClub = { userId: PEER, clubIds: [CLUB] };
    const elsewhere = { userId: 'u-far', clubIds: ['other-club'] };

    expect(canOpenDm(dmActors.participant, inClub)).toBe(true);
    // No global user search: sharing no club is the same as not existing.
    expect(canOpenDm(dmActors.participant, elsewhere)).toBe(false);
    // Blocked in EITHER direction, from one symmetric set. The blocked party's context looks
    // identical to the blocker's here, which is the entire point.
    expect(canOpenDm(dmActors.blocked, inClub)).toBe(false);
    expect(sharesAClub(dmActors.participant, inClub)).toBe(true);
    expect(sharesAClub(dmActors.outsider, inClub)).toBe(false);
  });

  /*
   * Profile visibility, which had no predicate at all until 2026-08-08.
   *
   * The rule was stated in ADR-0009, in PRD/03's rejected alternatives and in `sharesAClub`'s
   * own docstring, and enforced nowhere: `readProfile` took a context and never read it. Note
   * that this is the inverse of the alias trap in AGENTS.md failure mode 10 - an alias hides a
   * capability behind another name, whereas this capability had no name to count.
   */
  it('opens a profile to a clubmate, a conversation partner and nobody else', () => {
    const inClub = { userId: PEER, clubIds: [CLUB] };
    const elsewhere = { userId: 'u-far', clubIds: ['other-club'] };

    // A shared club is the ADR's rule.
    expect(canViewProfile(dmActors.participant, inClub)).toBe(true);
    // Sharing nothing is the same as not existing, exactly as it is for DM eligibility.
    expect(canViewProfile(dmActors.participant, elsewhere)).toBe(false);
    // Always your own.
    expect(
      canViewProfile(dmActors.participant, {
        userId: dmActors.participant.userId,
        clubIds: [],
      }),
    ).toBe(true);

    /*
     * And a conversation partner after the last shared club has gone. This is the branch that
     * is easy to leave out and would be wrong: PRD/14 rule 3 keeps the thread read-only rather
     * than deleting it, so its history stays readable - and a name in readable history has to
     * stay tappable. `sharesClub: false` is exactly that state.
     */
    const strandedPeer = accessContextOf({
      userId: 'u-stranded',
      dmThreads: [{ conversationId: 'dm-1', otherUserId: PEER, sharesClub: false }],
    });
    expect(sharesAClub(strandedPeer, inClub)).toBe(false);
    expect(canViewProfile(strandedPeer, inClub)).toBe(true);

    /*
     * A block does NOT withhold the card, deliberately.
     *
     * Blocking stops messages and hides the pair from each other's search. It does not erase
     * somebody from a club they are both still in, where their name and face are on the roster
     * already - so hiding the card alone would conceal nothing and break a roster the blocker
     * can see. `canOpenDm` is the predicate that answers the other way, on the same pair.
     */
    expect(canViewProfile(dmActors.blocked, inClub)).toBe(true);
    expect(canOpenDm(dmActors.blocked, inClub)).toBe(false);
  });

  it('a thread in one conversation grants nothing in another', () => {
    const other: ChannelRef = { id: 'ch-dm2', scope: 'dm', clubId: null, scopeId: 'other-dm' };
    expect(isChannelMember(dmActors.participant, dmChannel)).toBe(true);
    expect(isChannelMember(dmActors.participant, other)).toBe(false);
    expect(canPostInChannel(dmActors.participant, other)).toBe(false);
  });
});

// ===========================================================================
// Poll voter visibility
// ===========================================================================

describe('poll voter visibility', () => {
  const creator = accessContextOf({ userId: MEMBER, clubRole: [[CLUB, 'member']] });
  const otherMember = accessContextOf({ userId: 'u-other', clubRole: [[CLUB, 'member']] });
  const outsider = accessContextOf({ userId: OUTSIDER });

  const publicPoll: PollRef = {
    id: 'p',
    clubId: CLUB,
    scope: 'club',
    scopeId: CLUB,
    creatorId: MEMBER,
    isPrivate: false,
  };
  const privatePoll: PollRef = { ...publicPoll, isPrivate: true };

  it('on a public poll, everyone eligible can see who voted', () => {
    expect(canSeePollVoters(creator, publicPoll)).toBe(true);
    expect(canSeePollVoters(otherMember, publicPoll)).toBe(true);
  });

  it('on a private poll, only the creator can', () => {
    // Fully anonymous polls were rejected: somebody must be accountable for interpreting a
    // sensitive vote.
    expect(canSeePollVoters(creator, privatePoll)).toBe(true);
    expect(canSeePollVoters(otherMember, privatePoll)).toBe(false);
  });

  it('a non-member sees neither', () => {
    expect(canSeePollVoters(outsider, publicPoll)).toBe(false);
    expect(canSeePollVoters(outsider, privatePoll)).toBe(false);
  });
});

// ===========================================================================
// Completeness guard
// ===========================================================================

describe('the gate itself', () => {
  it('covers all five spec tables, with both directions asserted in every cell', () => {
    // PRD/02 has four table sections: Club, Club content, Race, and Eboard. The Club table
    // (14 rows) is covered in policy.test.ts from Phase 0. PRD/14 adds the fifth, for the
    // fourth scope.
    const cells =
      contentMatrix.length * 3 +
      raceMatrix.length * RACE_ACTORS.length +
      eboardMatrix.length * 4 +
      dmMatrix.length * DM_ACTORS.length;
    // A guard against the suite quietly shrinking: deleting a row or an actor column fails
    // here rather than silently reducing coverage.
    // The Eboard table is 11 rows since cancelling a meeting became its own rule, separate from
    // editing one - the two differ, so they are two rows rather than one.
    expect(cells).toBe(7 * 3 + 14 * 5 + 11 * 4 + 11 * 4);
    expect(cells).toBe(179);
  });

  it('asserts at least one deny in every matrix', () => {
    // A matrix of all-allows would prove nothing. This catches a predicate accidentally
    // widened to everybody, which is the failure mode an allow-only suite cannot see.
    expect(contentMatrix.some((r) => !r.owner || !r.admin || !r.member)).toBe(true);
    expect(raceMatrix.some((r) => !r.manager || !r.raceMember)).toBe(true);
    expect(eboardMatrix.some((r) => !r.eboardMember || !r.adminOutside)).toBe(true);
    expect(dmMatrix.some((r) => !r.participant || !r.blocked)).toBe(true);
  });

  it('asserts read and post diverging somewhere, which is the fourth scope cost', () => {
    // If no row has read true and post false, the DM matrix is not exercising the one
    // structural change the scope forced - and `canPostInChannel` could quietly go back to
    // being an alias without a single test noticing.
    const read = dmMatrix.find((r) => r.action === 'Read the conversation');
    const post = dmMatrix.find((r) => r.action === 'Post a message');
    expect(read?.blocked).toBe(true);
    expect(post?.blocked).toBe(false);
  });
});

// ===========================================================================
// Cross-scope isolation, and the chat abstraction across all four scopes
// ===========================================================================

describe('cross-scope isolation', () => {
  it('a race roster row in one race grants nothing in another', () => {
    const other: RaceRef = { id: 'other-race', clubId: CLUB };
    expect(isRaceMember(raceActors.raceMember, race)).toBe(true);
    expect(isRaceMember(raceActors.raceMember, other)).toBe(false);
  });

  it('an Eboard membership in one club grants nothing in another', () => {
    const otherEboard = 'other-eboard';
    expect(canManageEboardMembers(eboardActors.eboardMember, EBOARD)).toBe(true);
    expect(canManageEboardMembers(eboardActors.eboardMember, otherEboard)).toBe(false);
  });

  it('the club matrix rows still hold, so Phase 0 coverage did not regress', () => {
    // A thin cross-check against policy.test.ts, so a refactor that broke the club matrix
    // would fail here too rather than only in the older file.
    const owner = accessContextOf({ userId: OWNER, clubRole: [[CLUB, 'owner']] });
    const admin = accessContextOf({ userId: ADMIN, clubRole: [[CLUB, 'admin']] });
    expect(canDeleteClub(owner, CLUB)).toBe(true);
    expect(canDeleteClub(admin, CLUB)).toBe(false);
    expect(canTransferOwnership(owner, CLUB)).toBe(true);
    expect(canTransferOwnership(admin, CLUB)).toBe(false);
    expect(canLeaveClub(owner, CLUB)).toBe(false);
    expect(canRemoveMember(admin, CLUB, { role: 'admin', userId: 'x' })).toBe(false);
    expect(canRemoveMember(owner, CLUB, { role: 'admin', userId: 'x' })).toBe(true);
    expect(canEditClub(admin, CLUB)).toBe(true);
    expect(canShareInviteLink(admin, CLUB)).toBe(true);
    expect(canManageJoinRequests(admin, CLUB)).toBe(true);
    expect(canAnnounceInChannel(admin, { id: 'c', scope: 'club', clubId: CLUB, scopeId: CLUB })).toBe(
      true,
    );
    expect(
      canDeleteMessage(admin, { id: 'c', scope: 'club', clubId: CLUB, scopeId: CLUB }, {
        senderId: 'x',
      }),
    ).toBe(true);
  });
});
