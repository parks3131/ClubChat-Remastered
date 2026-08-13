/**
 * The pieces a create-something form is built from.
 *
 * Written for the poll composer on 2026-08-13, from a reference the founder sent, and extracted
 * rather than inlined because the event, race and meeting composers are the same form with
 * different fields - and because the four of them have already drifted once, each having invented
 * its own card, its own label weight and its own idea of how much air a section gets.
 *
 * **The shape being held: small type, generous space, and no chrome that is not carrying meaning.**
 * A section is a quiet uppercase label with air above it, not a card with a border. A field is a
 * field. The only filled surfaces are the ones you can act on.
 */

import type { ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { color, radius, space, type } from './theme.ts';

/**
 * A section heading: CHOICES, SETTINGS.
 *
 * Uppercased in style rather than in the string, so a screen reader says the word rather than
 * spelling it. The air above it is the section break - there is no rule, no card and no border,
 * because a label with space around it already reads as the start of something.
 */
export function SectionLabel({ children }: { children: string }) {
  return <Text style={styles.sectionLabel}>{children}</Text>;
}

/**
 * The primary action, sized for a header.
 *
 * A pill rather than a bar: it sits beside a title rather than under a form, so it has to read as
 * one control at the end of a row instead of as the end of the page.
 */
export function HeaderAction({
  label,
  onPress,
  disabled = false,
  busyLabel,
  busy = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  /** What it says mid-flight. Absent means it keeps saying `label`. */
  busyLabel?: string;
  busy?: boolean;
}) {
  const off = disabled || busy;

  return (
    <Pressable
      style={[styles.headerAction, off && styles.headerActionOff]}
      onPress={onPress}
      disabled={off}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: off }}
    >
      <MaterialIcons name="send" size={15} color={color.onAccent} />
      <Text style={styles.headerActionLabel}>{busy && busyLabel !== undefined ? busyLabel : label}</Text>
    </Pressable>
  );
}

/**
 * A text field.
 *
 * `filled` is for the one field a form is really about - the question - and outlines everything
 * else. Two weights of the same control, so the eye lands on the important one without it being
 * bigger or bolder than the rest.
 */
