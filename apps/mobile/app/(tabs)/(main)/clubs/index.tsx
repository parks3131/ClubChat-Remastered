/**
 * The Chats destination: every conversation in one list.
 *
 * **This replaced the My Clubs list on 2026-08-02.** The landing screen used to be a roster of
 * clubs, which meant the two things a member actually opens the app for - a club's chat and a
 * direct message - lived on different screens, one of them two taps down and the other behind a
 * button at the bottom of a list. Now they are one list ordered by what happened most recently,
 * which is the shape every chat app has converged on for the same reason.
 *
 * Three rules this screen exists to hold:
 *
 *  1. **No filter is the resting state.** The chips narrow the list; none of them is selected on
 *     arrival. Landing on Unread would mean opening the app to an empty screen on every day you
 *     are caught up, which is most days, and an empty list reads as a broken app rather than as
 *     good news.
 *  2. **Club main chats and DMs only.** A race and an Eboard space each have a real channel, and
 *     both are deliberately absent - see `CONVERSATION_SCOPES` on the server. Their unread still
 *     reaches the member through the Notifications inbox and the badge.
 *  3. **A club row opens that club's hub; a DM row opens the conversation.** The two differ
 *     because the destinations differ: a DM *is* a conversation and has nowhere else to go, while
 *     a club is a place with a chat in it - plus News, races, the Eboard space and the calendar -
 *     and landing straight in its chat puts the rest of the club a back-press behind you.
 *
 *     The cost is that a club row previews a message and then opens something that is not that
 *     conversation, which is a real inconsistency and was the argument for opening chat. What
 *     makes it tolerable is that the hub's own chat row carries the same unread count, so the
 *     count on this row leads somewhere that repeats it rather than swallowing it.
 *
 * The search field filters by NAME and deliberately not by message content. Message search is on
 * `PRD/17`'s "deliberately deferred" list and stayed there in this change; searching a list you
 * already hold is a different and much smaller thing than indexing every message in the product.
 */

import { useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { Redirect, useRouter } from 'expo-router';
import {
  conversationSummaryText,
  type ConversationSummary,
} from '@clubchat/shared';
import { channelApi } from '../../../../src/api.ts';
import { useSession } from '../../../../src/chat-provider.tsx';
import { useClearClub } from '../../../../src/current-space.tsx';
import { formatConversationTimestamp } from '../../../../src/dates.ts';
import { color, radius, space, type } from '../../../../src/theme.ts';
import { Avatar, DataScreen, EmptyState, SearchField, Tabs } from '../../../../src/ui.tsx';
import { useLoad } from '../../../../src/use-load.ts';

/** The three chips, in the order the design shows them. */
const FILTERS = [
  { key: 'unread', label: 'Unread' },
  { key: 'dms', label: 'DMs' },
  { key: 'clubs', label: 'Clubs' },
] as const;

type Filter = (typeof FILTERS)[number]['key'];

/**
 * Whether a row survives the active filter and the search text.
 *
 * A pure function over one row so it can be reasoned about without a screen around it, which is
 * the rule pitfall 34 exists to enforce - both of chat's marker bugs shipped from list arithmetic
 * buried in a memo inside a 3,400 line component.
 */
export function matchesFilter(
  row: ConversationSummary,
  filter: Filter | null,
  query: string,
): boolean {
  const trimmed = query.trim().toLowerCase();
  if (trimmed.length > 0 && !row.name.toLowerCase().includes(trimmed)) return false;

  switch (filter) {
    case 'unread':
      return row.unread > 0;
    case 'dms':
      return row.scope === 'dm';
    case 'clubs':
      // Every non-DM scope, so this stays correct if races are ever added to the list rather
      // than silently excluding them from the only chip they could belong to.
      return row.scope !== 'dm';
    default:
      return true;
  }
}

/**
 * Where a row goes.
 *
 * A club opens its **hub**, not its chat: a club is a place with a chat in it, and the hub is
 * where News, the races list, the Eboard space and the calendar are reached from. A DM opens the
 * conversation, because a DM *is* the conversation.
 *
 * Falling back to the channel covers a club row that somehow arrived without its `clubId` -
 * impossible for the `club` scope, whose `club_id` is `NOT NULL` by a check constraint, but a
 * navigation that silently does nothing is a worse answer than one that opens the chat.
 */
function destinationOf(row: ConversationSummary): string {
  if (row.scope === 'dm' || row.clubId === null) return `/chat/${row.channelId}`;
  return `/clubs/${row.clubId}`;
}

/**
 * The line under the name: who said it, and what.
 *
 * The sender is prefixed even in a DM, which is what the design shows and is right for a reason
 * beyond matching it - a thread where both people speak reads as a conversation rather than as a
 * feed of the other person. A card, a photo or a tombstone has no useful prefix, so it gets none.
 */
function previewLine(row: ConversationSummary, viewerId: string | null): string {
  const last = row.lastMessage;
  const text = conversationSummaryText(last);
  if (last === null || last.deleted) return text;
  // A system message narrates itself - "X was added by Y" - so a name in front of it would be
  // the system actor's, which is not a person and never renders anywhere else in the product.
  if (last.type === 'system') return text;

  const who = last.senderId === viewerId ? 'You' : (last.senderName ?? 'Deleted member');
  return `${who}: ${text}`;
}

export default function ChatsScreen() {
  /*
   * The one screen outside every club, and therefore the only one that clears it.
   *
   * > **Leaving a club is an act, not a side effect of glancing at another tab.** Calendar,
   * > Notifications and Profile each used to clear it too, which broke the Clubs tab's whole
   * > purpose: stepping across to the Calendar and tapping it dropped you on this list instead of
   * > surfacing at the club's front door.
   */
  useClearClub();
  const { authState, revision, userId } = useSession();
  const router = useRouter();

  const [filter, setFilter] = useState<Filter | null>(null);
  const [query, setQuery] = useState('');

  const load = useLoad(() => channelApi.conversations(), [revision]);

  // A guarded screen renders a placeholder in its denied branch, because the redirect lands a
  // frame later and an unguarded render would flash real chrome first.
  if (authState === 'checking') return <View style={styles.flex} />;
  if (authState === 'signed-out') return <Redirect href="/sign-in" />;

  return (
    <View style={styles.flex}>
      <View style={styles.header}>
        <Text style={styles.title}>Chats</Text>
        <View style={styles.headerActions}>
          {/*
            Two actions, and which is which matters. The person+ starts a CONVERSATION with
            somebody; the plain + joins or creates a CLUB. Both are additive, so neither is
            styled as the primary.
          */}
          <Pressable
            style={styles.headerButton}
            onPress={() => router.push('/dm/new')}
            accessibilityRole="button"
            accessibilityLabel="Message someone"
            hitSlop={space.xs}
          >
            <MaterialIcons name="person-add-alt" size={22} color={color.accent} />
          </Pressable>
          <Pressable
            style={styles.headerButton}
            onPress={() => router.push('/clubs/add')}
            accessibilityRole="button"
            accessibilityLabel="Join or create a club"
            hitSlop={space.xs}
          >
            <MaterialIcons name="add" size={24} color={color.accent} />
          </Pressable>
        </View>
      </View>

      <View style={styles.controls}>
        <SearchField value={query} onChangeText={setQuery} placeholder="Search chats" />
        <Tabs
          tabs={FILTERS}
          active={filter}
          variant="pill"
          // Tapping the active chip clears it, so getting back to "everything" needs no fourth
          // chip and no second gesture to learn.
          onChange={(key) => setFilter((current) => (current === key ? null : key))}
        />
      </View>

      <DataScreen load={load}>
        {(data) => {
          const rows = data.conversations.filter((row) => matchesFilter(row, filter, query));
          return (
            <FlatList<ConversationSummary>
              data={rows}
              keyExtractor={(row) => row.channelId}
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
                  title={emptyTitle(filter, query, data.conversations.length)}
                  body={emptyBody(filter, query, data.conversations.length)}
                />
              }
              renderItem={({ item }) => (
                <ConversationRow
                  row={item}
                  viewerId={userId}
                  onPress={() => router.push(destinationOf(item))}
                />
              )}
            />
          );
        }}
      </DataScreen>
    </View>
  );
}

/**
 * The empty state, which says which of three different things happened.
 *
 * "No chats yet" under an active Unread filter would be a lie - there are chats, you have read
 * them all. `PRD/16` rule 2 asks an empty list to tell the truth rather than be blank, and the
 * truth here is not one sentence.
 */
