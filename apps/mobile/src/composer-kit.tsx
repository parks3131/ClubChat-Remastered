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
import { Children, Fragment, useEffect, useRef } from 'react';
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
/**
 * Several fields as ONE bordered object, with a hairline between each.
 *
 * **Added 2026-09-02, and it is a deliberate exception to this module's own opening paragraph.**
 * That paragraph says a section is a label with air above it rather than a card with a border,
 * which was written after four bordered groups read as four unrelated panels. The exception is
 * narrow and it exists for a defect air could not fix: two outlined fields stacked with a small
 * gap read as one control with a line through it, and at zero gap they genuinely touch. Reported
 * off the phone on 2026-09-02 against the meetup composer, where the map link and the location
 * notes shared an edge.
 *
 * The fix is structural rather than cosmetic: inside a group there is only ever ONE border, so
 * two fields cannot collide however the spacing is later adjusted. Air still separates the
 * groups from each other, which is the half of the original rule that was doing the work.
 *
 * A group of one is legitimate and is not a card for its own sake - it is what keeps a lone
 * field on the same rail as the grouped ones above it.
 */
export function FieldGroup({ children }: { children: ReactNode }) {
  // `toArray` drops null and false, so `{cond && <Field/>}` does not leave a stray divider.
  const items = Children.toArray(children);
  return (
    <View style={styles.fieldGroup}>
      {items.map((child, index) => (
        <Fragment key={index}>
          {index > 0 && <View style={styles.fieldGroupDivider} />}
          {child}
        </Fragment>
      ))}
    </View>
  );
}

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
  tall = false,
  grouped = false,
  trailing,
  autoCapitalize = 'sentences',
  autoCorrect = true,
}: {
  value: string;
  onChangeText: (next: string) => void;
  placeholder: string;
  accessibilityLabel: string;
  filled?: boolean;
  multiline?: boolean;
  /** Inside a `FieldGroup`, which draws the border this field would otherwise draw itself. */
  grouped?: boolean;
  /**
   * Open the field to several lines, for prose rather than a sentence.
   *
   * Per call site rather than a bigger `multiline`, because the two multiline fields in this app
   * want opposite things: a meetup's description is a paragraph and wants room to be one, while a
   * poll's question is nearly always a single line and a tall empty box under it just looks
   * unfinished. `multiline` says the text may wrap; this says it is expected to.
   */
  tall?: boolean;
  /** A control at the field's right edge, such as remove-this-choice. */
  trailing?: ReactNode;
  /**
   * Off for a field holding something the keyboard must not help with.
   *
   * A pasted URL is the case that needed it: iOS capitalises the first letter and autocorrects
   * what it takes for words, and a link that arrives as "Https://Maps.app.goo.gl" is a link the
   * server will not recognise. Everything else keeps the default.
   */
  autoCapitalize?: 'none' | 'sentences';
  autoCorrect?: boolean;
}) {
  return (
    <View
      style={[
        styles.field,
        filled ? styles.fieldFilled : styles.fieldOutlined,
        /* Last, so it strips the border the outlined style just applied. See `FieldGroup`. */
        grouped && styles.fieldGrouped,
      ]}
    >
      <TextInput
        style={[
          styles.fieldInput,
          multiline && styles.fieldInputMultiline,
          multiline && tall && styles.fieldInputTall,
          /* Last, so it lifts the multiline floor rather than being overridden by it. */
          grouped && !tall && styles.fieldInputEven,
        ]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={color.textSecondary}
        multiline={multiline}
        autoCapitalize={autoCapitalize}
        autoCorrect={autoCorrect}
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
  grouped = false,
}: {
  label: string;
  /** The right-hand side: a switch, or a value that opens something. */
  children: ReactNode;
  /** Present when the whole row opens something. A row with a switch passes nothing. */
  onPress?: () => void;
  accessibilityLabel?: string;
  /**
   * Inside a `FieldGroup`, which owns the border but not the inset.
   *
   * A bare row takes its horizontal inset from the form's own padding; inside a group that
   * padding is outside the border, so the row would start hard against the edge while every
   * field beside it is inset. This adds the field's own inset back.
   */
  grouped?: boolean;
}) {
  const rowStyle = [styles.settingRow, grouped && styles.settingRowGrouped];

  const body = (
    <>
      <Text style={styles.settingLabel}>{label}</Text>
      {children}
    </>
  );

  if (onPress === undefined) return <View style={rowStyle}>{body}</View>;

  return (
    <Pressable
      style={rowStyle}
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
  /*
    Inside a `FieldGroup`: no border and no radius, because the group draws both.

    The radius is zeroed rather than left alone even though nothing is painted under it - a
    rounded transparent box clips nothing and looks identical, right up until somebody gives the
    field a background and finds its corners cut inside a square group.
  */
  /*
    Inside a `FieldGroup`: no border, no background, no radius. The group draws all three.

    **`borderWidth: 0` is the load-bearing line and it was missing for one build.** Without it
    every grouped field kept the hairline `fieldOutlined` gave it, so what looked like a divider
    between two rows was really their two adjacent borders - drawn in `hairline`, the bright warm
    colour reserved for the OUTSIDE of a card. The group then read as bright lines everywhere
    rather than as a bright edge around quiet rows, and `fieldGroupDivider` underneath was never
    visible at all. Reported off the phone on 2026-09-02 as the segmenting line being as bright as
    the border, which is exactly what it was.
  */
  fieldGrouped: {
    backgroundColor: 'transparent',
    borderRadius: 0,
    borderWidth: 0,
  },
  /*
    The group: one border around several fields, so two of them can never share an edge.

    `overflow: hidden` is what makes the corners work - the first and last field are square, and
    the group clips them into its own radius rather than each field having to know where it sits.
  */
  fieldGroup: {
    backgroundColor: color.card,
    borderWidth: 1,
    borderColor: color.hairline,
    borderRadius: radius.lg,
    overflow: 'hidden',
  },
  /* The hairline BETWEEN two fields, inset by nothing: it divides rows of one object. */
  fieldGroupDivider: { height: 1, backgroundColor: color.divider },
  fieldInput: { ...type.body, flex: 1, color: color.textPrimary },
  fieldInputMultiline: { minHeight: 44, textAlignVertical: 'top' },
  /*
    Roughly five lines before it has to grow.

    A minimum rather than a height, so the field still grows with the text and never scrolls a
    paragraph inside itself. What this buys is the invitation: a one-line box asks for a phrase,
    and the description of a meetup is meant to be more than that.
  */
  fieldInputTall: { minHeight: 132 },
  /*
    Inside a group, a multiline field starts at one line like its neighbours.

    **Rows of one object have to be the same height, or the group is the uneven thing it was
    introduced to fix.** `fieldInputMultiline` floors the input at 44 so that a multiline field
    LOOKS like it takes more than a line - which is right when it stands alone with air around it,
    and wrong beside a single-line row sharing its border: 12 + 44 + 12 against 12 + 26 + 12 is an
    18 point step, and that step is exactly what was reported on 2026-09-02.

    It removes the floor and nothing else, so the field still grows as it is typed into and still
    aligns its text to the top. A field that genuinely wants the height asks with `tall`, which is
    checked before this and wins.
  */
  fieldInputEven: {
    minHeight: 0,
    /*
      iOS gives a multiline input its own vertical padding on top of the wrapper's, which is worth
      about five points and is the whole of the residual once the 44 floor is lifted. The wrapper
      already owns the air (`field.paddingVertical`), so this is the input declining to add more
      rather than the row losing any.
    */
    paddingTop: 0,
    paddingBottom: 0,
  },

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
  /* Matches `field`'s own inset, so a row and a field inside one group start on the same line. */
  settingRowGrouped: { paddingHorizontal: space.md },
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
