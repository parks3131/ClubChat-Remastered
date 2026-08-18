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
 *  1. **Everything is the resting state.** `All` is selected on arrival and the other chips narrow
 *     from there. Landing on Unread would mean opening the app to an empty screen on every day you
 *     are caught up, which is most days, and an empty list reads as a broken app rather than as
 *     good news.
 *
 *     Until 2026-08-09 that state was "no chip selected", cleared by tapping the active chip a
 *     second time. Same behaviour, invisible affordance: a filter with nothing on screen saying
 *     how to leave it is worse than one more chip.
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

import { useCallback, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { Redirect, useFocusEffect, useRouter, useScrollToTop } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  conversationSummaryText,
  type ConversationSummary,
} from '@clubchat/shared';
import { channelApi, clubApi, dmApi } from '../../../../src/api.ts';
import { useSession } from '../../../../src/chat-provider.tsx';
import { useClearClub } from '../../../../src/current-space.tsx';
import { formatConversationTimestamp } from '../../../../src/dates.ts';
import { longPressFeedback } from '../../../../src/haptics.ts';
import { color, radius, space, tabBarSpace, type } from '../../../../src/theme.ts';
import {
  Avatar,
  ConfirmDialog,
  ContextMenu,
  DataScreen,
  DestinationHeader,
  EmptyState,
  SearchField,
  Tabs,
  measureRow,
  type PressAnchor,
} from '../../../../src/ui.tsx';
import { useLoad, usePullToRefresh, useRefreshOnReturn } from '../../../../src/use-load.ts';

/**
 * The four chips, in the order the design shows them.
 *
 * > **`all` is a real chip, and it replaced "no chip is selected" on 2026-08-09.** The resting
 * > state is unchanged - everything is shown, and the app never opens on a filtered list - but it
 * > is now *stated* rather than implied by an empty row of pills. The old version cleared a filter
 * > by tapping the active chip again, which is a gesture with nothing on screen to suggest it; a
 * > filter you cannot see how to leave is worse than a fourth chip.
 */
const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'dms', label: 'DMs' },
  { key: 'unread', label: 'Unread' },
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
    // `all` and null are the same answer. Null is still accepted because it is the honest type
    // for "nothing selected", and a state the screen can no longer reach is not a state worth
    // making this function lie about.
    default:
      return true;
  }
}

/**
 * The number beside the Unread chip: conversations with anything unread, not messages.
 *
 * **The same rule the tab badge follows**, and it has to be, because they are two drawings of one
 * fact: a chat with 48 unread contributes 1 here and says 48 on its own row. Counting messages
 * would put "63" on a chip that filters to two rows, which reads as a broken number rather than
 * as a lot of messages.
 */
