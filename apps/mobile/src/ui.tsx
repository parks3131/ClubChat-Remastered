/**
 * The shared UI vocabulary.
 *
 * Everything here exists because it would otherwise be written once per screen, and the version
 * that gets written on screen thirty is the one that forgets the error state or hardcodes a
 * colour. Tokens only - never a colour, radius, spacing value or font size a token covers.
 *
 * Accessibility is applied here rather than remembered per screen. `PRD/16` calls the absence of
 * it "the product's clearest gap" in v1, with zero labels on any icon-only control; a control
 * built from `<Action>` cannot ship without a label because the prop is required.
 */

import type { ComponentProps, ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { Link } from 'expo-router';
import { color, radius, space, type } from './theme.ts';
import type { Loaded } from './use-load.ts';

// ---------------------------------------------------------------------------
// The three states
// ---------------------------------------------------------------------------

/**
 * Wraps a read in its loading, error and empty states.
 *
 * `children` is called only with loaded, non-null data, so a screen body never writes
 * `data?.` or a null guard - which is the other half of why this exists. An error is always
 * retryable and always says something true.
 */
export function DataScreen<T>({
  load,
  children,
  empty,
  isEmpty,
}: {
  load: Loaded<T>;
  children: (data: T) => ReactNode;
  /** Shown instead of `children` when the loaded data is empty. Always tells the truth. */
  empty?: ReactNode;
  isEmpty?: (data: T) => boolean;
}) {
  if (load.state === 'loading' && load.data === null) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={color.accent} />
      </View>
    );
  }

  if (load.state === 'error' && load.data === null) {
    return (
      <View style={styles.centered}>
        <Text style={styles.emptyTitle}>{load.error?.message ?? 'Something went wrong'}</Text>
        <Action label="Retry" onPress={load.reload} />
      </View>
    );
  }

  if (load.data === null) return null;
  if (empty && isEmpty?.(load.data)) return <>{empty}</>;
  return <>{children(load.data)}</>;
}

