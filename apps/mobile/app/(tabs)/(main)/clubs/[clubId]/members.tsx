/**
 * The club roster: members, pending requests, and role changes.
 *
 * **Opening this screen is what clears that club's pending join-request notifications** - not
 * opening the inbox. That is one of the two exceptions in the notification model, and it lives here
 * because this is the screen where the request is actually dealt with.
 *
 * The authority rules on display are deliberately asymmetric, and all three are the server's:
 * any admin may promote or demote; removing an Admin is Owner-only; the Owner can never be removed
 * at all. A control that is hidden is UX - every one of these is refused server-side too.
 *
 * The screen itself is `MembersScreen`, shared with the race and Eboard rosters. Everything
 * club-specific is in the two functions below: which section a row belongs to, and what may be
 * done to it.
 */

import { useEffect } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { useDeclareClub } from '../../../../../src/current-space.tsx';
import { clubApi } from '../../../../../src/api.ts';
import type { ClubRoster, RosterEntry } from '../../../../../src/api-types.ts';
import { useSession } from '../../../../../src/chat-provider.tsx';
import {
  MembersScreen,
  type MemberAction,
  type MemberRow,
} from '../../../../../src/screens/members.tsx';
import { DataScreen } from '../../../../../src/ui.tsx';
import { useLoad } from '../../../../../src/use-load.ts';

/** Owner and Admins get their own sections, so authority is legible without reading every tag. */
const SECTIONS = ['Owner', 'Admins', 'Members'] as const;

function sectionOf(role: RosterEntry['role']): string {
  return role === 'owner' ? 'Owner' : role === 'admin' ? 'Admins' : 'Members';
}

export default function ClubMembersScreen() {
  const { clubId } = useLocalSearchParams<{ clubId: string }>();
  // Inside this club for as long as this screen is mounted, which is what the Clubs tab reads.
  useDeclareClub(clubId);
  const { userId } = useSession();

  const roster = useLoad(() => clubApi.roster(clubId), [clubId]);

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
    <DataScreen load={roster}>
      {(data: ClubRoster) => {
        const viewer = data.members.find((member) => member.userId === userId);
        const isOwner = viewer?.role === 'owner';
        // `pendingRequests` is null for a non-admin, which is distinct from an empty queue - so
        // the admin-only surface is driven by that rather than by re-deriving the role.
        const isAdmin = data.pendingRequests !== null;

        const rows: MemberRow[] = data.members.map((member) => ({
          userId: member.userId,
          name: member.name,
          image: member.image,
          // The section heading already says "Owner", so repeating it beside the name is noise.
          tag: null,
          section: sectionOf(member.role),
          isSelf: member.userId === userId,
        }));

        const actionsFor = (row: MemberRow): MemberAction[] => {
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

          // Any admin removes a plain Member; removing an Admin is Owner-only; the Owner is
          // never removable. Mirrors canRemoveMember exactly.
          const removable =
            member.role !== 'owner' && (member.role === 'admin' ? isOwner === true : isAdmin);
          if (removable) {
            actions.push({
              label: 'Remove from club',
              destructive: true,
              run: (id) => clubApi.removeMember(clubId, id),
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
            onChanged={roster.reload}
          />
        );
      }}
    </DataScreen>
  );
}
