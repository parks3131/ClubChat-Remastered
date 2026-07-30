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
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { Redirect, useRouter } from 'expo-router';
import { unreadCount, type Club } from '@clubchat/shared';
import { clubApi } from '../../src/api.ts';
import type { ClubSearchResult } from '../../src/api-types.ts';
import { useSession } from '../../src/chat-provider.tsx';
import { color, space, type } from '../../src/theme.ts';
import { Action, Badge, DataScreen, EmptyState, Field, Row, SectionHeader } from '../../src/ui.tsx';
import { useLoad } from '../../src/use-load.ts';

type Mode = 'list' | 'create' | 'join';

export default function ClubsScreen() {
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
              <EmptyState
                title="No clubs yet"
                body="Create one to get a chat, a calendar and an Eboard space - or join one you have been told about."
              />
            }
            renderItem={({ item }) => {
              const unread = unreadFor(item.mainChannelId);
              return (
                <Row
                  title={item.name}
                  subtitle={item.sport}
                  href={`/clubs/${item.id}`}
                  accessibilityLabel={`Open ${item.name}`}
                  right={
                    <>
                      {/* Role badges are visible, so authority is never guessed. */}
                      <Badge label={item.role} tone="muted" />
                      {unread > 0 && <Badge label={String(unread)} tone="alert" />}
                    </>
                  }
                />
              );
            }}
          />
        )}
      </DataScreen>

      <View style={styles.footer}>
        {/*
          Messages is additive and positioned as such: group chat is the product, so this is a
          secondary control below the club list rather than a fifth tab.
        */}
        <Action
          label="Messages"
          variant="secondary"
          onPress={() => router.push('/dm')}
          accessibilityLabel="Open your direct messages"
          style={styles.footerButton}
        />
        <Action
          label="Join"
          variant="secondary"
          onPress={() => setMode('join')}
          style={styles.footerButton}
        />
        <Action
          label="Create"
          onPress={() => setMode('create')}
          accessibilityLabel="Create a club"
          style={styles.footerButton}
        />
      </View>
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
  flex: { flex: 1, backgroundColor: color.appBackground },
  list: { padding: space.md, gap: space.sm },
  footer: {
    flexDirection: 'row',
    padding: space.md,
    gap: space.sm,
    backgroundColor: color.chrome,
    borderTopWidth: 1,
    borderTopColor: color.divider,
  },
  footerButton: { flex: 1 },
  panel: { flex: 1, padding: space.md, gap: space.sm, backgroundColor: color.appBackground },
  panelActions: { flexDirection: 'row', gap: space.sm, paddingTop: space.sm },
  panelButton: { flex: 1 },
  results: { gap: space.sm },
  hint: { ...type.bodySmall, color: color.textSecondary },
  error: { ...type.bodySmall, color: color.error },
});
