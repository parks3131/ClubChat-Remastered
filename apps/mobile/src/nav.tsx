/**
 * Navigation pieces that every screen shares.
 *
 * The rule these exist to hold: **every screen must be navigable back out when reached with no
 * history** - a deep link, a page refresh, a notification tap. The navigator renders its own back
 * button only when history exists, so a screen that relies on it looks correct until somebody
 * arrives from outside. `SPEC/PRD/15` rule 3, and it has shipped as a bug twice here.
 *
 * The consequence is that a parent is **declared**, not inferred. Every screen states where "back"
 * goes when there is nowhere to return to.
 */

import { Link } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { color, radius, space, type } from './theme.ts';

/**
 * An explicit back control, rendered whether or not history exists.
 *
 * `Link` rather than `router.back()` on purpose: `back()` throws when there is nothing to pop,
 * which is every screen reached by a direct link or a refresh (AGENTS.md section 4). A link to
 * the declared parent always works.
 */
export function BackTo({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} asChild accessibilityRole="button" accessibilityLabel={`Back to ${label}`}>
      <Pressable>
        {/*
          The screen gutter as horizontal padding. The navigator renders this slot flush to x=0
          on web, so without it the label touches the edge of the viewport.
        */}
        <Text style={styles.back}>{label}</Text>
      </Pressable>
    </Link>
  );
}

/**
 * A header action on the right.
 *
 * Always carries a label, because a header control is the most likely thing in the app to be
 * icon-only and therefore invisible to a screen reader - which is exactly what happened in v1.
 */
export function HeaderAction({
  href,
  onPress,
  label,
}: {
  href?: string;
  onPress?: () => void;
  label: string;
}) {
  const text = <Text style={styles.action}>{label}</Text>;
  if (href !== undefined) {
    return (
      <Link href={href} asChild accessibilityRole="button" accessibilityLabel={label}>
        <Pressable style={styles.actionWrap}>{text}</Pressable>
      </Link>
    );
  }
  return (
    <Pressable
      style={styles.actionWrap}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      {text}
    </Pressable>
  );
}

/**
 * The header quick-nav strip under a chat or hub header.
 *
 * `PRD/15` gives club chat "Members · Poll · Routines · Events" and race chat "Members · Meet
 * Information · Polls · Car Assignments and Groups". One component, given different entries,
 * rather than one per scope - design-system rule 5.
 */
export function QuickNav({ items }: { items: ReadonlyArray<{ href: string; label: string }> }) {
  return (
    <View style={styles.quickNav}>
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          asChild
          accessibilityRole="button"
          accessibilityLabel={item.label}
        >
          <Pressable style={styles.quickItem}>
            <Text style={styles.quickLabel}>{item.label}</Text>
          </Pressable>
        </Link>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  back: {
    ...type.label,
    color: color.accent,
    textTransform: 'uppercase',
    paddingHorizontal: space.md,
  },
  actionWrap: { paddingHorizontal: space.md, paddingVertical: space.xs },
  action: { ...type.label, color: color.accent, textTransform: 'uppercase' },
  quickNav: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.xs,
    paddingHorizontal: space.md,
    paddingBottom: space.sm,
  },
  quickItem: {
    backgroundColor: color.card,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.divider,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  quickLabel: { ...type.label, color: color.textSecondary, textTransform: 'uppercase' },
});
