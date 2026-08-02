/**
 * Find somebody to message - the chat list's person+ action.
 *
 * **A result opens that person's profile, not the conversation.** That is deliberate and it is
 * the founder's flow: you look somebody up, you see who they are, and messaging them is an action
 * on their profile rather than the only thing tapping their name can do. It also means the
 * profile is the single place "message this person" lives, so reaching it from a roster or from
 * chat offers the same action rather than a different one.
 *
 * **There is no global user search, and the empty box shows nobody.** The pool is people the
 * viewer already shares a club with - `searchDmCandidates` enforces that server-side, and this
 * screen could not widen it if it tried. A stranger is reached with an invite link, which
 * ADR-0010 makes the only front door into a club.
 */

import { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { Redirect, useRouter } from 'expo-router';
import { dmApi, type DmCandidate } from '../../../../src/api.ts';
import { useSession } from '../../../../src/chat-provider.tsx';
import { color, radius, space, type } from '../../../../src/theme.ts';
import { Avatar, EmptyState, SearchField } from '../../../../src/ui.tsx';

type LoadState = 'idle' | 'loading' | 'loaded' | 'error';

export default function NewMessageScreen() {
  const { authState } = useSession();
  const router = useRouter();

  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<DmCandidate[]>([]);
  const [state, setState] = useState<LoadState>('idle');

  /*
   * Debounced, so typing a name is one request per pause rather than one per keystroke.
   *
   * The empty query is still sent: the server answers it with the people you share a club with,
   * which is a useful starting list rather than nothing, and it is bounded by club membership
   * rather than by the user table.
   */
  useEffect(() => {
    if (authState !== 'signed-in') return;
    let cancelled = false;
    setState('loading');
    const timer = setTimeout(() => {
      void dmApi
        .candidates(query)
        .then((body) => {
          if (cancelled) return;
          setCandidates(body.candidates);
          setState('loaded');
        })
        .catch(() => {
          if (!cancelled) setState('error');
        });
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, authState]);

  if (authState === 'checking') return <View style={styles.flex} />;
  if (authState === 'signed-out') return <Redirect href="/sign-in" />;

  return (
    <View style={styles.flex}>
      <View style={styles.searchWrap}>
        <SearchField
          value={query}
          onChangeText={setQuery}
          placeholder="Search people in your clubs"
        />
      </View>

      <FlatList
        data={candidates}
        keyExtractor={(candidate) => candidate.userId}
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          state === 'loading' ? (
            <ActivityIndicator color={color.accent} style={styles.spinner} />
          ) : state === 'error' ? (
            <EmptyState
              title="Could not search just now"
              body="Check your connection and try again."
            />
          ) : (
            <EmptyState
              title={query.trim().length === 0 ? 'Nobody to show yet' : 'Nobody found'}
              body="You can message anyone who is in one of your clubs."
            />
          )
        }
        renderItem={({ item }) => (
          <Pressable
            style={styles.row}
            // The profile, not the thread. Messaging is an action there.
            onPress={() => router.push(`/users/${item.userId}`)}
            accessibilityRole="button"
            accessibilityLabel={`Open ${item.name}'s profile`}
          >
            <Avatar name={item.name} image={item.image} size={44} />
            <Text style={styles.name} numberOfLines={1}>
              {item.name}
            </Text>
            <MaterialIcons name="chevron-right" size={22} color={color.textSecondary} />
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: color.appBackground },
  searchWrap: { padding: space.md, paddingBottom: space.sm },
  list: { paddingHorizontal: space.md, paddingBottom: space.lg, gap: space.xs },
  spinner: { marginTop: space.xl },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: color.card,
    borderRadius: radius.lg,
    padding: space.md,
  },
  name: { ...type.headline, fontSize: 17, color: color.textPrimary, flex: 1 },
});
