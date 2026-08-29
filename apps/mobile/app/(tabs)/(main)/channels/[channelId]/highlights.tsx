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
 *  - **A pinned CARD row opens its poll, event or meeting, and a pinned PHOTO opens the photo.**
 *    Every other row is view-only. This read "jumping to the message in chat is the pinned
 *    strip's job" until 2026-08-11, which was true while the strip jumped into the conversation
 *    and stopped being true when it started opening the object instead. The strip is capped at
 *    four and this list is not, so a fifth pinned poll is reachable from here and nowhere else.
 *    Ordinary messages still go nowhere, because this screen is where the strip sends them - it
 *    is the destination, not a waypoint. The avatar goes to the person, as it always did.
 *  - **The photo opens OVER this list rather than navigating anywhere**, which is the difference
 *    between it and a card. A card is a reference to something with a screen of its own; a
 *    photograph has no screen to go to, and a list this long should not lose its place to show
 *    you one picture. Nothing here jumps back into the conversation, which stays true: the
 *    viewer's menu offers it as a deliberate second step, exactly as the gallery's does.
 *
 * It carries chat's glass header rather than the native one, because it hangs off chat and a
 * different header treatment one tap away reads as a different app.
 */

import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { MaterialIcons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { MessageEnvelope } from '@clubchat/shared';
import { channelApi } from '../../../../../src/api.ts';
import type { ReportRow } from '../../../../../src/api-types.ts';
import { useSession } from '../../../../../src/chat-provider.tsx';
import { formatClock } from '../../../../../src/dates.ts';
import { highlightAction } from '../../../../../src/highlight-action.ts';
import { RemoteImage } from '../../../../../src/media-bubble.tsx';
import { openDocument } from '../../../../../src/open-document.ts';
import { PhotoViewer } from '../../../../../src/photo-viewer.tsx';
import { color, radius, space, type } from '../../../../../src/theme.ts';
import { useGoBack } from '../../../../../src/nav.tsx';
import { Avatar, DataScreen, EmptyState, Tabs } from '../../../../../src/ui.tsx';
import { useLoad } from '../../../../../src/use-load.ts';
import { useNotice } from '../../../../../src/use-notice.ts';

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
  /**
   * The pinned photograph being looked at full screen, or null.
   *
   * The whole envelope rather than the media id, for chat's reason: the viewer's header draws the
   * sender and the date, and Show in chat and Report both need the `seq`.
   *
   * Held here rather than inside the row so the viewer renders as a SIBLING of the list, over the
   * top of it. Returning it in place of the screen - as the gallery does - would unmount the
   * `ScrollView` and lose the scroll position, which matters far more here: the gallery grid is
   * one list, and this is the third tab of a screen whose Pinned list has no cap on its length.
   */
  const [viewingPhoto, setViewingPhoto] = useState<MessageEnvelope | null>(null);
  /**
   * The document being staged, by `seq`, or null.
   *
   * A `seq` rather than a boolean, because the spinner belongs on the tile that was tapped. A
   * screen-wide busy flag would put one on every document in the list, which says the app is
   * working on all of them.
   */
  const [openingSeq, setOpeningSeq] = useState<number | null>(null);
  /** Kept out of state: a second tap while the first download runs must not start a second one. */
  const openingDocument = useRef(false);
  /** What the last action said back. Clears itself; see `useNotice`. */
  const [notice, setNotice] = useNotice();
  const router = useRouter();
  const { userId } = useSession();
  const insets = useSafeAreaInsets();

  /**
   * Open a pinned document.
   *
   * The staging, the preview and the web download all live in `openDocument`, which chat already
   * calls - so this is the second caller of one implementation rather than a second copy of it.
   * That matters more here than it looks: the rule about iOS reading a file's type from its
   * extension is subtle enough that a reimplementation would get it wrong and produce a file that
   * opens as nothing.
   */
  const openDocumentMessage = async (message: MessageEnvelope) => {
    if (message.mediaId === null || openingDocument.current) return;
    openingDocument.current = true;
    setOpeningSeq(message.seq);
    try {
      const said = await openDocument(message.mediaId, message.documentName);
      if (said.length > 0) setNotice(said);
    } catch {
      // Losing access to the conversation is a legitimate reason for this to fail, so it is not
      // necessarily an error - but somebody tapped a file and is waiting, so it is never silent.
      setNotice('That document could not be opened. Try again.');
    } finally {
      openingDocument.current = false;
      setOpeningSeq(null);
    }
  };
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

        {/*
          The one thing a tile cannot say: a refusal, or a failure. The wait itself is reported on
          the tapped tile instead, which is chat's rule for the same action.
        */}
        {notice !== null && (
          <Text style={styles.notice} accessibilityLiveRegion="polite">
            {notice}
          </Text>
        )}

        {tab === 'pinned' && (
          <DataScreen
            load={pinned}
            isEmpty={(data) => data.messages.length === 0}
            empty={<EmptyState title="Nothing pinned" body="Admins pin a message for reference." />}
          >
            {(data) => (
              <View style={styles.list}>
                {data.messages.map((message) => (
                  <HighlightRow
                    key={message.seq}
                    message={message}
                    pinned
                    opening={openingSeq === message.seq}
                    onOpenPhoto={setViewingPhoto}
                    onOpenDocument={(m) => void openDocumentMessage(m)}
                  />
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
                  <HighlightRow
                    key={message.seq}
                    message={message}
                    pinned={false}
                    opening={openingSeq === message.seq}
                    onOpenPhoto={setViewingPhoto}
                    onOpenDocument={(m) => void openDocumentMessage(m)}
                  />
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

      {/*
        The full-screen photograph, drawn over the list rather than in place of it.

        A sibling of the header and the scroller, and it covers both: `PhotoViewer` is absolutely
        positioned at `zIndex: 200` against the glass header's 50, so paint order is decided by
        the tokens rather than by where this sits in the tree.

        **The same viewer chat and the gallery use, and the only thing that differs is the first
        item in its menu** - `Reply` from chat, `Show in chat` from both surfaces that have lifted
        the photograph out of the conversation it was said in. A second treatment for a full-screen
        picture is what `DESIGN` rule 5 exists to prevent, and it would be the copy that drifts.

        The `mediaId !== null` half of the guard is what narrows `string | null` to the `string`
        the viewer demands. `highlightAction` has already refused a null one, so this cannot fail
        in practice - it is the type system being told what the rule already guarantees.
      */}
      {viewingPhoto !== null && viewingPhoto.mediaId !== null && (
        <PhotoViewer
          /*
            **A list of one, so this viewer does not swipe, and that is the decision rather than
            an oversight.** The pinned strip is a mix of photographs, documents and text: paging
            through it would have to either skip the things that are not pictures or stop dead at
            them, and both are worse than the tap that already works. The gallery is where a run
            of photographs lives, and it is one tap away.
          */
          photos={[
            {
              mediaId: viewingPhoto.mediaId,
              seq: viewingPhoto.seq,
              senderId: viewingPhoto.senderId,
              senderName: viewingPhoto.senderName,
              senderImage: viewingPhoto.senderImage,
              createdAt: viewingPhoto.createdAt,
            },
          ]}
          initialIndex={0}
          /*
            "Show in chat" rather than "Reply", matching the gallery: a pin has been lifted out of
            the conversation it was said in, and what was being talked about is the question
            somebody actually has here. It is a menu item and not the row's tap, which is what
            keeps `PRD/05`'s "nothing jumps back into the conversation from this list" true.
          */
          contextAction={(photo) => ({
            label: 'Show in chat',
            icon: 'chat-bubble-outline',
            onPress: () => router.push(`/chat/${channelId}?around=${photo.seq}`),
          })}
          /*
            The two conditions are the server's answer and "not your own photo", exactly as in
            chat and the gallery. `canReport` is false for the whole Eboard scope, where reporting
            does not exist - never derived from the scope here, so this screen cannot drift from
            the policy module.
          */
          report={(photo) =>
            photo.senderId !== userId && meta.data?.canReport === true
              ? {
                  body: isDm
                    ? 'This photo goes to ClubChat moderators, who can read the messages around it. The other person is not told.'
                    : 'This photo goes to the admins of this space, who can read the messages around it. The sender is not told.',
                  run: async () => {
                    const result = await channelApi.report(channelId, photo.seq);
                    return result.alreadyReported
                      ? 'You already reported this photo.'
                      : 'Reported. The sender is not told.';
                  },
                }
              : null
          }
          onClose={() => setViewingPhoto(null)}
        />
      )}
    </View>
  );
}

/**
 * One pinned or announced message.
 *
 * Text rows stay view-only. A CARD row opens the thing it stands for, and a PHOTO row opens the
 * photograph itself, full screen, over this list.
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
 * > **That argument was written about cards and applies harder to a photograph, which is why the
 * > photo case was added on 2026-08-29.** A poll card at least NAMES a poll somebody could go and
 * > find. A row reading "Photo" names nothing: it is the one pin whose content is the thing
 * > pinned, and it was drawn as four inert letters while `mediaId` sat unread on the envelope.
 *
 * An ordinary pinned message still goes nowhere, and that is not an omission: Highlights is where
 * the strip sends it, so this screen IS its destination. There is nothing further to open.
 *
 * **Two sibling pressables inside a `View`, never one wrapping the other.** A pressable containing
 * a pressable is failure mode 17, it swallows the outer gesture on native, and it has shipped in
 * this repo once already. The thumbnail added with the photo case is deliberately NOT pressable
 * for that reason - it sits inside the body pressable and the whole row takes the tap, which is
 * also the bigger target.
 */
function HighlightRow({
  message,
  pinned,
  opening,
  onOpenPhoto,
  onOpenDocument,
}: {
  message: MessageEnvelope;
  pinned: boolean;
  /** This row's document is being staged. At most one row is ever true. */
  opening: boolean;
  /** Handed the whole envelope, because the viewer's header and its menu both need more than an id. */
  onOpenPhoto: (message: MessageEnvelope) => void;
  onOpenDocument: (message: MessageEnvelope) => void;
}) {
  const router = useRouter();
  const name = message.senderName ?? 'Deleted member';
  // One rule, shared with the pinned strip in chat. It refuses a tombstone itself.
  const action = highlightAction(message);

  const body = (
    <>
      {/*
        **The head spans the whole card, so the clock lands on the same edge in every row.**

        > It did not, briefly. The thumbnail was added as a sibling of this block on 2026-08-29,
        > which shortened it - so a photo row's time sat a thumbnail's width to the left of every
        > other row's, and a column that had been straight was suddenly ragged by one row in
        > three. Reported off the phone the same day with the misalignment drawn on it.

        The attachment moved down into the body line instead. Nothing here is allowed to shorten
        this row again: whatever a pin turns out to carry, the clock keeps the edge.
      */}
      <View style={styles.rowHead}>
        <Text style={styles.sender}>{name}</Text>
        {pinned && <MaterialIcons name="push-pin" size={12} color={color.accent} />}
        <Text style={styles.time}>{formatClock(message.createdAt)}</Text>
      </View>

      <View style={styles.rowBottom}>
        <Text style={message.deletedAt !== null ? styles.deleted : styles.body}>
          {message.deletedAt !== null
            ? 'This message was deleted'
            : (message.body ?? preview(message))}
        </Text>
        {/*
          What the pin is carrying, under its own clock rather than beside it.

          Keyed off `action` rather than off `message.type`, so the row can never show an
          attachment it would refuse to open: a pin whose upload never finished has no `mediaId`,
          and the one check answers both questions at once.
        */}
        {action?.kind === 'photo' && (
          <RemoteImage
            mediaId={action.mediaId}
            variant="thumb"
            style={styles.tile}
            resizeMode="cover"
          />
        )}
        {action?.kind === 'document' && (
          <View style={styles.tile}>
            {/*
              A spinner where the icon was, because staging a file is a download and the person
              who tapped it is waiting. Chat answers on the tapped tile for the same reason: a
              banner at the top of a list is not the thing you touched replying to you.
            */}
            {opening ? (
              <ActivityIndicator color={color.accent} />
            ) : (
              <MaterialIcons name="description" size={22} color={color.textSecondary} />
            )}
          </View>
        )}
      </View>
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
      {action === null ? (
        <View style={styles.rowBody}>{body}</View>
      ) : (
        /*
          Pressable only when there is somewhere to go. A row that takes a highlight under the
          finger and then does nothing reads as a fault rather than as a design decision, which
          is the same reasoning that gave the Chats rows their wash.
        */
        <Pressable
          style={({ pressed }) => [styles.rowBody, pressed && styles.rowBodyPressed]}
          onPress={() => {
            if (action.kind === 'photo') return onOpenPhoto(message);
            if (action.kind === 'document') return onOpenDocument(message);
            return router.push(action.href);
          }}
          accessibilityRole="button"
          accessibilityLabel={
            action.kind === 'photo'
              ? `Open this photo from ${name}, full screen`
              : action.kind === 'document'
                ? `Open ${action.name ?? 'this document'}`
                : `Open the pinned ${message.type}`
          }
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
   * The body line: the words, and whatever the pin is carrying, at the trailing edge.
   *
   * **`flex-start`, so the words begin at the same height in every row.** Centre or `flex-end`
   * both let the 44pt tile push a one-line body down, and a Pinned list mixing kinds then reads
   * as though the text rows and the attachment rows were set differently - which is the same
   * complaint, one axis over, as the clock that started this. The tile hangs below the line
   * instead; it is the thing that varies, so it is the thing that should move.
   */
  rowBottom: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  /*
   * Square, at the 44pt an iOS touch target is - small enough to stay a label for the row rather
   * than becoming the row's content, which is the gallery's job and not this list's.
   *
   * The sunken fill is what `RemoteImage` draws its spinner and its "Photo unavailable" against.
   * That fill is the load-bearing part: the box is reserved at its final size before any bytes
   * arrive, so the row does not reflow when they land. A photo bubble in the conversation had
   * exactly that defect on 2026-08-27, waiting in a hardcoded square and then arriving portrait.
   */
  tile: {
    width: 44,
    height: 44,
    borderRadius: radius.sm,
    backgroundColor: color.cardSunken,
    alignItems: 'center',
    justifyContent: 'center',
  },
  notice: { ...type.bodySmall, color: color.textSecondary, textAlign: 'center', marginTop: space.sm },
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
  body: { ...type.body, color: color.textPrimary, flex: 1 },
  deleted: { ...type.body, color: color.textSecondary, fontStyle: 'italic', flex: 1 },

  reportActions: { flexDirection: 'row', alignItems: 'center', gap: space.md, flexWrap: 'wrap' },
  confirm: { ...type.bodySmall, color: color.textPrimary, flex: 1 },
  deleteAction: { ...type.label, color: color.error, textTransform: 'none' },
  dismissAction: { ...type.label, color: color.textSecondary, textTransform: 'none' },
});