/** A list's empty state. Never a bare blank: it says what is not there. */
export function EmptyState({ title, body }: { title: string; body?: string }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{title}</Text>
      {body !== undefined && <Text style={styles.emptyBody}>{body}</Text>}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

/**
 * A button.
 *
 * `label` doubles as the accessibility label unless one is given, so no control built from this
 * is invisible to a screen reader. That is the whole reason it is not a bare `Pressable`.
 */
export function Action({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  accessibilityLabel,
  style,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger' | 'quiet';
  disabled?: boolean;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const shape =
    variant === 'primary'
      ? styles.primary
      : variant === 'danger'
        ? styles.danger
        : variant === 'quiet'
          ? styles.quiet
          : styles.secondary;
  const text =
    variant === 'primary' || variant === 'danger' ? styles.primaryLabel : styles.secondaryLabel;

  return (
    <Pressable
      style={[shape, disabled && styles.disabled, style]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled }}
    >
      <Text style={text}>{label}</Text>
    </Pressable>
  );
}

export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  multiline = false,
  keyboardType,
}: {
  label: string;
  value: string;
  onChangeText: (next: string) => void;
  placeholder?: string;
  multiline?: boolean;
  keyboardType?: 'default' | 'url' | 'numeric';
}) {
  return (
    <View style={styles.fieldWrap}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={[styles.input, multiline && styles.inputMultiline]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={color.textSecondary}
        multiline={multiline}
        keyboardType={keyboardType ?? 'default'}
        accessibilityLabel={label}
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

/** A tappable row. The outermost element owns the gesture - see failure mode 16. */
export function Row({
  title,
  subtitle,
  href,
  onPress,
  left,
  right,
  highlighted = false,
  accessibilityLabel,
}: {
  title: string;
  subtitle?: string;
  href?: string;
  onPress?: () => void;
  /** Leading content, typically an `Avatar` or an icon well. */
  left?: ReactNode;
  right?: ReactNode;
  /** The singled-out treatment: an unread notification, a selected choice. */
  highlighted?: boolean;
  accessibilityLabel?: string;
}) {
  // Navigable rows carry a chevron; rows that only hold a value do not. The design uses it as the
  // affordance that a row goes somewhere, so it follows the presence of a destination rather than
  // being decoration a caller opts into.
  const navigable = href !== undefined || onPress !== undefined;

  const body = (
    <View style={[styles.row, highlighted && styles.rowHighlighted]}>
      {/* A plain View for the same reason `right` is - the row owns the gesture. */}
      {left !== undefined && <View>{left}</View>}
      <View style={styles.rowMain}>
        <Text style={styles.rowTitle}>{title}</Text>
        {subtitle !== undefined && <Text style={styles.rowMeta}>{subtitle}</Text>}
      </View>
      {/*
        A plain View, never a nested Pressable. A pressable inside a pressable is a <button>
        inside a <button> on web and swallows the outer gesture on native (failure mode 16).
      */}
      {right !== undefined && <View style={styles.rowRight}>{right}</View>}
      {navigable && (
        // Hidden from the screen reader: the row already announces itself as a button with its
        // own label, and a chevron read out as "greater than" is noise.
        <Text style={styles.chevron} accessibilityElementsHidden importantForAccessibility="no">
          ›
        </Text>
      )}
    </View>
  );

  if (href !== undefined) {
    return (
      <Link
        href={href}
        asChild
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? title}
      >
        <Pressable>{body}</Pressable>
      </Link>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
    >
      {body}
    </Pressable>
  );
}

/** A non-interactive card, for content that is read rather than tapped. */
export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function SectionHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {action}
    </View>
  );
}

export function Badge({
  label,
  tone = 'neutral',
}: {
  label: string;
  tone?: 'neutral' | 'accent' | 'alert' | 'muted';
}) {
  const tint =
    tone === 'accent'
      ? { backgroundColor: color.accent, textColor: color.onAccent }
      : tone === 'alert'
        ? { backgroundColor: color.error, textColor: color.onAccent }
        : tone === 'muted'
          ? { backgroundColor: color.fallback, textColor: color.textSecondary }
          : { backgroundColor: color.secondary, textColor: color.onAccent };

  return (
    <View style={[styles.badge, { backgroundColor: tint.backgroundColor }]}>
      <Text style={[styles.badgeLabel, { color: tint.textColor }]}>{label}</Text>
    </View>
  );
}

/** A letter-initial placeholder when there is no avatar, used consistently everywhere. */
export function Avatar({ name, size = 40 }: { name: string; size?: number }) {
  const initial = name.trim().slice(0, 1).toUpperCase() || '?';
  return (
    <View
      style={[
        styles.avatar,
        // An explicit half-width radius, per the design system, rather than a radius token.
        { width: size, height: size, borderRadius: size / 2 },
      ]}
      accessibilityElementsHidden
      importantForAccessibility="no"
    >
      <Text style={styles.avatarLabel}>{initial}</Text>
    </View>
  );
}

/**
 * A tab strip, in the two shapes v1 ships.
 *
 * One implementation because every screen with tabs would otherwise grow its own, and a
 * selected-tab colour that drifts between them is exactly the kind of defect PRD/16's
 * pixel-perfection standard is about.
 *
 * `segmented` is a track with a raised active pill, which is what v1 uses to switch a view over
 * the same list: All polls / My votes, Upcoming / Past. `pill` is separate accent-filled pills,
 * which v1 uses where the tabs select genuinely different content: Highlights' Pinned /
 * Announcements / Reports. **The distinction carries meaning** - one says "same list, filtered",
 * the other says "different list" - so it is a variant rather than two screens' local styling.
 */
export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
  variant = 'segmented',
}: {
  tabs: ReadonlyArray<{ key: T; label: string }>;
  active: T;
  onChange: (key: T) => void;
  variant?: 'segmented' | 'pill';
}) {
  const pill = variant === 'pill';
  return (
    <View style={pill ? styles.tabsPill : styles.tabs}>
      {tabs.map((tab) => {
        const selected = tab.key === active;
        return (
          <Pressable
            key={tab.key}
            onPress={() => onChange(tab.key)}
            style={[
              pill ? styles.pillTab : styles.tab,
              selected && (pill ? styles.pillTabActive : styles.tabActive),
            ]}
            accessibilityRole="tab"
            accessibilityLabel={tab.label}
            accessibilityState={{ selected }}
          >
            <Text
              style={[
                pill ? styles.pillTabLabel : styles.tabLabel,
                selected && (pill ? styles.pillTabLabelActive : styles.tabLabelActive),
              ]}
            >
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * The floating create control.
 *
 * v1 puts one on every list a member can add to: polls, events, the calendar. Shared because
 * three screens placing their own would be three chances to place it differently, and it is
 * positioned absolutely - so it is the caller's job to leave room at the bottom of the list
 * rather than have the last row sit under it.
 */
export function Fab({
  onPress,
  accessibilityLabel,
  icon = 'add',
}: {
  onPress: () => void;
  /** Required: an icon-only control with no label is the accessibility gap PRD/16 names. */
  accessibilityLabel: string;
  icon?: ComponentProps<typeof MaterialIcons>['name'];
}) {
  return (
    <Pressable
      style={styles.fab}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
    >
      <MaterialIcons name={icon} size={26} color={color.onAccentPressed} />
    </Pressable>
  );
}

/**
 * A screen's own title block: a small eyebrow over a headline.
 *
 * v1's list screens open with one ("Community Voice" over "Active Conversations"), which is what
 * gives them a top edge rather than starting cold at the first row.
 */
export function ScreenHeading({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <View style={styles.heading}>
      <Text style={styles.headingEyebrow}>{eyebrow}</Text>
      <Text style={styles.headingTitle}>{title}</Text>
    </View>
  );
}

/**
 * A search box over a list.
 *
 * Filtering in the client, over data already loaded. Every list that has one in v1 has already
 * read its rows, so a round trip per keystroke would be slower and would break while offline.
 */
export function SearchField({
  value,
  onChangeText,
  placeholder,
}: {
  value: string;
  onChangeText: (next: string) => void;
  placeholder: string;
}) {
  return (
    <View style={styles.searchWrap}>
      <MaterialIcons
        name="search"
        size={18}
        color={color.textSecondary}
        accessibilityElementsHidden
        importantForAccessibility="no"
      />
      <TextInput
        style={styles.searchInput}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={color.textSecondary}
        accessibilityLabel={placeholder}
        autoCapitalize="none"
        autoCorrect={false}
      />
    </View>
  );
}

/**
 * A bottom sheet of choices, and its scrim.
 *
 * **An in-app sheet rather than a platform `Alert`.** A confirmation dialog can report success,
 * log nothing and do nothing where a platform stubs out the dialog API - and react-native-web is
 * exactly such a platform, which is the surface this project develops and tests on. Chat reached
 * the same conclusion independently; this is that decision made once.
 */
export function SheetMenu({
  title,
  items,
  onDismiss,
}: {
  title: string;
  items: ReadonlyArray<{ label: string; onPress: () => void; destructive?: boolean }>;
  onDismiss: () => void;
}) {
  return (
    <View style={styles.sheetBackdrop}>
      <Pressable
        style={styles.sheetScrim}
        onPress={onDismiss}
        accessibilityRole="button"
        accessibilityLabel="Dismiss"
      />
      <View style={styles.sheet}>
        <Text style={styles.sheetTitle}>{title}</Text>
        {items.map((item) => (
          <Pressable
            key={item.label}
            style={styles.sheetRow}
            onPress={item.onPress}
            accessibilityRole="button"
            accessibilityLabel={item.label}
          >
            <Text style={[styles.sheetLabel, item.destructive === true && styles.sheetDestructive]}>
              {item.label}
            </Text>
          </Pressable>
        ))}
        <Pressable
          style={styles.sheetRow}
          onPress={onDismiss}
          accessibilityRole="button"
          accessibilityLabel="Cancel"
        >
          <Text style={styles.sheetLabel}>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}

/**
 * A screen's scrolling body, with the gutter applied.
 *
 * Exists so no screen invents its own padding. `PRD/16`'s pixel-perfection standard names
 * inconsistent spacing as a defect, and inconsistent spacing is what happens when thirty screens
 * each pick their own container.
 */
export function Body({ children }: { children?: ReactNode }) {
  return (
    <ScrollView
      style={styles.bodyScroll}
      contentContainerStyle={styles.bodyContent}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  );
}

/** A label-and-value line, for detail screens. Hidden entirely when the value is empty. */
export function DetailLine({
  label,
  value,
  placeholder,
}: {
  label: string;
  value: string | null;
  /** Shown when empty INSTEAD of hiding the row. Photos and results do this; hotel does not. */
  placeholder?: string;
}) {
  if ((value === null || value.trim().length === 0) && placeholder === undefined) return null;
  return (
    <View style={styles.detailLine}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={value ? styles.detailValue : styles.detailPlaceholder}>
        {value && value.trim().length > 0 ? value : placeholder}
      </Text>
    </View>
  );
}

export const textStyles: Record<string, StyleProp<TextStyle>> = {
  title: { ...type.title, color: color.textPrimary },
  headline: { ...type.headline, color: color.textPrimary },
  body: { ...type.body, color: color.textPrimary },
  meta: { ...type.bodySmall, color: color.textSecondary },
};

const styles = StyleSheet.create({
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.md,
    padding: space.md,
    backgroundColor: color.appBackground,
  },
  empty: { alignItems: 'center', paddingTop: space.xl, gap: space.sm, paddingHorizontal: space.lg },
  emptyTitle: { ...type.title, color: color.textPrimary, textAlign: 'center' },
  emptyBody: { ...type.bodySmall, color: color.textSecondary, textAlign: 'center' },

  primary: {
    backgroundColor: color.accent,
    borderRadius: radius.sm,
    paddingVertical: space.md,
    paddingHorizontal: space.md,
    alignItems: 'center',
  },
  danger: {
    backgroundColor: color.error,
    borderRadius: radius.sm,
    paddingVertical: space.md,
    paddingHorizontal: space.md,
    alignItems: 'center',
  },
  secondary: {
    backgroundColor: color.card,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: color.divider,
    paddingVertical: space.md,
    paddingHorizontal: space.md,
    alignItems: 'center',
  },
  quiet: { paddingVertical: space.sm, paddingHorizontal: space.sm, alignItems: 'center' },
  disabled: { opacity: 0.5 },
  primaryLabel: { ...type.label, color: color.onAccent, textTransform: 'uppercase' },
  secondaryLabel: { ...type.label, color: color.textSecondary, textTransform: 'uppercase' },

  fieldWrap: { gap: space.xs },
  fieldLabel: { ...type.label, color: color.textSecondary, textTransform: 'uppercase' },
  input: {
    backgroundColor: color.card,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: color.divider,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    ...type.body,
    color: color.textPrimary,
  },
  inputMultiline: { minHeight: 88, textAlignVertical: 'top' },

  /*
   * The card treatment, on both `Row` and `Card`.
   *
   * A 16px radius with a 1px hairline, which is v1's single most repeated shape: every row, card
   * and field in the shipped interface carries it. The remaster shipped an 8px borderless block
   * instead, and against a near-white background that reads as no card at all - the border is
   * what separates the surface from the page, not the fill.
   */
  row: {
    backgroundColor: color.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.hairline,
    padding: space.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  rowHighlighted: { backgroundColor: color.accentSoft, borderColor: color.accentSoftBorder },
  rowMain: { flex: 1, gap: space.xs },
  rowRight: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  rowTitle: { ...type.headline, color: color.textPrimary },
  rowMeta: { ...type.bodySmall, color: color.textSecondary },
  chevron: { ...type.title, color: color.border, marginLeft: space.xs },

  card: {
    backgroundColor: color.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.hairline,
    padding: space.md,
    gap: space.sm,
  },

  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: space.lg,
    paddingBottom: space.sm,
    gap: space.sm,
  },
  sectionTitle: { ...type.label, color: color.textSecondary, textTransform: 'uppercase' },

  badge: {
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    minWidth: 24,
    alignItems: 'center',
  },
  badgeLabel: { ...type.label },

  // v1 tints the initial with the accent on a sunken well, rather than greying it out. It is the
  // one place a person's absence of a photo still reads as a person.
  avatar: { backgroundColor: color.cardSunken, alignItems: 'center', justifyContent: 'center' },
  avatarLabel: { ...type.headline, color: color.accent },

  tabs: {
    flexDirection: 'row',
    gap: space.xs,
    backgroundColor: color.chrome,
    borderRadius: radius.md,
    padding: space.xs,
  },
  tab: { flex: 1, paddingVertical: space.sm, alignItems: 'center', borderRadius: radius.sm },
  tabActive: { backgroundColor: color.card },
  tabLabel: { ...type.label, color: color.textSecondary, textTransform: 'uppercase' },
  tabLabelActive: { color: color.accent },

  tabsPill: { flexDirection: 'row', gap: space.sm },
  pillTab: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: space.sm + 2,
    borderRadius: radius.pill,
    backgroundColor: color.cardSunken,
  },
  pillTabActive: { backgroundColor: color.accent },
  pillTabLabel: { ...type.label, color: color.onSecondaryContainer },
  pillTabLabelActive: { color: color.onAccent },

  fab: {
    position: 'absolute',
    right: space.md,
    bottom: space.md,
    width: 56,
    height: 56,
    borderRadius: radius.pill,
    backgroundColor: color.accentPressed,
    alignItems: 'center',
    justifyContent: 'center',
  },

  heading: { paddingHorizontal: space.md, paddingTop: space.lg, gap: space.xs },
  headingEyebrow: { ...type.label, color: color.textSecondary, textTransform: 'uppercase' },
  headingTitle: { ...type.title, fontSize: 24, lineHeight: 30, color: color.textPrimary },

  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: color.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.hairline,
    paddingHorizontal: space.md,
  },
  searchInput: {
    ...type.body,
    flex: 1,
    paddingVertical: space.sm + 4,
    color: color.textPrimary,
  },

  // Explicit edges rather than `StyleSheet.absoluteFillObject`, which this React Native version
  // does not declare on the type.
  sheetBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'flex-end',
    zIndex: 100,
  },
  sheetScrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  sheet: {
    backgroundColor: color.card,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingTop: space.md,
    paddingBottom: space.xl,
  },
  sheetTitle: {
    ...type.label,
    color: color.textSecondary,
    textTransform: 'uppercase',
    textAlign: 'center',
    paddingBottom: space.sm,
  },
  sheetRow: { paddingVertical: space.md, paddingHorizontal: space.md },
  sheetLabel: { ...type.body, color: color.textPrimary, textAlign: 'center' },
  sheetDestructive: { color: color.error },

  bodyScroll: { flex: 1, backgroundColor: color.appBackground },
  bodyContent: { padding: space.md, gap: space.sm, paddingBottom: space.xl },

  detailLine: { gap: space.xs, paddingVertical: space.xs },
  detailLabel: { ...type.label, color: color.textSecondary, textTransform: 'uppercase' },
  detailValue: { ...type.body, color: color.textPrimary },
  detailPlaceholder: { ...type.body, color: color.textSecondary, fontStyle: 'italic' },
});
