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
import { SYSTEM_ACTOR_ID, type MessageEnvelope } from '@clubchat/shared';
import { useSession } from '../../src/chat-provider.tsx';
import { color, radius, space, type } from '../../src/theme.ts';

type Row =
  | { kind: 'message'; message: MessageEnvelope }
  /** An optimistic row from the send outbox, not yet acked. */
  | { kind: 'pending'; clientMsgId: string; body: string; failed: boolean };

export default function ChatScreen() {
  const { channelId } = useLocalSearchParams<{ channelId: string }>();
  const { authState, client, userId, revision, offline } = useSession();
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const listRef = useRef<FlatList<Row>>(null);

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
      }));
    setRows([...stored.map((message) => ({ kind: 'message' as const, message })), ...pending]);
    setLoading(false);
  }, [client, channelId]);

  useEffect(() => {
    void refresh();
  }, [refresh, revision]);

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

  const send = async () => {
    const body = draft.trim();
    if (body.length === 0 || !client || !channelId) return;
    setDraft('');
    try {
      await client.sendWithRetry(channelId, body);
    } catch {
      // The send failed VISIBLY: the entry stays in the outbox marked failed, and the
      // row below renders it with a retry affordance. It is never silently dropped.
    }
    await refresh();
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

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/*
        Chat's own header. The back control ALWAYS renders and always has an explicit
        target: a control that only appears when history exists is a bug, because direct
        URL entry and page refresh leave no history on any screen.

        The target is the clubs list and NEVER this chat's own hub. Chat is the home
        screen of a race and of an Eboard space, so a back-fallback pointing at the hub
        would bounce hub to chat to hub forever on an entry with no history.
      */}
      <View style={styles.header}>
        <Pressable
          onPress={() => router.replace('/clubs')}
          accessibilityRole="button"
          accessibilityLabel="Back to clubs"
          hitSlop={space.sm}
        >
          <Text style={styles.backLabel}>Clubs</Text>
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1}>
          Chat
        </Text>
        {/* Balances the row so the title stays optically centred. */}
        <View style={styles.headerSpacer} />
      </View>

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
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
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
                  <Text style={styles.sentText}>{item.body}</Text>
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
            return (
              <View style={[styles.bubble, mine ? styles.sent : styles.received]}>
                <Text style={mine ? styles.sentText : styles.receivedText}>{message.body}</Text>
                <Text style={mine ? styles.sentMeta : styles.receivedMeta}>
                  {new Date(message.createdAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </Text>
              </View>
            );
          }}
        />
      )}

      <View style={styles.composer}>
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

    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
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
  // Matches the back control's optical width so the centred title does not sit off-axis.
  headerSpacer: { width: 44 },
  offlineBanner: {
    backgroundColor: color.fallback,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    alignItems: 'center',
  },
  offlineText: { ...type.label, color: color.textSecondary, textTransform: 'uppercase' },
  backLabel: { ...type.label, color: color.accent, textTransform: 'uppercase' },
});
