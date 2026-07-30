import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import {
  reactionEmoji,
  reactionSummary,
  SYSTEM_ACTOR_ID,
  type MessageEnvelope,
  type ReactionEmoji,
} from '@clubchat/shared';
import { useSession } from '../../src/chat-provider.tsx';
import { channelApi, dmApi, type ChannelMeta } from '../../src/api.ts';
import { DocumentBubble, PhotoBubble } from '../../src/media-bubble.tsx';
import {
  pickDocument,
  pickPhoto,
  takePhoto,
  uploadAttachment,
  UploadError,
  type PickedAttachment,
  type UploadKind,
} from '../../src/upload.ts';
import { QuickNav } from '../../src/nav.tsx';
import { color, radius, space, type } from '../../src/theme.ts';

type Row =
  | { kind: 'message'; message: MessageEnvelope }
  /** An optimistic row from the send outbox, not yet acked. */
  | {
      kind: 'pending';
      clientMsgId: string;
      body: string;
      failed: boolean;
      type: 'text' | 'photo' | 'document';
      /** Renders the photo the sender just picked, before any round trip. */
      localUri?: string | undefined;
      documentName?: string | undefined;
      documentSize?: number | undefined;
    };

/** What the disabled composer says, per reason. */
const DENIED_TEXT: Record<NonNullable<ChannelMeta['postDeniedReason']>, string> = {
  // Reports the viewer's own action back to them, and offers the way out.
  you_blocked_them: 'You blocked this person. Unblock them to send messages.',
  /*
   * Deliberately does not say which of "they blocked you" and "you no longer share a club"
   * happened. PRD/14 requires the composer to state a reason while keeping a block quiet to
   * the blocked party, and both hold only if the reason does not identify the cause.
   */
  unavailable: 'You can no longer send messages in this conversation.',
};


/**
 * The header quick-nav entries for a group scope.
 *
 * `PRD/15` gives club chat "Members · Poll · Routines · Events" and race chat "Members · Meet
 * Information · Polls · Car Assignments and Groups", and Eboard chat "Members · Meetings · Polls".
 * Built from the channel's scope rather than forked per scope: one list function, three answers.
 *
 * Every target is addressed by the SCOPE id, which is why the channel meta carries it.
 */
function scopeLinks(
  scope: 'club' | 'race' | 'eboard',
  meta: { scopeId: string; clubId: string | null },
): Array<{ href: string; label: string }> {
  if (scope === 'club') {
    return [
      { href: `/clubs/${meta.scopeId}/members`, label: 'Members' },
      { href: `/clubs/${meta.scopeId}/polls`, label: 'Polls' },
      { href: `/clubs/${meta.scopeId}/routines`, label: 'Routines' },
      { href: `/clubs/${meta.scopeId}/events`, label: 'Events' },
    ];
  }
  if (scope === 'race') {
    return [
      { href: `/races/${meta.scopeId}/roster`, label: 'Members' },
      { href: `/races/${meta.scopeId}/meet`, label: 'Meet Info' },
      { href: `/races/${meta.scopeId}/polls`, label: 'Polls' },
      { href: `/races/${meta.scopeId}/car-groups`, label: 'Car Groups' },
    ];
  }
  return [
    { href: `/eboard/${meta.scopeId}/members`, label: 'Members' },
    { href: `/eboard/${meta.scopeId}/meetings`, label: 'Meetings' },
    { href: `/eboard/${meta.scopeId}/polls`, label: 'Polls' },
  ];
}

