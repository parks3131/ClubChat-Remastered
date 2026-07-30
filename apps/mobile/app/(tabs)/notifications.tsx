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
 */

import { useEffect } from 'react';
import { FlatList, RefreshControl, StyleSheet, View } from 'react-native';
import { Redirect } from 'expo-router';
import type { NotificationTarget } from '@clubchat/shared';
import { inboxApi } from '../../src/api.ts';
import type { InboxRow } from '../../src/api-types.ts';
import { useSession } from '../../src/chat-provider.tsx';
import { color, space } from '../../src/theme.ts';
import { Badge, DataScreen, EmptyState, Row } from '../../src/ui.tsx';
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

export default function NotificationsScreen() {
  const { authState, revision } = useSession();
  const load = useLoad(() => inboxApi.page(), [revision]);

  /*
   * Mark the inbox read on open.
   *
   * Deliberately fire-and-forget and deliberately NOT reloading afterwards: the server clears the
   * badge and leaves the chat-unread and pending-request rows alone, so re-reading would only
   * repaint identical content. A failure here is invisible on purpose - the badge is an
   * enhancement, and the rows below are the real information.
   */
  useEffect(() => {
    if (authState !== 'signed-in') return;
    void inboxApi.markRead().catch(() => undefined);
  }, [authState]);

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
    return (
      <Row
        title={row.channelName}
        subtitle={`${row.count} unread`}
        {...(href ? { href } : {})}
        accessibilityLabel={`${row.channelName}, ${row.count} unread. Open`}
        right={<Badge label={String(row.count)} tone="alert" />}
      />
    );
  }

  return (
    <Row
      title={row.title}
      subtitle={row.body}
      {...(href ? { href } : {})}
      accessibilityLabel={href ? `${row.title}. Open` : row.title}
      right={
        <>
          {/* A decided request stays in the feed, tagged - history rather than a pending action. */}
          {row.decision !== undefined && (
            <Badge label={row.decision === 'approved' ? 'Approved' : 'Denied'} tone="muted" />
          )}
          {!row.read && <Badge label="New" tone="accent" />}
        </>
      }
    />
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: color.appBackground },
  list: { padding: space.md, gap: space.sm },
});
