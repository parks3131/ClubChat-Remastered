/**
 * The Clubs destination.
 *
 * The list, plus the two ways in that `PRD/04` names: create, and join. Joining is by **search or
 * link only** - there is no screen anywhere that asks for a typed invite code (ADR-0010), and that
 * absence is a requirement rather than an omission.
 *
 * A row opens the club **hub**, not its chat. That is a change from the previous version, which
 * jumped straight into the main channel: the hub is where News, races, the Eboard space and the
 * calendar are reached from, and `PRD/15` puts News and Highlights as its first row.
 */

import { useCallback, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { RemoteImage } from '../../../../src/media-bubble.tsx';
import { Redirect, useRouter } from 'expo-router';
import { useClearClub } from '../../../../src/current-space.tsx';
import { unreadCount, type Club } from '@clubchat/shared';
import { clubApi } from '../../../../src/api.ts';
import type { ClubSearchResult } from '../../../../src/api-types.ts';
import { useSession } from '../../../../src/chat-provider.tsx';
import { color, radius, space, type } from '../../../../src/theme.ts';
import { Action, Badge, DataScreen, EmptyState, Field, Row, SectionHeader } from '../../../../src/ui.tsx';
import { useLoad } from '../../../../src/use-load.ts';

type Mode = 'list' | 'create' | 'join';

export default function ClubsScreen() {
  // Outside every club: leaving one is declared here rather than inferred from a blur.
  useClearClub();
  const { authState, channels, client, revision } = useSession();
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('list');

  const load = useLoad(() => clubApi.mine(), [revision]);

  // A guarded screen renders a placeholder in its denied branch, because the redirect lands a
  // frame later and an unguarded render would flash real chrome first.
  if (authState === 'checking') return <View style={styles.flex} />;
  if (authState === 'signed-out') return <Redirect href="/sign-in" />;

  const unreadFor = (channelId: string): number => {
    const channel = channels.find((entry) => entry.id === channelId);
    // Computed from the log, never stored. A stored count drifts; this one cannot.
    return channel ? unreadCount(channel) : 0;
  };

  if (mode === 'create') {
    return (
      <CreateClub
        onCancel={() => setMode('list')}
        onCreated={async () => {
          setMode('list');
          // Resubscribe so the brand-new club's channel is live immediately.
          await client?.reconnect().catch(() => undefined);
          load.reload();
        }}
      />
    );
  }

  if (mode === 'join') {
    return (
      <JoinClub
        onDone={async () => {
          setMode('list');
          await client?.reconnect().catch(() => undefined);
          load.reload();
        }}
        onCancel={() => setMode('list')}
      />
    );
  }

  return (
    <View style={styles.flex}>
      {/* v1's page header: the title, and one line saying what this screen is for. */}
      <View style={styles.heading}>
        <Text style={styles.title}>My Clubs</Text>
        <Text style={styles.subtitle}>Manage your teams and athletic communities</Text>
      </View>

      {/*
        The two ways in, side by side and equally weighted. Create is filled and Join is outlined,
        which is the only hierarchy between them - both are first-class, and a member with no clubs
        needs whichever one matches how they heard about the club.
      */}
      <View style={styles.actions}>
        <Pressable
          style={styles.primaryButton}
          onPress={() => setMode('create')}
          accessibilityRole="button"
          accessibilityLabel="Create a club"
        >
          <MaterialIcons name="add-circle" size={18} color={color.onAccent} />
          <Text style={styles.primaryButtonText}>Create a Club</Text>
        </Pressable>
        <Pressable
          style={styles.secondaryButton}
          onPress={() => setMode('join')}
          accessibilityRole="button"
          accessibilityLabel="Join a club"
        >
          <MaterialIcons name="explore" size={18} color={color.accent} />
          <Text style={styles.secondaryButtonText}>Join a Club</Text>
        </Pressable>
      </View>

      <DataScreen load={load}>
        {(data) => (
          <FlatList<Club>
            data={data.clubs}
            keyExtractor={(club) => club.id}
            contentContainerStyle={styles.list}
            refreshControl={
              <RefreshControl
                refreshing={load.state === 'loading'}
                onRefresh={load.reload}
                tintColor={color.accent}
              />
            }
            ListEmptyComponent={
              <View style={styles.empty}>
                <MaterialIcons name="groups" size={48} color={color.border} />
                <Text style={styles.emptyTitle}>No clubs yet?</Text>
                <Text style={styles.emptyBody}>
                  Every champion needs a team. Join an existing club or lead your own squad to
                  victory.
                </Text>
                <Pressable
                  style={styles.primaryButton}
                  onPress={() => setMode('create')}
                  accessibilityRole="button"
                  accessibilityLabel="Create your first club"
                >
                  <Text style={styles.primaryButtonText}>Create your first club</Text>
                </Pressable>
              </View>
            }
            renderItem={({ item }) => {
              const unread = unreadFor(item.mainChannelId);
              const isAdminTier = item.role === 'owner' || item.role === 'admin';
              return (
                <Pressable
                  style={styles.clubRow}
                  onPress={() => router.push(`/clubs/${item.id}`)}
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${item.name}, ${item.role}`}
                >
                  <View style={styles.clubRowLeft}>
                    {item.image === null ? (
                      <View style={styles.clubAvatar}>
                        <Text style={styles.clubAvatarInitial}>
                          {item.name.charAt(0).toUpperCase()}
                        </Text>
                      </View>
                    ) : (
                      <RemoteImage
                        mediaId={item.image}
                        variant="thumb"
                        style={styles.clubAvatar}
                        resizeMode="cover"
                      />
                    )}
                    <View style={styles.clubRowText}>
                      <Text style={styles.clubName} numberOfLines={1}>
                        {item.name}
                      </Text>
                      <Text style={styles.clubSport}>{item.sport}</Text>
                    </View>
                  </View>
                  <View style={styles.clubRowRight}>
                    {/* Only when there IS unread. A zero badge is noise. */}
                    {unread > 0 && (
                      <Text style={styles.unreadBadge}>{unread > 99 ? '99+' : unread}</Text>
                    )}
                    {/* Role badges are visible, so authority is never guessed. */}
                    <Text
                      style={[
                        styles.roleBadge,
                        isAdminTier ? styles.roleBadgeAdmin : styles.roleBadgeMember,
                      ]}
                    >
                      {item.role === 'owner' ? 'Owner' : item.role === 'admin' ? 'Admin' : 'Member'}
                    </Text>
                    <MaterialIcons name="chevron-right" size={22} color={color.textSecondary} />
                  </View>
                </Pressable>
              );
            }}
          />
        )}
      </DataScreen>
    </View>
  );
}

function CreateClub({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: () => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [sport, setSport] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const submit = async () => {
    if (name.trim().length === 0 || sport.trim().length === 0) return;
    setBusy(true);
    setFailed(null);
    try {
      await clubApi.create({ name: name.trim(), sport: sport.trim() });
      await onCreated();
    } catch {
      setFailed('Could not create the club. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.panel}>
      <SectionHeader title="Create a club" />
      <Field label="Club name" value={name} onChangeText={setName} placeholder="Riverside Runners" />
      <Field label="Sport" value={sport} onChangeText={setSport} placeholder="running" />
      {failed !== null && <Text style={styles.error}>{failed}</Text>}
      <View style={styles.panelActions}>
        <Action
          label="Cancel"
          variant="secondary"
          onPress={onCancel}
          style={styles.panelButton}
        />
        <Action
          label={busy ? 'Creating' : 'Create'}
          onPress={() => void submit()}
          disabled={busy || name.trim().length === 0 || sport.trim().length === 0}
          style={styles.panelButton}
        />
      </View>
      <Text style={styles.hint}>
        You become the Owner, with a main chat and an Eboard space created for you.
      </Text>
    </View>
  );
}

/**
 * Join by search.
 *
 * The safe projection is all this screen gets: name, sport, member count and the caller's own
 * request status. A non-member can find and join a club without being able to read anything
 * inside it, which is why there is no preview of its chat or roster here.
 */
function JoinClub({ onDone, onCancel }: { onDone: () => Promise<void>; onCancel: () => void }) {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<ClubSearchResult[] | null>(null);
  const [busy, setBusy] = useState(false);

  const search = useCallback(async (value: string) => {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      setResults(null);
      return;
    }
    setBusy(true);
    try {
      const found = await clubApi.search(trimmed);
      setResults(found.clubs);
    } catch {
      setResults([]);
    } finally {
      setBusy(false);
    }
  }, []);

  const join = async (club: ClubSearchResult) => {
    try {
      await clubApi.join(club.id);
      await onDone();
    } catch {
      // Re-search rather than guessing: the club may have switched policy or been deleted.
      void search(term);
    }
  };

  return (
    <View style={styles.panel}>
      <SectionHeader title="Join a club" />
      <Field
        label="Search by name"
        value={term}
        onChangeText={(next) => {
          setTerm(next);
          void search(next);
        }}
        placeholder="Riverside"
      />

      {results === null ? (
        <Text style={styles.hint}>
          Search for a club by name. An open club joins in one tap; a request club files a request
          for an admin to approve.
        </Text>
      ) : results.length === 0 ? (
        // Tells the truth, and deliberately does not offer to create a club with that name.
        <Text style={styles.hint}>{busy ? 'Searching...' : 'No clubs found'}</Text>
      ) : (
        <View style={styles.results}>
          {results.map((club) => (
            <Row
              key={club.id}
              title={club.name}
              subtitle={`${club.sport}  ·  ${club.memberCount} member${club.memberCount === 1 ? '' : 's'}`}
              onPress={() => {
                if (!club.requestPending) void join(club);
              }}
              accessibilityLabel={
                club.requestPending ? `${club.name}, already requested` : `Join ${club.name}`
              }
              right={
                club.requestPending ? (
                  <Badge label="Requested" tone="muted" />
                ) : (
                  <Badge label={club.joinPolicy === 'open' ? 'Join' : 'Request'} tone="accent" />
                )
              }
            />
          ))}
        </View>
      )}

      <View style={styles.panelActions}>
        <Action label="Done" variant="secondary" onPress={onCancel} style={styles.panelButton} />
      </View>
      <Text style={styles.hint}>
        Have an invite link? Opening it joins you directly, even on a request club.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: color.appBackground, padding: space.md },

  heading: { marginBottom: space.md },
  title: { ...type.title, color: color.textPrimary },
  subtitle: {
    ...type.label,
    color: color.textSecondary,
    marginTop: space.xs,
    textTransform: 'none',
  },

  actions: { flexDirection: 'row', gap: space.sm, marginBottom: space.md },
  primaryButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    backgroundColor: color.accent,
    borderRadius: radius.pill,
    paddingVertical: space.sm + 4,
  },
  primaryButtonText: { ...type.label, color: color.onAccent, textTransform: 'uppercase' },
  secondaryButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    // A 2px edge, not a hairline: this is a peer of the filled button, not a quiet control.
    borderWidth: 2,
    borderColor: color.accent,
    borderRadius: radius.pill,
    paddingVertical: space.sm + 4,
  },
  secondaryButtonText: { ...type.label, color: color.accent, textTransform: 'uppercase' },

  list: { gap: space.sm, paddingBottom: space.lg },
  clubRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: color.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.hairline,
    padding: space.md,
  },
  clubRowLeft: { flexDirection: 'row', alignItems: 'center', gap: space.md, flex: 1 },
  clubRowText: { flex: 1 },
  // Larger than the avatar anywhere else in the app: a club is the biggest thing in the product,
  // and this list is the first screen anybody sees.
  clubAvatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: color.cardSunken,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clubAvatarInitial: { ...type.title, fontSize: 20, lineHeight: 26, color: color.accent },
  clubName: { ...type.headline, fontSize: 17, color: color.textPrimary },
  clubSport: { ...type.label, color: color.onSecondaryContainer, marginTop: 2, textTransform: 'none' },
  clubRowRight: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  roleBadge: {
    ...type.label,
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 4,
    textTransform: 'none',
    overflow: 'hidden',
  },
  roleBadgeAdmin: { backgroundColor: color.accentSoft, color: color.onAccentSoft },
  roleBadgeMember: { backgroundColor: color.fallback, color: color.textSecondary },
  unreadBadge: {
    ...type.label,
    fontSize: 10,
    minWidth: 20,
    textAlign: 'center',
    borderRadius: radius.pill,
    paddingHorizontal: space.xs,
    paddingVertical: 2,
    backgroundColor: color.error,
    color: color.onAccent,
    overflow: 'hidden',
  },

  empty: { alignItems: 'center', marginTop: 60, gap: space.sm, paddingHorizontal: space.md },
  emptyTitle: { ...type.title, fontSize: 20, lineHeight: 26, color: color.textPrimary },
  emptyBody: {
    ...type.body,
    color: color.textSecondary,
    textAlign: 'center',
    maxWidth: 280,
  },

  panel: { flex: 1, gap: space.sm, backgroundColor: color.appBackground },
  panelActions: { flexDirection: 'row', gap: space.sm, paddingTop: space.sm },
  panelButton: { flex: 1 },
  results: { gap: space.sm },
  hint: { ...type.bodySmall, color: color.textSecondary },
  error: { ...type.bodySmall, color: color.error },
});
