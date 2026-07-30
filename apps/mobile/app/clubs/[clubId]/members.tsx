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
 */

import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { clubApi } from '../../../src/api.ts';
import type { RosterEntry } from '../../../src/api-types.ts';
import { useSession } from '../../../src/chat-provider.tsx';
import { color, space, type } from '../../../src/theme.ts';
import { Action, Avatar, Badge, Body, Card, DataScreen, SectionHeader } from '../../../src/ui.tsx';
import { useLoad } from '../../../src/use-load.ts';

export default function ClubMembersScreen() {
  const { clubId } = useLocalSearchParams<{ clubId: string }>();
  const { userId } = useSession();
  const [busy, setBusy] = useState<string | null>(null);

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

  const act = async (key: string, run: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await run();
      roster.reload();
    } catch {
      // Reload anyway: the refusal may be because the state already changed under us, and the
      // truth is on the server rather than in this component.
      roster.reload();
    } finally {
      setBusy(null);
    }
  };

  return (
    <DataScreen load={roster}>
      {(data) => {
        const viewer = data.members.find((member) => member.userId === userId);
        const isOwner = viewer?.role === 'owner';
        // `pendingRequests` is null for a non-admin, which is distinct from an empty queue - so
        // the admin-only section is driven by that rather than by re-deriving the role.
        const isAdmin = data.pendingRequests !== null;

        return (
          <Body>
            {data.pendingRequests !== null && data.pendingRequests.length > 0 && (
              <>
                <SectionHeader title={`Pending requests (${data.pendingRequests.length})`} />
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
                            clubApi.decideRequest(request.requestId, false),
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
                            clubApi.decideRequest(request.requestId, true),
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
              <MemberCard
                key={member.userId}
                clubId={clubId}
                member={member}
                isSelf={member.userId === userId}
                canChangeRole={isAdmin}
                canRemove={
                  // Any admin removes a plain Member; removing an Admin is Owner-only; the Owner
                  // is never removable. Mirrors canRemoveMember exactly.
                  member.role !== 'owner' &&
                  member.userId !== userId &&
                  (member.role === 'admin' ? isOwner === true : isAdmin)
                }
                busy={busy === member.userId}
                onAct={act}
              />
            ))}
          </Body>
        );
      }}
    </DataScreen>
  );
}

function MemberCard({
  clubId,
  member,
  isSelf,
  canChangeRole,
  canRemove,
  busy,
  onAct,
}: {
  clubId: string;
  member: RosterEntry;
  isSelf: boolean;
  canChangeRole: boolean;
  canRemove: boolean;
  busy: boolean;
  onAct: (key: string, run: () => Promise<unknown>) => Promise<void>;
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);

  return (
    <Card>
      <View style={styles.person}>
        <Avatar name={member.name} />
        <View style={styles.personText}>
          {/* Tapping the row opens the read-only profile card, from any roster. */}
          <Text style={styles.name}>{member.name}</Text>
          <Text style={styles.meta}>{member.role}</Text>
        </View>
        {isSelf && <Badge label="You" tone="muted" />}
      </View>

      {/* The Owner's role is never writable here: it moves only through transfer. */}
      {canChangeRole && member.role !== 'owner' && !isSelf && (
        <Action
          label={member.role === 'admin' ? 'Demote to member' : 'Promote to admin'}
          variant="secondary"
          disabled={busy}
          onPress={() =>
            void onAct(member.userId, () =>
              clubApi.changeRole(clubId, member.userId, member.role === 'admin' ? 'member' : 'admin'),
            )
          }
          accessibilityLabel={`${member.role === 'admin' ? 'Demote' : 'Promote'} ${member.name}`}
        />
      )}

      {canRemove &&
        (confirmRemove ? (
          <View style={styles.actions}>
            {/* The confirmation names the person and states what is lost. */}
            <Text style={styles.confirm}>
              Remove {member.name}? They lose access to this club, every race in it, and the Eboard
              space.
            </Text>
            <View style={styles.actions}>
              <Action
                label="Keep"
                variant="secondary"
                style={styles.actionButton}
                onPress={() => setConfirmRemove(false)}
              />
              <Action
                label="Remove"
                variant="danger"
                style={styles.actionButton}
                disabled={busy}
                onPress={() =>
                  void onAct(member.userId, () => clubApi.removeMember(clubId, member.userId))
                }
              />
            </View>
          </View>
        ) : (
          <Action
            label="Remove from club"
            variant="secondary"
            onPress={() => setConfirmRemove(true)}
            accessibilityLabel={`Remove ${member.name} from the club`}
          />
        ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  person: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  personText: { flex: 1, gap: space.xs },
  name: { ...type.headline, color: color.textPrimary },
  meta: { ...type.label, color: color.textSecondary, textTransform: 'uppercase' },
  actions: { flexDirection: 'row', gap: space.sm },
  actionButton: { flex: 1 },
  confirm: { ...type.bodySmall, color: color.textPrimary, flex: 1 },
});
