/**
 * Highlights: **Pinned | Announcements | Reports.**
 *
 * One implementation for club, race and Eboard chat - design-system rule 5. The scope reaches this
 * screen as a channel id and changes nothing, which is the client half of the channel abstraction.
 *
 * Three things worth knowing:
 *
 *  - **Both lists are queried over the whole channel**, not over the loaded page. v1 computed them
 *    from a bounded slice of history, so a pin older than what chat had loaded silently vanished
 *    from the list whose entire job is to keep it findable.
 *  - **A DM has no Reports tab**, because there is no admin of the conversation to read it. A DM
 *    report goes to a platform moderator through a separate queue instead.
 *  - **Pinned and announcement rows are view-only.** Jumping to the message in chat is the pinned
 *    strip's job; this screen is the durable record. Only the avatar goes anywhere, to the person.
 *
 * It carries chat's glass header rather than the native one, because it hangs off chat and a
 * different header treatment one tap away reads as a different app.
 */

import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { MaterialIcons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { MessageEnvelope } from '@clubchat/shared';
import { channelApi } from '../../../../../src/api.ts';
import type { ReportRow } from '../../../../../src/api-types.ts';
import { formatClock } from '../../../../../src/dates.ts';
import { color, radius, space, type } from '../../../../../src/theme.ts';
import { useGoBack } from '../../../../../src/nav.tsx';
import { Avatar, DataScreen, EmptyState, Tabs } from '../../../../../src/ui.tsx';
import { useLoad } from '../../../../../src/use-load.ts';

type Tab = 'pinned' | 'announcements' | 'reports';

/** Matches chat's, so the two headers are the same object as far as the eye is concerned. */
const HEADER_HEIGHT = 76;

export default function HighlightsScreen() {
  const { channelId } = useLocalSearchParams<{ channelId: string }>();
  const [tab, setTab] = useState<Tab>('pinned');
  const router = useRouter();
  const insets = useSafeAreaInsets();
  // Highlights is a view over a conversation, so back always returns to that chat.
  const goBack = useGoBack(`/chat/${channelId}`);

  const meta = useLoad(() => channelApi.meta(channelId), [channelId]);
  const isDm = meta.data?.scope === 'dm';
  /*
   * Offered only to somebody who can actually read them, which the server answers. A DM has no
   * Reports tab at all - there is no admin of the conversation to read one, and a DM report goes to
   * a platform moderator through a separate queue.
   */
  const showReports = isDm === false && meta.data?.canReadReports === true;

  const pinned = useLoad(() => channelApi.pinned(channelId), [channelId]);
  const announcements = useLoad(() => channelApi.announcements(channelId), [channelId]);
  const reports = useLoad(
    () => (showReports ? channelApi.reports(channelId) : Promise.resolve({ reports: [] })),
    [channelId, showReports],
  );

  const tabs: Array<{ key: Tab; label: string }> = [
    { key: 'pinned', label: 'Pinned' },
    { key: 'announcements', label: 'Announcements' },
    // Absent rather than empty for anybody who cannot read them: a DM has nobody it could be
    // for, and a plain club member is not the audience.
    ...(showReports ? [{ key: 'reports' as Tab, label: 'Reports' }] : []),
  ];

  return (
    <View style={styles.flex}>
      {/*
        The back control ALWAYS renders and always has an explicit target: a control that only
        appears when history exists is a bug, because direct URL entry and page refresh leave no
        history on any screen.
      */}
      <BlurView
        intensity={80}
        tint="light"
        style={[
          styles.header,
          { paddingTop: insets.top + space.md, height: HEADER_HEIGHT + insets.top },
        ]}
      >
        <Pressable
          onPress={goBack}
          accessibilityRole="button"
          accessibilityLabel="Back to the conversation"
          hitSlop={space.sm}
          style={styles.backButton}
        >
          <MaterialIcons name="arrow-back" size={20} color={color.textPrimary} />
        </Pressable>
        <View>
          <Text style={styles.headerTitle}>ClubChat</Text>
          {/*
            The channel's name arrives a moment after the screen, so the subtitle fills in rather
            than showing "Highlights" and replacing it with "Track Club · Highlights". Same rule as
            chat's header: never render a word that is about to be swapped.
          */}
          <Text style={styles.headerSubtitle}>
            {meta.data === null ? '' : `${meta.data.name} · Highlights`}
          </Text>
        </View>
      </BlurView>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingTop: HEADER_HEIGHT + insets.top + space.sm },
        ]}
      >
        <Tabs tabs={tabs} active={tab} onChange={setTab} variant="pill" />

        {tab === 'pinned' && (
          <DataScreen
            load={pinned}
            isEmpty={(data) => data.messages.length === 0}
            empty={<EmptyState title="Nothing pinned" body="Admins pin a message for reference." />}
          >
            {(data) => (
              <View style={styles.list}>
                {data.messages.map((message) => (
                  <HighlightRow key={message.seq} message={message} pinned />
                ))}
              </View>
            )}
          </DataScreen>
        )}

        {tab === 'announcements' && (
          <DataScreen
            load={announcements}
            isEmpty={(data) => data.messages.length === 0}
            empty={
              <EmptyState
                title="No announcements"
                body="An announcement notifies everybody in this chat."
              />
            }
          >
            {(data) => (
              <View style={styles.list}>
                {data.messages.map((message) => (
                  <HighlightRow key={message.seq} message={message} pinned={false} />
                ))}
              </View>
            )}
          </DataScreen>
        )}

        {tab === 'reports' && (
          <DataScreen
            load={reports}
            isEmpty={(data) => data.reports.length === 0}
            empty={
              <EmptyState title="No reports" body="Reported messages appear here for admins only." />
            }
          >
            {(data) => (
              <View style={styles.list}>
                {data.reports.map((report) => (
                  <ReportCard
                    key={report.reportId}
                    report={report}
                    channelId={channelId}
                    onResolved={reports.reload}
                  />
                ))}
              </View>
            )}
          </DataScreen>
        )}
      </ScrollView>
    </View>
  );
}

