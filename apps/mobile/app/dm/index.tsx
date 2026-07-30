/**
 * Messages: the DM thread list, and the only way to start a new one.
 *
 * **Group chat is the product; DMs are additive.** This screen is deliberately a flat list of
 * people rather than a second home for club activity - nothing club-scoped appears here, and
 * there is no way to reach a club, race or Eboard conversation from it.
 *
 * Discovery is a search over people the viewer already shares a club with. There is no global
 * user search, which is why the empty search box shows nothing rather than everybody.
 */

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
import { useSession } from '../../src/chat-provider.tsx';
import { dmApi, type DmCandidate, type DmThread } from '../../src/api.ts';
import { color, radius, space, type } from '../../src/theme.ts';

type LoadState = 'loading' | 'loaded' | 'error';

export default function MessagesScreen() {
  const { authState, revision, client } = useSession();
  const router = useRouter();

  const [threads, setThreads] = useState<DmThread[]>([]);
  const [state, setState] = useState<LoadState>('loading');
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<DmCandidate[]>([]);
  const [searchState, setSearchState] = useState<LoadState>('loaded');

  const load = useCallback(async () => {
    try {
      const body = await dmApi.threads();
      setThreads(body.threads);
      setState('loaded');
    } catch {
      // Three states on every data screen, and the error one retries. No screen fails to a
      // blank page.
      setState('error');
    }
  }, []);

  useEffect(() => {
    if (authState === 'signed-in') void load();
  }, [authState, load, revision]);

  // Debounced, so typing a name is one request per pause rather than one per keystroke.
  useEffect(() => {
    if (!searching) return;
    let cancelled = false;
    setSearchState('loading');
    const timer = setTimeout(() => {
      void dmApi
        .candidates(query)
        .then((body) => {
          if (cancelled) return;
          setCandidates(body.candidates);
          setSearchState('loaded');
        })
        .catch(() => {
          if (!cancelled) setSearchState('error');
        });
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, searching]);

  // A guarded screen renders a placeholder in its denied branch, because the redirect lands a
  // frame later and an unguarded render would flash real chrome first.
  if (authState === 'checking') {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={color.accent} />
      </View>
    );
  }
  if (authState === 'signed-out') return <Redirect href="/sign-in" />;

  const openThread = async (userId: string) => {
    try {
      const { channelId } = await dmApi.open(userId);
      setSearching(false);
      setQuery('');
      // Subscribe before navigating, so the brand-new channel is live rather than waiting for
      // the next foreground reconcile.
      await client?.reconnect().catch(() => undefined);
      router.push(`/chat/${channelId}`);
    } catch {
      // A refusal here means the person is no longer eligible - they left the last shared club,
      // or blocked us between the search and the tap. Refreshing the list is the honest
      // response: they simply will not be in it any more.
      setSearchState('error');
    }
  };

  if (state === 'error') {
    return (
      <View style={styles.centered}>
        <Text style={styles.emptyTitle}>Could not load your messages</Text>
        <Pressable
          style={styles.button}
          onPress={() => void load()}
          accessibilityRole="button"
          accessibilityLabel="Retry loading messages"
        >
          <Text style={styles.buttonLabel}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  if (searching) {
    return (
      <View style={styles.flex}>
        <View style={styles.searchBar}>
          <TextInput
            style={styles.input}
            placeholder="Search people in your clubs"
            placeholderTextColor={color.textSecondary}
            value={query}
            onChangeText={setQuery}
            autoFocus
            accessibilityLabel="Search people in your clubs"
          />
          <Pressable
            onPress={() => {
              setSearching(false);
              setQuery('');
            }}
            accessibilityRole="button"
            accessibilityLabel="Cancel search"
            hitSlop={space.sm}
          >
            <Text style={styles.cancelLabel}>Cancel</Text>
          </Pressable>
        </View>

        <FlatList
          data={candidates}
          keyExtractor={(candidate) => candidate.userId}
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            searchState === 'loading' ? (
              <ActivityIndicator color={color.accent} style={styles.spinner} />
            ) : (
              <View style={styles.empty}>
                <Text style={styles.emptyTitle}>
                  {query.trim().length === 0 ? 'Who do you want to message?' : 'Nobody found'}
                </Text>
                <Text style={styles.emptyBody}>
                  You can message anyone who is in one of your clubs.
                </Text>
              </View>
            )
          }
          renderItem={({ item }) => (
            <Pressable
              style={styles.row}
              onPress={() => void openThread(item.userId)}
              accessibilityRole="button"
              accessibilityLabel={`Message ${item.name}`}
            >
              <Text style={styles.rowTitle}>{item.name}</Text>
            </Pressable>
          )}
        />
      </View>
    );
  }

  return (
    <View style={styles.flex}>
      <FlatList
        data={threads}
        keyExtractor={(thread) => thread.conversationId}
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
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>No messages yet</Text>
              <Text style={styles.emptyBody}>
                Start a conversation with someone from one of your clubs.
              </Text>
            </View>
          )
        }
        renderItem={({ item }) => (
          <Pressable
            style={styles.row}
            onPress={() => router.push(`/chat/${item.channelId}`)}
            accessibilityRole="button"
            accessibilityLabel={`Open your conversation with ${item.otherName}`}
          >
            <View style={styles.rowMain}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {item.otherName}
              </Text>
              <Text style={styles.rowMeta} numberOfLines={1}>
                {item.lastMessage === null
                  ? 'No messages yet'
                  : // Deletion nulls the body, so a tombstone must not resurrect the text here.
                    (item.lastMessage.body ?? 'Message deleted')}
              </Text>
            </View>
            {/*
              A read-only thread stays in the list and says so. Blocking and losing the last
              shared club both leave history readable; neither deletes the conversation.
            */}
            {!item.canPost && <Text style={styles.badge}>READ ONLY</Text>}
            {item.muted && <Text style={styles.badge}>MUTED</Text>}
            {/* Still counts while muted. Mute silences the buzz, not the count. */}
            {item.unread > 0 && (
              <View style={styles.unread}>
                <Text style={styles.unreadLabel}>{item.unread}</Text>
              </View>
            )}
          </Pressable>
        )}
      />

      <View style={styles.footer}>
        <Pressable
          style={styles.button}
          onPress={() => setSearching(true)}
          accessibilityRole="button"
          accessibilityLabel="Start a new conversation"
        >
          <Text style={styles.buttonLabel}>New message</Text>
        </Pressable>
      </View>
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
  emptyTitle: { ...type.title, color: color.textPrimary, textAlign: 'center' },
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
    gap: space.sm,
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
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    padding: space.md,
    backgroundColor: color.chrome,
    borderBottomWidth: 1,
    borderBottomColor: color.divider,
  },
  input: {
    flex: 1,
    backgroundColor: color.card,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: color.divider,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    ...type.body,
    color: color.textPrimary,
  },
  cancelLabel: { ...type.label, color: color.accent, textTransform: 'uppercase' },
  button: {
    backgroundColor: color.accent,
    borderRadius: radius.sm,
    paddingVertical: space.md,
    alignItems: 'center',
  },
  buttonLabel: { ...type.label, color: color.onAccent, textTransform: 'uppercase' },
});
