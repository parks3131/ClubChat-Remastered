/**
 * The club roster: members, pending requests, role changes, and bans.
 *
 * **Opening this screen is what clears that club's pending join-request notifications** - not
 * opening the inbox. That is one of the two exceptions in the notification model, and it lives here
 * because this is the screen where the request is actually dealt with.
 *
 * The authority rules on display are deliberately asymmetric, and all of them are the server's:
 * any admin may promote or demote; removing an Admin is Owner-only; the Owner can never be removed
 * at all; and banning follows that same ladder while **lifting a ban does not** - any admin may
 * undo any ban. A control that is hidden is UX; every one of these is refused server-side too.
 *
 * > **The removal ladder used to be re-derived here**, from the target's role and the viewer's own
 * > `isAdmin`/`isOwner`. Banning adds a third ladder that is asymmetric in the opposite direction,
 * > which is the moment a restated rule starts drifting - so the server now answers `canRemove` and
 * > `canBan` per row and this screen renders the answer. Same reason `canLeave` is answered
 * > server-side for a conversation.
 *
 * The screen itself is `MembersScreen`, shared with the race and Eboard rosters. Everything
 * club-specific is below: which section a row belongs to, and what may be done to it. **The banned
 * list is a section rather than a separate screen**, because the attribution is the safeguard and
 * it belongs where every admin already is, one tap from the fix.
 */

import { useEffect } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { useDeclareClub } from '../../../../../src/current-space.tsx';
import { clubApi } from '../../../../../src/api.ts';
import type { ClubBan, ClubRoster, RosterEntry } from '../../../../../src/api-types.ts';
import { useSession } from '../../../../../src/chat-provider.tsx';
import {
  MembersScreen,
  type MemberAction,
  type MemberRow,
} from '../../../../../src/screens/members.tsx';
import { DataScreen } from '../../../../../src/ui.tsx';
import { useLoad } from '../../../../../src/use-load.ts';

/**
 * Owner and Admins get their own sections, so authority is legible without reading every tag.
 * Banned sits last: it is the least-visited part of the screen and reads as a footnote to the
 * roster rather than as part of it, which is the right weight.
 */
const SECTIONS = ['Owner', 'Admins', 'Members', 'Banned'] as const;

function sectionOf(role: RosterEntry['role']): string {
  return role === 'owner' ? 'Owner' : role === 'admin' ? 'Admins' : 'Members';
}

type RosterView = { roster: ClubRoster; bans: ClubBan[] };