function emptyTitle(filter: Filter | null, query: string, total: number): string {
  if (query.trim().length > 0) return 'No chats match that';
  if (total === 0) return 'No chats yet';
  if (filter === 'unread') return "You're all caught up";
  if (filter === 'dms') return 'No direct messages yet';
  return 'No club chats yet';
}

function emptyBody(filter: Filter | null, query: string, total: number): string | undefined {
  if (query.trim().length > 0) return undefined;
  if (total === 0) return 'Join or create a club to get started, or message someone you know.';
  if (filter === 'unread') return 'Everything here has been read.';
  if (filter === 'dms') return 'Tap the person icon above to message someone from your clubs.';
  return undefined;
}

function ConversationRow({
  row,
  viewerId,
  onPress,
}: {
  row: ConversationSummary;
  viewerId: string | null;
  onPress: () => void;
}) {
  const unread = row.unread > 0;
  const timestamp = useMemo(
    () =>
      row.lastMessage === null ? '' : formatConversationTimestamp(row.lastMessage.createdAt),
    [row.lastMessage],
  );

  return (
    <Pressable
      style={[styles.row, unread && styles.rowUnread]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={
        unread
          ? `${row.name}, ${row.unread} unread ${row.unread === 1 ? 'message' : 'messages'}`
          : row.name
      }
    >
      <Avatar name={row.name} image={row.image} size={52} />

      <View style={styles.rowText}>
        <View style={styles.rowTopLine}>
          <Text style={[styles.name, unread && styles.nameUnread]} numberOfLines={1}>
            {row.name}
          </Text>
          <Text style={[styles.timestamp, unread && styles.timestampUnread]}>{timestamp}</Text>
        </View>

        <View style={styles.rowBottomLine}>
          <Text style={[styles.preview, unread && styles.previewUnread]} numberOfLines={1}>
            {previewLine(row, viewerId)}
          </Text>

          {/* Mute is about the buzz, not the count, so a muted row can still be unread. */}
          {row.muted && (
            <MaterialIcons
              name="notifications-off"
              size={14}
              color={color.textSecondary}
              accessibilityLabel="Muted"
            />
          )}
          {/*
            A DM that went read-only stays in the list and says so. Blocking and losing the last
            shared club both leave history readable, so the row is not removed.
          */}
          {!row.canPost && row.scope === 'dm' && <Text style={styles.readOnly}>READ ONLY</Text>}
          {unread && (
            <View style={styles.unreadBadge}>
              <Text style={styles.unreadLabel}>{row.unread > 99 ? '99+' : row.unread}</Text>
            </View>
          )}
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: color.appBackground },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.md,
    paddingTop: space.sm,
  },
  title: { ...type.title, color: color.textPrimary },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  headerButton: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.cardSunken,
  },

  controls: { paddingHorizontal: space.md, paddingTop: space.sm, gap: space.sm },

  list: { padding: space.md, gap: space.xs, paddingBottom: space.lg },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: color.card,
    borderRadius: radius.lg,
    paddingVertical: space.sm + 2,
    paddingHorizontal: space.md,
  },
  // Tinted rather than badged-in-the-corner, so unread is legible at a glance down a long list.
  rowUnread: { backgroundColor: color.accentSoft },

  rowText: { flex: 1, gap: 2 },
  rowTopLine: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
  name: { ...type.headline, fontSize: 17, color: color.textPrimary, flex: 1 },
  nameUnread: { color: color.textPrimary },
  timestamp: { ...type.label, fontSize: 11, color: color.textSecondary, textTransform: 'none' },
  timestampUnread: { color: color.onAccentSoft },

  rowBottomLine: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  preview: { ...type.bodySmall, color: color.textSecondary, flex: 1 },
  // Full strength when unread, secondary when read - the same contrast the inbox uses.
  previewUnread: { color: color.textPrimary },

  readOnly: { ...type.label, fontSize: 10, color: color.secondary },
  unreadBadge: {
    minWidth: 20,
    height: 20,
    borderRadius: radius.pill,
    backgroundColor: color.error,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.xs,
  },
  unreadLabel: { ...type.label, fontSize: 10, color: color.onAccent },
});
