import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Redirect, useRouter } from 'expo-router';
import { unreadCount, type Club } from '@clubchat/shared';
import { useSession } from '../../src/chat-provider.tsx';
import { config } from '../../src/config.ts';
import { sessionStore } from '../../src/session.ts';
import { color, radius, space, type } from '../../src/theme.ts';

type LoadState = 'loading' | 'loaded' | 'error';

export default function ClubsScreen() {
  const { authState, channels, client, signOut, revision } = useSession();
  const router = useRouter();
  const [clubs, setClubs] = useState<Club[]>([]);
  const [state, setState] = useState<LoadState>('loading');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [sport, setSport] = useState('');

  const load = useCallback(async () => {
    try {
      const token = await sessionStore.load();
      const response = await fetch(`${config.apiUrl}/clubs`, {
        headers: { authorization: `Bearer ${token ?? ''}` },
      });
      if (!response.ok) throw new Error(String(response.status));
      const body = (await response.json()) as { clubs: Club[] };
      setClubs(body.clubs);
      setState('loaded');
    } catch {
      // Every data-loading screen has three states, and the error one is retryable.
      // No screen may fail to a blank page.
      setState('error');
    }
  }, []);

  useEffect(() => {
    if (authState === 'signed-in') void load();
  }, [authState, load, revision]);

  // A guarded screen renders a placeholder in its denied branch, because the redirect
  // lands a frame later and an unguarded render would flash real chrome first.
  if (authState === 'checking') {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={color.accent} />
      </View>
    );
  }
  if (authState === 'signed-out') return <Redirect href="/sign-in" />;

  const create = async () => {
    if (name.trim().length === 0 || sport.trim().length === 0) return;
    const token = await sessionStore.load();
    const response = await fetch(`${config.apiUrl}/clubs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token ?? ''}`,
      },
      body: JSON.stringify({ name: name.trim(), sport: sport.trim() }),
    });
    if (response.ok) {
      setName('');
      setSport('');
      setCreating(false);
      // Resubscribe so the brand-new club's channel is live immediately.
      await client?.reconnect().catch(() => undefined);
      await load();
    }
  };

  const unreadFor = (channelId: string): number => {
    const channel = channels.find((entry) => entry.id === channelId);
    // Computed from the log, never stored. A stored count drifts; this one cannot.
    return channel ? unreadCount(channel) : 0;
  };

  if (state === 'error') {
    return (
      <View style={styles.centered}>
        <Text style={styles.emptyTitle}>Could not load your clubs</Text>
        <Pressable
          style={styles.button}
          onPress={() => void load()}
          accessibilityRole="button"
          accessibilityLabel="Retry loading clubs"
        >
          <Text style={styles.buttonLabel}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.flex}>
      <FlatList
        data={clubs}
        keyExtractor={(club) => club.id}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={state === 'loading'}
            onRefresh={() => void load()}
            tintColor={color.accent}
          />
        }
        ListEmptyComponent={
          state === 'loading' ? (
            <ActivityIndicator color={color.accent} style={styles.spinner} />
          ) : (
            // An empty state that tells the truth, never a bare blank.
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>No clubs yet</Text>
              <Text style={styles.emptyBody}>
                Create one to get a chat, a calendar and an Eboard space.
              </Text>
            </View>
          )
        }
        renderItem={({ item }) => {
          const unread = unreadFor(item.mainChannelId);
          return (
            <Pressable
              style={styles.row}
              onPress={() => router.push(`/chat/${item.mainChannelId}`)}
              accessibilityRole="button"
              accessibilityLabel={`Open ${item.name} chat`}
            >
              <View style={styles.rowMain}>
                <Text style={styles.rowTitle}>{item.name}</Text>
                <Text style={styles.rowMeta}>
                  {item.sport}
                  {'  ·  '}
                  {/* Role badges are visible, so authority is never guessed. */}
                  <Text style={styles.badge}>{item.role.toUpperCase()}</Text>
                </Text>
              </View>
              {unread > 0 && (
                <View style={styles.unread}>
                  <Text style={styles.unreadLabel}>{unread}</Text>
                </View>
              )}
            </Pressable>
          );
        }}
      />

      {creating ? (
        <View style={styles.createPanel}>
          <TextInput
            style={styles.input}
            placeholder="Club name"
            placeholderTextColor={color.textSecondary}
            value={name}
            onChangeText={setName}
            accessibilityLabel="Club name"
          />
          <TextInput
            style={styles.input}
            placeholder="Sport"
            placeholderTextColor={color.textSecondary}
            value={sport}
            onChangeText={setSport}
            accessibilityLabel="Sport"
          />
          <View style={styles.createActions}>
            <Pressable
              style={styles.secondaryButton}
              onPress={() => setCreating(false)}
              accessibilityRole="button"
              accessibilityLabel="Cancel creating a club"
            >
              <Text style={styles.secondaryLabel}>Cancel</Text>
            </Pressable>
            <Pressable
              style={styles.button}
              onPress={() => void create()}
              accessibilityRole="button"
              accessibilityLabel="Create club"
            >
              <Text style={styles.buttonLabel}>Create</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <View style={styles.footer}>
          {/*
            Additive, and positioned as such. Group chat is the product, so Messages is a
            secondary control below the club list rather than a peer of it.
          */}
          <Pressable
            style={styles.secondaryButton}
            onPress={() => router.push('/dm')}
            accessibilityRole="button"
            accessibilityLabel="Open your direct messages"
          >
            <Text style={styles.secondaryLabel}>Messages</Text>
          </Pressable>
          <Pressable
            style={styles.button}
            onPress={() => setCreating(true)}
            accessibilityRole="button"
            accessibilityLabel="Create a club"
          >
            <Text style={styles.buttonLabel}>Create a club</Text>
          </Pressable>
          <Pressable
            onPress={() => void signOut()}
            accessibilityRole="button"
            accessibilityLabel="Sign out"
          >
            <Text style={styles.signOut}>Sign out</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: color.appBackground },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.md,
    backgroundColor: color.appBackground,
  },
  list: { padding: space.md, gap: space.sm },
  spinner: { marginTop: space.xl },
  empty: { alignItems: 'center', paddingTop: space.xl, gap: space.sm },
  emptyTitle: { ...type.title, color: color.textPrimary },
  emptyBody: {
    ...type.bodySmall,
    color: color.textSecondary,
    textAlign: 'center',
    paddingHorizontal: space.lg,
  },
  row: {
    backgroundColor: color.card,
    borderRadius: radius.sm,
    padding: space.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  rowMain: { flex: 1, gap: space.xs },
  rowTitle: { ...type.headline, color: color.textPrimary },
  rowMeta: { ...type.bodySmall, color: color.textSecondary },
  badge: { ...type.label, color: color.secondary },
  unread: {
    minWidth: 24,
    height: 24,
    borderRadius: radius.pill,
    backgroundColor: color.error,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.xs,
  },
  unreadLabel: { ...type.label, color: color.onAccent },
  footer: {
    padding: space.md,
    gap: space.sm,
    backgroundColor: color.chrome,
    borderTopWidth: 1,
    borderTopColor: color.divider,
  },
  createPanel: {
    padding: space.md,
    gap: space.sm,
    backgroundColor: color.chrome,
    borderTopWidth: 1,
    borderTopColor: color.divider,
  },
  createActions: { flexDirection: 'row', gap: space.sm },
  input: {
    backgroundColor: color.card,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: color.divider,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    ...type.body,
    color: color.textPrimary,
  },
  button: {
    flex: 1,
    backgroundColor: color.accent,
    borderRadius: radius.sm,
    paddingVertical: space.md,
    alignItems: 'center',
  },
  buttonLabel: { ...type.label, color: color.onAccent, textTransform: 'uppercase' },
  secondaryButton: {
    flex: 1,
    backgroundColor: color.card,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: color.divider,
    paddingVertical: space.md,
    alignItems: 'center',
  },
  secondaryLabel: { ...type.label, color: color.textSecondary, textTransform: 'uppercase' },
  signOut: { ...type.bodySmall, color: color.textSecondary, textAlign: 'center', padding: space.sm },
});
