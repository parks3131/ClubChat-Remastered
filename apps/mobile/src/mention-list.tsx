/**
 * The `@` list: who the composer is offering while a mention is being typed.
 *
 * > **Extracted at the second caller**, which is the photo send sheet - `AGENTS.md` 2.2's rule
 * > that shared UI is parametrized rather than forked, so a fix lands everywhere at once. The
 * > chat composer had it inline, and a second hand-written copy over a dark surface is how two
 * > lists of the same people end up with two row heights and two ideas of what a match looks like.
 *
 * The list renders **only when something matches**. An empty panel hovering over the conversation
 * is worse than no panel, and the caller decides where it sits - this owns what a row looks like,
 * never where the bar goes.
 *
 * `keyboardShouldPersistTaps="always"` is load-bearing rather than decorative: without it the
 * first tap is spent dismissing the keyboard and the row never fires, which reads as a list that
 * ignores you.
 */

import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import type { Mentionable } from './mentions.ts';
import { color, space, type } from './theme.ts';
import { Avatar } from './ui.tsx';

export function MentionList({
  matches,
  onPick,
  style,
  /**
   * Drawn over a dark photo rather than over the conversation.
   *
   * A flag rather than a second component, because the only difference is two colours - and a
   * fork would be the copy this extraction exists to prevent. Not a general theme: there are
   * exactly two surfaces this list appears on.
   */
  onDark = false,
}: {
  matches: readonly Mentionable[];
  onPick: (member: Mentionable) => void;
  style?: StyleProp<ViewStyle>;
  onDark?: boolean;
}) {
  if (matches.length === 0) return null;

  return (
    <View style={[styles.bar, onDark && styles.barDark, style]}>
      <ScrollView keyboardShouldPersistTaps="always" showsVerticalScrollIndicator={false}>
        {matches.map((member) => (
          <Pressable
            key={member.userId}
            style={styles.row}
            onPress={() => onPick(member)}
            accessibilityRole="button"
            accessibilityLabel={`Mention ${member.name}`}
          >
            <Avatar name={member.name} image={member.image} size={28} />
            <Text style={[styles.name, onDark && styles.nameDark]}>{member.name}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  /*
   * Capped in height so a big club cannot cover the conversation, and anchored by the caller to
   * whatever it sits above rather than floating, so it reads as part of what is being typed.
   */
  bar: {
    maxHeight: 200,
    backgroundColor: color.chrome,
    borderTopWidth: 1,
    borderTopColor: color.divider,
    paddingHorizontal: space.sm,
  },
  barDark: {
    backgroundColor: color.inverseSurface,
    borderTopColor: 'rgba(255,255,255,0.15)',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm + 2,
    paddingVertical: space.sm,
    paddingHorizontal: space.sm,
  },
  name: { ...type.body, color: color.textPrimary },
  nameDark: { color: color.onInverseSurface },
});
