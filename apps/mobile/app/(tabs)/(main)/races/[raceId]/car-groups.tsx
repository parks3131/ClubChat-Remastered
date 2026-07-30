/**
 * Car Assignments and Groups.
 *
 * **Every race member views this, read-only; only managers create, delete, assign or remove**
 * (`PRD/09` rule 20). A manager with no roster row gets nothing here at all - they manage the
 * roster, not the race - which is the server's answer and the clearest expression of authority not
 * being access.
 *
 * The Incharge rule is the one worth getting right: they **must be a current member of that group**,
 * because the Incharge is the person everyone calls when the car does not show up. A group with no
 * Incharge is a normal state - it is cleared automatically when its holder leaves, and the group
 * persists until an admin names a new one.
 */

import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useDeclareClub } from '../../../../../src/current-club.tsx';
import { raceApi } from '../../../../../src/api.ts';
import type { CarGroup } from '../../../../../src/api-types.ts';
import { useSession } from '../../../../../src/chat-provider.tsx';
import { color, space, type } from '../../../../../src/theme.ts';
import {
  Action,
  Badge,
  Body,
  Card,
  DataScreen,
  EmptyState,
  SectionHeader,
} from '../../../../../src/ui.tsx';
import { useLoad } from '../../../../../src/use-load.ts';

export default function CarGroupsScreen() {
  const { raceId } = useLocalSearchParams<{ raceId: string }>();
  const groups = useLoad(() => raceApi.carGroups(raceId), [raceId]);
  const race = useLoad(() => raceApi.detail(raceId), [raceId]);
  // Inside this club for as long as this screen is mounted. Resolved from the read
  // rather than a param: a race and an Eboard space each know their own club.
  useDeclareClub(race.data?.race.clubId);
  const [busy, setBusy] = useState(false);

  const isManager = race.data?.race.viewer.isManager === true;

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await run();
    } finally {
      setBusy(false);
      groups.reload();
    }
  };

  return (
    <DataScreen
      load={groups}
      isEmpty={(data) => data.groups.length === 0 && !isManager}
      empty={<EmptyState title="No car groups yet" body="An admin creates and fills them." />}
    >
      {(data) => (
        <Body>
          {data.groups.map((group) => (
            <GroupCard
              key={group.id}
              group={group}
              unassigned={data.unassigned}
              isManager={isManager}
              busy={busy}
              onAct={act}
              raceId={raceId}
            />
          ))}

          {data.unassigned.length > 0 && (
            <>
              <SectionHeader title={`Not in a car (${data.unassigned.length})`} />
              <Card>
                <Text style={styles.meta}>
                  {data.unassigned.map((person) => person.name).join(', ')}
                </Text>
              </Card>
            </>
          )}

          {isManager && (
            <>
              <SectionHeader title="Manage" />
              {/* Auto-numbered, with no naming prompt: naming eight cars is friction. */}
              <Action
                label="Add a group"
                disabled={busy}
                onPress={() => void act(() => raceApi.createCarGroup(raceId))}
              />
            </>
          )}
        </Body>
      )}
    </DataScreen>
  );
}

function GroupCard({
  group,
  unassigned,
  isManager,
  busy,
  onAct,
  raceId,
}: {
  group: CarGroup;
  unassigned: Array<{ userId: string; name: string }>;
  isManager: boolean;
  busy: boolean;
  onAct: (run: () => Promise<unknown>) => Promise<void>;
  raceId: string;
}) {
  const { userId } = useSession();
  const [adding, setAdding] = useState(false);

  return (
    <Card>
      <View style={styles.header}>
        <Text style={styles.groupTitle}>Group {group.number}</Text>
        {group.inchargeUserId === null && <Badge label="No Incharge" tone="muted" />}
      </View>

      {group.members.length === 0 ? (
        <Text style={styles.meta}>Empty.</Text>
      ) : (
        group.members.map((member) => (
          <View key={member.userId} style={styles.memberRow}>
            <Text style={styles.member}>{member.name}</Text>
            {member.isIncharge && <Badge label="Incharge" tone="accent" />}

            {/* The Incharge must be in this car, so only its own members can be named. */}
            {isManager && !member.isIncharge && (
              <Action
                label="Make Incharge"
                variant="quiet"
                disabled={busy}
                onPress={() => void onAct(() => raceApi.setIncharge(group.id, member.userId))}
                accessibilityLabel={`Make ${member.name} the Incharge of group ${group.number}`}
              />
            )}
            {isManager && member.isIncharge && (
              <Action
                label="Clear"
                variant="quiet"
                disabled={busy}
                onPress={() => void onAct(() => raceApi.setIncharge(group.id, null))}
                accessibilityLabel={`Clear the Incharge of group ${group.number}`}
              />
            )}

            {/* Any member can leave their own car without leaving the race. */}
            {(member.userId === userId || isManager) && (
              <Action
                label={member.userId === userId ? 'Leave' : 'Remove'}
                variant="quiet"
                disabled={busy}
                onPress={() => void onAct(() => raceApi.leaveCarGroup(raceId, member.userId))}
                accessibilityLabel={
                  member.userId === userId
                    ? `Leave group ${group.number}`
                    : `Remove ${member.name} from group ${group.number}`
                }
              />
            )}
          </View>
        ))
      )}

      {isManager &&
        (adding ? (
          <View style={styles.addPanel}>
            {/*
              The add search excludes anybody already in a group for this race, which is rule 16 -
              and the server's `unassigned` list is exactly that set, so there is nothing to filter
              here.
            */}
            {unassigned.length === 0 ? (
              <Text style={styles.meta}>Everybody on the roster is already in a car.</Text>
            ) : (
              unassigned.map((person) => (
                <Action
                  key={person.userId}
                  label={person.name}
                  variant="secondary"
                  disabled={busy}
                  onPress={() => {
                    void onAct(() => raceApi.assignToCarGroup(group.id, person.userId));
                    setAdding(false);
                  }}
                  accessibilityLabel={`Add ${person.name} to group ${group.number}`}
                />
              ))
            )}
            <Action label="Done" variant="quiet" onPress={() => setAdding(false)} />
          </View>
        ) : (
          <Action
            label="Add somebody"
            variant="secondary"
            onPress={() => setAdding(true)}
            accessibilityLabel={`Add somebody to group ${group.number}`}
          />
        ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  groupTitle: { ...type.headline, color: color.textPrimary, flex: 1 },
  memberRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  member: { ...type.body, color: color.textPrimary, flex: 1 },
  meta: { ...type.bodySmall, color: color.textSecondary },
  addPanel: { gap: space.sm },
});
