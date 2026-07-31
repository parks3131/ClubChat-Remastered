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
 */

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { contentApi } from '../api.ts';
import { formatInstant } from '../dates.ts';
import { color, radius, space, type } from '../theme.ts';
import { useLoad } from '../use-load.ts';

export function ChatMeetingCard({ meetingId }: { meetingId: string }) {
  const router = useRouter();
  const load = useLoad(() => contentApi.meeting(meetingId), [meetingId]);

  // No spinner and no error text: a pending or failed read should leave the message reading as
  // it did before cards existed, rather than shouting in the log.
  if (load.data === null) return null;
  const meeting = load.data.meeting;

  return (
    <Pressable
      style={styles.card}
      onPress={() => router.push(`/meetings/${meetingId}`)}
      accessibilityRole="button"
      accessibilityLabel={`${meeting.title}, ${formatInstant(meeting.startsAt)}. View this meeting`}
    >
      <View style={styles.cardHead}>
        <MaterialIcons name="groups" size={18} color={color.accent} />
        <Text style={styles.cardTitle} numberOfLines={2}>
          {meeting.title}
        </Text>
      </View>

      <View style={styles.cardLine}>
        <MaterialIcons name="schedule" size={14} color={color.textSecondary} />
        <Text style={styles.cardMeta} numberOfLines={1}>
          {formatInstant(meeting.startsAt)}
        </Text>
      </View>

      {/* The joining link, shown as "there is one" rather than as a URL. A raw meeting link is
          forty unreadable characters and the card is not where anybody types it out. */}
      {meeting.link !== null && meeting.link.trim().length > 0 && (
        <View style={styles.cardLine}>
          <MaterialIcons name="videocam" size={14} color={color.textSecondary} />
          <Text style={styles.cardMeta} numberOfLines={1}>
            Joining link attached
          </Text>
        </View>
      )}

      <View style={styles.cardCta}>
        <Text style={styles.cardCtaLabel}>VIEW MEETING</Text>
        <MaterialIcons name="arrow-forward" size={14} color={color.onAccent} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  /* Its own surface, because the creator's bubble behind it is accent-filled. */
  card: {
    backgroundColor: color.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.divider,
    padding: space.md,
    gap: space.sm,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  cardTitle: { ...type.headline, color: color.textPrimary, flex: 1 },
  cardLine: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  cardMeta: { ...type.bodySmall, color: color.textSecondary, flex: 1 },
  cardCta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    backgroundColor: color.accent,
    borderRadius: radius.pill,
    paddingVertical: space.sm,
    marginTop: space.xs,
  },
  cardCtaLabel: { ...type.label, fontSize: 11, color: color.onAccent },
});
