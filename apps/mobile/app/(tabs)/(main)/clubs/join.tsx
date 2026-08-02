/**
 * Join a club - v1's "FIND YOUR SQUAD".
 *
 * **There is no invite-code field here, and there is not one anywhere else either.** v1's version
 * of this screen opened with a "HAVE AN INVITE?" card above the search; ADR-0010 deleted that
 * entire surface, because the link and the code carried the same secret and the code's need to be
 * typeable is what forced the token to be short and case-insensitive. The link is the only side
 * channel now, and the token is 32 bytes matched exactly. That absence is a requirement, not an
 * omission - so this screen is v1's minus one card, deliberately.
 *
 * **The search says "by club name" rather than v1's "by club name or sport".** The server matches
 * `c.name` and nothing else, and a placeholder that promises sport search is a promise the query
 * does not keep.
 *
 * The results are a safe projection - name, sport, member count, and the caller's own request
 * status. A non-member finds a club without being able to read anything inside it, which is why
 * there is no preview of its chat or roster here (`PRD/04`).
 */

import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { clubApi } from '../../../../src/api.ts';
import type { ClubSearchResult } from '../../../../src/api-types.ts';
import { useSession } from '../../../../src/chat-provider.tsx';
import { color, radius, space, type } from '../../../../src/theme.ts';
import { ARRIVED_FORWARD } from '../../../../src/nav.tsx';

export default function JoinClubScreen() {
  const router = useRouter();
  const { client } = useSession();

  const [term, setTerm] = useState('');
  const [results, setResults] = useState<ClubSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const search = useCallback(async (value: string) => {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      setResults(null);
      return;
    }
    setSearching(true);
    try {
      const found = await clubApi.search(trimmed);
      setResults(found.clubs);
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, []);

  /**
   * Join, or file a request, and TELL THE TWO APART.
   *
   * The server answers which one happened, because the club's policy decides it and the client
   * does not get a vote. Navigating into a club on `requested` would be the screen claiming an
   * admin already approved something nobody has looked at yet.
   */
  const join = async (club: ClubSearchResult) => {
    setJoiningId(club.id);
    setFailed(null);
    try {
      const outcome = await clubApi.join(club.id);
      if (outcome.status === 'joined') {
        await client?.reconnect().catch(() => undefined);
        router.replace(`/clubs/${club.id}?${ARRIVED_FORWARD}`);
        return;
      }
      // Requested: stay here, and mark the row so the button cannot be pressed again.
      setResults((current) =>
        (current ?? []).map((entry) =>
          entry.id === club.id ? { ...entry, requestPending: true } : entry,
        ),
      );
    } catch {
      setFailed('Could not join that club. Check your connection and try again.');
    } finally {
      setJoiningId(null);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>FIND YOUR SQUAD</Text>
        <Text style={styles.subtitle}>
          Join an existing team or discover new athletic communities.
        </Text>

        <View style={styles.searchWrap}>
          <MaterialIcons name="search" size={20} color={color.textSecondary} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search by club name..."
            placeholderTextColor={color.textSecondary}
            autoCapitalize="none"
            autoCorrect={false}
            value={term}
            onChangeText={(next) => {
              setTerm(next);
              void search(next);
            }}
            accessibilityLabel="Search for a club by name"
          />
          {searching && <ActivityIndicator color={color.accent} />}
        </View>

        {failed !== null && <Text style={styles.error}>{failed}</Text>}

        {results === null ? (
          <Text style={styles.hint}>
            An open club joins in one tap. A request club files a request for an admin to approve.
          </Text>
        ) : results.length === 0 ? (
          // Tells the truth, and deliberately does not offer to create a club with that name.
          <Text style={styles.hint}>{searching ? 'Searching...' : 'No clubs found.'}</Text>
        ) : (
          results.map((club) => (
            <Pressable
              key={club.id}
              style={styles.result}
              disabled={club.requestPending || joiningId !== null}
              onPress={() => void join(club)}
              accessibilityRole="button"
              accessibilityLabel={
                club.requestPending
                  ? `${club.name}, already requested`
                  : `${club.joinPolicy === 'open' ? 'Join' : 'Request to join'} ${club.name}`
              }
            >
              <View style={styles.resultText}>
                <Text style={styles.resultName}>{club.name}</Text>
                <Text style={styles.resultMeta}>
                  {club.sport}
                  {'  ·  '}
                  {club.memberCount} member{club.memberCount === 1 ? '' : 's'}
                </Text>
              </View>
              {joiningId === club.id ? (
                <ActivityIndicator color={color.accent} />
              ) : club.requestPending ? (
                <Text style={styles.requested}>Requested</Text>
              ) : (
                <View style={styles.joinPill}>
                  <Text style={styles.joinPillLabel}>
                    {club.joinPolicy === 'open' ? 'Join' : 'Request'}
                  </Text>
                </View>
              )}
            </Pressable>
          ))
        )}

        <Text style={styles.footnote}>
          Have an invite link? Opening it joins you directly, even on a request club.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: color.appBackground },
  content: { padding: space.md, gap: space.sm, paddingBottom: space.xl },

  // Centred, unlike Create's left-aligned heading: v1 centres this one, and the difference reads
  // as "this is a search" rather than "this is a form".
  title: {
    ...type.display,
    fontSize: 28,
    lineHeight: 34,
    color: color.textPrimary,
    textAlign: 'center',
  },
  subtitle: {
    ...type.bodySmall,
    color: color.textSecondary,
    textAlign: 'center',
    marginTop: -space.xs,
  },

  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    borderWidth: 1,
    borderColor: color.accentSoftBorder,
    backgroundColor: color.card,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
    marginTop: space.md,
  },
  searchInput: { ...type.body, flex: 1, color: color.textPrimary, padding: 0 },

  hint: { ...type.bodySmall, color: color.textSecondary, textAlign: 'center', marginTop: space.md },
  error: { ...type.bodySmall, color: color.error, textAlign: 'center' },

  result: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: color.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.hairline,
    padding: space.md,
  },
  resultText: { flex: 1, gap: 2 },
  resultName: { ...type.headline, color: color.textPrimary },
  resultMeta: { ...type.bodySmall, color: color.textSecondary },
  requested: { ...type.label, color: color.textSecondary, textTransform: 'none' },
  joinPill: {
    backgroundColor: color.accent,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: space.xs + 2,
  },
  joinPillLabel: { ...type.label, color: color.onAccent },

  footnote: {
    ...type.bodySmall,
    color: color.textSecondary,
    textAlign: 'center',
    marginTop: space.md,
  },
});
