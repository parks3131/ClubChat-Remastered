/**
 * The Eboard roster.
 *
 * **Members only** - unlike a race roster, which a manager outside it can read because managing it
 * is their job. There is no equivalent outside role here: an admin who is not in the space has no
 * standing over it, and letting one approve would let them approve their own way in.
 *
 * Removal is the strictest rule in the product: **the club Owner only.** Mutual removal between
 * admins was rejected outright - this is the highest-trust space in it.
 */

import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { eboardApi } from '../../../src/api.ts';
import { useSession } from '../../../src/chat-provider.tsx';
import { color, space, type } from '../../../src/theme.ts';
import { Action, Avatar, Badge, Body, Card, DataScreen, SectionHeader } from '../../../src/ui.tsx';
import { useLoad } from '../../../src/use-load.ts';

export default function EboardMembersScreen() {
  const { eboardId } = useLocalSearchParams<{ eboardId: string }>();
  const { userId } = useSession();
  const [busy, setBusy] = useState<string | null>(null);

  const roster = useLoad(() => eboardApi.roster(eboardId), [eboardId]);
  const eboard = useLoad(() => eboardApi.detail(eboardId), [eboardId]);

  useEffect(() => {
    void eboardApi.rosterSeen(eboardId).catch(() => undefined);
  }, [eboardId]);

  const act = async (key: string, run: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await run();
    } finally {
      setBusy(null);
      roster.reload();
    }
  };

  const isOwner = eboard.data?.eboard.viewer.isOwner === true;

  return (
    <DataScreen load={roster}>
      {(data) => (
        <Body>
          {data.pendingRequests.length > 0 && (
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
                          eboardApi.decideRequest(request.requestId, false),
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
                          eboardApi.decideRequest(request.requestId, true),
                        )
                      }
                      accessibilityLabel={`Approve ${request.name}`}
                    />
                  </View>
                </Card>
              ))}
            </>
          )}

          <SectionHeader title={`Members (${data.members.length})`} />
          {data.members.map((member) => (
            <Card key={member.userId}>
              <View style={styles.person}>
                <Avatar name={member.name} />
                <View style={styles.personText}>
                  <Text style={styles.name}>{member.name}</Text>
                  <Text style={styles.meta}>{member.role}</Text>
                </View>
                {member.userId === userId && <Badge label="You" tone="muted" />}
              </View>

              {/* Anybody may leave. Removing somebody else is the Owner and nobody else. */}
              {member.userId === userId ? (
                <Action
                  label="Leave the space"
                  variant="secondary"
                  disabled={busy === member.userId}
                  onPress={() =>
                    void act(member.userId, () => eboardApi.removeMember(eboardId, member.userId))
                  }
                />
              ) : (
                isOwner &&
                member.role !== 'owner' && (
                  <Action
                    label="Remove"
                    variant="secondary"
                    disabled={busy === member.userId}
                    onPress={() =>
                      void act(member.userId, () => eboardApi.removeMember(eboardId, member.userId))
                    }
                    accessibilityLabel={`Remove ${member.name} from the board space`}
                  />
                )
              )}
            </Card>
          ))}

          <Text style={styles.meta}>
            Promotion to admin adds somebody here automatically, and demotion removes them. Only the
            club Owner can remove a member by hand.
          </Text>
        </Body>
      )}
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
