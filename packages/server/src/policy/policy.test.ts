/**
 * The permission matrix, as a test file.
 *
 * SPEC/PRD/17-roadmap-and-open-questions.md records that in v1 the matrix was
 * "verified by hand". That ends here. Every cell of the consolidated matrices in
 * SPEC/PRD/02-roles-and-permissions.md becomes a case asserting allow AND deny.
 *
 * Asserting deny is the half that matters. A predicate that returns true for
 * everybody passes every allow-only test ever written.
 */

import { describe, expect, it } from 'vitest';
import type { ClubRole } from '@clubchat/shared';
import { accessContextOf, type AccessContext } from './context.ts';
import {
  canAnnounceInChannel,
  canChangeRole,
  canDeleteClub,
  canDeleteMessage,
  canEditClub,
  canLeaveClub,
  canManageJoinRequests,
  canPinInChannel,
  canPostInChannel,
  canRemoveMember,
  canReportMessage,
  canShareInviteLink,
  canTransferOwnership,
  isChannelAdmin,
  isChannelMember,
  isClubAdmin,
  isClubMember,
  isClubOwner,
  type ChannelRef,
} from './predicates.ts';

const CLUB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EBOARD = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RACE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const DM = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

const OWNER = 'u-owner';
const ADMIN = 'u-admin';
const MEMBER = 'u-member';
const OUTSIDER = 'u-outsider';
/** The other side of the DM. There are exactly two participants, ever. */
const PEER = 'u-peer';

type ActorName = 'owner' | 'admin' | 'member' | 'nonMember';

const actors: Record<ActorName, AccessContext> = {
  owner: accessContextOf({ userId: OWNER, clubRole: [[CLUB, 'owner']] }),
  admin: accessContextOf({ userId: ADMIN, clubRole: [[CLUB, 'admin']] }),
  member: accessContextOf({ userId: MEMBER, clubRole: [[CLUB, 'member']] }),
  nonMember: accessContextOf({ userId: OUTSIDER }),
};

const ACTOR_NAMES: ActorName[] = ['owner', 'admin', 'member', 'nonMember'];

const clubChannel: ChannelRef = {
  id: 'ch-club',
  scope: 'club',
  clubId: CLUB,
  scopeId: CLUB,
};

// ---------------------------------------------------------------------------
// PRD/02 - the Club matrix
// ---------------------------------------------------------------------------

type Row = {
  action: string;
  run: (ctx: AccessContext) => boolean;
  owner: boolean;
  admin: boolean;
  member: boolean;
  nonMember: boolean;
};

const clubMatrix: Row[] = [
  {
    action: 'Read club content',
    run: (c) => isClubMember(c, CLUB),
    owner: true,
    admin: true,
    member: true,
    nonMember: false,
  },
  {
    action: 'Send messages',
    run: (c) => canPostInChannel(c, clubChannel),
    owner: true,
    admin: true,
    member: true,
    nonMember: false,
  },
  {
    action: 'Pin / unpin a message',
    run: (c) => canPinInChannel(c, clubChannel),
    owner: true,
    admin: true,
    member: false,
    nonMember: false,
  },
  {
    action: 'Post an announcement',
    run: (c) => canAnnounceInChannel(c, clubChannel),
    owner: true,
    admin: true,
    member: false,
    nonMember: false,
  },
  {
    action: "Delete another member's message",
    run: (c) => canDeleteMessage(c, clubChannel, { senderId: 'someone-else' }),
    owner: true,
    admin: true,
    member: false,
    nonMember: false,
  },
  {
    action: 'Edit club identity / join policy',
    run: (c) => canEditClub(c, CLUB),
    owner: true,
    admin: true,
    member: false,
    nonMember: false,
  },
  {
    action: 'Share or copy the join link',
    run: (c) => canShareInviteLink(c, CLUB),
    owner: true,
    admin: true,
    member: false,
    nonMember: false,
  },
  {
    action: 'Approve or deny join requests',
    run: (c) => canManageJoinRequests(c, CLUB),
    owner: true,
    admin: true,
    member: false,
    nonMember: false,
  },
  {
    action: 'Promote a Member to Admin',
    run: (c) => canChangeRole(c, CLUB, { role: 'member' }),
    owner: true,
    admin: true,
    member: false,
    nonMember: false,
  },
  {
    action: 'Remove a Member',
    run: (c) => canRemoveMember(c, CLUB, { role: 'member', userId: MEMBER }),
    owner: true,
    admin: true,
    member: false,
    nonMember: false,
  },
  {
    // The deliberate asymmetry: demoting an admin is any-admin, ejecting one is not.
    action: 'Remove an Admin (Owner only)',
    run: (c) => canRemoveMember(c, CLUB, { role: 'admin', userId: ADMIN }),
    owner: true,
    admin: false,
    member: false,
    nonMember: false,
  },
  {
    action: 'Transfer ownership (Owner only)',
    run: (c) => canTransferOwnership(c, CLUB),
    owner: true,
    admin: false,
    member: false,
    nonMember: false,
  },
  {
    // The Owner cannot leave their own club. Transfer first.
    action: 'Leave the club',
    run: (c) => canLeaveClub(c, CLUB),
    owner: false,
    admin: true,
    member: true,
    nonMember: false,
  },
  {
    action: 'Delete the club (Owner only)',
    run: (c) => canDeleteClub(c, CLUB),
    owner: true,
    admin: false,
    member: false,
    nonMember: false,
  },
];