/**
 * One pinned or announced message.
 *
 * View-only by deliberate choice: only the avatar navigates, to the sender's profile. Jumping to
 * the message in chat belongs to the pinned strip, which is the surface for "take me there"; this
 * one is the record of what was said.
 */
function HighlightRow({ message, pinned }: { message: MessageEnvelope; pinned: boolean }) {
  const router = useRouter();
  const name = message.senderName ?? 'Deleted member';

  return (
    <View style={styles.row}>
      <Pressable
        onPress={() => router.push(`/users/${message.senderId}`)}
        accessibilityRole="button"
        accessibilityLabel={`Open ${name}'s profile`}
        hitSlop={space.xs}
      >
        <Avatar name={name} size={36} />
      </Pressable>
      <View style={styles.rowBody}>
        <View style={styles.rowHead}>
          <Text style={styles.sender}>{name}</Text>
          {pinned && <MaterialIcons name="push-pin" size={12} color={color.accent} />}
          <Text style={styles.time}>{formatClock(message.createdAt)}</Text>
        </View>
        <Text style={message.deletedAt !== null ? styles.deleted : styles.body}>
          {message.deletedAt !== null
            ? 'This message was deleted'
            : (message.body ?? preview(message))}
        </Text>
      </View>
    </View>
  );
}

/** A stand-in line for a message whose content is not text. Never a blank row. */
function preview(message: MessageEnvelope): string {
  if (message.type === 'photo') return 'Photo';
  if (message.type === 'document') return message.documentName ?? 'Document';
  return '(no text)';
}

/**
 * A reported message, and the two ways to resolve it.
 *
 * **Deleting also dismisses.** They are separate server actions on purpose - one says "this is
 * fine", the other says "this had to go" - but deleting without dismissing leaves the report in
 * the queue pointing at a tombstone, with nothing left to decide.
 */
