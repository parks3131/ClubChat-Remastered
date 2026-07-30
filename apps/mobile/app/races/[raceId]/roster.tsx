/**
 * The race roster.
 *
 * The one race screen a **manager with no roster row** can open, which is `PRD/09` rule 5 - they
 * manage who goes without going themselves. Everything else about the race refuses them.
 *
 * `pendingRequests === null` means this viewer is a race member but not a manager: they see who is
 * going and have no decision to make. That is distinct from an empty queue, and the screen renders
 * the two differently.
 */

import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { raceApi } from '../../../src/api.ts';
import { useSession } from '../../../src/chat-provider.tsx';
import { color, space, type } from '../../../src/theme.ts';
import { Action, Avatar, Badge, Body, Card, DataScreen, SectionHeader } from '../../../src/ui.tsx';
import { useLoad } from '../../../src/use-load.ts';

export default function RaceRosterScreen() {
  const { raceId } = useLocalSearchParams<{ raceId: string }>();
  const { userId } = useSession();
  const [busy, setBusy] = useState<string | null>(null);

  const roster = useLoad(() => raceApi.roster(raceId), [raceId]);

  // Opening the roster is what clears this race's pending-request rows. Refused server-side for
  // somebody with no standing, so it is safe to call unconditionally.
  useEffect(() => {
    void raceApi.rosterSeen(raceId).catch(() => undefined);
  }, [raceId]);

  const act = async (key: string, run: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await run();
    } finally {
      setBusy(null);
      roster.reload();
    }
  };

  return (
    <DataScreen load={roster}>
      {(data) => {
        const isManager = data.pendingRequests !== null;

        return (
          <Body>
            {data.pendingRequests !== null && data.pendingRequests.length > 0 && (
              <>
                <SectionHeader title={`Requests (${data.pendingRequests.length})`} />
                {data.pendingRequests.map((request) => (
                  <Card key={request.requestId}>
                    <View style={styles.person}>
                      <Avatar name={request.name} />
                      <Text style={styles.name}>{request.name}</Text>
                    </View>
                    <View style={styles.actions}>
                      <Action
                        label="Deny"
                        variant="secondary"
                        style={styles.actionButton}
                        disabled={busy === request.requestId}
                        onPress={() =>
                          void act(request.requestId, () =>
                            raceApi.decideRequest(request.requestId, false),
                          )
                        }
                        accessibilityLabel={`Deny ${request.name}`}
                      />
                      <Action
                        label="Approve"
                        style={styles.actionButton}
                        disabled={busy === request.requestId}
                        onPress={() =>
                          void act(request.requestId, () =>
                            raceApi.decideRequest(request.requestId, true),
                          )
                        }
                        accessibilityLabel={`Approve ${request.name}`}
                      />
                    </View>
                  </Card>
                ))}
              </>
            )}

            <SectionHeader title={`Going (${data.members.length})`} />
            {data.members.length === 0 ? (
              <Text style={styles.meta}>Nobody on the roster yet.</Text>
            ) : (
              data.members.map((member) => (
                <Card key={member.userId}>
                  <View style={styles.person}>
                    <Avatar name={member.name} />
                    <View style={styles.personText}>
                      <Text style={styles.name}>{member.name}</Text>
                      {/* Rides along from the roster read: rule 16's add-to-group search. */}
                      <Text style={styles.meta}>
                        {member.carGroupNumber === null
                          ? 'No car group'
                          : `Group ${member.carGroupNumber}`}
                      </Text>
                    </View>
                    {member.isManager && <Badge label="Admin" tone="muted" />}
                    {member.userId === userId && <Badge label="You" tone="muted" />}
                  </View>

                  {/* Leaving is your own business; removing somebody else is a manager's. */}
                  {member.userId === userId ? (
                    <Action
                      label="Leave this race"
                      variant="secondary"
                      disabled={busy === member.userId}
                      onPress={() =>
                        void act(member.userId, () => raceApi.removeMember(raceId, member.userId))
                      }
                    />
                  ) : (
                    isManager && (
                      <Action
                        label="Remove from race"
                        variant="secondary"
                        disabled={busy === member.userId}
                        onPress={() =>
                          void act(member.userId, () => raceApi.removeMember(raceId, member.userId))
                        }
                        accessibilityLabel={`Remove ${member.name} from the race`}
                      />
                    )
                  )}
                </Card>
              ))
            )}

            {isManager && (
              <Text style={styles.meta}>
                Removing somebody also takes them out of their car group. If they were the Incharge,
                every club admin is told the group needs a new one.
              </Text>
            )}
          </Body>
        );
      }}
    </DataScreen>
  );
}

const styles = StyleSheet.create({
  person: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  personText: { flex: 1, gap: space.xs },
  name: { ...type.headline, color: color.textPrimary },
  meta: { ...type.bodySmall, color: color.textSecondary },
  actions: { flexDirection: 'row', gap: space.sm },
  actionButton: { flex: 1 },
});
