/**
 * The reported message, and the few either side of it.
 *
 * > **This is the single door to the contents of a private conversation, and opening it is
 * > written down.** Every other screen in the app reads messages a member is entitled to; this
 * > one reads two other people's, so it is bounded and logged rather than trusted.
 *
 * Three properties, none of them this screen's to choose - they are enforced on the server and
 * restated here so nobody "improves" the screen past them:
 *
 *  1. **A window, never the conversation.** Five messages either side of the reported one, fixed
 *     by `MODERATION_CONTEXT_RADIUS`. There is deliberately no parameter to widen it and no
 *     paging control here, because moderation is not a licence to browse.
 *  2. **The read is logged in the same transaction that serves it**, naming the moderator, the
 *     report and the window actually returned. A log written afterwards could be skipped by a
 *     failure between the two.
 *  3. **No door without a report.** The read resolves through `message_reports`, so a
 *     conversation nobody complained about cannot be reached from here at all.
 *
 * Which is why the load is triggered by arriving on this screen rather than prefetched from the
 * queue: every fetch is a logged look at somebody's private messages, and a speculative one would
 * fill the audit trail with reads no person performed.
 */

import { StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { moderationApi } from '../../../../src/api.ts';
import type { ModerationContext } from '../../../../src/api-types.ts';
import { formatInstant } from '../../../../src/dates.ts';
import { color, radius, space, type } from '../../../../src/theme.ts';
import { Body, DataScreen } from '../../../../src/ui.tsx';
import { useLoad } from '../../../../src/use-load.ts';

export default function ReportedContextScreen() {
  const { messageId } = useLocalSearchParams<{ messageId: string }>();
  const context = useLoad(() => moderationApi.context(messageId), [messageId]);

  return (
    <DataScreen load={context}>
      {(data: ModerationContext) => (
        <Body>
          {/*
            Said plainly, at the top, to the person doing it. The logging is not a secret kept
            from the moderator - it is a constraint they should feel while they read.
          */}
          <View style={styles.notice}>
            <Text style={styles.noticeText}>
              You are reading part of a private conversation. This was recorded: your name, the
              report, and the messages shown.
            </Text>
            <Text style={styles.noticeMeta}>
              Messages {data.fromSeq} to {data.toSeq}, around the reported one.
            </Text>
          </View>

          {data.messages.map((message) => {
            const reported = message.seq === data.reportedSeq;
            return (
              <View
                key={message.seq}
                style={[styles.bubble, reported && styles.reportedBubble]}
              >
                <View style={styles.bubbleHead}>
                  <Text style={[styles.sender, reported && styles.reportedSender]}>
                    {message.senderName ?? 'Deleted member'}
                  </Text>
                  <Text style={styles.when}>{formatInstant(message.createdAt)}</Text>
                </View>
                <Text style={styles.body}>
                  {/*
                    A deleted message keeps its place with a tombstone rather than vanishing.
                    A hole in the middle of the window would make the surrounding messages
                    unreadable, which is the same reason chat never hard-deletes.
                  */}
                  {message.deletedAt != null
                    ? 'This message was deleted.'
                    : (message.body ?? 'Photo or attachment')}
                </Text>
                {reported && <Text style={styles.flag}>This is the reported message</Text>}
              </View>
            );
          })}

          <Text style={styles.footnote}>
            Only these messages were shown. The rest of the conversation is not readable from
            here.
          </Text>
        </Body>
      )}
    </DataScreen>
  );
}

const styles = StyleSheet.create({
  notice: {
    backgroundColor: color.errorContainer,
    borderRadius: radius.lg,
    padding: space.md,
    gap: space.xs,
    marginBottom: space.sm,
  },
  noticeText: { ...type.bodySmall, color: color.onErrorContainer },
  noticeMeta: { ...type.label, color: color.onErrorContainer, textTransform: 'none' },

  bubble: {
    backgroundColor: color.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.hairline,
    padding: space.sm + 4,
    gap: space.xs,
    marginBottom: space.xs,
  },
  // The reported message is marked rather than isolated, because judging it needs what sits
  // around it - which is the entire reason a window is served instead of one message.
  reportedBubble: { borderColor: color.error, borderWidth: 2 },

  bubbleHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  sender: { ...type.label, color: color.textSecondary, textTransform: 'none', flex: 1 },
  reportedSender: { color: color.error },
  when: { ...type.bodySmall, color: color.textSecondary },
  body: { ...type.body, color: color.textPrimary },
  flag: { ...type.label, color: color.error, textTransform: 'none' },

  footnote: {
    ...type.bodySmall,
    color: color.textSecondary,
    textAlign: 'center',
    paddingTop: space.sm,
    paddingBottom: space.lg,
  },
});