function ReportCard({
  report,
  channelId,
  onResolved,
}: {
  report: ReportRow;
  channelId: string;
  onResolved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const deleted = report.message === null;

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
    } finally {
      setBusy(false);
      setConfirming(false);
      onResolved();
    }
  };

  return (
    <View style={styles.row}>
      <Avatar name={report.message?.senderName ?? '?'} size={36} />
      <View style={styles.rowBody}>
        <View style={styles.rowHead}>
          <Text style={styles.sender}>{report.message?.senderName ?? 'Unknown sender'}</Text>
          <Text style={styles.reportedBy}>reported by {report.reporterName}</Text>
          <Text style={styles.time}>{formatClock(report.createdAt)}</Text>
        </View>
        <Text style={deleted ? styles.deleted : styles.body}>
          {report.message?.body ?? 'This message was deleted'}
        </Text>

        {report.dismissedAt !== null ? (
          <Text style={styles.time}>Dismissed</Text>
        ) : confirming ? (
          <View style={styles.reportActions}>
            <Text style={styles.confirm}>
              Delete this message? It cannot be brought back, and the report is cleared with it.
            </Text>
            <View style={styles.reportActions}>
              <Pressable
                onPress={() => setConfirming(false)}
                accessibilityRole="button"
                accessibilityLabel="Keep the message"
              >
                <Text style={styles.dismissAction}>Keep</Text>
              </Pressable>
              <Pressable
                disabled={busy}
                onPress={() =>
                  void run(async () => {
                    await channelApi.deleteMessage(channelId, report.seq);
                    await channelApi.dismissReport(report.reportId);
                  })
                }
                accessibilityRole="button"
                accessibilityLabel="Confirm delete"
              >
                <Text style={styles.deleteAction}>Delete</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <View style={styles.reportActions}>
            {!deleted && (
              <Pressable
                disabled={busy}
                onPress={() => setConfirming(true)}
                accessibilityRole="button"
                accessibilityLabel="Delete the reported message"
              >
                <Text style={styles.deleteAction}>Delete message</Text>
              </Pressable>
            )}
            <Pressable
              disabled={busy}
              onPress={() => void run(() => channelApi.dismissReport(report.reportId))}
              accessibilityRole="button"
              accessibilityLabel="Dismiss this report"
            >
              <Text style={styles.dismissAction}>Dismiss</Text>
            </Pressable>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: color.appBackground },

  header: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 50,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingBottom: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: color.divider,
    // react-native-web renders BlurView as a plain View, so the chrome tint has to be real.
    backgroundColor: color.chrome,
  },
  backButton: {
    width: 36,
    height: 36,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.cardSunken,
  },
  headerTitle: {
    ...type.headerTitle,
    fontSize: 22,
    color: color.accent,
    textTransform: 'uppercase',
    fontStyle: 'italic',
    letterSpacing: -0.5,
  },
  headerSubtitle: { ...type.label, fontSize: 9, color: color.textSecondary, marginTop: 2 },

  scroll: { flex: 1 },
  scrollContent: { padding: space.md, gap: space.sm, paddingBottom: space.xl },
  list: { gap: space.sm, paddingTop: space.sm },

  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm + 2,
    backgroundColor: color.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.hairline,
    padding: space.md,
  },
  rowBody: { flex: 1, gap: space.xs },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: space.xs + 2 },
  sender: { ...type.headline, fontSize: 14, color: color.textPrimary },
  reportedBy: { ...type.label, color: color.error, textTransform: 'none' },
  time: { ...type.label, color: color.textSecondary, marginLeft: 'auto', textTransform: 'none' },
  body: { ...type.body, color: color.textPrimary },
  deleted: { ...type.body, color: color.textSecondary, fontStyle: 'italic' },

  reportActions: { flexDirection: 'row', alignItems: 'center', gap: space.md, flexWrap: 'wrap' },
  confirm: { ...type.bodySmall, color: color.textPrimary, flex: 1 },
  deleteAction: { ...type.label, color: color.error, textTransform: 'none' },
  dismissAction: { ...type.label, color: color.textSecondary, textTransform: 'none' },
});