describe('PRD/02 club permission matrix', () => {
  for (const row of clubMatrix) {
    for (const actor of ACTOR_NAMES) {
      const expected = row[actor];
      it(`${row.action}: ${actor} -> ${expected ? 'allow' : 'deny'}`, () => {
        expect(row.run(actors[actor])).toBe(expected);
      });
    }
  }

  it('covers every action in the spec table', () => {
    // A guard against the matrix quietly shrinking. PRD/02's Club table has 14 rows
    // that Phase 0's predicates can answer; if a row is deleted this fails rather
    // than silently reducing coverage.
    expect(clubMatrix).toHaveLength(14);
  });
});

// ---------------------------------------------------------------------------
// The bug that shipped four times
// ---------------------------------------------------------------------------

describe('owner is a strict superset of admin', () => {
  it('isClubAdmin matches the Owner, not only literal admins', () => {
    expect(isClubAdmin(actors.owner, CLUB)).toBe(true);
    expect(isClubAdmin(actors.admin, CLUB)).toBe(true);
    expect(isClubAdmin(actors.member, CLUB)).toBe(false);
  });

  it('isClubOwner does NOT match a plain admin', () => {
    expect(isClubOwner(actors.owner, CLUB)).toBe(true);
    expect(isClubOwner(actors.admin, CLUB)).toBe(false);
  });

  /**
   * The property behind the bug, stated once so it cannot regress row by row:
   * anything a plain Admin may do, the Owner may also do. A brand-new club's only
   * admin-tier member is its Owner, so any capability that admits Admin but not
   * Owner is broken for every new club - which is exactly how this shipped four
   * times.
   */
  it('every capability granted to Admin is also granted to Owner', () => {
    const adminAllowed = clubMatrix.filter((row) => row.admin);
    expect(adminAllowed.length).toBeGreaterThan(0);

    for (const row of adminAllowed) {
      // 'Leave the club' is the one deliberate exception, and it is a restriction on
      // the Owner rather than a capability withheld: an ownerless club has no
      // recovery path, so transfer is the only exit.
      if (row.action === 'Leave the club') continue;
      expect(row.run(actors.owner), `Owner denied "${row.action}" that Admin is allowed`).toBe(
        true,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The channel abstraction: one implementation, four scopes
// ---------------------------------------------------------------------------

describe('channel abstraction holds across scopes', () => {
  const eboardChannel: ChannelRef = {
    id: 'ch-eboard',
    scope: 'eboard',
    clubId: CLUB,
    scopeId: EBOARD,
  };
  const raceChannel: ChannelRef = { id: 'ch-race', scope: 'race', clubId: CLUB, scopeId: RACE };
  const dmChannel: ChannelRef = { id: 'ch-dm', scope: 'dm', clubId: null, scopeId: DM };

  it('club admin status does NOT grant race chat access', () => {
    // The most-misunderstood rule in the product, and deliberate. Management
    // authority over a race is not access to it: chat, polls and car-group
    // assignment all require a real roster row, for admins too. Substituting an
    // admin check for a roster row was wrong in five separate places in v1.
    const adminNotOnRoster = accessContextOf({
      userId: ADMIN,
      clubRole: [[CLUB, 'admin']],
    });
    expect(isChannelMember(adminNotOnRoster, raceChannel)).toBe(false);
    expect(isChannelAdmin(adminNotOnRoster, raceChannel)).toBe(false);
  });

  it('a race member can post but only a rostered club admin can pin', () => {
    const plainRacer = accessContextOf({
      userId: MEMBER,
      clubRole: [[CLUB, 'member']],
      raceRoster: [RACE],
    });
    const rosteredAdmin = accessContextOf({
      userId: ADMIN,
      clubRole: [[CLUB, 'admin']],
      raceRoster: [RACE],
    });

    expect(canPostInChannel(plainRacer, raceChannel)).toBe(true);
    expect(canPinInChannel(plainRacer, raceChannel)).toBe(false);
    expect(canPinInChannel(rosteredAdmin, raceChannel)).toBe(true);
  });

  it('an Eboard member is an admin of their own space, and an outside club admin is not', () => {
    const inside = accessContextOf({
      userId: ADMIN,
      clubRole: [[CLUB, 'admin']],
      eboardMember: [EBOARD],
    });
    expect(isChannelMember(inside, eboardChannel)).toBe(true);
    expect(isChannelAdmin(inside, eboardChannel)).toBe(true);

    // An admin who left the space must request or be re-added; admin status alone
    // does not re-admit them.
    expect(isChannelMember(actors.admin, eboardChannel)).toBe(false);
    expect(isChannelAdmin(actors.admin, eboardChannel)).toBe(false);
  });

  it('nobody is an admin in a DM, which removes announcements for free', () => {
    const participant = accessContextOf({
      userId: MEMBER,
      clubRole: [[CLUB, 'member']],
      dmThreads: [{ conversationId: DM, otherUserId: PEER }],
    });

    expect(isChannelMember(participant, dmChannel)).toBe(true);
    expect(canPostInChannel(participant, dmChannel)).toBe(true);
    // ADR-0009: isChannelAdmin constant-false for the scope is what removes announcements
    // and poll creation automatically, since both were already gated on it.
    expect(isChannelAdmin(participant, dmChannel)).toBe(false);
    expect(canAnnounceInChannel(participant, dmChannel)).toBe(false);
    // Pinning is the exception, and had to become its own predicate: PRD/14 rule 4 says a
    // DM has no admins AND that either participant may pin for reference. Leaving pinning
    // aliased to isChannelAdmin silently dropped that.
    expect(canPinInChannel(participant, dmChannel)).toBe(true);
  });

  it('neither DM participant can delete the other message, but each can delete their own', () => {
    const participant = accessContextOf({
      userId: MEMBER,
      clubRole: [[CLUB, 'member']],
      dmThreads: [{ conversationId: DM, otherUserId: PEER }],
    });

    expect(canDeleteMessage(participant, dmChannel, { senderId: MEMBER })).toBe(true);
    // The row that differs from every other scope. The admin who would hold this
    // power in club chat does not exist here, so moderation is blocking plus
    // reporting rather than deletion.
    expect(canDeleteMessage(participant, dmChannel, { senderId: PEER })).toBe(false);
  });

  it('a sender can always delete their own message in any scope', () => {
    const cases: Array<[string, AccessContext, ChannelRef]> = [
      ['club', actors.member, clubChannel],
      [
        'race',
        accessContextOf({ userId: MEMBER, clubRole: [[CLUB, 'member']], raceRoster: [RACE] }),
        raceChannel,
      ],
      [
        'eboard',
        accessContextOf({ userId: MEMBER, clubRole: [[CLUB, 'admin']], eboardMember: [EBOARD] }),
        eboardChannel,
      ],
      [
        'dm',
        accessContextOf({
          userId: MEMBER,
          clubRole: [[CLUB, 'member']],
          dmThreads: [{ conversationId: DM, otherUserId: PEER }],
        }),
        dmChannel,
      ],
    ];

    for (const [name, ctx, channel] of cases) {
      expect(canDeleteMessage(ctx, channel, { senderId: MEMBER }), `scope ${name}`).toBe(true);
    }
  });

  it('a non-member is denied every scope, including by direct reference', () => {
    for (const channel of [clubChannel, eboardChannel, raceChannel, dmChannel]) {
      expect(isChannelMember(actors.nonMember, channel), `scope ${channel.scope}`).toBe(false);
      expect(canPostInChannel(actors.nonMember, channel), `scope ${channel.scope}`).toBe(false);
      expect(isChannelAdmin(actors.nonMember, channel), `scope ${channel.scope}`).toBe(false);
    }
  });
});

describe('reporting', () => {
  it('anyone with access can report a message they did not send', () => {
    expect(canReportMessage(actors.member, clubChannel, { senderId: OWNER })).toBe(true);
  });

  it('you cannot report your own message', () => {
    expect(canReportMessage(actors.member, clubChannel, { senderId: MEMBER })).toBe(false);
  });

  it('a non-member cannot report into a club they are not in', () => {
    expect(canReportMessage(actors.nonMember, clubChannel, { senderId: OWNER })).toBe(false);
  });
});

describe('role changes', () => {
  it("the Owner's role is never writable through canChangeRole", () => {
    // The Owner tier moves only through the ownership-transfer path, which demotes
    // the outgoing owner BEFORE promoting the new one - the one-owner constraint is
    // checked per statement, so the other order momentarily holds two owners and
    // fails. Proved against the live database in db/constraint-proof.sql.
    const target: { role: ClubRole } = { role: 'owner' };
    expect(canChangeRole(actors.owner, CLUB, target)).toBe(false);
    expect(canChangeRole(actors.admin, CLUB, target)).toBe(false);
  });

  it('the Owner can never be removed by anyone, including themselves', () => {
    for (const actor of ACTOR_NAMES) {
      expect(canRemoveMember(actors[actor], CLUB, { role: 'owner', userId: OWNER })).toBe(false);
    }
  });

  it('removing yourself is not a removal - that is leaving', () => {
    expect(canRemoveMember(actors.admin, CLUB, { role: 'admin', userId: ADMIN })).toBe(false);
  });
});

describe('cross-club isolation', () => {
  const OTHER_CLUB = '99999999-9999-4999-8999-999999999999';

  it('a role in one club grants nothing in another', () => {
    // Roles are per club. Owner of one club, plain member of another, no interaction.
    expect(isClubOwner(actors.owner, OTHER_CLUB)).toBe(false);
    expect(isClubAdmin(actors.owner, OTHER_CLUB)).toBe(false);
    expect(isClubMember(actors.owner, OTHER_CLUB)).toBe(false);
    expect(canDeleteClub(actors.owner, OTHER_CLUB)).toBe(false);
  });
});
