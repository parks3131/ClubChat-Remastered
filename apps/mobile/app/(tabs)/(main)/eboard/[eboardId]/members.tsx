/**
 * The Eboard roster.
 *
 * **Members only** - unlike a race roster, which a manager outside it can read because managing it
 * is their job. There is no equivalent outside role here: an admin who is not in the space has no
 * standing over it, and letting one approve would let them approve their own way in.
 *
 * Removal is the strictest rule in the product: **the club Owner only.** Mutual removal between
 * admins was rejected outright - this is the highest-trust space in it.
 *
 * The screen is `MembersScreen`, shared with the club and race rosters. What is Eboard-specific:
 * the roster is flat, because everybody in here is already admin-tier and there is no second rank
 * to split by; and the add-member pool is the club's admin tier only.
 */

import { useEffect } from 'react';
import { StyleSheet, Text } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useDeclareEboard } from '../../../../../src/current-space.tsx';
import { eboardApi } from '../../../../../src/api.ts';
import { useSession } from '../../../../../src/chat-provider.tsx';
import {
  MembersScreen,
  type MemberAction,
  type MemberRow,
} from '../../../../../src/screens/members.tsx';
import { color, space, type } from '../../../../../src/theme.ts';
import { DataScreen } from '../../../../../src/ui.tsx';
import { useLoad } from '../../../../../src/use-load.ts';

const SECTIONS = ['Members'] as const;

export default function EboardMembersScreen() {
  const { eboardId } = useLocalSearchParams<{ eboardId: string }>();
  const { userId } = useSession();

  const roster = useLoad(() => eboardApi.roster(eboardId), [eboardId]);
  const eboard = useLoad(() => eboardApi.detail(eboardId), [eboardId]);
  // Inside this club for as long as this screen is mounted. Resolved from the read
  // rather than a param: a race and an Eboard space each know their own club.
  useDeclareEboard(
    eboardId,
    eboard.data?.eboard.clubId,
    eboard.data?.eboard.name,
    eboard.data?.eboard.image,
  );

  useEffect(() => {
    void eboardApi.rosterSeen(eboardId).catch(() => undefined);
  }, [eboardId]);

  const isOwner = eboard.data?.eboard.viewer.isOwner === true;

  return (
    <DataScreen load={roster}>
      {(data) => {
        const rows: MemberRow[] = data.members.map((member) => ({
          userId: member.userId,
          name: member.name,
          image: member.image,
          tag: member.role,
          section: 'Members',
          isSelf: member.userId === userId,
        }));

        const actionsFor = (row: MemberRow): MemberAction[] => {
          // Anybody may leave, including the Owner.
          if (row.userId === userId) {
            return [
              {
                label: 'Leave the space',
                destructive: true,
                run: (id) => eboardApi.removeMember(eboardId, id),
              },
            ];
          }
          const member = data.members.find((m) => m.userId === row.userId);
          // The Owner, and nobody else. Not even another admin in the same space.
          return isOwner && member !== undefined && member.role !== 'owner'
            ? [
                {
                  label: 'Remove from the space',
                  destructive: true,
                  run: (id) => eboardApi.removeMember(eboardId, id),
                },
              ]
            : [];
        };

        return (
          <>
            <MembersScreen
              rows={rows}
              sections={SECTIONS}
              // Never null here: reaching this screen at all requires membership, and every
              // member of the space may decide a request.
              pendingRequests={data.pendingRequests}
              onDecideRequest={(requestId, approve) =>
                eboardApi.decideRequest(requestId, approve)
              }
              actionsFor={actionsFor}
              addSearch={{
                placeholder: 'Search club admins',
                find: (q: string) =>
                  eboardApi.memberCandidates(eboardId, q).then((r) => r.candidates),
                add: (id: string) => eboardApi.addMember(eboardId, id),
              }}
              emptyTitle="Nobody in the space yet"
              onChanged={roster.reload}
            />
            <Text style={styles.note}>
              Promotion to admin adds somebody here automatically, and demotion removes them. Only
              the club Owner can remove a member by hand.
            </Text>
          </>
        );
      }}
    </DataScreen>
  );
}

const styles = StyleSheet.create({
  note: {
    ...type.bodySmall,
    color: color.textSecondary,
    paddingHorizontal: space.md,
    paddingBottom: space.md,
    backgroundColor: color.appBackground,
  },
});
