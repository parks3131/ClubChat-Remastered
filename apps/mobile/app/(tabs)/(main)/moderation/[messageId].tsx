/**
 * The reported message, the few either side of it, and the two things a moderator can do.
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
 *
 * **The actions live here rather than on the queue, deliberately.** Apple's guideline 1.2 asks a
 * developer to act on a report within 24 hours by removing the content and ejecting the user, and
 * both of those are judgements that should be made having read the evidence. Offering them on a
 * list of names would be offering them to somebody who has not looked.
 */

import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { moderationApi } from '../../../../src/api.ts';
import type { ModerationContext } from '../../../../src/api-types.ts';
import { formatInstant } from '../../../../src/dates.ts';
import { color, radius, space, type } from '../../../../src/theme.ts';
import { Action, Body, ConfirmDialog, DataScreen } from '../../../../src/ui.tsx';
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

          <Decide data={data} />
        </Body>
      )}
    </DataScreen>
  );
}

/**
 * What a moderator can do about it.
 *
 * > **Nothing here re-fetches the context, and that is not an optimisation.** Every call to
 * > `moderationApi.context` writes an audit row, so reloading after an action would record a
 * > second look at a private conversation that nobody performed. The two outcomes are tracked in
 * > local state instead, seeded from what the server already said.
 */
function Decide({ data }: { data: ModerationContext }) {
  const [removed, setRemoved] = useState(data.removed);
  const [suspended, setSuspended] = useState(data.subjectSuspended);
  const [asking, setAsking] = useState<'remove' | 'suspend' | 'reinstate' | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const subject =
    data.messages.find((message) => message.seq === data.reportedSeq)?.senderName ??
    'this member';

  /** Run one action, then reflect it locally. See the note above on why nothing reloads. */
  const run = (work: () => Promise<unknown>, settle: () => void) => {
    setBusy(true);
    setFailed(null);
    void work()
      .then(() => settle())
      // A failure has to be visible: a moderation action that silently did nothing is worse
      // than one that refused, because the queue would read as handled.
      .catch(() => setFailed('That did not go through. Try again.'))
      .finally(() => {
        setBusy(false);
        setAsking(null);
      });
  };

  return (
    <View style={styles.decide}>
      <Text style={styles.decideTitle}>Act on this report</Text>

      {removed ? (
        <Text style={styles.done}>The message has been removed. A tombstone is left in its place.</Text>
      ) : (
        <Action
          label="Remove this message"
          variant="danger"
          disabled={busy}
          onPress={() => setAsking('remove')}
        />
      )}

      {suspended ? (
        <Action
          label="Reinstate this account"
          disabled={busy}
          onPress={() => setAsking('reinstate')}
        />
      ) : (
        <Action
          label="Suspend this account"
          variant="danger"
          disabled={busy}
          onPress={() => setAsking('suspend')}
        />
      )}

      {failed !== null && <Text style={styles.failed}>{failed}</Text>}

      {/*
        Confirmation-gated, and the body NAMES what is lost - PRD/16 rule 5. In-app rather than
        a native alert, because `Alert.alert` is a no-op on web and this has to behave the same
        on all three platforms.
      */}
      {asking === 'remove' && (
        <ConfirmDialog
          title="Remove this message?"
          body={`It will be replaced by "This message was deleted" for both people in the conversation. Nothing else in the thread changes, and this is recorded against your name.`}
          confirmLabel="Remove it"
          onCancel={() => setAsking(null)}
          onConfirm={() =>
            run(() => moderationApi.remove(data.messageId), () => setRemoved(true))
          }
        />
      )}

      {asking === 'suspend' && (
        <ConfirmDialog
          title={`Suspend ${subject}?`}
          body={`They will be signed out everywhere and unable to sign in again until somebody lifts it. Their clubs, messages and memberships are untouched, and this is recorded against your name.`}
          confirmLabel="Suspend"
          onCancel={() => setAsking(null)}
          onConfirm={() =>
            run(
              () => moderationApi.setSuspended(data.subjectUserId, true, data.messageId),
              () => setSuspended(true),
            )
          }
        />
      )}

      {asking === 'reinstate' && (
        <ConfirmDialog
          title={`Reinstate ${subject}?`}
          body={`They will be able to sign in again. They will have to enter their password, because suspending signed every device out. This is recorded against your name.`}
          confirmLabel="Reinstate"
          dismissLabel="Leave suspended"
          onCancel={() => setAsking(null)}
          onConfirm={() =>
            run(
              () => moderationApi.setSuspended(data.subjectUserId, false),
              () => setSuspended(false),
            )
          }
        />
      )}
    </View>
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
  },

  // The actions sit below the evidence, so the order of the screen is read-then-decide.
  decide: {
    gap: space.sm,
    paddingTop: space.lg,
    paddingBottom: space.lg,
  },
  decideTitle: { ...type.headline, color: color.textPrimary },
  done: { ...type.bodySmall, color: color.textSecondary },
  failed: { ...type.bodySmall, color: color.error },
});