export default function ChatScreen() {
  const { channelId, around } = useLocalSearchParams<{ channelId: string; around?: string }>();
  const { authState, client, userId, revision, offline } = useSession();
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [meta, setMeta] = useState<ChannelMeta | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  /**
   * The seq a long press selected.
   *
   * One sheet for both actions on a message, which is why a long press does not report
   * directly: reacting is the common case and reporting is the rare one, and a gesture that
   * did the rare thing immediately would be a trap.
   */
  const [selected, setSelected] = useState<number | null>(null);
  /** Set once Report is tapped, so the confirmation is a second deliberate step. */
  const [confirmingReport, setConfirmingReport] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  /** True while bytes are in flight, so the "+" cannot start a second upload. */
  const [uploading, setUploading] = useState(false);
  const listRef = useRef<FlatList<Row>>(null);
  /**
   * The message a jump landed on, if any.
   *
   * Held in state rather than read from the param on every render because it does two jobs: it
   * suppresses the scroll-to-end that chat otherwise does on every content change, and it marks
   * the row so the reader can see WHICH message they were sent to. Cleared once they scroll away,
   * which is what makes it a jump rather than a mode.
   */
  const [jumpedTo, setJumpedTo] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    if (!client || !channelId) return;
    const stored = await client.store.list(channelId);
    const pending: Row[] = [...client.outbox.values()]
      .filter((entry) => entry.channelId === channelId)
      .map((entry) => ({
        kind: 'pending' as const,
        clientMsgId: entry.clientMsgId,
        body: entry.body,
        failed: entry.status === 'failed',
        type: entry.type ?? 'text',
        localUri: entry.localUri,
        documentName: entry.documentName,
        documentSize: entry.documentSize,
      }));
    setRows([...stored.map((message) => ({ kind: 'message' as const, message })), ...pending]);
    setLoading(false);
  }, [client, channelId]);

  useEffect(() => {
    void refresh();
  }, [refresh, revision]);

  /**
   * Load the channel's title and whether the composer is live.
   *
   * One endpoint for all four scopes, so this screen stays a single implementation rather than
   * forking for DMs. A failure here is not fatal: history still renders from the local cache,
   * which is what makes the screen work in airplane mode.
   */
  const loadMeta = useCallback(async () => {
    if (!channelId) return;
    try {
      setMeta(await dmApi.meta(channelId));
    } catch {
      setMeta(null);
    }
  }, [channelId]);

  useEffect(() => {
    void loadMeta();
  }, [loadMeta, revision]);

  /**
   * Jump to a message named in the URL.
   *
   * > **This is what `GET /channels/:id/messages/around` exists for.** Highlights, a pinned-strip
   * > notice and a mention notification all name a specific `seq`, and paging backward from the tail
   * > until it appears cannot satisfy "jumps on the FIRST tap" - the message is not loaded yet, so a
   * > first tap could only start fetching.
   *
   * The window is written into the local store rather than held in this component, so it is cached
   * like every other page of history and a second jump to the same place needs no network at all.
   * Failing is survivable: the chat still renders its tail, which is the "realtime and paging are
   * enhancements" rule applied to navigation.
   */
  useEffect(() => {
    const target = Number(around);
    if (!client || !channelId || !Number.isInteger(target) || target <= 0) return;

    let alive = true;
    void (async () => {
      try {
        const window = await channelApi.around(channelId, target);
        if (!alive) return;
        await client.store.upsert(window.messages);
        await refresh();
      } catch {
        // Leave the tail on screen. A jump that cannot load is a worse outcome than a jump that
        // does not happen, and the notice below says which.
        if (alive) setNotice('Could not open that message.');
      } finally {
        if (alive) setJumpedTo(target);
      }
    })();
    return () => {
      alive = false;
    };
  }, [client, channelId, around, refresh]);

  /**
   * Scroll the jumped-to message into view.
   *
   * Separate from the fetch because it has to run after the rows render - the index does not exist
   * until the window is in `rows`. `viewPosition: 0.5` puts the target in the middle rather than at
   * the top, so the messages around it are visible, which is the whole reason a window was fetched
   * instead of one message.
   */
  useEffect(() => {
    if (jumpedTo === null) return;
    const index = rows.findIndex((row) => row.kind === 'message' && row.message.seq === jumpedTo);
    if (index < 0) return;
    listRef.current?.scrollToIndex({ index, viewPosition: 0.5, animated: false });
  }, [jumpedTo, rows]);

  // Opening a chat marks it read. That is the ONLY thing that clears its unread count -
  // nothing else does, including opening the notification inbox.
  useEffect(() => {
    if (!client || !channelId) return;
    const channel = client.channels.find((entry) => entry.id === channelId);
    if (channel && channel.lastSeq > 0) client.markRead(channelId, channel.lastSeq);
  }, [client, channelId, revision]);

  if (authState === 'checking') {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={color.accent} />
      </View>
    );
  }
  if (authState === 'signed-out') return <Redirect href="/sign-in" />;

  const canPost = meta === null ? true : meta.canPost;

  const send = async () => {
    const body = draft.trim();
    if (body.length === 0 || !client || !channelId || !canPost) return;
    setDraft('');
    try {
      await client.sendWithRetry(channelId, body);
    } catch {
      // The send failed VISIBLY: the entry stays in the outbox marked failed, and the
      // row below renders it with a retry affordance. It is never silently dropped.
    }
    await refresh();
  };

  /**
   * Toggle a reaction.
   *
   * Optimistic, and reconciled from the response rather than from a locally-guessed set: the
   * server returns the full resulting set, which is also what arrives over the socket for
   * everybody else. Two devices held by the same member therefore converge on the same answer
   * without either one having to have guessed right.
   */
  const react = async (seq: number, emoji: ReactionEmoji) => {
    if (!client || !channelId) return;
    try {
      const result = await dmApi.reactionToggle(channelId, seq, emoji);
      await client.store.patch(channelId, seq, { reactions: result.reactions });
    } catch {
      // A refusal here is a blocked DM participant or a deleted message. Say so rather than
      // leaving a pill that silently did not stick.
      setNotice('Could not react to that message.');
    }
    await refresh();
  };

  /**
   * Pick, upload, then send.
   *
   * The upload finishes BEFORE the message is enqueued, which is what makes the send safe to
   * retry from the outbox across a reconnect: the object is already durable and already
   * verified, so a retry re-sends an id rather than re-sending bytes.
   */
  const attach = async (pick: () => Promise<PickedAttachment | null>, kind: UploadKind) => {
    setAttachOpen(false);
    if (!client || !channelId || uploading) return;

    setUploading(true);
    try {
      const picked = await pick();
      // Dismissed. Not an error, and not worth a notice.
      if (!picked) return;

      const uploaded = await uploadAttachment(channelId, picked, kind);
      await client.sendWithRetry(channelId, '', {
        type: kind,
        mediaId: uploaded.mediaId,
        localUri: uploaded.localUri,
        ...(uploaded.name ? { documentName: uploaded.name } : {}),
        documentSize: uploaded.bytes,
      });
    } catch (error) {
      // PRD/05: an upload failure is surfaced and the message is NOT posted. Both halves
      // matter - a silent failure leaves the sender believing a photo arrived.
      setNotice(
        error instanceof UploadError
          ? error.message
          : 'The attachment could not be sent. Try again.',
      );
    } finally {
      setUploading(false);
      await refresh();
    }
  };

  const retry = async (clientMsgId: string) => {
    if (!client) return;
    try {
      await client.flushOne(clientMsgId);
    } catch {
      /* stays failed, still visible */
    }
    await refresh();
  };

  /**
   * The parent this screen falls back to.
   *
   * Always explicit and never this conversation's own hub: chat is the home screen of a race
   * and of an Eboard space, so a fallback pointing at the hub would bounce hub to chat to hub
   * forever on an entry with no history. A DM's parent is the message list.
   */
  const parent = meta?.scope === 'dm' ? '/dm' : '/clubs';
  const parentLabel = meta?.scope === 'dm' ? 'Messages' : 'Clubs';

  const act = async (run: () => Promise<unknown>, message: string) => {
    setMenuOpen(false);
    try {
      await run();
      setNotice(message);
      await loadMeta();
    } catch {
      setNotice('That did not work. Try again.');
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/*
        Chat's own header. The back control ALWAYS renders and always has an explicit
        target: a control that only appears when history exists is a bug, because direct
        URL entry and page refresh leave no history on any screen.
      */}
      <View style={styles.header}>
        <Pressable
          onPress={() => router.replace(parent)}
          accessibilityRole="button"
          accessibilityLabel={`Back to ${parentLabel}`}
          hitSlop={space.sm}
        >
          <Text style={styles.backLabel}>{parentLabel}</Text>
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {meta?.name ?? 'Chat'}
        </Text>
        <Pressable
          onPress={() => setMenuOpen((open) => !open)}
          accessibilityRole="button"
          accessibilityLabel="Conversation options"
          hitSlop={space.sm}
          style={styles.headerAction}
        >
          <Text style={styles.backLabel}>More</Text>
        </Pressable>
      </View>

      {/*
        The header quick-nav.
        
        `PRD/15` hangs everything else off chat's header, because chat is the home screen of a race
        and of an Eboard space - so Highlights, Members and the Gallery have no other entry point in
        those scopes. Built from the channel's own scope rather than forked per scope: a DM gets
        Gallery and the profile card and nothing club-shaped, which is the same list minus the
        entries that have no meaning there.
      */}
      {meta !== null && (
        <QuickNav
          items={[
            { href: `/channels/${channelId}/highlights`, label: 'Highlights' },
            { href: `/channels/${channelId}/gallery`, label: 'Gallery' },
            ...(meta.scope === 'dm'
              ? meta.peer !== null
                ? [{ href: `/users/${meta.peer.userId}`, label: 'Profile' }]
                : []
              : scopeLinks(meta.scope, meta)),
          ]}
        />
      )}

      {/*
        An in-app sheet rather than a platform Alert. A confirmation dialog can report success,
        log nothing and do nothing where a platform stubs out the dialog API - and react-native-web
        is exactly such a platform, which would make block and mute silently no-op on the surface
        this project develops on.
      */}
      {menuOpen && (
        <View style={styles.sheet}>
          <Pressable
            style={styles.sheetRow}
            onPress={() =>
              void act(
                () =>
                  meta?.muted
                    ? dmApi.unmute(channelId!)
                    : dmApi.mute(channelId!),
                meta?.muted ? 'Unmuted.' : 'Muted. You will still see unread counts.',
              )
            }
            accessibilityRole="button"
            accessibilityLabel={meta?.muted ? 'Unmute this conversation' : 'Mute this conversation'}
          >
            <Text style={styles.sheetLabel}>
              {meta?.muted ? 'Unmute conversation' : 'Mute conversation'}
            </Text>
            <Text style={styles.sheetHint}>
              {meta?.muted ? 'Notifications on again' : 'No notifications, unread still counts'}
            </Text>
          </Pressable>

          {meta?.peer && (
            <Pressable
              style={styles.sheetRow}
              onPress={() =>
                void act(
                  () =>
                    meta.peer!.blockedByMe
                      ? dmApi.unblock(meta.peer!.userId)
                      : dmApi.block(meta.peer!.userId),
                  meta.peer!.blockedByMe
                    ? `Unblocked ${meta.peer!.name}.`
                    : `Blocked ${meta.peer!.name}. History stays visible to you both.`,
                )
              }
              accessibilityRole="button"
              accessibilityLabel={
                meta.peer.blockedByMe ? `Unblock ${meta.peer.name}` : `Block ${meta.peer.name}`
              }
            >
              <Text style={[styles.sheetLabel, !meta.peer.blockedByMe && styles.destructive]}>
                {meta.peer.blockedByMe ? `Unblock ${meta.peer.name}` : `Block ${meta.peer.name}`}
              </Text>
              <Text style={styles.sheetHint}>
                {meta.peer.blockedByMe
                  ? 'You will both be able to send again'
                  : 'Instant. Nobody reviews it, and they are not told'}
              </Text>
            </Pressable>
          )}

          <Pressable
            style={styles.sheetRow}
            onPress={() => setMenuOpen(false)}
            accessibilityRole="button"
            accessibilityLabel="Close options"
          >
            <Text style={styles.sheetLabel}>Close</Text>
          </Pressable>
        </View>
      )}

      {/*
        Says so, rather than looking broken. History below is real - it comes from the local
        cache - and a send will queue rather than fail, so the honest message is "offline",
        not "error".
      */}
      {offline && (
        <View style={styles.offlineBanner}>
          <Text style={styles.offlineText}>Offline. Showing saved messages.</Text>
        </View>
      )}

      {notice !== null && (
        <Pressable
          style={styles.notice}
          onPress={() => setNotice(null)}
          accessibilityRole="button"
          accessibilityLabel="Dismiss message"
        >
          <Text style={styles.noticeText}>{notice}</Text>
        </Pressable>
      )}

      {loading ? (
        // The composer is not shown until the channel resolves, so nobody types into a
        // chat that has not loaded.
        <View style={styles.centered}>
          <ActivityIndicator color={color.accent} />
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={rows}
          keyExtractor={(row) =>
            row.kind === 'message' ? `m-${row.message.seq}` : `p-${row.clientMsgId}`
          }
          contentContainerStyle={styles.list}
          /*
            Chat opens at the tail - except when a jump sent us somewhere specific, where scrolling
            to the end would immediately undo the jump. `jumpedTo` is the one thing that suppresses
            it.
          */
          onContentSizeChange={() => {
            if (jumpedTo === null) listRef.current?.scrollToEnd({ animated: false });
          }}
          /*
            A row whose height has not been measured yet cannot be scrolled to, which is exactly the
            case a jump hits - the target is far from the tail. The list reports the failure instead
            of throwing, so the recovery is to scroll to the offset it managed and try the index
            again once that render has measured it.
          */
          onScrollToIndexFailed={(info) => {
            listRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
            setTimeout(() => {
              if (jumpedTo !== null) {
                listRef.current?.scrollToIndex({
                  index: info.index,
                  viewPosition: 0.5,
                  animated: false,
                });
              }
            }, 50);
          }}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>No messages yet</Text>
              <Text style={styles.emptyBody}>Say something to get started.</Text>
            </View>
          }
          renderItem={({ item }) => {
            if (item.kind === 'pending') {
              return (
                <View style={[styles.bubble, styles.sent, styles.pending]}>
                  {item.type === 'photo' && (
                    <PhotoBubble mediaId={null} localUri={item.localUri} mine />
                  )}
                  {item.type === 'document' && (
                    <DocumentBubble
                      name={item.documentName ?? null}
                      size={item.documentSize ?? null}
                      mine
                    />
                  )}
                  {item.body.length > 0 && <Text style={styles.sentText}>{item.body}</Text>}
                  {item.failed ? (
                    <Pressable
                      onPress={() => void retry(item.clientMsgId)}
                      accessibilityRole="button"
                      accessibilityLabel="Retry sending this message"
                    >
                      <Text style={styles.failed}>Failed. Tap to retry</Text>
                    </Pressable>
                  ) : (
                    <Text style={styles.pendingLabel}>Sending</Text>
                  )}
                </View>
              );
            }

            const { message } = item;

            // A system message is centred and unattributed, not a bubble.
            if (message.senderId === SYSTEM_ACTOR_ID) {
              return (
                <View style={styles.systemRow}>
                  <Text style={styles.systemText}>{message.body}</Text>
                </View>
              );
            }

            // A soft-deleted message leaves a tombstone rather than a hole, so the
            // replies around it stay readable.
            if (message.deletedAt !== null) {
              return (
                <View style={styles.systemRow}>
                  <Text style={styles.tombstone}>This message was deleted</Text>
                </View>
              );
            }

            const mine = message.senderId === userId;
            // Marked so a reader can see WHICH message a jump sent them to. Without it the screen
            // has silently scrolled somewhere and the target is indistinguishable from its
            // neighbours, which is most of the value of jumping.
            const isJumpTarget = jumpedTo === message.seq;
            return (
              <View style={isJumpTarget ? styles.jumpTarget : undefined}>
                <Pressable
                  // Long press, not a visible button: reporting is rare and a tap target on
                  // every bubble would be noise. Own messages are excluded because nobody can
                  // report themselves.
                  onLongPress={() => {
                    setSelected(message.seq);
                    setConfirmingReport(null);
                  }}
                  delayLongPress={400}
                  accessibilityRole="button"
                  accessibilityLabel={
                    mine
                      ? 'Press and hold to react to your message'
                      : 'Press and hold to react to or report this message'
                  }
                  style={[styles.bubble, mine ? styles.sent : styles.received]}
                >
                  {message.type === 'photo' && message.mediaId !== null && (
                    <PhotoBubble mediaId={message.mediaId} mine={mine} />
                  )}
                  {message.type === 'document' && (
                    <DocumentBubble
                      name={message.documentName}
                      size={message.documentSize}
                      mine={mine}
                    />
                  )}
                  {/* A photo may carry a caption, and usually does not. */}
                  {message.body !== null && message.body.length > 0 && (
                    <Text style={mine ? styles.sentText : styles.receivedText}>
                      {message.body}
                    </Text>
                  )}
                  <Text style={mine ? styles.sentMeta : styles.receivedMeta}>
                    {new Date(message.createdAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </Text>
                </Pressable>

                {/*
                  The reaction row, rendered under the bubble it belongs to and aligned with
                  it. Only emoji anyone actually used, in the fixed order from the shared
                  constant so the row does not reshuffle as counts change.
                */}
                {(() => {
                  const summary = reactionSummary(message.reactions, userId);
                  if (summary.length === 0) return null;
                  return (
                    <View style={[styles.pillRow, mine ? styles.pillRowMine : styles.pillRowTheirs]}>
                      {summary.map((entry) => (
                        <Pressable
                          key={entry.emoji}
                          style={[styles.pill, entry.mine && styles.pillMine]}
                          onPress={() => void react(message.seq, entry.emoji)}
                          accessibilityRole="button"
                          accessibilityLabel={
                            entry.mine
                              ? `Remove your ${entry.emoji} reaction, ${entry.count} total`
                              : `React with ${entry.emoji}, ${entry.count} total`
                          }
                        >
                          <Text style={styles.pillEmoji}>{entry.emoji}</Text>
                          <Text style={[styles.pillCount, entry.mine && styles.pillCountMine]}>
                            {entry.count}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  );
                })()}

                {selected === message.seq && confirmingReport !== message.seq && (
                  <View style={styles.actionSheet}>
                    {/*
                      Six large tap targets, which is the whole reason the set is fixed rather
                      than a searchable grid: reacting should cost one tap.
                    */}
                    <View style={styles.emojiRow}>
                      {reactionEmoji.map((emoji) => (
                        <Pressable
                          key={emoji}
                          style={styles.emojiButton}
                          onPress={() => {
                            setSelected(null);
                            void react(message.seq, emoji);
                          }}
                          accessibilityRole="button"
                          accessibilityLabel={`React with ${emoji}`}
                        >
                          <Text style={styles.emojiGlyph}>{emoji}</Text>
                        </Pressable>
                      ))}
                    </View>
                    <View style={styles.reportActions}>
                      <Pressable
                        style={styles.secondaryButton}
                        onPress={() => setSelected(null)}
                        accessibilityRole="button"
                        accessibilityLabel="Close message actions"
                      >
                        <Text style={styles.secondaryLabel}>Close</Text>
                      </Pressable>
                      {/* Nobody can report their own message, so it is not offered. */}
                      {!mine && (
                        <Pressable
                          style={styles.secondaryButton}
                          onPress={() => setConfirmingReport(message.seq)}
                          accessibilityRole="button"
                          accessibilityLabel="Report this message"
                        >
                          <Text style={[styles.secondaryLabel, styles.destructive]}>Report</Text>
                        </Pressable>
                      )}
                    </View>
                  </View>
                )}

                {confirmingReport === message.seq && (
                  <View style={styles.actionSheet}>
                    <Text style={styles.reportPrompt}>
                      {meta?.scope === 'dm'
                        ? // No club admin ever sees the contents of a DM, so say where it goes.
                          'Report this to ClubChat moderators?'
                        : 'Report this to the admins of this space?'}
                    </Text>
                    <View style={styles.reportActions}>
                      <Pressable
                        style={styles.secondaryButton}
                        onPress={() => {
                          setConfirmingReport(null);
                          setSelected(null);
                        }}
                        accessibilityRole="button"
                        accessibilityLabel="Cancel reporting"
                      >
                        <Text style={styles.secondaryLabel}>Cancel</Text>
                      </Pressable>
                      <Pressable
                        style={styles.button}
                        onPress={() => {
                          setConfirmingReport(null);
                          setSelected(null);
                          void dmApi
                            .report(channelId!, message.seq)
                            .then((result) =>
                              setNotice(
                                result.alreadyReported
                                  ? 'You already reported this message.'
                                  : 'Reported. The other person is not told.',
                              ),
                            )
                            .catch(() => setNotice('Could not report that. Try again.'));
                        }}
                        accessibilityRole="button"
                        accessibilityLabel="Confirm report"
                      >
                        <Text style={styles.buttonLabel}>Report</Text>
                      </Pressable>
                    </View>
                  </View>
                )}
              </View>
            );
          }}
        />
      )}

      {/*
        The attach menu. PRD/05 rule 11: Photos, Camera and Document are always available; the
        admin-gated create actions (Poll, Event, Meeting) belong to their own phases and are
        deliberately absent rather than stubbed.
      */}
      {attachOpen && canPost && (
        <View style={styles.sheet}>
          {(
            [
              ['Photos', 'Choose an image from your library', pickPhoto, 'photo'],
              ['Camera', 'Take a photo now', takePhoto, 'photo'],
              ['Document', 'Any file, shown with its name and size', pickDocument, 'document'],
            ] as const
          ).map(([label, hint, pick, kind]) => (
            <Pressable
              key={label}
              style={styles.sheetRow}
              onPress={() => void attach(pick, kind)}
              accessibilityRole="button"
              accessibilityLabel={label}
            >
              <Text style={styles.sheetLabel}>{label}</Text>
              <Text style={styles.sheetHint}>{hint}</Text>
            </Pressable>
          ))}
          <Pressable
            style={styles.sheetRow}
            onPress={() => setAttachOpen(false)}
            accessibilityRole="button"
            accessibilityLabel="Close the attach menu"
          >
            <Text style={styles.sheetLabel}>Close</Text>
          </Pressable>
        </View>
      )}

      {canPost ? (
        <View style={styles.composer}>
          {/*
            The "+". Disabled while bytes are in flight rather than hidden, so a second tap
            cannot start a concurrent upload and the reason is visible.
          */}
          <Pressable
            style={[styles.attachButton, uploading && styles.sendDisabled]}
            onPress={() => setAttachOpen((open) => !open)}
            disabled={uploading}
            accessibilityRole="button"
            accessibilityLabel={uploading ? 'Uploading an attachment' : 'Attach a photo or file'}
          >
            {uploading ? (
              <ActivityIndicator color={color.accent} />
            ) : (
              <Text style={styles.attachLabel}>+</Text>
            )}
          </Pressable>
          <TextInput
            style={styles.input}
            placeholder="Message"
            placeholderTextColor={color.textSecondary}
            value={draft}
            onChangeText={setDraft}
            multiline
            accessibilityLabel="Message"
            onSubmitEditing={() => void send()}
          />
          <Pressable
            style={[styles.sendButton, draft.trim().length === 0 && styles.sendDisabled]}
            onPress={() => void send()}
            disabled={draft.trim().length === 0}
            accessibilityRole="button"
            accessibilityLabel="Send message"
          >
            <Text style={styles.sendLabel}>Send</Text>
          </Pressable>
        </View>
      ) : (
        /*
          A disabled composer that STATES ITS REASON, rather than an input that silently
          rejects. History above is fully readable, which is the point: blocking and losing the
          last shared club both make a thread read-only rather than deleting it.
        */
        <View style={styles.composerDisabled}>
          <Text style={styles.composerDisabledText}>
            {DENIED_TEXT[meta?.postDeniedReason ?? 'unavailable']}
          </Text>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  /** The row a jump landed on. A left rule rather than a fill, so the bubble keeps its own colour. */
  jumpTarget: {
    borderLeftWidth: 3,
    borderLeftColor: color.accent,
    backgroundColor: color.chrome,
    borderRadius: radius.sm,
  },
  flex: { flex: 1, backgroundColor: color.appBackground },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  list: {
    padding: space.md,
    gap: space.sm,
    flexGrow: 1,
    // Anchor to the bottom so a short conversation sits just above the composer rather
    // than stranded at the top under a screen of empty space. With flexGrow alone the
    // content container fills the viewport and leaves the gap below the messages.
    justifyContent: 'flex-end',
  },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.sm },
  emptyTitle: { ...type.title, color: color.textPrimary },
  emptyBody: { ...type.bodySmall, color: color.textSecondary },
  bubble: {
    maxWidth: '80%',
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    gap: space.xs,
  },
  sent: { alignSelf: 'flex-end', backgroundColor: color.accent },
  received: {
    alignSelf: 'flex-start',
    backgroundColor: color.card,
    borderWidth: 1,
    borderColor: color.divider,
  },
  pending: { opacity: 0.6 },
  pendingLabel: { ...type.label, color: color.onAccent },
  failed: { ...type.label, color: color.onAccent, textDecorationLine: 'underline' },
  sentText: { ...type.body, color: color.onAccent },
  receivedText: { ...type.body, color: color.textPrimary },
  sentMeta: { ...type.label, color: color.onAccent, opacity: 0.8 },
  receivedMeta: { ...type.label, color: color.textSecondary },
  systemRow: { alignItems: 'center', paddingVertical: space.xs },
  systemText: { ...type.bodySmall, color: color.textSecondary, textAlign: 'center' },
  tombstone: {
    ...type.bodySmall,
    color: color.textSecondary,
    fontStyle: 'italic',
    textAlign: 'center',
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: space.sm,
    padding: space.sm,
    backgroundColor: color.chrome,
    borderTopWidth: 1,
    borderTopColor: color.divider,
  },
  composerDisabled: {
    padding: space.md,
    backgroundColor: color.chrome,
    borderTopWidth: 1,
    borderTopColor: color.divider,
    alignItems: 'center',
  },
  composerDisabledText: { ...type.bodySmall, color: color.textSecondary, textAlign: 'center' },
  input: {
    flex: 1,
    maxHeight: 120,
    backgroundColor: color.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.divider,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    ...type.body,
    color: color.textPrimary,
  },
  sendButton: {
    backgroundColor: color.accent,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
  },
  sendDisabled: { opacity: 0.4 },
  attachButton: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.card,
    borderWidth: 1,
    borderColor: color.divider,
  },
  // Optically centred: the glyph's own line height sits high in the box.
  attachLabel: { fontSize: 24, lineHeight: 28, color: color.accent, marginTop: -2 },
  sendLabel: { ...type.label, color: color.onAccent, textTransform: 'uppercase' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    backgroundColor: color.chrome,
    borderBottomWidth: 1,
    borderBottomColor: color.divider,
  },
  headerTitle: { ...type.headline, color: color.accent, flex: 1, textAlign: 'center' },
  // Matches the back control's optical width so the centred title stays on axis.
  headerAction: { minWidth: 44, alignItems: 'flex-end' },
  offlineBanner: {
    backgroundColor: color.fallback,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    alignItems: 'center',
  },
  offlineText: { ...type.label, color: color.textSecondary, textTransform: 'uppercase' },
  backLabel: { ...type.label, color: color.accent, textTransform: 'uppercase' },
  sheet: {
    backgroundColor: color.card,
    borderBottomWidth: 1,
    borderBottomColor: color.divider,
  },
  sheetRow: {
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    gap: space.xs,
    borderBottomWidth: 1,
    borderBottomColor: color.divider,
  },
  sheetLabel: { ...type.body, color: color.textPrimary },
  sheetHint: { ...type.bodySmall, color: color.textSecondary },
  destructive: { color: color.error },
  notice: {
    backgroundColor: color.fallback,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
  },
  noticeText: { ...type.bodySmall, color: color.textPrimary, textAlign: 'center' },
  actionSheet: {
    alignSelf: 'flex-start',
    maxWidth: '90%',
    backgroundColor: color.card,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: color.divider,
    padding: space.sm,
    gap: space.sm,
    marginTop: space.xs,
  },
  emojiRow: { flexDirection: 'row', gap: space.xs, justifyContent: 'space-between' },
  emojiButton: {
    // A generous target: this is the control the whole fixed-set decision exists to keep fast.
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
    backgroundColor: color.appBackground,
  },
  emojiGlyph: { fontSize: 24, lineHeight: 30 },
  pillRow: { flexDirection: 'row', gap: space.xs, flexWrap: 'wrap', marginTop: -space.xs },
  // Aligned under the bubble they belong to, on whichever side it sits.
  pillRowMine: { alignSelf: 'flex-end' },
  pillRowTheirs: { alignSelf: 'flex-start' },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    borderRadius: radius.pill,
    backgroundColor: color.card,
    borderWidth: 1,
    borderColor: color.divider,
  },
  // The viewer's own reaction is outlined in the accent, so "did I react" is visible without
  // counting or tapping.
  pillMine: { borderColor: color.accent, backgroundColor: color.appBackground },
  pillEmoji: { fontSize: 14, lineHeight: 18 },
  pillCount: { ...type.label, color: color.textSecondary },
  pillCountMine: { color: color.accent },
  reportPrompt: { ...type.bodySmall, color: color.textPrimary },
  reportActions: { flexDirection: 'row', gap: space.sm },
  button: {
    flex: 1,
    backgroundColor: color.accent,
    borderRadius: radius.sm,
    paddingVertical: space.sm,
    alignItems: 'center',
  },
  buttonLabel: { ...type.label, color: color.onAccent, textTransform: 'uppercase' },
  secondaryButton: {
    flex: 1,
    backgroundColor: color.card,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: color.divider,
    paddingVertical: space.sm,
    alignItems: 'center',
  },
  secondaryLabel: { ...type.label, color: color.textSecondary, textTransform: 'uppercase' },
});
