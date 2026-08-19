/**
 * The notification inbox.
 *
 * **One feed across every club**, merging two different kinds of row: discrete notifications
 * written by the effects pipeline, and live chat-unread rows computed from the log. They look
 * alike and clear differently, which is the whole subtlety of this screen:
 *
 * | Opening | Clears |
 * |---|---|
 * | this inbox | the badge, and nothing else |
 * | a chat | that chat's unread row, leaving a "caught up on N messages" row behind |
 * | the relevant roster | that club's or race's pending join-request rows |
 *
 * So opening the inbox marks it read on the server and the chat-unread rows **stay**. A screen that
 * cleared everything on open would be simpler and would lose the two exceptions the product depends
 * on: an unread chat you have not opened, and a join request nobody has decided.
 *
 * ---
 *
 * **The read treatment, which is v1's and is load-bearing rather than decorative.**
 *
 *  1. An unread row is *tinted* - `accentSoft` fill, a filled accent icon well and full-strength
 *     body text. A read row sits on the plain app background with a neutral well and secondary
 *     text. The difference has to be visible at a glance across a long list, which a small "New"
 *     badge on the right is not.
 *  2. **Discrete notifications are marked read on BLUR, not on focus.** Marking on arrival flips
 *     every row light before the reader can perceive that any of them were new, which defeats the
 *     entire point of having an unread state. They stay tinted for the whole visit and are light
 *     the *next* time the tab is opened.
 *  3. **A chat-unread row is always drawn unread, and this screen never clears it.** It exists in
 *     the feed only while the count is above zero, and the count comes down by opening that chat -
 *     never by looking at this list. Glancing at an inbox is not reading 48 messages.
 *
 * Rules 2 and 3 are the ones that get "simplified" away by anybody who reads only rule 1.
 *
 * ---
 *
 * **The rows are flat and full-bleed, and the list draws its own title.** Both changed 2026-08-12.
 *
 * Flat is not a restyle for its own sake: a carded list insets its rows and tints *inside* that
 * inset, so two adjacent unread rows read as two tinted cards separated by a gap. Tinting edge to
 * edge makes a run of unread rows one continuous band, which is what says "everything above this
 * line is new" at a glance. `TECH/13` had already recorded the Chats list going flat and called
 * unifying the rest a follow-up; this is that follow-up, and it went into `Row` as a parameter
 * rather than becoming a second row implementation.
 *
 * The title moved out of the navigator's branded header and into the body, matching the Chats
 * list. `PRD/15` used to say Calendar and Notifications keep the branded header "because they have
 * no nested stack of their own to host one" - true about where a header *can* live, and not a
 * reason it has to be that one. A destination naming itself in the page reads as the page's own
 * name rather than as chrome above it.
 */

import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { Redirect, useFocusEffect } from 'expo-router';
import { inboxApi } from '../../src/api.ts';
import type { InboxPicture, InboxRow } from '../../src/api-types.ts';
import { useSession } from '../../src/chat-provider.tsx';
import { timeAgo } from '../../src/dates.ts';
import { hrefFor } from '../../src/notification-href.ts';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, radius, space, tabBarSpace, type } from '../../src/theme.ts';
import { Avatar, DataScreen, DestinationHeader, Row } from '../../src/ui.tsx';
import { adoptBadgeCount } from '../../src/use-badge.ts';
import { useLoad, usePullToRefresh } from '../../src/use-load.ts';

/**
 * The glyph for a notification type, matching v1's.
 *
 * Keyed by the server's `type` string, which is open-ended here in a way `target` is not - so an
 * unrecognised type falls back to a bell rather than rendering an empty well. That fallback is the
 * honest handling: a notification the client does not have an icon for is still a notification.
 */
const ICON_BY_TYPE: Readonly<Record<string, IconName>> = {
  club_join_request: 'person-add',
  race_join_request: 'person-add',
  eboard_join_request: 'person-add',
  request_approved: 'check-circle',
  request_denied: 'cancel',
  member_added: 'group-add',
  member_removed: 'person-remove',
  role_changed: 'military-tech',
  poll_created: 'poll',
  poll_closing_soon: 'timer',
  event_created: 'event',
  race_created: 'flag',
  meeting_created: 'groups',
  announcement: 'campaign',
  chat_caught_up: 'done-all',
  mentioned: 'alternate-email',
  // The same shield the Report action carries in the message menu, so the notification and the
  // control that produced it read as the same thing.
  message_reported: 'shield',
  news_post_created: 'photo-camera',
  car_group_incharge_left: 'directions-car',
};

type IconName = React.ComponentProps<typeof MaterialIcons>['name'];

