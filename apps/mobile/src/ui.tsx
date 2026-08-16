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

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentProps, ComponentType, ReactNode } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Pressable,
  ScrollView,
  StyleSheet,
  Modal,
  Switch,
  Text,
  TextInput,
  useWindowDimensions,
  View,
  type StyleProp,
  type SwitchProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { Link } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { RemoteImage } from './media-bubble.tsx';
import {
  WEEKDAYS,
  monthCells,
  shiftMonth,
  todayParts,
  useMonthPager,
  type MonthCursor,
} from './month-pager.tsx';
import { avatarTint, color, radius, space, type } from './theme.ts';
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
  errorMessage,
}: {
  load: Loaded<T>;
  children: (data: T) => ReactNode;
  /** Shown instead of `children` when the loaded data is empty. Always tells the truth. */
  empty?: ReactNode;
  isEmpty?: (data: T) => boolean;
  /**
   * The failure line, when this screen has a better one than the raw error.
   *
   * "Couldn't load notifications." beats a propagated HTTP message: it names what failed in the
   * reader's terms. The raw error is still the fallback, because a screen that has not thought
   * about its failure text should not silently show nothing.
   */
  errorMessage?: string;
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
        <Text style={styles.emptyTitle}>
          {errorMessage ?? load.error?.message ?? 'Something went wrong'}
        </Text>
        <Action label="Retry" onPress={load.reload} />
      </View>
    );
  }

  if (load.data === null) return null;
  if (empty && isEmpty?.(load.data)) return <>{empty}</>;
  return <>{children(load.data)}</>;
}

/**
 * The masthead a top-level destination wears: its name, big, left, in the accent.
 *
 * **One component rather than one per tab.** Chats and Notifications each hand-rolled this same
 * row, and Calendar and Profile wore a navigator header instead - so the four destinations
 * disagreed about size (28pt against 20pt), colour and alignment, and there was nowhere to fix
 * that once. Design-system rule 5, and the same argument as the policy module one layer up.
 *
 * Three things it owns, each of which was wrong somewhere before it existed:
 *
 *  1. **The top inset is added here, not baked into the style.** This number is about the
 *     hardware - 59pt on one phone, 0 in a browser - and the padding beside it is about the
 *     design. Keeping them separate is why a notch does not become a magic constant.
 *  2. **The title truncates rather than shoving the actions off screen.** The Calendar's title
 *     carries a club's name, so it is the one that can be arbitrarily long.
 *  3. **A destination with no actions still gets the same row**, so all four line up at the same
 *     height whether or not anything sits on the right.
 *
 * Not for a screen you can go BACK from: those wear a navigator header with a back control, and
 * a masthead is the mark of a place you arrive at rather than one you travelled to.
 */
export function DestinationHeader({ title, children }: { title: string; children?: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.destinationHeader, { paddingTop: insets.top + space.sm }]}>
      <Text style={styles.destinationTitle} numberOfLines={1}>
        {title}
      </Text>
      {children === undefined ? null : <View style={styles.destinationActions}>{children}</View>}
    </View>
  );
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

/**
 * A switch that is the accent colour on every platform.
 *
 * > **`activeThumbColor` is not optional, and leaving it out is not a cosmetic bug.**
 * > react-native-web supports `activeThumbColor` and `ios_backgroundColor` at runtime, but
 * > React Native's own bundled types do not declare them, hence the cast. Without
 * > `activeThumbColor` set explicitly, **react-native-web's "on" thumb silently defaults to
 * > teal regardless of `trackColor`** - so a toggle that is correct on a phone turns green on
 * > the web build, in an app that has exactly one accent.
 *
 * This is v1's `ThemedSwitch`, carried over with its reason. It was found there the expensive
 * way: a founder flagged an announcement toggle turning green, having been read as correct in
 * review because the native build was fine.
 */
const AnySwitch = Switch as ComponentType<Record<string, unknown>>;

export function ThemedSwitch(props: SwitchProps) {
  return (
    <AnySwitch
      trackColor={{ false: color.cardSunken, true: color.accent }}
      thumbColor={color.onAccent}
      activeThumbColor={color.onAccent}
      ios_backgroundColor={color.cardSunken}
      {...props}
    />
  );
}

/**
 * "Are you sure?", for something that cannot be undone.
 *
 * > **Deliberately in-app, and not `Alert.alert` or `window.confirm`.** `PRD/00` says any
 * > behaviour must work identically on iOS, Android and web, and names confirmation dialogs as
 * > one of the things that behaves differently on each and "has caused a shipped bug". A native
 * > alert also blocks the JavaScript thread on web, which makes the flow untestable in a browser.
 *
 * The destructive button carries the verb - "Delete poll", not "OK" - so the last thing read
 * before the tap is what is about to happen.
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  /**
   * The way OUT. "Cancel" everywhere except where the destructive action is itself a
   * cancellation.
   *
   * > **"Cancel" beside "Cancel meeting" is a coin toss, not a choice.** Both buttons start with
   * > the same word and one of them means "do nothing" - which is exactly the moment a dialog
   * > has to be unambiguous. That screen passes "Keep it".
   */
  dismissLabel = 'Cancel',
  onConfirm,
  onCancel,
  hosted = false,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  dismissLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  /**
   * Draw without a `Modal` of this dialog's own, for a caller already inside one.
   *
   * Same reason as `ContextMenu`'s: iOS presents one modal per view controller and refuses the
   * second in silence, so a confirmation raised from inside a panel belongs to that panel's
   * modal - `RisingSheet`'s `overlay` - rather than being a new one.
   */
  hosted?: boolean;
}) {
  const Host = hosted ? HostedOverlay : ConfirmDialogModal;

  return (
    <Host onDismiss={onCancel}>
      <View style={styles.pickerBackdrop}>
        <Pressable
          style={styles.pickerScrim}
          onPress={onCancel}
          accessibilityRole="button"
          accessibilityLabel="Cancel"
        />
        <View style={styles.confirmSheet}>
          <Text style={styles.confirmTitle}>{title}</Text>
          <Text style={styles.confirmBody}>{body}</Text>
          <View style={styles.confirmActions}>
            <Action
              label={dismissLabel}
              variant="secondary"
              style={styles.confirmAction}
              onPress={onCancel}
            />
            <Action
              label={confirmLabel}
              variant="danger"
              style={styles.confirmAction}
              onPress={onConfirm}
            />
          </View>
        </View>
      </View>
    </Host>
  );
}

/** The dialog's own modal, for the ordinary case where nothing else is presented. */
function ConfirmDialogModal({
  children,
  onDismiss,
}: {
  children: ReactNode;
  onDismiss: () => void;
}) {
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onDismiss}>
      {children}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Date and time
// ---------------------------------------------------------------------------