export default function ClubMembersScreen() {
  const { clubId } = useLocalSearchParams<{ clubId: string }>();
  // Inside this club for as long as this screen is mounted, which is what the Clubs tab reads.
  useDeclareClub(clubId);
  const { userId } = useSession();

  /*
   * Both reads in one load, so the roster and the ban list can never render a tick apart.
   *
   * The ban list refuses a non-admin with a 404 - the same answer as a club that does not exist,
   * per the refusal discipline - so an ordinary member falls through to an empty list and simply
   * has no Banned section. That is a refusal handled as absence, not an error worth a screen.
   */
  const view = useLoad(
    (): Promise<RosterView> =>
      Promise.all([
        clubApi.roster(clubId),
        clubApi.bans(clubId).catch(() => ({ bans: [] as ClubBan[] })),
      ]).then(([roster, bans]) => ({ roster, bans: bans.bans })),
    [clubId],
  );

  /*
   * Clearing the join-request rows, once, on open.
   *
   * Not in the load itself: a reload after approving somebody would fire it again, and the point
   * of the row being cleared "by opening the roster" is that opening is the event. Refused
   * server-side for a non-admin, so the call is safe to make unconditionally.
   */
  useEffect(() => {
    void clubApi.rosterSeen(clubId).catch(() => undefined);
  }, [clubId]);

  return (
    <DataScreen load={view}>
      {({ roster: data, bans }: RosterView) => {
        const viewer = data.members.find((member) => member.userId === userId);
        const isOwner = viewer?.role === 'owner';
        // `pendingRequests` is null for a non-admin, which is distinct from an empty queue - so
        // the admin-only surface is driven by that rather than by re-deriving the role.
        const isAdmin = data.pendingRequests !== null;

        const rows: MemberRow[] = [
          ...data.members.map((member) => ({
            userId: member.userId,
            name: member.name,
            image: member.image,
            // The section heading already says "Owner", so repeating it beside the name is noise.
            tag: null,
            section: sectionOf(member.role),
            isSelf: member.userId === userId,
          })),
          /*
           * The banned, tagged with who banned them.
           *
           * That tag is the whole point rather than decoration: an open power is made safe by
           * being visible, so every other admin sees a wrongful ban with a name on it, on the
           * screen where undoing it is one tap away.
           */
          ...bans.map((ban) => ({
            userId: ban.userId,
            name: ban.name,
            image: ban.image,
            tag: ban.bannedByName === null ? 'banned' : `banned by ${ban.bannedByName}`,
            section: 'Banned',
            isSelf: false,
          })),
        ];

        const actionsFor = (row: MemberRow): MemberAction[] => {
          // A banned row is not a member, so it gets the one action that applies to it.
          if (row.section === 'Banned') {
            return isAdmin
              ? [
                  {
                    // Any admin, including one who did not impose it. The asymmetry is deliberate
                    // and is what contains a rogue admin - ADR-0021.
                    label: 'Lift ban',
                    run: (id) => clubApi.liftBan(clubId, id),
                  },
                ]
              : [];
          }

          const member = data.members.find((m) => m.userId === row.userId);
          if (!member || member.userId === userId) return [];

          const actions: MemberAction[] = [];

          // Any admin may promote or demote. The Owner's role is never writable here: it moves
          // only through transfer.
          if (isAdmin && member.role !== 'owner') {
            actions.push({
              label: member.role === 'admin' ? 'Demote to member' : 'Promote to admin',
              run: (id) =>
                clubApi.changeRole(clubId, id, member.role === 'admin' ? 'member' : 'admin'),
            });
          }

          // Owner only, and never onto themselves.
          if (isOwner === true && member.role !== 'owner') {
            actions.push({
              label: 'Transfer ownership',
              destructive: true,
              run: (id) => clubApi.transferOwnership(clubId, id),
            });
          }

          // Both answered by the server. Note they are NOT the same question: removing an Admin
          // and banning an Admin are both Owner-only, but a ban outlives the removal, so the two
          // flags are read independently rather than one being inferred from the other.
          if (member.canRemove) {
            actions.push({
              label: 'Remove from club',
              destructive: true,
              run: (id) => clubApi.removeMember(clubId, id),
            });
          }

          if (member.canBan) {
            actions.push({
              label: 'Ban from club',
              destructive: true,
              run: (id) => clubApi.ban(clubId, id),
            });
          }

          return actions;
        };

        return (
          <MembersScreen
            rows={rows}
            sections={SECTIONS}
            pendingRequests={data.pendingRequests}
            onDecideRequest={(requestId, approve) => clubApi.decideRequest(requestId, approve)}
            actionsFor={actionsFor}
            {...(isAdmin
              ? {
                  addPeople: {
                    /*
                     * Search, not pick, and the pool is the reason. A club's candidates are
                     * everybody you share ANY club with, which is not a list anybody reads down
                     * - opening the panel onto it would be a wall of near-strangers. The race
                     * and Eboard rosters draw from one club and do offer the pick list.
                     */
                    mode: 'search' as const,
                    placeholder: 'Search by name',
                    find: (q: string) =>
                      clubApi.memberCandidates(clubId, q).then((r) => r.candidates),
                    add: (id: string) => clubApi.addMember(clubId, id),
                  },
                }
              : {})}
            emptyTitle="No members yet"
            /*
             * The card opens knowing which club it was reached from, so it can offer Ban and
             * Unban. Without it the profile has no club context and correctly shows neither -
             * which is why the race and Eboard rosters do not pass one.
             */
            profileHref={(row) =>
              // A banned person shares no club with anybody here any more, so their profile is
              // deliberately unreadable - offering the card would open a guaranteed "Not found".
              // The Lift ban action on the row is the whole menu for them.
              row.section === 'Banned' ? null : `/users/${row.userId}?clubId=${clubId}`
            }
            onChanged={view.reload}
          />
        );
      }}
    </DataScreen>
  );
}
