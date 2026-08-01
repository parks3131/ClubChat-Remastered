/**
 * The race roster.
 *
 * The one race screen a **manager with no roster row** can open, which is `PRD/09` rule 5 - they
 * manage who goes without going themselves. Everything else about the race refuses them.
 *
 * `pendingRequests === null` means this viewer is a race member but not a manager: they see who is
 * going and have no decision to make. That is distinct from an empty queue, and the shared screen
 * renders the two differently.
 *
 * The screen is `MembersScreen`, shared with the club and Eboard rosters. What is race-specific:
 * the roster is flat rather than split by role, the car group rides along on each row, and
 * **leaving is an action on your own row** - the one place a member acts on themselves.
 */

import { useEffect } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { raceApi } from '../../../../../src/api.ts';
import { useSession } from '../../../../../src/chat-provider.tsx';
import {
  MembersScreen,
  type MemberAction,
  type MemberRow,
} from '../../../../../src/screens/members.tsx';
import { DataScreen } from '../../../../../src/ui.tsx';
import { useLoad } from '../../../../../src/use-load.ts';

/**
 * One section, not three.
 *
 * A race roster has no role hierarchy of its own: managing authority comes from the club, and
 * splitting the list by it would suggest a rank inside the race that does not exist. Who manages
 * is a tag on the row instead.
 */
const SECTIONS = ['Going'] as const;

export default function RaceRosterScreen() {
  const { raceId } = useLocalSearchParams<{ raceId: string }>();
  const { userId } = useSession();

  const roster = useLoad(() => raceApi.roster(raceId), [raceId]);

  // Opening the roster is what clears this race's pending-request rows. Refused server-side for
  // somebody with no standing, so it is safe to call unconditionally.
  useEffect(() => {
    void raceApi.rosterSeen(raceId).catch(() => undefined);
  }, [raceId]);

  return (
    <DataScreen load={roster}>
      {(data) => {
        const isManager = data.pendingRequests !== null;

        const rows: MemberRow[] = data.members.map((member) => ({
          userId: member.userId,
          name: member.name,
          image: member.image,
          // Both facts on one line: who manages, and which car they are in. The car group is the
          // question this roster gets asked most, and it rides along on the same read.
          tag: [
            member.isManager ? 'Admin' : null,
            member.carGroupNumber === null ? 'No car group' : `Group ${member.carGroupNumber}`,
          ]
            .filter((part) => part !== null)
            .join('  ·  '),
          section: 'Going',
          isSelf: member.userId === userId,
        }));

        const actionsFor = (row: MemberRow): MemberAction[] => {
          // Leaving is your own business, and needs no standing at all.
          if (row.userId === userId) {
            return [
              {
                label: 'Leave this race',
                destructive: true,
                run: (id) => raceApi.removeMember(raceId, id),
              },
            ];
          }
          // Removing somebody else is a manager's. It also takes them out of their car group,
          // and if they were the Incharge every club admin is told the group needs a new one -
          // which the server does, not this screen.
          return isManager
            ? [
                {
                  label: 'Remove from race',
                  destructive: true,
                  run: (id) => raceApi.removeMember(raceId, id),
                },
              ]
            : [];
        };

        return (
          <MembersScreen
            rows={rows}
            sections={SECTIONS}
            pendingRequests={data.pendingRequests}
            onDecideRequest={(requestId, approve) => raceApi.decideRequest(requestId, approve)}
            actionsFor={actionsFor}
            {...(isManager
              ? {
                  addSearch: {
                    // Narrower than the club's on purpose: only this race's own club members.
                    placeholder: 'Search club members',
                    find: (q: string) =>
                      raceApi.memberCandidates(raceId, q).then((r) => r.candidates),
                    add: (id: string) => raceApi.addMember(raceId, id),
                  },
                }
              : {})}
            emptyTitle="Nobody on the roster yet"
            onChanged={roster.reload}
          />
        );
      }}
    </DataScreen>
  );
}
