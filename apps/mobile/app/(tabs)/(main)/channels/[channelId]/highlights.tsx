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
 *  - **A pinned CARD row opens its poll, event or meeting; every other row is view-only.** This
 *    read "jumping to the message in chat is the pinned strip's job" until 2026-08-11, which was
 *    true while the strip jumped into the conversation and stopped being true when it started
 *    opening the object instead. The strip is capped at four and this list is not, so a fifth
 *    pinned poll is reachable from here and nowhere else. Ordinary messages still go nowhere,
 *    because this screen is where the strip sends them - it is the destination, not a waypoint.
 *    The avatar goes to the person, as it always did.
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
import { hrefForCard } from '../../../../../src/notification-href.ts';
import { Avatar, DataScreen, EmptyState, Tabs } from '../../../../../src/ui.tsx';
import { useLoad } from '../../../../../src/use-load.ts';

type Tab = 'pinned' | 'announcements' | 'reports';

/** Matches chat's, so the two headers are the same object as far as the eye is concerned. */
const HEADER_HEIGHT = 76;

export default function HighlightsScreen() {
  const { channelId, tab: requestedTab } = useLocalSearchParams<{
    channelId: string;
    /** Which tab to open on. Sent by a `message_reported` notification, which means Reports. */
    tab?: string;
  }>();
  /*
   * The requested tab is the INITIAL value only, never a controlled one.
   *
   * A reviewer arriving from a report notification should land on Reports; from then on the tab
   * is theirs. Reading the parameter on every render would fight them the moment they tapped
   * Pinned, and a parameter that keeps reasserting itself is the kind of thing that reads as the
   * screen ignoring you.
   */
  const [tab, setTab] = useState<Tab>(requestedTab === 'reports' ? 'reports' : 'pinned');
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
          <MaterialIcons name="arrow-back" size={22} color={color.accent} />
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
                    key={report.messageId}
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
 * Text rows stay view-only, and a CARD row opens the thing it stands for.
 *
 * > **The old rule here was "jumping to the message in chat is the pinned strip's job".** That was
 * > written when the strip jumped into the conversation. It no longer does - it opens the poll,
 * > event or meeting a pinned card announces - so the sentence stopped being true and this screen
 * > was the half that did not move.
 *
 * Consistency is the weaker half of the argument. The stronger one: **the strip is capped at four
 * and this list is not**, so a fifth pinned poll is reachable from here and nowhere else. Leaving
 * the row inert did not make it a record, it made it the only surface that could show somebody a
 * poll while giving them no way to reach it.
 *
 * An ordinary pinned message still goes nowhere, and that is not an omission: Highlights is where
 * the strip sends it, so this screen IS its destination. There is nothing further to open.
 *
 * **Two sibling pressables inside a `View`, never one wrapping the other.** A pressable containing
 * a pressable is failure mode 17, it swallows the outer gesture on native, and it has shipped in
 * this repo once already.
 */
function HighlightRow({ message, pinned }: { message: MessageEnvelope; pinned: boolean }) {
  const router = useRouter();
  const name = message.senderName ?? 'Deleted member';
  // A tombstone links nowhere even if the row still remembers what it once pointed at.
  const card = message.deletedAt === null ? hrefForCard(message) : null;

  const body = (
    <>
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
    </>
  );

  return (
    <View style={styles.row}>
      <Pressable
        onPress={() => router.push(`/users/${message.senderId}`)}
        accessibilityRole="button"
        accessibilityLabel={`Open ${name}'s profile`}
        hitSlop={space.xs}
      >
        <Avatar name={name} image={message.senderImage} size={36} />
      </Pressable>
      {card === null ? (
        <View style={styles.rowBody}>{body}</View>
      ) : (
        /*
          Pressable only when there is somewhere to go. A row that takes a highlight under the
          finger and then does nothing reads as a fault rather than as a design decision, which
          is the same reasoning that gave the Chats rows their wash.
        */
        <Pressable
          style={({ pressed }) => [styles.rowBody, pressed && styles.rowBodyPressed]}
          onPress={() => router.push(card)}
          accessibilityRole="button"
          accessibilityLabel={`Open the pinned ${message.type}`}
        >
          {body}
        </Pressable>
      )}
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
 * Who reported it, named rather than counted.
 *
 * Reports are grouped by message, so a row can carry several - and an admin deciding what to do
 * about a message wants to know it was three different people rather than one person three times,
 * which a bare count cannot say. Names the first two, then counts the rest.
 */
function describeReporters(reporters: ReportRow['reporters']): string {
  const names = reporters.map((r) => r.name);
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]!} and ${names[1]!}`;
  return `${names[0]!}, ${names[1]!} and ${names.length - 2} more`;
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
  // The message's own deletion, not "the payload had no body" - a reported photo has no body
  // either, and calling that deleted told an admin the job was already done.
  const deleted = report.deletedAt !== null;
  const reportedBy = describeReporters(report.reporters);

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
      <Avatar name={report.senderName} image={report.senderImage} size={36} />
      <View style={styles.rowBody}>
        <View style={styles.rowHead}>
          <Text style={styles.sender}>{report.senderName}</Text>
          <Text style={styles.reportedBy}>reported by {reportedBy}</Text>
          {/* The first report is when this landed in the queue. `reporters` is never empty. */}
          <Text style={styles.time}>{formatClock(report.reporters[0]!.createdAt)}</Text>
        </View>
        <Text style={deleted || report.body === null ? styles.deleted : styles.body}>
          {deleted ? 'This message was deleted' : (report.body ?? 'No text')}
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
                    await channelApi.dismissReport(report.messageId);
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
              onPress={() => void run(() => channelApi.dismissReport(report.messageId))}
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
  /*
   * Matched to chat's, which is itself matched to the capsule iOS draws on every native header.
   *
   * Changed in the same commit as chat's for the reason this screen carries chat's header at all:
   * it hangs one tap off chat, and a back control that differed between them would be the exact
   * "reads as a different app" this header was copied to avoid. See DESIGN/04.
   */
  backButton: {
    width: 48,
    height: 40,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.card,
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
  /*
   * Only a card row is pressable, so this is the one place the wash appears.
   *
   * A background tint rather than `opacity`, matching the Chats rows: dimming a row under the
   * finger reads as it becoming disabled, which is the opposite of what a press means. It also
   * needs the row's own padding so the tint reaches the edges - a highlight inset inside the
   * gutter leaves an untinted stripe and reads as a rendering fault.
   */
  rowBodyPressed: {
    backgroundColor: color.cardRaised,
    borderRadius: radius.sm,
    marginHorizontal: -space.xs,
    paddingHorizontal: space.xs,
  },
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
