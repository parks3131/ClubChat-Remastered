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
 *  1. An unread row is *tinted* - `accentSoft` fill, `accentSoftBorder` edge, a filled accent icon
 *     well, full-strength body text and a dot. A read row is a plain white card with a neutral
 *     well and secondary text. The difference has to be visible at a glance across a long list,
 *     which a small "New" badge on the right is not.
 *  2. **Discrete notifications are marked read on BLUR, not on focus.** Marking on arrival flips
 *     every row light before the reader can perceive that any of them were new, which defeats the
 *     entire point of having an unread state. They stay tinted for the whole visit and are light
 *     the *next* time the tab is opened.
 *  3. **A chat-unread row is always drawn unread, and this screen never clears it.** It exists in
 *     the feed only while the count is above zero, and the count comes down by opening that chat -
 *     never by looking at this list. Glancing at an inbox is not reading 48 messages.
 *
 * Rules 2 and 3 are the ones that get "simplified" away by anybody who reads only rule 1.
 */

import { useCallback } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { Redirect, useFocusEffect } from 'expo-router';
import type { NotificationTarget } from '@clubchat/shared';
import { inboxApi } from '../../src/api.ts';
import type { InboxRow } from '../../src/api-types.ts';
import { useSession } from '../../src/chat-provider.tsx';
import { timeAgo } from '../../src/dates.ts';
import { color, radius, space, type } from '../../src/theme.ts';
import { DataScreen, EmptyState, Row } from '../../src/ui.tsx';
import { useLoad } from '../../src/use-load.ts';

/**
 * Where a row goes when tapped.
 *
 * Exhaustive over `NotificationTarget`, which is the reason that type is imported from
 * `@clubchat/shared` rather than restated here: the server derives the target exhaustively over the
 * notification types, and this switch is the client half of the same guarantee. A new target kind
 * becomes a compile error rather than a row that silently navigates nowhere.
 */
function hrefFor(target: NotificationTarget): string | undefined {
  switch (target.kind) {
    case 'chat':
      // `seq` rides along for a mention or a pin, so the chat opens ON the message rather than at
      // the tail - which is what the jump-to-message window exists for.
      return target.seq === undefined
        ? `/chat/${target.channelId}`
        : `/chat/${target.channelId}?around=${target.seq}`;
    case 'club':
      return `/clubs/${target.clubId}`;
    case 'club_members':
      return `/clubs/${target.clubId}/members`;
    case 'race':
      return `/races/${target.raceId}`;
    case 'race_roster':
      return `/races/${target.raceId}/roster`;
    case 'race_car_groups':
      return `/races/${target.raceId}/car-groups`;
    case 'eboard':
      return `/eboard/${target.eboardId}`;
    case 'eboard_roster':
      return `/eboard/${target.eboardId}/members`;
    case 'poll':
      return `/polls/${target.pollId}`;
    case 'event':
      // An event has no screen of its own: it lives in the club's merged events list, which is
      // where PRD/07 puts it. Routed to the club rather than invented.
      return undefined;
    case 'meeting':
      return `/meetings/${target.meetingId}`;
    case 'news':
      return `/clubs/${target.clubId}/news`;
    case 'inbox':
      // Already here.
      return undefined;
  }
}

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
  news_post_created: 'photo-camera',
  car_group_incharge_left: 'directions-car',
};

type IconName = React.ComponentProps<typeof MaterialIcons>['name'];

export default function NotificationsScreen() {
  const { authState, revision } = useSession();
  const load = useLoad(() => inboxApi.page(), [revision]);

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
      return () => {
        void inboxApi.markRead().catch(() => undefined);
      };
    }, [authState]),
  );

  if (authState === 'checking') return <View style={styles.flex} />;
  if (authState === 'signed-out') return <Redirect href="/sign-in" />;

  return (
    <View style={styles.flex}>
      <DataScreen
        load={load}
        isEmpty={(data) => data.rows.length === 0}
        empty={
          <EmptyState title="Nothing new" body="Mentions, announcements and requests land here." />
        }
      >
        {(data) => (
          <FlatList<InboxRow>
            data={data.rows}
            keyExtractor={(row) => `${row.kind}:${row.id}`}
            contentContainerStyle={styles.list}
            refreshControl={
              <RefreshControl
                refreshing={load.state === 'loading'}
                onRefresh={load.reload}
                tintColor={color.accent}
              />
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
 * One row.
 *
 * Every row navigates to its target and **fails gracefully if access was lost** - a race you were
 * removed from between the notification and the tap. A target with no screen stays a plain row
 * rather than becoming a dead link.
 */
function InboxRowView({ row }: { row: InboxRow }) {
  const href = hrefFor(row.target);

  if (row.kind === 'chat_unread') {
    /*
     * Always unread. This row exists only while the count is above zero, and the count comes down
     * by opening that chat. Reading it as read here would be the screen claiming 48 messages were
     * read because somebody glanced at a list.
     */
    return (
      <Row
        title={`${row.count} unread in ${row.channelName}`}
        subtitle={timeAgo(row.createdAt)}
        highlighted
        left={<IconWell icon="chat-bubble" unread />}
        {...(href ? { href } : {})}
        accessibilityLabel={`${row.count} unread messages in ${row.channelName}. Open the chat`}
        right={<View style={styles.dot} accessibilityElementsHidden importantForAccessibility="no" />}
      />
    );
  }

  const unread = !row.read;

  return (
    <Row
      title={row.title}
      subtitle={`${row.body}  ·  ${timeAgo(row.createdAt)}`}
      highlighted={unread}
      left={<IconWell icon={ICON_BY_TYPE[row.type] ?? 'notifications'} unread={unread} />}
      {...(href ? { href } : {})}
      accessibilityLabel={`${unread ? 'Unread. ' : ''}${row.title}. ${row.body}${
        href ? '. Open' : ''
      }`}
      right={
        <>
          {/* A decided request stays in the feed, tagged - history rather than a pending action. */}
          {row.decision !== undefined && (
            <Text style={[styles.decision, row.decision === 'denied' && styles.decisionDenied]}>
              {row.decision === 'approved' ? 'Approved' : 'Denied'}
            </Text>
          )}
          {unread && (
            <View style={styles.dot} accessibilityElementsHidden importantForAccessibility="no" />
          )}
        </>
      }
    />
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: color.appBackground },
  list: { padding: space.md, gap: space.sm },

  well: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.cardSunken,
  },
  wellUnread: { backgroundColor: color.accent },

  dot: { width: 8, height: 8, borderRadius: radius.pill, backgroundColor: color.accent },

  decision: {
    ...type.label,
    fontSize: 10,
    color: color.onAccentSoft,
    backgroundColor: color.accentSoft,
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    overflow: 'hidden',
  },
  decisionDenied: { color: color.onErrorContainer, backgroundColor: color.errorContainer },
});