/** `YYYY-MM-DD` from a Date, in LOCAL time. `toISOString` would shift the day across midnight. */
function isoDate(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * One month of day cells inside the picker's pager.
 *
 * **Memoised for the reason the calendar's grid is:** the live heading re-renders the pager as
 * the finger crosses half a page, and without this that rebuilds 126 cells across three grids at
 * the exact moment the frame budget is already going on a scroll.
 *
 * Filler days from the neighbouring months are drawn blank rather than as pickable dates. The
 * grid is a fixed six weeks so its height never changes as months page, which is the same rule
 * the calendar grid follows and the reason a month starting on a Saturday does not make the
 * sheet jump.
 */
const PickerMonth = memo(function PickerMonth({
  year,
  month,
  value,
  width,
  onPick,
}: {
  year: number;
  month: number;
  /** The chosen day, `YYYY-MM-DD`, or empty. */
  value: string;
  /** The pager's measured width. Null before first layout, when nothing is drawn yet. */
  width: number | null;
  onPick: (iso: string) => void;
}) {
  const cells = useMemo(() => monthCells(year, month), [year, month]);

  return (
    <View style={width === null ? undefined : { width }}>
      <View style={styles.dayGrid}>
        {cells.map((date, index) => {
          // A day belonging to the month either side. Drawn as a hole rather than as a date,
          // so tapping near the edge of a month cannot silently choose a day in another one.
          if (date.getMonth() !== month - 1) {
            return <View key={`pad-${index}`} style={styles.dayCell} />;
          }
          const iso = isoDate(date);
          const chosen = iso === value;
          return (
            <Pressable
              key={iso}
              style={[styles.dayCell, chosen && styles.dayCellOn]}
              onPress={() => onPick(iso)}
              accessibilityRole="button"
              accessibilityState={{ selected: chosen }}
              accessibilityLabel={iso}
            >
              <Text style={[styles.dayLabel, chosen && styles.dayLabelOn]}>{date.getDate()}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
});

/**
 * A date, chosen from a month grid rather than typed.
 *
 * > **`YYYY-MM-DD` in a text box is a format quiz.** It was one here, and the validity check
 * > rejected everything a person would naturally type. A grid cannot produce an invalid date.
 *
 * Built rather than pulled in: the app has no date-picker dependency, and the one screen that
 * already draws a month is the calendar tab, so this is that grid at field size. It also keeps
 * iOS, Android and web identical, which a platform-native picker would not.
 */
export function DateField({
  label,
  value,
  onChange,
  optional = false,
}: {
  label: string;
  /** `YYYY-MM-DD`, or empty for unset. */
  value: string;
  onChange: (next: string) => void;
  optional?: boolean;
}) {
  const [open, setOpen] = useState(false);
  /*
   * A 1-based `MonthCursor`, not a Date, because that is what the shared pager speaks.
   *
   * Seeded from the chosen day so reopening the picker lands on the month you are looking at,
   * and built from split components rather than by parsing - `new Date('2026-09-12')` is UTC
   * midnight and lands on the 11th west of Greenwich.
   */
  const [cursor, setCursor] = useState<MonthCursor>(() => {
    if (value) {
      const [y, m] = value.split('-');
      return { year: Number(y), month: Number(m) };
    }
    return todayParts();
  });

  /*
   * The same swipe the Calendar destination uses, from the same hook.
   *
   * > **Buttons AND slide.** The chevrons stay and are still the accessible path - a swipe is
   * > not announceable and cannot be performed by anybody driving this with a switch or a
   * > keyboard - and the drag is what somebody reaches for first.
   */
  const pager = useMonthPager(cursor, (delta) => setCursor((c) => shiftMonth(c, delta)));
  const { shown } = pager;

  return (
    <>
      <Pressable
        style={styles.pickerField}
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={value ? `${label}, ${value}. Change` : `Choose ${label}`}
      >
        <Text style={value ? styles.pickerValue : styles.pickerPlaceholder}>
          {value || 'YYYY-MM-DD'}
        </Text>
        <MaterialIcons name="calendar-today" size={18} color={color.accent} />
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <View style={styles.pickerBackdrop}>
          <Pressable
            style={styles.pickerScrim}
            onPress={() => setOpen(false)}
            accessibilityRole="button"
            accessibilityLabel="Close"
          />
          <View style={styles.pickerSheet}>
            <View style={styles.pickerHead}>
              <Pressable
                onPress={() => setCursor((c) => shiftMonth(c, -1))}
                hitSlop={space.sm}
                accessibilityRole="button"
                accessibilityLabel="Previous month"
              >
                <MaterialIcons name="chevron-left" size={26} color={color.textPrimary} />
              </Pressable>
              {/*
                Named from the pager's `shown`, not from the cursor, so the month name travels
                WITH the grid under the finger instead of snapping half a second after it. That
                lag was the first thing reported about the calendar's swipe.
              */}
              <Text style={styles.pickerMonth}>
                {new Date(shown.year, shown.month - 1, 1).toLocaleDateString(undefined, {
                  month: 'long',
                  year: 'numeric',
                })}
              </Text>
              <Pressable
                onPress={() => setCursor((c) => shiftMonth(c, 1))}
                hitSlop={space.sm}
                accessibilityRole="button"
                accessibilityLabel="Next month"
              >
                <MaterialIcons name="chevron-right" size={26} color={color.textPrimary} />
              </Pressable>
            </View>

            <View style={styles.weekRow}>
              {WEEKDAYS.map((day, index) => (
                <Text key={index} style={styles.weekday}>
                  {day}
                </Text>
              ))}
            </View>

            {/*
              Three months in a row, resting on the middle one. The sheet has no vertical scroll
              of its own, so the only gesture to arbitrate against is the day tap - which a
              ScrollView leaves alone and a PanResponder would eat.
            */}
            <View onLayout={pager.onLayout}>
              <ScrollView ref={pager.pagerRef} {...pager.pagerProps}>
                {pager.months.map((m) => (
                  <PickerMonth
                    key={`${m.year}-${m.month}`}
                    year={m.year}
                    month={m.month}
                    value={value}
                    width={pager.width}
                    onPick={(iso) => {
                      onChange(iso);
                      setOpen(false);
                    }}
                  />
                ))}
              </ScrollView>
            </View>

            {/* Only where the field may legitimately be empty, so it cannot clear a required one. */}
            {optional && value.length > 0 && (
              <Pressable
                onPress={() => {
                  onChange('');
                  setOpen(false);
                }}
                accessibilityRole="button"
                accessibilityLabel={`Clear ${label}`}
              >
                <Text style={styles.pickerClear}>CLEAR</Text>
              </Pressable>
            )}
          </View>
        </View>
      </Modal>
    </>
  );
}

const HOURS = Array.from({ length: 24 }, (_, i) => `${i}`.padStart(2, '0'));
const MINUTES = Array.from({ length: 12 }, (_, i) => `${i * 5}`.padStart(2, '0'));

/**
 * A time, chosen from two wheels, the way a phone's alarm does it.
 *
 * Minutes step by five deliberately: a club meets at half past, not at 17:23, and twelve targets
 * are reachable where sixty are a scroll hunt.
 */
export function TimeField({
  label,
  value,
  onChange,
}: {
  label: string;
  /** `HH:MM`, or empty for unset. */
  value: string;
  onChange: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [hour, minute] = value.split(':');

  /*
   * `||`, not `??`.
   *
   * An unset field splits to `['']`, so the hour is the EMPTY STRING rather than undefined - and
   * `?? '00'` does not catch an empty string. Picking the minutes first therefore produced ":00"
   * with no hour at all, which parsed to an invalid date and silently disabled the save button
   * with nothing on screen explaining why.
   */
  const commit = (nextHour: string, nextMinute: string) =>
    onChange(`${nextHour || '00'}:${nextMinute || '00'}`);

  return (
    <>
      <Pressable
        style={styles.pickerField}
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={value ? `${label}, ${value}. Change` : `Choose ${label}`}
      >
        <Text style={value ? styles.pickerValue : styles.pickerPlaceholder}>
          {value || 'HH:MM'}
        </Text>
        <MaterialIcons name="schedule" size={18} color={color.accent} />
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <View style={styles.pickerBackdrop}>
          <Pressable
            style={styles.pickerScrim}
            onPress={() => setOpen(false)}
            accessibilityRole="button"
            accessibilityLabel="Close"
          />
          <View style={styles.pickerSheet}>
            <Text style={styles.pickerMonth}>{label}</Text>
            <View style={styles.wheels}>
              <ScrollView style={styles.wheel} showsVerticalScrollIndicator={false}>
                {HOURS.map((h) => (
                  <Pressable
                    key={h}
                    style={[styles.wheelItem, h === hour && styles.wheelItemOn]}
                    onPress={() => commit(h, minute ?? '')}
                    accessibilityRole="button"
                    accessibilityState={{ selected: h === hour }}
                    accessibilityLabel={`${h} hours`}
                  >
                    <Text style={[styles.wheelLabel, h === hour && styles.wheelLabelOn]}>{h}</Text>
                  </Pressable>
                ))}
              </ScrollView>
              <Text style={styles.wheelColon}>:</Text>
              <ScrollView style={styles.wheel} showsVerticalScrollIndicator={false}>
                {MINUTES.map((m) => (
                  <Pressable
                    key={m}
                    style={[styles.wheelItem, m === minute && styles.wheelItemOn]}
                    onPress={() => commit(hour ?? '', m)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: m === minute }}
                    accessibilityLabel={`${m} minutes`}
                  >
                    <Text style={[styles.wheelLabel, m === minute && styles.wheelLabelOn]}>{m}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            </View>
            <Action label="Done" onPress={() => setOpen(false)} />
          </View>
        </View>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

/** A tappable row. The outermost element owns the gesture - see failure mode 16. */
export function Row({
  title,
  subtitle,
  body,
  href,
  onPress,
  left,
  right,
  highlighted = false,
  flat = false,
  accessibilityLabel,
  navigates,
}: {
  title: string;
  subtitle?: string;
  /**
   * The row's whole middle, when a title-and-subtitle pair is the wrong shape for it.
   *
   * A notification is one sentence with emphasis inside it - "**48 unread** messages in **Track
   * Club** chat" - not a heading over a detail line. Forcing that into `title` would either lose
   * the mixed weight or put the timestamp somewhere it does not belong.
   */
  body?: ReactNode;
  href?: string;
  onPress?: () => void;
  /** Leading content, typically an `Avatar` or an icon well. */
  left?: ReactNode;
  right?: ReactNode;
  /** The singled-out treatment: an unread notification, a selected choice. */
  highlighted?: boolean;
  /**
   * Full-bleed and uncarded: no edge, no radius, no chevron, and the gutter on the row rather
   * than on the list.
   *
   * The reason it is a parameter and not a second component is what `highlighted` does under it.
   * A carded highlighted row is a tinted card with a gap above and below; a flat one tints edge
   * to edge, so a run of unread rows becomes one continuous band. That is a property of the
   * variant, not of the caller, and it cannot be expressed by a caller passing a style.
   */
  flat?: boolean;
  accessibilityLabel?: string;
  /**
   * Whether the tap goes somewhere, when the answer is not what the props suggest.
   *
   * The chevron means "this row has a destination", and for almost every row that is exactly the
   * presence of `href` or `onPress`. The exception is a row whose tap *does* something and stays
   * put - "Copy Link" is one - where a chevron promises a screen that never arrives.
   */
  navigates?: boolean;
}) {
  /*
   * Navigable rows carry a chevron; rows that only hold a value do not. The design uses it as the
   * affordance that a row goes somewhere, so it follows the presence of a destination rather than
   * being decoration a caller opts into.
   *
   * **A flat row never draws one.** The chevron belongs to the carded list, where it sits against
   * an edge; on a full-bleed row it reads as a stray character at the end of a sentence. What
   * replaces it as the "this is a control" cue is the pressed wash below, which is why that is not
   * optional for the variant.
   */
  const navigable = !flat && (navigates ?? (href !== undefined || onPress !== undefined));

  const content = (pressed: boolean) => (
    <View
      style={[
        styles.row,
        highlighted && styles.rowHighlighted,
        flat && styles.rowFlat,
        // Order matters: the tint has to sit over the unread fill rather than under it, or a
        // pressed unread row shows no change at all.
        flat && highlighted && styles.rowFlatHighlighted,
        flat && pressed && styles.rowFlatPressed,
      ]}
    >
      {/* A plain View for the same reason `right` is - the row owns the gesture. */}
      {left !== undefined && <View>{left}</View>}
      <View style={styles.rowMain}>
        {body ?? (
          <>
            <Text style={styles.rowTitle}>{title}</Text>
            {subtitle !== undefined && <Text style={styles.rowMeta}>{subtitle}</Text>}
          </>
        )}
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
        <Pressable>{({ pressed }) => content(pressed)}</Pressable>
      </Link>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
    >
      {({ pressed }) => content(pressed)}
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

/**
 * Somebody's - or something's - face: their picture, or their initial when there is none.
 *
 * **The fallback is not an error state.** Most people and most spaces have no picture, so the
 * lettered circle is the ordinary case and the photograph is the exception, which is why they
 * live in one component rather than in a conditional at every call site. Four screens had already
 * written that conditional by hand before this took the `image` prop.
 *
 * `shape` is the product's one rule about roundness: **circles are people, rounded squares are
 * things.** A club, a race and Eboard & Council are things.
 */
export function Avatar({
  name,
  size = 40,
  image = null,
  shape,
  kind = 'person',
  tintId = null,
  ring = false,
}: {
  name: string;
  size?: number;
  /** A media id. Null - the common case - draws the initial instead. */
  image?: string | null;
  /**
   * Roundness, which **defaults to whatever `kind` already said** rather than to a fixed value.
   *
   * These two props encode one fact - is this a person or a thing - and while they were
   * independent they drifted: the Chats list passed `kind="group"` and no shape, so every club
   * on the landing screen drew the group glyph inside a circle. A caller that has said `group`
   * has already said `square`, and having to say it twice is having the chance to say it once.
   *
   * Still overridable, because the override is legible at the call site and the disagreement
   * was not.
   */
  shape?: 'circle' | 'square';
  /**
   * What the fallback should draw when there is no picture.
   *
   * `person` is an initial, which is meaningless for a group: "B" tells you nothing about
   * Binghamton Running Club that the name beside it does not already say, and a list of clubs
   * becomes a column of unrelated letters. `group` draws a two-person glyph instead, so the
   * shape alone separates a club from a person before any word is read.
   */
  kind?: 'person' | 'group';
  /**
   * The id a `group` tint is derived from. Falls back to the name.
   *
   * An id rather than the name because a club can be renamed and should not change colour when
   * it is. See `avatarTint`.
   */
  tintId?: string | null;
  /**
   * Draw a hairline ring instead of a filled disc.
   *
   * Opt-in rather than the default: this is the 2026-08-09 Chats treatment, and turning it on
   * everywhere at once would restyle every roster, profile and chat bubble in the product in a
   * change that was scoped to one screen. The follow-up pass is where the default flips.
   */
  ring?: boolean;
}) {
  const resolvedShape = shape ?? (kind === 'group' ? 'square' : 'circle');
  const borderRadius = resolvedShape === 'circle' ? size / 2 : Math.round(size / 4);

  if (image !== null) {
    return (
      <RemoteImage
        mediaId={image}
        variant="thumb"
        style={{ width: size, height: size, borderRadius }}
        resizeMode="cover"
      />
    );
  }

  if (kind === 'group') {
    return (
      <View
        style={[
          styles.avatar,
          ring && styles.avatarRing,
          { width: size, height: size, borderRadius },
        ]}
        accessibilityElementsHidden
        importantForAccessibility="no"
      >
        <MaterialIcons
          name="group"
          size={Math.round(size * 0.5)}
          color={avatarTint(tintId ?? name)}
        />
      </View>
    );
  }

  const initial = name.trim().slice(0, 1).toUpperCase() || '?';
  /*
   * The initial scales with the circle, for the same reason the radius does. A fixed size read
   * as a full-height letter in a 28px stack avatar and as a speck adrift in a 96px profile one -
   * the ratio is what makes it look like the same placeholder at every size. 0.42 is the ratio
   * the 40px default already had, so no avatar already in the app changes.
   */
  const initialSize = Math.round(size * 0.42);
  return (
    <View
      style={[
        styles.avatar,
        ring && styles.avatarRing,
        // An explicit radius computed from the size, per the design system, rather than a
        // radius token - a token would not scale with a 28px stack avatar and a 140px profile.
        { width: size, height: size, borderRadius },
      ]}
      accessibilityElementsHidden
      importantForAccessibility="no"
    >
      <Text style={[styles.avatarLabel, { fontSize: initialSize, lineHeight: Math.round(initialSize * 1.25) }]}>
        {initial}
      </Text>
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
  tabs: ReadonlyArray<{
    key: T;
    label: string;
    /**
     * A number shown beside the label, or absent.
     *
     * **Absent at zero rather than showing "0"**, which is the rule the notification badge
     * already follows: a chip reading "Unread 0" is a count of nothing dressed as information,
     * and it is exactly the state where the word alone is the whole answer. Tapping it then
     * lands on "You're all caught up", which says the same thing in the place with room to.
     */
    count?: number;
  }>;
  /**
   * The selected tab, or **null for none**.
   *
   * Null exists for the chat list's filter chips, where "no filter" is the resting state rather
   * than a fourth chip called All - which is what the design shows and what stops the landing
   * screen ever being an empty list. Every other caller passes a real key and is unaffected,
   * since `T` is assignable to `T | null`.
   */
  active: T | null;
  onChange: (key: T) => void;
  variant?: 'segmented' | 'pill' | 'chip';
}) {
  const pill = variant === 'pill';
  const chip = variant === 'chip';

  if (chip) {
    return (
      <View style={styles.chipRow}>
        {tabs.map((tab) => {
          const selected = tab.key === active;
          const count = tab.count ?? 0;
          return (
            <Pressable
              key={tab.key}
              onPress={() => onChange(tab.key)}
              style={[styles.chip, selected && styles.chipActive]}
              accessibilityRole="tab"
              accessibilityLabel={count > 0 ? `${tab.label}, ${count}` : tab.label}
              accessibilityState={{ selected }}
            >
              <Text style={[styles.chipLabel, selected && styles.chipLabelActive]}>
                {tab.label}
              </Text>
              {count > 0 && (
                <Text style={[styles.chipCount, selected && styles.chipCountActive]}>
                  {count > 99 ? '99+' : count}
                </Text>
              )}
            </Pressable>
          );
        })}
      </View>
    );
  }

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
 * A panel that rises from the bottom edge while the screen behind it dims in place.
 *
 * **The two halves are animated separately, and that is the whole point of this component.**
 *
 * > `animationType="slide"` on a `Modal` translates the WHOLE modal, scrim included, so the
 * > dimming arrives as a shaded band sweeping up the screen with a hard edge across the middle of
 * > whatever is behind it - reported from the device on 2026-08-13 as "the shade going up and
 * > down". What every other app does is dim where it stands and move only the panel.
 *
 * So the modal itself animates nothing and these two values do the work: `dim` fades the scrim in
 * place, `rise` slides the panel up from below its own bottom edge. Both run on the native driver,
 * which keeps them smooth while whatever is behind is still settling.
 *
 * **The panel is measured rather than given a height**, because it hugs its content: a card about
 * a person and a list of thirty reactors are different distances from off-screen, and a constant
 * would make the short one crawl and the tall one snap. It is invisible until measured, so it
 * never appears at its resting place for the one frame before the animation knows its distance.
 *
 * `children` is a function so that anything inside can dismiss with the exit animation rather than
 * by yanking the panel off screen; `requestClose` is the same exit for a caller that decides from
 * the outside that there is nothing left to show.
 */
export function RisingSheet({
  children,
  overlay,
  onDismiss,
  requestClose = false,
  label = 'Close',
}: {
  children: (close: () => void) => ReactNode;
  /**
   * Anything that has to draw OVER the panel and cover the whole screen: a menu, a confirmation,
   * a second list. Rendered inside this component's own modal, as a sibling of the panel.
   *
   * > **This exists because of iOS, and it is not a convenience.** A `Modal` rendered as a
   * > SIBLING of this one - the obvious way to write a menu that belongs to a panel - never
   * > appears on iOS. Only one modal can be presented per view controller, so the second is
   * > silently refused; on 2026-08-14 that shipped as a card whose "..." did nothing, whose club
   * > faces did nothing, and whose only working control was the one that navigated instead of
   * > opening something. Web showed all of it working, because a browser has no such rule.
   *
   * So anything above this panel goes HERE, inside the one modal, and the components that draw it
   * take a `hosted` prop that skips their own `Modal` wrapper. Window coordinates still line up:
   * this modal fills the screen, so an absolutely-positioned child of it shares the window's
   * coordinate system, which is the reason `ContextMenu` reached for a modal in the first place.
   */
  overlay?: ReactNode;
  /** Called once the exit animation has finished, never before it. */
  onDismiss: () => void;
  /** Flip to true to play the exit from outside - "the thing this was about is gone". */
  requestClose?: boolean;
  /** What the scrim announces to a screen reader as the way out. */
  label?: string;
}) {
  const insets = useSafeAreaInsets();
  const { dim, rise, sheetHeight, setSheetHeight, close } = useRisingSheet(onDismiss);

  useEffect(() => {
    if (requestClose) close();
  }, [requestClose, close]);

  return (
    <Modal visible transparent animationType="none" onRequestClose={close}>
      <View style={styles.risingBackdrop}>
        {/*
          The scrim is a sibling filling the screen, never a wrapper: a Pressable around the panel
          would put every row inside another press target, which is failure mode 17.
        */}
        <Animated.View
          style={[styles.risingScrim, { opacity: dim }]}
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no"
        />
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={close}
          accessibilityRole="button"
          accessibilityLabel={label}
        />
        {/* The home indicator is the phone's, not ours: the last row stops above it. */}
        <Animated.View
          onLayout={(event) => setSheetHeight(event.nativeEvent.layout.height)}
          style={[
            styles.risingSheet,
            {
              paddingBottom: insets.bottom + space.sm,
              opacity: sheetHeight === 0 ? 0 : 1,
              transform: [
                {
                  translateY: rise.interpolate({
                    inputRange: [0, 1],
                    outputRange: [sheetHeight, 0],
                  }),
                },
              ],
            },
          ]}
        >
          {/* The grabber says "this came from the edge" before a word of it has been read. */}
          <View style={styles.risingGrabber} />
          {children(close)}
        </Animated.View>
        {/* Last in the tree, so it draws over the panel rather than inside it. */}
        {overlay}
      </View>
    </Modal>
  );
}

/**
 * The motion behind `RisingSheet`, on its own, for a panel that draws its own shell.
 *
 * Chat's reactor sheet is the other caller: it had all of this inline first, and its own layout is
 * elaborate enough that sharing the *values* rather than the wrapper is the smaller change. What
 * matters is that the durations, the easings and the measure-then-travel trick have one definition
 * - two panels rising at different speeds is exactly the kind of drift nobody files a bug about
 * and everybody feels.
 */
export function useRisingSheet(onDismiss: () => void) {
  const dim = useRef(new Animated.Value(0)).current;
  const rise = useRef(new Animated.Value(0)).current;
  const [sheetHeight, setSheetHeight] = useState(0);

  useEffect(() => {
    Animated.timing(dim, {
      toValue: 1,
      duration: 160,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  }, [dim]);

  useEffect(() => {
    if (sheetHeight === 0) return;
    Animated.timing(rise, {
      toValue: 1,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [rise, sheetHeight]);

  /**
   * Leave the way it arrived, then unmount.
   *
   * The parent drops this the moment it is told to, so the exit has to finish first - otherwise
   * the scrim vanishes in one frame, which is the same jolt the entrance had.
   *
   * > **The shade must never lift before the panel has gone**, and getting that wrong is what the
   * > founder reported from his phone on 2026-08-14 as "whenever I click, it just stucks in
   * > between". The exit ran the shade out in 140ms on a quadratic and the panel in 160ms on a
   * > **cubic** - and a cubic-in curve barely moves for its first half, so a third of the way
   * > through the panel had travelled a quarter of its distance while the dimming was already
   * > essentially gone. What you see is a card hanging halfway up a perfectly normal-looking
   * > list, which reads as a frozen screen rather than as an animation.
   *
   * So the panel now leaves on the gentler curve and the shade on the steeper one: the dimming is
   * the LAST thing on screen, every time. The entrance is deliberately the other way round -
   * shade first, then the panel arrives into an already-dimmed screen.
   *
   * > **The fix is the ORDER, not the duration, and the first attempt confused the two.** Slowing
   * > the exit to 200/220ms did fix the overlap and made every sheet in the app feel sluggish -
   * > reported immediately, about the reactions sheet, which shares this hook and had been fine
   * > for a day. The exit is back to its original length; only the curves changed places. If this
   * > ever needs adjusting again, move the easings, and leave the clock alone.
   */
  const closing = useRef(false);
  const close = useCallback(() => {
    // Once only. The scrim can be tapped twice in the time the exit takes, and `requestClose`
    // re-fires its effect whenever the caller hands down a fresh `onDismiss` - either would
    // restart the animation from wherever it had got to, which reads as a stutter on the way out.
    if (closing.current) return;
    closing.current = true;
    Animated.parallel([
      Animated.timing(dim, {
        toValue: 0,
        // Ten milliseconds behind the panel, so the shade is last off screen by a hair rather
        // than by a beat. Any longer and the whole app feels like it is thinking about it.
        duration: 170,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(rise, {
        toValue: 0,
        duration: 160,
        easing: Easing.in(Easing.quad),
        useNativeDriver: true,
      }),
    ]).start(() => onDismiss());
  }, [dim, rise, onDismiss]);

  return { dim, rise, sheetHeight, setSheetHeight, close };
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
 * The pressed row's rectangle in window coordinates.
 *
 * A rectangle rather than the touch point, because the menu lifts the row itself and has to draw
 * it back exactly where it was. `measureRow` below is how a row produces one.
 */
export type PressAnchor = { x: number; y: number; width: number; height: number };

export type ContextMenuItem = {
  label: string;
  icon: ComponentProps<typeof MaterialIcons>['name'];
  onPress: () => void;
  /** Red, for an action that ends something. At most one, and always last. */
  destructive?: boolean;
};

/** The card's fixed width, and the height one row occupies. Used to keep it on screen. */
const CONTEXT_MENU_WIDTH = 248;
const CONTEXT_MENU_ROW = 48;
/** How much the lifted row grows. Enough to read as picked up, not enough to reflow its text. */
const LIFT_SCALE = 1.04;

/**
 * Measure a row for `ContextMenu`, from its own long-press handler.
 *
 * `measureInWindow` is asynchronous, so this resolves a frame later than the press. That is
 * deliberate and invisible: the haptic has already fired, and the menu is not drawn until the
 * rectangle is known - which is what stops it appearing at a wrong position and correcting
 * itself on the next frame.
 *
 * Falls back to a zero-height rect at the touch point if the view has gone, so a menu still
 * opens rather than the gesture doing nothing.
 */
export function measureRow(
  view: { measureInWindow: (cb: (x: number, y: number, w: number, h: number) => void) => void } | null,
  fallback: { x: number; y: number },
  then: (anchor: PressAnchor) => void,
): void {
  if (!view) {
    then({ x: fallback.x, y: fallback.y, width: 0, height: 0 });
    return;
  }
  view.measureInWindow((x, y, width, height) => then({ x, y, width, height }));
}

/**
 * The long-press menu: the row lifts, the screen blurs behind it, the menu springs in.
 *
 * **A popover rather than `SheetMenu` above, and the difference is not decoration.** A bottom
 * sheet fills the bottom of the screen, which is where the tab bar is: on the club hub the sheet
 * opened underneath it, so "Pin" was visible and Cancel was not. This cannot be clipped, and it
 * keeps the row you pressed on screen - which is what makes the menu belong to that row.
 *
 * Three things happen together, and they are one gesture rather than three effects:
 *
 *  - **The row is drawn again, floating at the exact rectangle it occupies in the list**, and
 *    grows by `LIFT_SCALE`. Redrawn rather than snapshotted, because React Native has no cheap
 *    view snapshot - the caller passes the same row component it already renders, which is also
 *    what keeps the lifted copy from drifting from the real one.
 *  - **The background blurs** rather than dimming to grey. A dim says "something is in front";
 *    a blur says "this is still your list, and it is waiting".
 *  - **The menu springs from slightly small and slightly high**, so it reads as coming out of
 *    the row rather than fading in over it.
 *
 * **No Cancel row.** Tapping anywhere else dismisses, and in a menu this short a Cancel would be
 * a fifth of its height spent on "never mind". `SheetMenu` keeps its Cancel because a sheet has
 * no obvious outside to tap.
 *
 * The card's height is COMPUTED from the item count rather than measured, for the same reason
 * `measureRow` resolves before the menu opens: a second layout pass would be a visible jump.
 * Placement is clamped inside the safe area, and the menu flips above the row when there is no
 * room below it.
 */
export function ContextMenu({
  items,
  anchor,
  preview,
  onDismiss,
  hosted = false,
}: {
  items: ReadonlyArray<ContextMenuItem>;
  anchor: PressAnchor;
  /** The pressed row, redrawn to be lifted. Omit and the menu opens alone at the anchor. */
  preview?: ReactNode;
  onDismiss: () => void;
  /**
   * Draw without a `Modal` of this component's own, for a caller that is already inside one.
   *
   * **iOS presents one modal per view controller and silently refuses the second**, so a menu
   * opened from inside another modal has to be part of that modal rather than a new one - see the
   * `overlay` prop on `RisingSheet`, which is where a hosted menu belongs. The host must fill the
   * screen, or the window coordinates this positions itself with will not line up.
   */
  hosted?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.spring(progress, {
      toValue: 1,
      useNativeDriver: true,
      damping: 18,
      stiffness: 260,
      mass: 0.7,
    }).start();
  }, [progress]);

  const clamp = (value: number, low: number, high: number) =>
    Math.max(low, Math.min(value, Math.max(low, high)));

  const menuHeight = items.length * CONTEXT_MENU_ROW + space.xs * 2;
  const topLimit = insets.top + space.md;
  const bottomLimit = height - insets.bottom - space.md;

  // The lifted row stays where it is, only nudged back inside the safe area if the press caught
  // a row half under the header or the tab bar.
  const previewTop = clamp(anchor.y, topLimit, Math.max(topLimit, bottomLimit - anchor.height));
  const previewBottom = previewTop + anchor.height;

  // Below the row by preference, above it when the row sits low enough that below would not fit.
  // Anything else would put the menu over the row it is about.
  const fitsBelow = previewBottom + space.sm + menuHeight <= bottomLimit;
  const menuTop = fitsBelow
    ? previewBottom + space.sm
    : clamp(previewTop - space.sm - menuHeight, topLimit, bottomLimit - menuHeight);

  // Left-aligned to the row, the way a menu hangs off the thing it belongs to.
  const menuLeft = clamp(
    anchor.width > 0 ? anchor.x + space.md : anchor.x - CONTEXT_MENU_WIDTH / 2,
    space.md,
    width - CONTEXT_MENU_WIDTH - space.md,
  );

  const menuStyle = {
    opacity: progress,
    transform: [
      { scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] }) },
      {
        translateY: progress.interpolate({
          inputRange: [0, 1],
          outputRange: [fitsBelow ? -10 : 10, 0],
        }),
      },
    ],
  };

  /*
   * A Modal, and not merely for layering.
   *
   * `measureRow` reports the row in WINDOW coordinates, so the overlay has to be positioned in
   * window coordinates too - and a plain absolutely-positioned View is placed relative to its
   * nearest ancestor instead. On the club hub the menu is rendered inside a ScrollView beneath a
   * native header, and the lifted row landed a header's height below the row it was copying,
   * with the header left unblurred above it. A Modal renders at the root, so the two coordinate
   * systems are the same one. `ConfirmDialog` reaches for this for the same reason.
   *
   * `animationType="none"` because the spring below is the animation; letting the Modal fade as
   * well would be two of them fighting over the same 300ms.
   *
   * A `hosted` caller supplies that root itself, because it is already inside a modal and a
   * second one would never be presented at all - see the prop's own note.
   */
  const Host = hosted ? HostedOverlay : ContextMenuModal;

  return (
    <Host onDismiss={onDismiss}>
      {/*
        The blur and the dismiss target are the same layer. A separate transparent Pressable over
        the blur would work equally well and is one more view in a tree that is already an
        overlay over a list.
      */}
      <AnimatedPressable
        style={[styles.contextScrim, { opacity: progress }]}
        onPress={onDismiss}
        accessibilityRole="button"
        accessibilityLabel="Dismiss"
      >
        <BlurView intensity={22} tint="light" style={StyleSheet.absoluteFill} />
        <View style={styles.contextDim} />
      </AnimatedPressable>

      {preview !== undefined && anchor.width > 0 && (
        <Animated.View
          // Not pressable. The lifted row is the subject of the menu, not a control - tapping it
          // should dismiss like tapping anywhere else, which the scrim underneath already does.
          pointerEvents="none"
          style={[
            styles.contextPreview,
            {
              left: anchor.x,
              top: previewTop,
              width: anchor.width,
              transform: [
                {
                  scale: progress.interpolate({
                    inputRange: [0, 1],
                    outputRange: [1, LIFT_SCALE],
                  }),
                },
              ],
            },
          ]}
        >
          {preview}
        </Animated.View>
      )}

      <Animated.View
        style={[styles.contextCard, { left: menuLeft, top: menuTop, width: CONTEXT_MENU_WIDTH }, menuStyle]}
      >
        {items.map((item, index) => (
          <Pressable
            key={item.label}
            style={[styles.contextRow, index > 0 && styles.contextRowDivided]}
            onPress={item.onPress}
            accessibilityRole="button"
            accessibilityLabel={item.label}
          >
            <MaterialIcons
              name={item.icon}
              size={20}
              color={item.destructive === true ? color.error : color.textPrimary}
            />
            <Text
              style={[styles.contextLabel, item.destructive === true && styles.sheetDestructive]}
            >
              {item.label}
            </Text>
          </Pressable>
        ))}
      </Animated.View>
    </Host>
  );
}

/**
 * The two roots an overlay can have: its own modal, or its caller's.
 *
 * Written as components rather than as a ternary around the whole tree, so the markup between
 * them cannot drift - the reason a hosted menu exists at all is that two copies of an overlay
 * diverge, and one of them is only ever seen on a platform nobody is currently looking at.
 */
function ContextMenuModal({
  children,
  onDismiss,
}: {
  children: ReactNode;
  onDismiss: () => void;
}) {
  return (
    <Modal visible transparent animationType="none" onRequestClose={onDismiss}>
      {children}
    </Modal>
  );
}

/** Fills whatever already covers the screen. See `RisingSheet`'s `overlay`. */
function HostedOverlay({ children }: { children: ReactNode; onDismiss: () => void }) {
  return <View style={StyleSheet.absoluteFill}>{children}</View>;
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

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
  labelCase = 'upper',
}: {
  label: string;
  value: string | null;
  /** Shown when empty INSTEAD of hiding the row. Photos and results do this; hotel does not. */
  placeholder?: string;
  /**
   * Uppercase by default, matching every detail card in the app.
   *
   * `title` is for a person's profile, where the labels sit on the page rather than inside a
   * card and read as prose - "Date of birth", not "DATE OF BIRTH". Parametrized rather than
   * forked, per design-system rule 5: a second copy of this line is how the two drift apart.
   */
  labelCase?: 'upper' | 'title';
}) {
  if ((value === null || value.trim().length === 0) && placeholder === undefined) return null;
  return (
    <View style={styles.detailLine}>
      <Text style={[styles.detailLabel, labelCase === 'title' && styles.detailLabelTitleCase]}>
        {label}
      </Text>
      <Text style={value ? styles.detailValue : styles.detailPlaceholder}>
        {value && value.trim().length > 0 ? value : placeholder}
      </Text>
    </View>
  );
}

/**
 * The header a full-screen composer draws for itself.
 *
 * Three composers - poll, event, meeting - hide the navigator's header while creating and put
 * their own in its place, and each had its own byte-identical copy of this.
 *
 * > **A screen that opts out of the navigator's header inherits the navigator's inset problem.**
 * > None of the three applied the top inset, so all three drew their title and their back arrow
 * > UNDER the status bar: the title collided with the clock, and the back control's hit area was
 * > half-buried behind it, which is why it "didn't click properly". A browser has no notch, so it
 * > looks perfect until somebody holds a phone - `clubs/index.tsx` and chat both lost the same
 * > inset the same way, and fixing it in three more places would have been the fourth and fifth
 * > copies of the fix.
 *
 * `hitSlop` on top of that: a 22pt arrow in `space.xs` padding is a target well under the 44pt
 * minimum, and being at the very top of the screen is the worst place to make somebody aim.
 */
export function ComposerHeader({
  title,
  discardLabel,
  onCancel,
  dismiss = 'back',
  action,
}: {
  title: string;
  /** What backing out throws away, said plainly. Required, per this module's own rule. */
  discardLabel: string;
  onCancel: () => void;
  /**
   * Which way out this is.
   *
   * `back` returns to where you came from and is the default every other composer wants. `close`
   * says the form is a thing you are inside and are dismissing, which is what a header carrying
   * its own primary action implies - you are not going back a step, you are done with it.
   */
  dismiss?: 'back' | 'close';
  /**
   * The primary action, in the header rather than at the foot of the form.
   *
   * Optional because it changes the shape of the screen: with one here the form has no trailing
   * button, and the action stays reachable however far the content grows. Added for the poll
   * composer on 2026-08-13, whose deadline picker expands in place and would otherwise push a
   * trailing button off screen.
   */
  action?: ReactNode;
}) {
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.composerHeader, { paddingTop: insets.top + space.sm }]}>
      <Pressable
        onPress={onCancel}
        style={styles.composerBack}
        hitSlop={space.md}
        accessibilityRole="button"
        accessibilityLabel={discardLabel}
      >
        <MaterialIcons
          name={dismiss === 'close' ? 'close' : 'arrow-back'}
          size={22}
          color={color.accent}
        />
      </Pressable>
      {/* Takes the slack, so the action sits hard against the right edge on any width. */}
      <Text style={styles.composerTitle}>{title}</Text>
      {action !== undefined && <View style={styles.composerAction}>{action}</View>}
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
  /* The four destinations' masthead. See `DestinationHeader`. */
  destinationHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingBottom: space.md,
    // No paddingTop: the safe-area inset supplies it at the call site inside the component.
  },
  // flexShrink so a long club name truncates instead of pushing the actions off the edge.
  destinationTitle: { ...type.title, color: color.accent, flexShrink: 1 },
  destinationActions: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  composerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    // `paddingTop` is set inline from the safe-area inset, so this is the bottom half only.
    paddingBottom: space.sm,
    backgroundColor: color.chrome,
    borderBottomWidth: 1,
    borderBottomColor: color.divider,
  },
  composerBack: { padding: space.xs },
  /* `flex: 1` so the title takes the slack and any header action is pushed to the right edge. */
  composerTitle: { ...type.headerTitle, color: color.textPrimary, flex: 1 },
  composerAction: { flexShrink: 0 },

  pickerField: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: color.card,
    borderWidth: 1,
    borderColor: color.hairline,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 4,
    gap: space.sm,
  },
  pickerValue: { ...type.body, color: color.textPrimary },
  pickerPlaceholder: { ...type.body, color: color.textSecondary },
  pickerBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    padding: space.md,
  },
  pickerScrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  pickerSheet: {
    backgroundColor: color.card,
    borderRadius: radius.xl,
    padding: space.md,
    width: '100%',
    maxWidth: 360,
    gap: space.sm,
  },
  pickerHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  confirmSheet: {
    backgroundColor: color.card,
    borderRadius: radius.xl,
    padding: space.md,
    width: '100%',
    maxWidth: 380,
    gap: space.sm,
  },
  confirmTitle: { ...type.headerTitle, fontSize: 18, color: color.textPrimary },
  confirmBody: { ...type.body, color: color.textSecondary },
  confirmActions: { flexDirection: 'row', gap: space.sm, paddingTop: space.sm },
  confirmAction: { flex: 1 },
  /*
   * The accent, deliberately, and deliberately NOT what the Calendar destination uses.
   *
   * > **The two are different objects and the colour is what says so.** The Calendar's heading
   * > sits on a full page where the month IS the screen's subject, so it is drawn in primary
   * > text like any other title. This one is the heading of a small sheet floating over a form
   * > somebody is filling in - it needs to read as part of the control they just opened rather
   * > than as a second page title, and the accent is what the product already uses for "this is
   * > the thing you are operating".
   *
   * Asked for on 2026-08-12: orange everywhere the picker appears - events, polls, races,
   * meetings - and left alone on the main calendar.
   */
  pickerMonth: { ...type.headerTitle, fontSize: 18, color: color.accent },
  pickerClear: { ...type.label, color: color.accent, textAlign: 'center', paddingTop: space.sm },
  weekRow: { flexDirection: 'row' },
  weekday: {
    ...type.label,
    color: color.textSecondary,
    width: `${100 / 7}%`,
    textAlign: 'center',
  },
  dayGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  dayCell: {
    width: `${100 / 7}%`,
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
  },
  dayCellOn: { backgroundColor: color.accent },
  dayLabel: { ...type.body, color: color.textPrimary },
  dayLabelOn: { color: color.onAccent },
  wheels: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm },
  wheel: { maxHeight: 190, width: 76 },
  wheelItem: { paddingVertical: space.sm, alignItems: 'center', borderRadius: radius.md },
  wheelItemOn: { backgroundColor: color.accentSoft },
  wheelLabel: { ...type.numeric, color: color.textSecondary },
  wheelLabelOn: { color: color.accent },
  wheelColon: { ...type.numeric, color: color.textPrimary },
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
  /*
   * The flat variant: no card, no edge, no radius, and full-bleed to the screen.
   *
   * The gutter moves from the LIST to the row, which is the whole point rather than a detail. A
   * carded list insets its rows and tints inside that inset, so two adjacent unread rows read as
   * two tinted cards with a gap between them. Flat rows tint edge to edge, so a run of unread ones
   * is a single continuous band - which is what the design asks for and what a card can never do.
   *
   * `TECH/13` records the Chats list going flat first and calls unifying the rest a deliberate
   * follow-up. This is that follow-up, as a parameter rather than a second implementation.
   */
  rowFlat: {
    backgroundColor: 'transparent',
    borderRadius: 0,
    borderWidth: 0,
    /*
     * A full step on the scale rather than the half-step this started at.
     *
     * The flat row lost the card's own padding, and 12 left the rows closer together than the
     * carded lists they sit beside - legible, but tighter than anything else in the product. At
     * the gutter value the row breathes and the tinted unread band reads as a block rather than
     * as a stripe. Raised 2026-08-12, on the founder seeing it on the phone.
     */
    paddingVertical: space.md,
    paddingHorizontal: space.md,
  },
  /*
   * A wash while the finger is down, and it is not optional here.
   *
   * Flat removes every other sign that a row is a control - no card edge, no chevron - so without
   * this a tap is acknowledged only by the next screen arriving, and on a slow open the row reads
   * as dead. The Chats list learned this when it went flat; the same reasoning, in one place now.
   */
  /*
   * The unread fill, restated for the flat variant.
   *
   * `rowHighlighted` also sets `borderColor`, which is meaningless once `rowFlat` has taken the
   * border away - so this carries the fill alone and leaves the edge gone.
   */
  rowFlatHighlighted: { backgroundColor: color.accentSoft },
  rowFlatPressed: { backgroundColor: color.cardRaised },
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
  // The ring treatment: a hairline circle on the card rather than a filled disc, so the letter or
  // the glyph is the thing you see. Overrides the fill above rather than sitting beside it.
  avatarRing: { backgroundColor: color.card, borderWidth: 1, borderColor: color.avatarRing },
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

  /*
   * The filter chips: outlined, content-width, accent-filled when selected.
   *
   * Content-width rather than `flex: 1` like the other two variants, because these are FILTERS
   * rather than a segmented control - the set can grow, and four equal columns would make "All"
   * as wide as "Notifications" for no reason. It also means a count can widen its own chip
   * without stealing width from the others.
   */
  chipRow: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs + 2,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.avatarRing,
    backgroundColor: color.card,
  },
  chipActive: { backgroundColor: color.accent, borderColor: color.accent },
  chipLabel: { ...type.label, fontSize: 13, letterSpacing: 0.2, color: color.textPrimary, textTransform: 'none' },
  chipLabelActive: { color: color.onAccent },
  // The count is a plain numeral beside the word, not a filled badge. A badge here would compete
  // with the unread badges in the list itself, which are the ones that mean "act on this".
  // The numeral is text, in the text colour: it is telling you how many, not asking to be tapped.
  // Accent here would make the count look like the selected state on an unselected chip.
  chipCount: { ...type.label, fontSize: 13, letterSpacing: 0.2, color: color.textPrimary, textTransform: 'none' },
  chipCountActive: { color: color.onAccent },

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
  /*
    `RisingSheet`. The dimming is its own layer rather than a colour on the backdrop: it has to be
    able to fade on its own, since the panel slides and the shade does not, and the two sharing a
    view is precisely what made the dimming travel up the screen with the panel.
  */
  risingBackdrop: { flex: 1, justifyContent: 'flex-end' },
  risingScrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  risingSheet: {
    maxHeight: '85%',
    backgroundColor: color.card,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    gap: space.sm,
  },
  risingGrabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: color.fallback,
  },

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

  contextScrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  /*
    A light wash over the blur, not instead of it.
    Blur alone leaves a busy list still legible enough to compete with the menu; this settles it
    without the heavy grey a plain scrim uses, which would throw away the blur it sits on.
  */
  contextDim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(255,255,255,0.35)',
  },
  contextPreview: {
    position: 'absolute',
    backgroundColor: color.card,
    borderRadius: radius.lg,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.16,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  contextCard: {
    position: 'absolute',
    backgroundColor: color.card,
    borderRadius: radius.lg,
    paddingVertical: space.xs,
    // A real shadow, because this floats over content rather than sitting against a screen edge.
    // Without it the card reads as part of the row underneath on a light background.
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  contextRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    // Matches CONTEXT_MENU_ROW, which the placement maths uses to keep the card on screen.
    height: CONTEXT_MENU_ROW,
  },
  contextRowDivided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.hairline },
  contextLabel: { ...type.body, color: color.textPrimary },

  bodyScroll: { flex: 1, backgroundColor: color.appBackground },
  bodyContent: { padding: space.md, gap: space.sm, paddingBottom: space.xl },

  detailLine: { gap: space.xs, paddingVertical: space.xs },
  detailLabel: { ...type.label, color: color.textSecondary, textTransform: 'uppercase' },
  detailLabelTitleCase: { textTransform: 'none', letterSpacing: 0, fontSize: 13, lineHeight: 18 },
  detailValue: { ...type.body, color: color.textPrimary },
  detailPlaceholder: { ...type.body, color: color.textSecondary, fontStyle: 'italic' },
});
