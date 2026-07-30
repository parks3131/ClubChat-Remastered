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
  canCreateMeeting,
  canCreatePoll,
  canDeleteClub,
  canDeleteMessage,
  canEditClub,
  canLeaveClub,
  canManageCarGroups,
  canManageClubContent,
  canManageEboardMembers,
  canManageJoinRequests,
  canManageMeeting,
  canManagePoll,
  canManageRace,
  canPinInChannel,
  canPinInRace,
  canPinRace,
  canPostInChannel,
  canPostInRace,
  canReadClubContent,
  canReadMeetInformation,
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
    action: 'Create/edit/delete a routine workout',
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
    action: 'Create a race',
    run: (c) => canManageRace(c, race),
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
    manager: true,
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
    action: 'Edit Meet Information',
    run: (c) => canManageRace(c, race),
    manager: true,
    rosteredManager: true,
    raceMember: false,
    clubMemberOffRoster: false,
    outsider: false,
  },
  {
    action: 'Create/delete car groups, assign members, set Incharge',
    run: (c) => canManageCarGroups(c, race),
    manager: true,
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

describe('authority is not access', () => {
  /**
   * The property behind the five places v1 got this wrong, asserted once rather than
   * row by row: for every capability requiring race ACCESS, a club admin off the roster is
   * denied while the same admin on the roster is allowed. The only difference between the
   * two contexts is a roster row.
   */
  it('every access-gated race capability is denied to a manager off the roster', () => {
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
    ];

    for (const [label, run] of accessGated) {
      expect(run(raceActors.manager), `manager off roster was allowed to ${label}`).toBe(false);
      expect(run(raceActors.rosteredManager), `rostered manager was denied ${label}`).toBe(true);
    }
  });

  it('every authority-gated race capability is allowed to a manager off the roster', () => {
    // The converse: losing chat access must not cost them the management they legitimately
    // hold, which is what a naive "just require a roster row for everything" would do.
    const authorityGated: Array<[string, (c: AccessContext) => boolean]> = [
      ['manage the race', (c) => canManageRace(c, race)],
      ['manage car groups', (c) => canManageCarGroups(c, race)],
      ['read Meet Information', (c) => canReadMeetInformation(c, race)],
    ];
    for (const [label, run] of authorityGated) {
      expect(run(raceActors.manager), `manager was denied ${label}`).toBe(true);
    }
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
    action: "Edit/delete somebody else's meeting (creator only)",
    run: (c) => canManageMeeting(c, meetingByOther),
    eboardMember: false,
    ownerInside: false,
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
    expect(eboardMatrix).toHaveLength(10);
  });

  it('lets a meeting creator manage their own meeting', () => {
    expect(canManageMeeting(eboardActors.eboardMember, { creatorId: ADMIN })).toBe(true);
  });

  it('how Eboard differs from Race, stated as a test', () => {
    // Both are mini-clubs nested under a club, and their membership models are opposites.
    // For a race, authority and access are separate. For the Eboard they are the same
    // thing - which is why an admin's promotion auto-joins the space while it grants nothing
    // for a race.
    const adminNoRoster = accessContextOf({ userId: ADMIN, clubRole: [[CLUB, 'admin']] });
    // Race: manages but cannot enter.
    expect(canManageRace(adminNoRoster, race)).toBe(true);
    expect(isRaceMember(adminNoRoster, race)).toBe(false);
    // Eboard: an admin outside the space cannot manage it either - there is no
    // manage-without-access position at all.
    expect(canManageEboardMembers(adminNoRoster, EBOARD)).toBe(false);
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
  it('covers all four spec tables, with both directions asserted in every cell', () => {
    // PRD/02 has four table sections: Club, Club content, Race, and Eboard. The Club table
    // (14 rows) is covered in policy.test.ts from Phase 0.
    const cells =
      contentMatrix.length * 3 + raceMatrix.length * RACE_ACTORS.length + eboardMatrix.length * 4;
    // A guard against the suite quietly shrinking: deleting a row or an actor column fails
    // here rather than silently reducing coverage.
    expect(cells).toBe(7 * 3 + 14 * 5 + 10 * 4);
    expect(cells).toBe(131);
  });

  it('asserts at least one deny in every matrix', () => {
    // A matrix of all-allows would prove nothing. This catches a predicate accidentally
    // widened to everybody, which is the failure mode an allow-only suite cannot see.
    expect(contentMatrix.some((r) => !r.owner || !r.admin || !r.member)).toBe(true);
    expect(raceMatrix.some((r) => !r.manager || !r.raceMember)).toBe(true);
    expect(eboardMatrix.some((r) => !r.eboardMember || !r.adminOutside)).toBe(true);
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