export default function NotificationsScreen() {
  // The tab bar floats OVER this list, so the last row has to be able to scroll clear of it.
  const insets = useSafeAreaInsets();
  const { authState, revision } = useSession();
  const load = useLoad(() => inboxApi.page(), [revision]);

  /** Whether this screen has been opened before, so a return can be told from a first open. */
  const opened = useRef(false);

  /*
   * `revision` above is why this is needed rather than optional. The socket bumps it for
   * everything it hears about, so this screen re-reads whenever any message lands anywhere - and
   * a control bound to the loader's state would announce every one of those as a refresh.
   */
  const pull = usePullToRefresh(load);

  /*
   * Older pages, held beside the first one.
   *
   * Kept in their own state rather than merged into `load`, so a live refresh of page one
   * cannot collapse the list back to twenty rows underneath somebody who has scrolled. Chat-unread
   * rows are never paginated - they all arrive with the first page, however many chats there are,
   * and an older page never contains one.
   */
  const [older, setOlder] = useState<InboxRow[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [exhausted, setExhausted] = useState(false);

  const cursor = load.data?.nextCursor ?? null;
  const lastCursor = olderCursor ?? cursor;

  const loadOlder = async () => {
    if (loadingOlder || exhausted || lastCursor === null) return;
    setLoadingOlder(true);
    try {
      const page = await inboxApi.page(lastCursor);
      setOlder((current) => [...current, ...page.rows]);
      setOlderCursor(page.nextCursor);
      if (page.nextCursor === null) setExhausted(true);
    } catch {
      // Silent: the pages already loaded stay, and the next scroll retries. A failed page is
      // not worth an error state over content the reader has not asked for yet.
    } finally {
      setLoadingOlder(false);
    }
  };

  /*
   * Mark the inbox read when LEAVING, not on arrival.
   *
   * `useFocusEffect`'s cleanup runs on blur, which is the whole point: the rows stay tinted for as
   * long as this screen is on top, and are light the next time it is opened. Marking on mount
   * would clear them before the reader could see that anything was new.
   *
   * Deliberately fire-and-forget and deliberately not reloading: the server clears the badge and
   * leaves the chat-unread and pending-request rows alone, so re-reading would repaint identical
   * content. A failure is invisible on purpose - the badge is an enhancement, the rows are the
   * information.
   */
  useFocusEffect(
    useCallback(() => {
      if (authState !== 'signed-in') return;

      /*
       * Re-read on arrival, and mark read on the way out. Both halves are needed and they do
       * different jobs.
       *
       * The re-read is about the LIVE half of the feed. A chat-unread row is recomputed from the
       * read cursor on every read, so once that chat has been opened the row is simply gone from
       * the server's answer - and its "Caught up on N messages" replacement is there instead.
       * Without this reload the resolved row stayed on screen indefinitely, still claiming unread
       * messages that had already been read, which is exactly what was reported.
       *
       * The re-read does NOT undo the shade rule, because the marking happens on the way OUT. So
       * a visit loads rows in whatever state they were left in, keeps that state for the whole
       * visit, and finds them plain on the next visit. The two rules only look like they conflict.
       *
       * > **`refresh`, never `reload`.** Both re-read; only `reload` announces a load, and the
       * > pull control below is bound to that state - so returning to this tab fired the refresh
       * > spinner every single time, over content that was already on screen and about to be
       * > replaced by identical content. Reported as the inbox loading "unusually" on tab switch.
       * > This is the same mistake `use-load.ts` was split into two calls to prevent, and the
       * > same one already fixed once for the chat list.
       *
       * The pull-to-refresh gesture still calls `reload`, because there the spinner is the point:
       * somebody asked for a load and is owed the acknowledgement.
       */
      /*
       * > **Not on the FIRST fire.** `useFocusEffect` runs on mount as well as on return, and
       * > `useLoad` above has already read on mount - so opening this tab asked for
       * > `/notifications` twice, about 18ms apart, and the loader's attempt counter threw the
       * > first answer away. The same defect `useRefreshOnReturn` exists to prevent; this screen
       * > cannot simply use it, because the cleanup below has to run on every blur and that hook
       * > has no cleanup of its own.
       *
       * The pagination reset is inside the guard for the same reason and at no cost: on a first
       * open there is nothing paged in yet, so skipping it changes nothing.
       */
      if (opened.current) {
        load.refresh();
        setOlder([]);
        setOlderCursor(null);
        setExhausted(false);
      } else {
        opened.current = true;
      }

      return () => {
        /*
         * Mark on the way out, and take the count the write hands back.
         *
         * The badge re-reads on navigation, which happens at this same instant - so the read
         * races this write and usually wins, carrying the count from before the mark. The number
         * then sat wrong until the next navigation, which is why it only appeared to clear on
         * coming back to this screen.
         *
         * > **This used to call `notifyChanged()`, and that was a global broadcast sent to update
         * > one number.** It bumps the session revision that eight screens re-fetch on, so
         * > leaving this tab re-read the chat list with every DM in it, plus a club's name and
         * > its race list - none of which reading the inbox can change. Measured at 8 requests
         * > per tab exit on the iPhone, 2026-08-19.
         *
         * `markRead` already returns `badge`, recomputed by the server after the mark, so the
         * right answer was in the response the whole time. `adoptBadgeCount` publishes it and
         * orders it correctly against the navigation read still on the wire.
         */
        void inboxApi
          .markRead()
          .then(({ badge }) => adoptBadgeCount(badge))
          .catch(() => undefined);
      };
      // `load.reload` is deliberately not a dependency: it changes identity on every render, and
      // depending on it would re-fire this on every render rather than on focus.
      // `adoptBadgeCount` is a module-scope function with a stable identity, so unlike the
      // `notifyChanged` it replaced it does not belong in this list at all.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [authState]),
  );

  if (authState === 'checking') return <View style={styles.flex} />;
  if (authState === 'signed-out') return <Redirect href="/sign-in" />;

  return (
    <View style={styles.flex}>
      {/* The screen's own title, in the body rather than in a header bar. See DestinationHeader. */}
      <DestinationHeader title="Notifications" />

      <DataScreen
        load={load}
        isEmpty={(data) => data.rows.length === 0 && older.length === 0}
        errorMessage="Couldn't load notifications."
        empty={<Text style={styles.empty}>You're all caught up.</Text>}
      >
        {(data) => (
          <FlatList<InboxRow>
            data={[...data.rows, ...older]}
            keyExtractor={(row) => `${row.kind}:${row.id}`}
            contentContainerStyle={[styles.list, { paddingBottom: tabBarSpace(insets.bottom) }]}
            refreshControl={<RefreshControl {...pull} tintColor={color.accent} />}
            /*
              Paging is silent: no page numbers, and deliberately NO end-of-history footer.
              Nothing in this feed expires, so there is no "that's everything" to announce -
              the list simply keeps going, and a footer claiming an end would be a lie about a
              feed that reaches back to the day the account was created.
            */
            onEndReachedThreshold={0.5}
            onEndReached={() => void loadOlder()}
            ListFooterComponent={
              loadingOlder ? (
                <ActivityIndicator color={color.accent} style={styles.footerSpinner} />
              ) : null
            }
            renderItem={({ item }) => <InboxRowView row={item} />}
          />
        )}
      </DataScreen>
    </View>
  );
}

/** The icon well. Filled with the accent when unread, sunken and neutral when read. */
function IconWell({ icon, unread }: { icon: IconName; unread: boolean }) {
  return (
    <View
      style={[styles.well, unread && styles.wellUnread]}
      accessibilityElementsHidden
      importantForAccessibility="no"
    >
      <MaterialIcons
        name={icon}
        size={20}
        color={unread ? color.onAccent : color.textSecondary}
      />
    </View>
  );
}

/**
 * What sits at the left of a row: a face, or a glyph.
 *
 * `PRD/12` rule 2c - **a picture when the row is about a place or a person, a glyph when it is
 * about a thing that happened.** Which of the two a type gets is decided once, on the server,
 * from the mapping in `@clubchat/shared`; this only draws whichever arrived. A `null` picture is
 * an ordinary answer rather than a failure: the glyph tier never has one, and a subject that has
 * since been deleted resolves to none.
 *
 * > **Forced to a circle, which is this surface's one sanctioned exception to `DESIGN/02` rule
 * > 2.** Everywhere else a group is a rounded square and the shape answers person-versus-group
 * > before a word is read. Here every row is a sentence that already names its own subject, so the
 * > shape has nothing left to say and a column of alternating silhouettes costs more than it
 * > carries. Passed explicitly, because an override is legible at the call site.
 */
function RowFace({
  picture,
  icon,
  unread,
}: {
  picture: InboxPicture | null;
  icon: IconName;
  unread: boolean;
}) {
  if (picture === null) {
    return (
      <View style={[styles.face, unread && styles.faceUnread]}>
        <IconWell icon={icon} unread={unread} />
      </View>
    );
  }

  return (
    <View style={[styles.face, unread && styles.faceUnread]}>
      <Avatar
        name={picture.name}
        image={picture.image}
        // Decides the FALLBACK, not the shape: a group draws a glyph, a person their initial.
        kind={picture.kind}
        shape="circle"
        tintId={picture.tintId}
        size={40}
      />
    </View>
  );
}

/**
 * One row.
 *
 * Every row navigates to its target and **fails gracefully if access was lost** - a race you were
 * removed from between the notification and the tap. A target with no screen stays a plain row
 * rather than becoming a dead link.
 *
 * > **No trailing dot.** The tint, the filled well and the full-strength body already say unread
 * > three times over, and on a full-bleed row a dot at the right edge has no edge to sit against.
 * > It was decorative rather than a channel: it was hidden from the screen reader, which is told
 * > by the label below instead - so removing it takes nothing away from anybody.
 */
function InboxRowView({ row }: { row: InboxRow }) {
  const href = hrefFor(row.target);

  if (row.kind === 'chat_unread') {
    /*
     * Always drawn unread, and there is no read variant of this row at all. It exists only while
     * the count is above zero, and the count comes down by opening that chat. When it is opened
     * this row stops existing and a "Caught up on N messages" record takes its place in the same
     * list - the two must never appear at once.
     */
    return (
      <Row
        title=""
        highlighted
        flat
        left={<RowFace picture={row.picture} icon="chat-bubble" unread />}
        {...(href ? { href } : {})}
        accessibilityLabel={`${row.count} unread ${row.count === 1 ? 'message' : 'messages'} in ${row.channelName} chat. Open it`}
        body={
          <>
            {/* The count and the chat's name carry the weight; the joining words do not. */}
            <Text style={styles.body}>
              <Text style={styles.bodyStrong}>{row.count} unread</Text>
              {/* One message is the commonest case in a quiet club, not an edge case, so the
                  plural is chosen rather than assumed. The Chats list already does this for its
                  own count and this row read "1 unread messages" until 2026-08-12. */}
              {row.count === 1 ? ' message in ' : ' messages in '}
              <Text style={styles.bodyStrong}>{row.channelName}</Text>
              {' chat'}
            </Text>
            <Text style={styles.time}>{timeAgo(row.createdAt)}</Text>
          </>
        }
      />
    );
  }

  const unread = !row.read;

  return (
    <Row
      title=""
      highlighted={unread}
      flat
      left={
        <RowFace
          picture={row.picture}
          icon={ICON_BY_TYPE[row.type] ?? 'notifications'}
          unread={unread}
        />
      }
      {...(href ? { href } : {})}
      accessibilityLabel={`${unread ? 'Unread. ' : ''}${row.body}${href ? '. Open' : ''}`}
      body={
        <>
          <Text style={[styles.body, unread && styles.bodyUnread]}>{row.body}</Text>
          <View style={styles.metaRow}>
            <Text style={styles.time}>{timeAgo(row.createdAt)}</Text>
            {/* A decided request stays in the feed, tagged - history rather than a pending
                action - and is read, so it wears the plain style with the tag beside its time. */}
            {row.decision !== undefined && (
              <Text style={[styles.decision, row.decision === 'denied' && styles.decisionDenied]}>
                {row.decision === 'approved' ? 'Approved' : 'Denied'}
              </Text>
            )}
          </View>
        </>
      }
    />
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: color.appBackground },

  /*
   * The title block. Horizontal padding only - the rows are full-bleed and pay their own gutter,
   * so a padded list would put the title and the row text on two different left edges.
   */

  /*
   * No horizontal padding and no gap: both belong to the row now.
   *
   * This is what lets consecutive unread rows meet, forming one tinted band rather than a stack of
   * separated tinted blocks. A `gap` here would reintroduce exactly the seam the flat variant
   * exists to remove.
   */
  list: { paddingTop: space.xs },
  empty: {
    ...type.body,
    color: color.textSecondary,
    textAlign: 'center',
    marginTop: 40,
  },
  footerSpinner: { marginVertical: space.md },

  // Archivo Narrow 14: the body IS the notification, so it carries the reading weight.
  body: { ...type.bodySmall, color: color.textSecondary },
  bodyUnread: { color: color.textPrimary },
  bodyStrong: { fontFamily: 'Inter_600SemiBold' },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.xs },
  // Not uppercase: "2h ago" is prose, and the label token's letterspacing makes it shout.
  time: { ...type.label, fontSize: 11, color: color.border, textTransform: 'none' },

  well: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.cardSunken,
  },
  wellUnread: { backgroundColor: color.accent },

  /*
   * The box both tiers sit in, so a picture row and a glyph row line up.
   *
   * The border is always drawn and only its COLOUR changes - transparent when read, accent when
   * unread. Toggling `borderWidth` instead would resize the box, so every row would shift two
   * points sideways the moment the inbox was marked read, in a list where read and unread rows
   * are stacked directly on top of each other.
   */
  face: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  /*
   * Unread, for a photograph.
   *
   * Rule 2b fills the icon well to say unread, and a picture cannot be filled without hiding the
   * thing it is there to show. The ring says it around the outside instead, so both tiers signal
   * the same fact with the same weight by different means (`PRD/12` rule 2e).
   */
  faceUnread: { borderColor: color.accent },

  decision: {
    ...type.label,
    fontSize: 10,
    textTransform: 'none',
    color: color.onAccentSoft,
    backgroundColor: color.accentSoft,
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    overflow: 'hidden',
  },
  decisionDenied: { color: color.onErrorContainer, backgroundColor: color.errorContainer },
});