export function unreadChipCount(rows: readonly ConversationSummary[]): number {
  return rows.filter((row) => row.unread > 0).length;
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
  const { authState, revision, userId, client } = useSession();
  const router = useRouter();
  /*
   * This screen opts out of the stack header to draw its own title and actions, which means it
   * also owns the inset the header would have applied. Without it the title renders behind the
   * clock and the two buttons behind the battery - and a browser has no notch, so it looks
   * perfect right up until somebody holds a phone. Chat lost the same inset the same way.
   */
  const insets = useSafeAreaInsets();

  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  /** The row a long press opened the menu for, or null. */
  /** The row whose long-press menu is open, with the rectangle it occupies so it can be lifted. */
  const [sheetFor, setSheetFor] = useState<{
    row: ConversationSummary;
    anchor: PressAnchor;
  } | null>(null);
  const [confirmClear, setConfirmClear] = useState<ConversationSummary | null>(null);
  const [confirmLeave, setConfirmLeave] = useState<ConversationSummary | null>(null);

  const load = useLoad(() => channelApi.conversations(), [revision]);

  /*
   * Re-read whenever this screen comes back into view.
   *
   * `revision` covers changes this client made or was told about, and it is not enough on its
   * own: a count can move because another device read the conversation, or because a push was
   * opened, or simply because the socket was down while somebody wrote. Coming back to a list
   * and seeing what it said ten minutes ago is the specific complaint this fixes, and asking on
   * focus is the only version that cannot be reasoned wrong.
   *
   * Cheap: one small query, and only when the screen is actually being looked at.
   */
  /*
   * > **`useFocusEffect` fires on MOUNT as well as on return, so this screen read twice to
   * > open.** `useLoad` above reads on mount, and this fired a second read about 18ms behind it -
   * > caught on the dev trace as `/conversations` arriving in pairs, eight times in one session.
   * > Both answers were fetched and the first was discarded by the loader's attempt counter, so
   * > it cost a round trip and showed nothing for it.
   *
   * This is the exact defect `useRefreshOnReturn` was written for on 2026-08-17, and its doc
   * comment describes this screen's symptom. It simply was never moved over.
   */
  useRefreshOnReturn(load, 'chats');

  /**
   * A pull, and only a pull, spins the control. A background refresh must look like nothing.
   *
   * This screen had the rule written out inline and the inbox did not, which is how the inbox
   * came to spin on every arriving message. It lives in `use-load.ts` now, beside the `reload`
   * and `refresh` split it is the visible half of.
   */
  const pull = usePullToRefresh(load);

  /*
   * Tapping CHATS while already on this list scrolls it back to the top.
   *
   * The tab handler deliberately does NOT claim that press - see `(tabs)/_layout.tsx`. This hook
   * checks `defaultPrevented` and stays out of the way if anything did, which is the whole reason
   * the handler returns early instead of preventing and navigating to the screen you are on.
   *
   * It also declines unless this screen is focused AND is the first route of its stack, so being
   * three screens deep in a club still means "come back out" rather than a silent scroll.
   */
  const listRef = useRef<FlatList<ConversationSummary>>(null);
  useScrollToTop(listRef);

  const act = async (run: () => Promise<unknown>) => {
    setSheetFor(null);
    try {
      await run();
    } finally {
      // Reload either way: a refusal usually means the row is stale rather than that the
      // action was wrong, and showing the truth is more use than an error here.
      load.reload();
    }
  };

  // A guarded screen renders a placeholder in its denied branch, because the redirect lands a
  // frame later and an unguarded render would flash real chrome first.
  if (authState === 'checking') return <View style={styles.flex} />;
  if (authState === 'signed-out') return <Redirect href="/sign-in" />;

  return (
    <View style={styles.flex}>
      <DestinationHeader title="Chats">
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
      </DestinationHeader>

      <DataScreen load={load}>
        {(data) => {
          const rows = data.conversations.filter((row) => matchesFilter(row, filter, query));
          return (
            <FlatList<ConversationSummary>
              ref={listRef}
              data={rows}
              keyExtractor={(row) => row.channelId}
              /*
                The bottom padding is the floating bar's footprint, not a constant.

                > **The bar is drawn OVER this list, so without it the last row is sliced in half
                > by the bar's top edge** - the avatar cut down the middle by a rounded corner,
                > which is what "it cuts the image" was. A list that cannot scroll its final row
                > clear of the chrome has a row you can see and cannot read.

                From the same token the bar is built from, so the two cannot drift apart, and
                carrying the safe-area inset because the bar sits on it.
              */
              contentContainerStyle={[
                styles.list,
                { paddingBottom: tabBarSpace(insets.bottom) },
              ]}
              refreshControl={<RefreshControl {...pull} tintColor={color.accent} />}
              /*
                The search field and the chips SCROLL AWAY with the list, and only the title row
                stays.

                > **They are content, not chrome.** Pinned above the list they cost a fixed band of
                > every screenful forever, to hold two controls somebody touches once and then
                > scrolls past. Carried by the list, they are there when you arrive and when you
                > return to the top, which is exactly when you want them, and gone while you are
                > reading - which is the behaviour read off GroupMe.

                Passed as an ELEMENT rather than as a component, deliberately: a function here is
                a new component type on every render, so the search field would remount and drop
                its keyboard focus on each keystroke.

                This sits inside `DataScreen` now, where a note used to say it must not - the
                worry being that a reload would blink the controls out of existence. That cannot
                happen: `DataScreen` only replaces its children while `load.data` is null, so a
                refresh with data already on screen keeps them mounted. What it does mean is that
                the very first load and a hard error show no controls, and in both of those there
                is no list to search or narrow anyway.

                The unread count reads `load.data` rather than the filtered rows: it must say how
                much is unread in the WHOLE list, not in what the current filter has already
                narrowed to. Standing on Clubs and being told there are two unread would otherwise
                mean two unread CLUBS, silently dropping the DMs.
              */
              ListHeaderComponent={
                <View style={styles.controls}>
                  <SearchField value={query} onChangeText={setQuery} placeholder="Search" />
                  <Tabs
                    tabs={FILTERS.map((entry) =>
                      entry.key === 'unread'
                        ? { ...entry, count: unreadChipCount(load.data?.conversations ?? []) }
                        : entry,
                    )}
                    active={filter}
                    variant="chip"
                    onChange={setFilter}
                  />
                </View>
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
                  onLongPress={(anchor) => {
                    // The same buzz a long press gets on a chat bubble. This list had none, so
                    // the identical gesture felt like a different control depending on which
                    // screen you were on.
                    longPressFeedback();
                    setSheetFor({ row: item, anchor });
                  }}
                />
              )}
            />
          );
        }}
      </DataScreen>

      {/*
        The long-press menu.

        Pin and Mute apply to every row because both are per-person facts about a conversation in
        any scope. Delete chat now does too - it was a DM only until 2026-08-06, and widening it
        was a change to `canClearChannel` rather than to this menu, because who may clear what is
        a policy question. Leave club is last, red, and absent unless the server says the viewer
        may leave: a DM has nothing to leave, and an Owner cannot leave their own club.
      */}
      {sheetFor !== null && (
        <ContextMenu
          anchor={sheetFor.anchor}
          /*
            The same component the list draws, drawn again to be lifted. Reusing it rather than
            describing the row a second time is what stops the floating copy from drifting from
            the real one the next time a row grows a badge.
          */
          preview={
            <ConversationRow
              row={sheetFor.row}
              viewerId={userId}
              onPress={() => undefined}
              onLongPress={() => undefined}
            />
          }
          onDismiss={() => setSheetFor(null)}
          items={[
            {
              label: sheetFor.row.pinned ? 'Unpin' : 'Pin',
              icon: 'push-pin',
              onPress: () => {
                const row = sheetFor.row;
                void act(() => channelApi.pin(row.channelId, !row.pinned));
              },
            },
            {
              label: sheetFor.row.muted ? 'Unmute' : 'Mute',
              icon: sheetFor.row.muted ? 'notifications-active' : 'notifications-off',
              onPress: () => {
                const row = sheetFor.row;
                void act(() =>
                  row.muted ? dmApi.unmute(row.channelId) : dmApi.mute(row.channelId),
                );
              },
            },
            {
              label: 'Delete chat',
              icon: 'delete-outline',
              onPress: () => {
                const row = sheetFor.row;
                setSheetFor(null);
                setConfirmClear(row);
              },
            },
            ...(sheetFor.row.canLeave
              ? [
                  {
                    label: 'Leave club',
                    icon: 'logout' as const,
                    destructive: true,
                    onPress: () => {
                      const row = sheetFor.row;
                      setSheetFor(null);
                      setConfirmLeave(row);
                    },
                  },
                ]
              : []),
          ]}
        />
      )}

      {/*
        The wording is the important part. "Delete" reads as mutual and is not, so the dialog
        says whose copy goes and whose does not - which is what stops somebody using it thinking
        it reaches the other person, or avoiding it thinking it destroys the record for good.
      */}
      {confirmClear !== null && (
        <ConfirmDialog
          title="Delete this chat?"
          // Who keeps the messages depends on who else is in the room, so the sentence does too.
          // Naming the other person is right in a DM and wrong in a club, where it would name the
          // club as though a club could hold a copy.
          body={
            confirmClear.scope === 'dm'
              ? `This clears the conversation for you only. ${confirmClear.name} will still have every message, and will not be told.`
              : `This clears ${confirmClear.name} for you only. Everybody else keeps every message, and nobody is told.`
          }
          confirmLabel="Delete chat"
          dismissLabel="Keep it"
          onCancel={() => setConfirmClear(null)}
          onConfirm={() => {
            const row = confirmClear;
            setConfirmClear(null);
            void act(async () => {
              await channelApi.clear(row.channelId);
              // The device is holding exactly the messages that clear was meant to hide, and
              // renders from the cache before any network call resolves.
              await client?.forgetChannel(row.channelId);
            });
          }}
        />
      )}

      {/*
        Leaving is the one action here that cannot be undone by repeating it, so the dialog spells
        out the cascade rather than asking "are you sure". Losing the races and the Eboard is the
        part nobody expects from a menu they opened on a chat row - `cascadeOut` drops every race
        roster row and Eboard membership in the club, in the same transaction.
      */}
      {confirmLeave !== null && (
        <ConfirmDialog
          title={`Leave ${confirmLeave.name}?`}
          body="You will lose the club chat, every race in the club and any Eboard access. You can ask to join again later."
          confirmLabel="Leave club"
          dismissLabel="Stay"
          onCancel={() => setConfirmLeave(null)}
          onConfirm={() => {
            const row = confirmLeave;
            setConfirmLeave(null);
            if (row.clubId === null) return;
            const clubId = row.clubId;
            void act(async () => {
              await clubApi.leave(clubId);
              await client?.forgetChannel(row.channelId);
            });
          }}
        />
      )}
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
  if (filter === 'clubs') return 'No club chats yet';
  // `all` with conversations in hand cannot be empty, so this is the unreachable branch rather
  // than the catch-all it used to be - naming `clubs` above stops it quietly answering for a
  // fifth chip somebody adds later.
  return 'No chats yet';
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
  onLongPress,
}: {
  row: ConversationSummary;
  viewerId: string | null;
  onPress: () => void;
  /** Given the row's own rectangle, so the menu can lift it and hang off it. */
  onLongPress: (anchor: PressAnchor) => void;
}) {
  const self = useRef<View>(null);
  const unread = row.unread > 0;
  const timestamp = useMemo(
    () =>
      row.lastMessage === null ? '' : formatConversationTimestamp(row.lastMessage.createdAt),
    [row.lastMessage],
  );

  return (
    <Pressable
      ref={self}
      /*
        A grey wash while the finger is down.

        Flat rows removed every other cue that a row is a control - there is no card edge, no
        chevron and no ripple - so without this a tap is answered only by the next screen
        arriving, and on a slow open the row looks dead for as long as that takes. The
        highlight is the acknowledgement, and it costs nothing to be instant because it never
        waits on the navigation.
      */
      style={({ pressed }) => [styles.row, unread && styles.rowUnread, pressed && styles.rowPressed]}
      onPress={onPress}
      onLongPress={(event) =>
        measureRow(
          self.current,
          { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY },
          onLongPress,
        )
      }
      accessibilityRole="button"
      accessibilityLabel={
        unread
          ? `${row.name}, ${row.unread} unread ${row.unread === 1 ? 'message' : 'messages'}`
          : row.name
      }
    >
      {/*
        A club draws the group glyph, a DM draws an initial. Tinted from the CHANNEL id, which is
        stable for the life of the conversation - the club id would be equally stable but is null
        for a DM, and one source that always exists beats two that each work half the time.
      */}
      <Avatar
        name={row.name}
        image={row.image}
        size={56}
        kind={row.scope === 'dm' ? 'person' : 'group'}
        tintId={row.channelId}
        ring
      />

      <View style={styles.rowText}>
        <View style={styles.rowTopLine}>
          <Text style={[styles.name, unread && styles.nameUnread]} numberOfLines={1}>
            {row.name}
          </Text>
          {/* Why this row is at the top, said rather than left to be inferred. */}
          {row.pinned && (
            <MaterialIcons
              name="push-pin"
              size={13}
              color={color.textSecondary}
              accessibilityLabel="Pinned"
            />
          )}
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
            **A read-only DM says nothing here, and that is deliberate as of 2026-08-09.**

            The row used to carry a READ ONLY chip. `canPost` is a single boolean covering two very
            different causes - the pair blocked each other, or they no longer share a club - so the
            chip could not say which, and it did not have to: `PRD/14` rule 6 makes a block silent
            to the blocked party, and the resolution note under it puts the explanation on the
            **composer**, where the chat screen already draws one of two exact sentences.

            So the chip was redundant where it was right and disclosing where it was wrong. It
            announced a state on the landing screen, visible to anybody glancing at the phone,
            about a person who is meant not to be told. The conversation still opens, the history
            is still readable, and the reason is still given - one screen further in, which is
            where the spec puts it.
          */}
        </View>
      </View>

      {/*
        The right-hand column: when it happened, and how much of it you have not read.

        > **Unread is these two marks and nothing else as of 2026-08-09.** The row used to be
        > tinted `accentSoft` end to end, which was the most glanceable version and lost to the
        > redesign on purpose: a list where a third of the rows are filled blocks of peach is
        > loud, and it fights the flat white the rest of the screen is built on. The timestamp
        > turning accent is the cue that survives - it is the one element that changes colour
        > rather than appearing, so the eye catches it without the row shouting.

        Every unread row carries its number. The badge is not a "there is something here" dot;
        it is the count, which is the thing worth knowing before deciding what to open first.
      */}
      <View style={styles.rowMeta}>
        <Text style={[styles.timestamp, unread && styles.timestampUnread]}>{timestamp}</Text>
        {unread && (
          <View style={styles.unreadBadge}>
            <Text style={styles.unreadLabel}>{row.unread > 99 ? '99+' : row.unread}</Text>
          </View>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: color.appBackground },

  // The masthead itself is `DestinationHeader` in ui.tsx, shared with the other three
  // destinations. Only the two action discs are this screen's own.
  // Outlined rather than filled: both are additive actions, and a filled disc apiece reads as two
  // primary buttons on a screen whose primary action is opening a conversation.
  headerButton: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: color.accent,
  },

  controls: { paddingHorizontal: space.md, paddingTop: space.md, gap: space.md },

  /*
   * Flat rows on the app background, not cards.
   *
   * The gap between rows is vertical padding inside each row rather than a `gap` between them, so
   * the press target covers the whitespace it appears to own - a card list can afford a dead
   * gutter between rows because the card draws where the target ends, and a flat list cannot.
   */
  /*
   * No horizontal padding here: it belongs to the ROW.
   *
   * The press highlight is the row's own background, so padding the list instead would inset that
   * highlight by the gutter and leave a stripe of untinted background down each edge - a
   * half-highlighted row reads as a rendering fault rather than as a press. Padding the row makes
   * the wash run edge to edge, which is what every native list does.
   */
  list: { paddingBottom: space.lg },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm + 4,
    paddingHorizontal: space.md,
  },
  /** The finger is down. Light enough to be a wash rather than a selection. */
  rowPressed: { backgroundColor: color.cardRaised },
  /*
   * Deliberately empty, and deliberately still here.
   *
   * Unread is carried entirely by the timestamp and the badge as of 2026-08-09. The hook is kept
   * so the decision has somewhere to live: the next person wanting to mark an unread row will
   * find this and the note on `rowMeta` rather than reaching for a background tint again.
   */
  rowUnread: {},

  rowText: { flex: 1, gap: 2 },
  rowTopLine: { flexDirection: 'row', alignItems: 'center', gap: space.xs + 2 },
  name: { ...type.headline, fontSize: 17, color: color.textPrimary, flexShrink: 1 },
  nameUnread: { color: color.textPrimary },

  // Top-aligned, so the timestamp sits on the name's line and the badge hangs beneath it.
  rowMeta: { alignItems: 'flex-end', gap: space.xs, paddingTop: 2 },
  timestamp: { ...type.label, fontSize: 12, color: color.textSecondary, textTransform: 'none' },
  timestampUnread: { color: color.accent },

  rowBottomLine: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  preview: { ...type.bodySmall, color: color.textSecondary, flexShrink: 1 },
  // Full strength when unread, secondary when read - the same contrast the inbox uses.
  previewUnread: { color: color.textPrimary },

  // Accent, not `error`: an unread message is not a fault. Red is what this product uses for
  // something that went wrong, and a count of things your friends said is not that.
  unreadBadge: {
    minWidth: 22,
    height: 22,
    borderRadius: radius.pill,
    backgroundColor: color.accent,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.xs,
  },
  unreadLabel: { ...type.label, fontSize: 11, color: color.onAccent, textTransform: 'none' },
});
