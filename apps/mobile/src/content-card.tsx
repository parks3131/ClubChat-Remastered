/**
 * The content card: **one shell, three payloads.**
 *
 * A poll, an event and a meeting each post a card into chat, and each has a screen of its own that
 * shows the same thing at full size. That is one surface appearing in six places, so the shell
 * lives here rather than being written out per card - the arrangement `SPEC/DESIGN/05-content-card.md`
 * describes, and the reason it is a spec rather than three sets of styles.
 *
 * > **They had drifted before this module existed.** The poll card outlined itself in `divider` and
 * > the event card in the same, while the poll *list* card used `hairline`; the event and meeting
 * > cards ended in a full-width accent pill and the poll card did not. Nothing was wrong enough to
 * > report, which is exactly how three copies of one surface stay subtly different forever.
 *
 * Nothing in here knows what a poll or an event is. It takes a label, a title, some meta and
 * whatever the payload wants to put in the middle.
 */

import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { color, radius, space, type } from './theme.ts';

/**
 * The surface: white, hairline-outlined, gutter-padded.
 *
 * Pressable only when handed an `onPress`. The poll card must NOT be one - every option inside it
 * is its own button and wrapping those in a button is failure mode 17, invalid on web and gesture-
 * swallowing on native. The event and meeting cards have no inner controls, so the whole card is
 * the target and there is nothing to nest.
 *
 * **`onLongPress` belongs HERE, not on an ancestor, and that is the whole reason it is a prop.**
 * A press handler on this card makes it the touch responder on native, so a long press aimed at
 * it never reaches an enclosing pressable - the chat row wrapped one around every card for exactly
 * that job, and holding an event card did nothing for as long as the card has existed. The card
 * that owns the tap has to own the hold.
 */
export function ContentCard({
  children,
  onPress,
  onLongPress,
  accessibilityLabel,
}: {
  children: ReactNode;
  onPress?: () => void;
  /** React or report. Undefined on web, where the gesture is deliberately not offered. */
  onLongPress?: () => void;
  accessibilityLabel?: string;
}) {
  if (onPress === undefined) return <View style={styles.card}>{children}</View>;

  return (
    <Pressable
      style={styles.card}
      onPress={onPress}
      onLongPress={onLongPress}
      // Matches the bubble's, so one gesture has one feel wherever it is made.
      delayLongPress={400}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
    >
      {children}
    </Pressable>
  );
}

/**
 * The kind, in the accent, above the title: EVENT, POLL, MEETING.
 *
 * It is what makes a card scannable in a conversation - you know which of the three you are looking
 * at before reading a word of it. `chip` is the state that overrides that reading, which today
 * means a closed poll; the eyebrow mutes when one is present so the two are not two loud things.
 */
export function CardEyebrow({
  label,
  chip = null,
}: {
  label: string;
  /** A state that changes what the card means. Mutes the eyebrow when set. */
  chip?: string | null;
}) {
  return (
    <View style={styles.eyebrowRow}>
      <Text style={[styles.eyebrow, chip !== null && styles.eyebrowMuted]}>{label}</Text>
      {chip !== null && (
        <View style={styles.chip}>
          <Text style={styles.chipLabel}>{chip}</Text>
        </View>
      )}
    </View>
  );
}

/**
 * The day-over-month block that opens an event or a meeting card.
 *
 * Filled rather than outlined, because it is the one thing on the card a reader is scanning a
 * conversation for. Take the parts from `bibParts`, which is where the "is this a day or a moment"
 * question is answered - getting that wrong here shows the wrong date in the loudest possible place.
 */
export function DateChip({ day, month }: { day: number; month: string }) {
  return (
    <View style={styles.dateChip}>
      <Text style={styles.dateChipDay}>{day}</Text>
      <Text style={styles.dateChipMonth}>{month}</Text>
    </View>
  );
}

/** The card's headline. Body-bold rather than the display face: a card is read, not announced. */
export function CardTitle({ children }: { children: ReactNode }) {
  return (
    <Text style={styles.title} numberOfLines={2}>
      {children}
    </Text>
  );
}

/**
 * The quiet line under the title: time, place, who.
 *
 * Takes the parts rather than a joined string so that an absent one leaves no trace. A meta line
 * reading "6:00 AM  ·    ·  Coach Dana" is what building it at the call site produces the first
 * time somebody's event has no location.
 */
export function CardMeta({ parts }: { parts: (string | null | undefined)[] }) {
  const present = parts.filter((part): part is string => part != null && part.trim().length > 0);
  if (present.length === 0) return null;

  return (
    <Text style={styles.meta} numberOfLines={2}>
      {present.join('  ·  ')}
    </Text>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: color.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    /*
      `hairline`, not `divider`. It is v1's card outline and the reason its cards read as objects
      rather than as blocks of white on a near-white page - see the token's own note. The three
      cards each picked their own before this module existed.
    */
    borderColor: color.hairline,
    padding: space.md,
    gap: space.sm,
  },

  eyebrowRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  eyebrow: { ...type.label, color: color.accent },
  eyebrowMuted: { color: color.textSecondary },
  chip: {
    backgroundColor: color.cardSunken,
    borderRadius: radius.xs,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
  },
  chipLabel: { ...type.label, fontSize: 10, color: color.textSecondary },

  dateChip: {
    width: 56,
    height: 56,
    borderRadius: radius.md,
    backgroundColor: color.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dateChipDay: { ...type.numeric, color: color.onAccent },
  dateChipMonth: { ...type.label, color: color.onAccent },

  title: { ...type.headline, color: color.textPrimary },
  meta: { ...type.bodySmall, color: color.textSecondary },
});
