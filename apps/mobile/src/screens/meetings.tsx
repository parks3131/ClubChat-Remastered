/**
 * The meeting card that sits in board chat, for a `card` message carrying a `linkedMeetingId`.
 *
 * The event card's twin, and deliberately so - a board reading its chat should not have to learn
 * two card shapes for two things that are both "something is happening at a time". What differs
 * is what a meeting HAS: a joining link where an event has a place, because a board meets on a
 * call more often than in a room.
 *
 * Fetched by id rather than read off the message, for the same reason the event card is: the
 * message carries a sentence, and the time this card exists to show was never on the wire. The
 * read is membership-gated, so a card in a conversation somebody should not see renders as
 * nothing rather than leaking the board's schedule.
 *
 * > **"Twin" was a claim the code did not keep.** Both cards were written to the same sketch and
 * > then maintained apart, so they had separately chosen their own border token and their own
 * > glyph. They now share `content-card.tsx`, which is what makes the twinning a fact rather than
 * > an intention.
 */

import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { contentApi } from '../api.ts';
import { bibParts, formatInstant, formatTimeOfDay } from '../dates.ts';
import { CardEyebrow, CardMeta, CardTitle, ContentCard, DateChip } from '../content-card.tsx';
import { space } from '../theme.ts';
import { useLoad } from '../use-load.ts';

export function ChatMeetingCard({
  meetingId,
  fallback = null,
  onLongPress,
}: {
  meetingId: string;
  /** The message's own sentence, drawn when the meeting cannot be. See `ChatPollCard`. */
  fallback?: ReactNode;
  /** React or report, on the card's own pressable rather than the row's. See `ChatEventCard`. */
  onLongPress?: () => void;
}) {
  const router = useRouter();
  const load = useLoad(() => contentApi.meeting(meetingId), [meetingId]);

  // No spinner and no error text: a pending or failed read falls back to the message's own
  // sentence, because the chat screen has already suppressed it for any card-carrying message.
  if (load.data === null) return <>{fallback}</>;
  const meeting = load.data.meeting;
  // An instant, never a date-only value - so its day is the reader's, not UTC's. See `bibParts`.
  const bib = bibParts(meeting.startsAt, false);
  const hasLink = meeting.link !== null && meeting.link.trim().length > 0;

  return (
    <ContentCard
      onPress={() => router.push(`/meetings/${meetingId}`)}
      onLongPress={onLongPress}
      accessibilityLabel={`${meeting.title}, ${formatInstant(meeting.startsAt)}. View this meeting`}
    >
      <View style={styles.cardRow}>
        <DateChip day={bib.day} month={bib.month} />
        <View style={styles.cardText}>
          <CardEyebrow label="MEETING" />
          <CardTitle>{meeting.title}</CardTitle>
          {/* The joining link, shown as "there is one" rather than as a URL. A raw meeting link is
              forty unreadable characters and the card is not where anybody types it out.

              No creator, as on the event card: the avatar and name above the card say it. */}
          <CardMeta
            parts={[formatTimeOfDay(meeting.startsAt), hasLink ? 'Joining link attached' : null]}
          />
        </View>
      </View>
    </ContentCard>
  );
}

const styles = StyleSheet.create({
  cardRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  cardText: { flex: 1, gap: space.xs },
});