export function ComposerField({
  value,
  onChangeText,
  placeholder,
  accessibilityLabel,
  filled = false,
  multiline = false,
  trailing,
}: {
  value: string;
  onChangeText: (next: string) => void;
  placeholder: string;
  accessibilityLabel: string;
  filled?: boolean;
  multiline?: boolean;
  /** A control at the field's right edge, such as remove-this-choice. */
  trailing?: ReactNode;
}) {
  return (
    <View style={[styles.field, filled ? styles.fieldFilled : styles.fieldOutlined]}>
      <TextInput
        style={[styles.fieldInput, multiline && styles.fieldInputMultiline]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={color.textSecondary}
        multiline={multiline}
        accessibilityLabel={accessibilityLabel}
      />
      {trailing}
    </View>
  );
}

/** A full-width filled row that adds another of something. */
export function AddRow({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      style={styles.addRow}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <MaterialIcons name="add" size={18} color={color.textPrimary} />
      <Text style={styles.addRowLabel}>{label}</Text>
    </Pressable>
  );
}

/**
 * One setting: what it is on the left, its state on the right.
 *
 * No description line under the label. The reference has none, and a paragraph under every row
 * turns a settings list into a wall - what actually needs explaining goes in one `SettingNote` at
 * the end of the section, where it can be read once instead of skipped three times.
 */
export function SettingRow({
  label,
  children,
  onPress,
  accessibilityLabel,
}: {
  label: string;
  /** The right-hand side: a switch, or a value that opens something. */
  children: ReactNode;
  /** Present when the whole row opens something. A row with a switch passes nothing. */
  onPress?: () => void;
  accessibilityLabel?: string;
}) {
  const body = (
    <>
      <Text style={styles.settingLabel}>{label}</Text>
      {children}
    </>
  );

  if (onPress === undefined) return <View style={styles.settingRow}>{body}</View>;

  return (
    <Pressable
      style={styles.settingRow}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
    >
      {body}
    </Pressable>
  );
}

/** The value on the right of a `SettingRow` that opens something. Accent when set. */
export function SettingValue({ children, muted = false }: { children: string; muted?: boolean }) {
  return <Text style={[styles.settingValue, muted && styles.settingValueMuted]}>{children}</Text>;
}

/** The one explanatory paragraph a section is allowed. See `SettingRow`. */
export function SettingNote({ children }: { children: string }) {
  return <Text style={styles.settingNote}>{children}</Text>;
}

// ---------------------------------------------------------------------------
// The wheel
// ---------------------------------------------------------------------------

/** The height of one wheel row. Shared by the layout, the snapping and the scroll maths. */
const ROW = 36;
/** How many rows are visible. Odd, so there is a middle one for the band to sit on. */
const VISIBLE = 5;

export type WheelItem = { key: string; label: string };

/**
 * One column of a picker wheel.
 *
 * **Every item is also a button, and that is not a nicety.** Snapping is a scroll behaviour, and
 * scroll behaviour is the part of this that differs most between iOS, Android and a browser - so
 * selection cannot be left to depend on it. Tapping a row selects it on every platform; the
 * snapping is what makes it feel like a wheel.
 */
function WheelColumn({
  items,
  selectedKey,
  onSelect,
  accessibilityLabel,
  flex,
}: {
  items: WheelItem[];
  selectedKey: string;
  onSelect: (key: string) => void;
  accessibilityLabel: string;
  flex: number;
}) {
  const ref = useRef<ScrollView>(null);
  const index = Math.max(
    0,
    items.findIndex((item) => item.key === selectedKey),
  );

  /*
   * Follow the selection, however it changed.
   *
   * Covers both directions: a tap lower down the column scrolls it to the middle, and a change
   * made elsewhere - picking a day that shortens the valid hours, say - drags this column to
   * wherever it now has to be. `animated` because a wheel that teleports reads as a glitch.
   */
  useEffect(() => {
    ref.current?.scrollTo({ y: index * ROW, animated: true });
  }, [index]);

  return (
    <ScrollView
      ref={ref}
      style={{ flex }}
      contentContainerStyle={styles.wheelColumnContent}
      showsVerticalScrollIndicator={false}
      snapToInterval={ROW}
      decelerationRate="fast"
      accessibilityLabel={accessibilityLabel}
      onMomentumScrollEnd={(event) => {
        const landed = Math.round(event.nativeEvent.contentOffset.y / ROW);
        const item = items[Math.min(items.length - 1, Math.max(0, landed))];
        if (item !== undefined && item.key !== selectedKey) onSelect(item.key);
      }}
    >
      {items.map((item) => (
        <Pressable
          key={item.key}
          style={styles.wheelItem}
          onPress={() => onSelect(item.key)}
          accessibilityRole="button"
          accessibilityState={{ selected: item.key === selectedKey }}
          accessibilityLabel={item.label}
        >
          <Text
            style={[styles.wheelLabel, item.key === selectedKey && styles.wheelLabelOn]}
            numberOfLines={1}
          >
            {item.label}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

/**
 * The picker itself: columns side by side, under one highlight band.
 *
 * The band is drawn once for the whole wheel rather than per column, which is what makes the
 * middle row read as one selected line across all three rather than as three separate selections
 * that happen to line up. It takes no touches, or it would eat every tap aimed at the row it sits
 * on top of.
 */
export function Wheel({
  columns,
}: {
  columns: {
    key: string;
    items: WheelItem[];
    selectedKey: string;
    onSelect: (key: string) => void;
    accessibilityLabel: string;
    flex: number;
  }[];
}) {
  return (
    <View style={styles.wheel}>
      <View style={styles.wheelBand} pointerEvents="none" />
      {columns.map((column) => (
        <WheelColumn
          key={column.key}
          items={column.items}
          selectedKey={column.selectedKey}
          onSelect={column.onSelect}
          accessibilityLabel={column.accessibilityLabel}
          flex={column.flex}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  sectionLabel: {
    ...type.label,
    color: color.textSecondary,
    textTransform: 'uppercase',
    marginTop: space.lg,
    marginBottom: space.xs,
  },

  headerAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs + 2,
    backgroundColor: color.accent,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  headerActionOff: { opacity: 0.4 },
  headerActionLabel: { ...type.label, color: color.onAccent },

  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    // Generous, because the air inside the field is what makes the form feel unhurried at a
    // small type size. Cutting this is the first thing that makes it look cramped again.
    paddingVertical: space.sm + 4,
  },
  fieldFilled: { backgroundColor: color.cardSunken },
  fieldOutlined: {
    backgroundColor: color.card,
    borderWidth: 1,
    borderColor: color.hairline,
  },
  fieldInput: { ...type.body, flex: 1, color: color.textPrimary },
  fieldInputMultiline: { minHeight: 44, textAlignVertical: 'top' },

  addRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    backgroundColor: color.cardSunken,
    borderRadius: radius.md,
    paddingVertical: space.sm + 4,
  },
  addRowLabel: { ...type.body, color: color.textPrimary },

  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
    // Taller than a field, because a row of settings with no boxes around them needs the space
    // itself to separate them.
    minHeight: 48,
  },
  settingLabel: { ...type.body, color: color.textPrimary, flex: 1 },
  settingValue: { ...type.bodySmall, color: color.accent },
  settingValueMuted: { color: color.textSecondary },
  settingNote: { ...type.bodySmall, color: color.textSecondary, marginTop: space.sm },

  wheel: {
    flexDirection: 'row',
    height: ROW * VISIBLE,
    marginTop: space.sm,
  },
  wheelBand: {
    position: 'absolute',
    left: 0,
    right: 0,
    // Dead centre: two rows above it, two below.
    top: ROW * Math.floor(VISIBLE / 2),
    height: ROW,
    backgroundColor: color.cardSunken,
    borderRadius: radius.md,
  },
  /*
    Half the wheel's height, less half a row, of padding at each end - which is exactly what lets
    the FIRST and LAST items reach the middle band. Without it neither end of a column is
    selectable by scrolling, and the bug looks like "the wheel will not go to today".
  */
  wheelColumnContent: { paddingVertical: ROW * Math.floor(VISIBLE / 2) },
  wheelItem: { height: ROW, alignItems: 'center', justifyContent: 'center' },
  wheelLabel: { ...type.bodySmall, color: color.textSecondary },
  wheelLabelOn: { ...type.bodySmallStrong, color: color.textPrimary },
});
