/**
 * The Calendar destination: this club's feed when you are inside one, the merged cross-club feed
 * when you are not.
 *
 * Two views over one read, which is the server's design and therefore this screen's: a month grid
 * for "what is happening when", and a tapped day's items beneath it. There is no calendar table for
 * anything to write into, so neither view can be stale relative to the other.
 *
 * **The cross-club view tags every row with its club and offers no create action** - creating an
 * event belongs to a club, and a cross-club create would have to ask which one, which is the club
 * calendar's job. The club-scoped version of this screen is the same component with a club id.
 *
 * Two rules from v1's grid, both of which read as bugs when broken:
 *
 *  1. **Paging months never changes the grid's height.** Always six weeks of cells, so a month
 *     starting on a Saturday and one starting on a Sunday do not render five rows and six.
 *  2. **A filler day from an adjacent month is never marked and never tappable**, even when it
 *     carries something. A solid marker on a greyed-out day reads as a prominent control that
 *     does nothing.
 */

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { Redirect, useNavigation, useRouter } from 'expo-router';
import { useCurrentSpace } from '../../src/current-space.tsx';
import { calendarApi } from '../../src/api.ts';
import type { FeedItem } from '../../src/api-types.ts';
import { bucketByDay, dayInView, type DayChoice } from '../../src/calendar-days.ts';
import { useSession } from '../../src/chat-provider.tsx';
import { formatDayTitle, formatMonthTitle, formatTimeOfDay, toDateKey } from '../../src/dates.ts';
import { color, radius, space, type } from '../../src/theme.ts';
import { DataScreen, EmptyState } from '../../src/ui.tsx';
import { useLoad } from '../../src/use-load.ts';

/** Six weeks, fixed, so the grid's height never changes as months are paged. */
const CELLS = 42;
const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'] as const;

function todayParts(): { year: number; month: number } {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

type MonthCursor = { year: number; month: number };

/**
 * The month `delta` away, carrying the year.
 *
 * Its own function because the pager needs the two NEIGHBOURS as well as the destination: a swipe
 * draws the month either side of the current one before it knows which way you are going. This
 * was the body of `step` when only the arrows could move.
 *
 * The double modulo is what makes December + 1 and January - 1 both work: `%` keeps the sign of
 * the dividend in JavaScript, so a plain one gives -1 for January's predecessor.
 */
function shiftMonth(from: MonthCursor, delta: number): MonthCursor {
  const zeroBased = from.month - 1 + delta;
  return {
    year: from.year + Math.floor(zeroBased / 12),
    month: (((zeroBased % 12) + 12) % 12) + 1,
  };
}


/**
 * The destination, which follows whichever club you are inside.
 *
 * > **It reads the current club and does NOT clear it**, which is the whole rule: `PRD/15` says
 * > the Calendar destination is club-scoped while a club is active, showing that club's feed under
 * > its name, and reverts to the merged feed once the club has been left. Stepping across to
 * > another tab is not leaving the club - the Clubs tab is still one tap from its hub.
 *
 * It cleared the club instead, which broke two things at once and only sometimes. The scoping the
 * rule asks for never happened, so this always drew the cross-club feed. And clearing raced the
 * Clubs tab's own handler: whether tapping CLUBS afterwards surfaced at the club's front door or
 * dropped you on the My Clubs list depended on which ran first. Leaving a club is declared by the
 * My Clubs list, which is the screen that actually IS outside one.
 */
export default function CalendarScreen() {
  const { currentClub } = useCurrentSpace();
  const { authState } = useSession();
  const navigation = useNavigation();

  /*
   * Only the header TITLE changes between the two.
   *
   * The tab bar label stays "Calendar" either way, so the destination never appears to move when
   * a club becomes current. Set through the navigator rather than a `<Stack.Screen>` element,
   * because this screen's parent is the tab navigator and a Stack element would be addressed to a
   * stack that is not above it.
   */
  const title =
    currentClub === null || currentClub.name.length === 0
      ? 'Calendar'
      : `${currentClub.name} Calendar`;
  useEffect(() => {
    navigation.setOptions({ title });
  }, [navigation, title]);

  if (authState === 'checking') return <View style={styles.flex} />;
  if (authState === 'signed-out') return <Redirect href="/sign-in" />;

  return <CalendarView {...(currentClub === null ? {} : { clubId: currentClub.clubId })} />;
}

/**
 * Shared by this destination and the club-scoped calendar.
 *
 * Exported so `clubs/[clubId]/calendar.tsx` renders the same component with a club id rather than
 * a second implementation - design-system rule 5.
 */
export function CalendarView({ clubId }: { clubId?: string } = {}) {
  const [cursor, setCursor] = useState(todayParts());
  const [choice, setChoice] = useState<DayChoice>(null);

  /*
   * One read for both views.
   *
   * `when: 'all'` rather than the markers endpoint plus a second paged read: the grid needs to
   * know which days carry something AND the tapped day needs its items, and asking twice would
   * make the dots and the list two answers to the same question. The feed is one query per
   * feature per club either way.
   */
  const feed = useLoad(
    () => calendarApi.feed({ ...(clubId ? { club: clubId } : {}), when: 'all' }),
    [clubId],
  );

  /*
   * Both views' input, built once per load rather than once per render - it was inside the render
   * body, which rebuilt the whole Map on every paged month and every tap.
   *
   * `selected` is derived from it rather than stored beside it, which is what makes today open on
   * arrival: the feed is not loaded on the first render, so a default chosen then would be chosen
   * from an empty map. See `calendar-days.ts` for the rest of that argument.
   */
  const byDay = useMemo(() => bucketByDay(feed.data?.items ?? []), [feed.data]);
  const todayKey = toDateKey(new Date());
  const selected = dayInView(choice, byDay, todayKey);

  const step = (delta: number) => {
    // Paging is a deliberate move away from today, so it closes the day rather than reverting to
    // "has not chosen yet" - which would reopen today the moment the current month came back.
    setChoice({ day: null });
    setCursor((current) => shiftMonth(current, delta));
  };

  /** Jumping from the picker follows the same rule as paging: the open day closes. */
  const jumpTo = (next: MonthCursor) => {
    setChoice({ day: null });
    setCursor(next);
  };

  return (
    <DataScreen load={feed}>
      {(data) => {
        const dayItems = selected === null ? [] : (byDay.get(selected) ?? []);

        return (
          <ScrollView style={styles.flex} contentContainerStyle={styles.content}>
            <MonthPager
              cursor={cursor}
              byDay={byDay}
              today={todayKey}
              selected={selected}
              // Compared against the day actually open, not against the stored choice: on arrival
              // today is open without having been chosen, and tapping it has to close it.
              onSelect={(day) => setChoice({ day: day === selected ? null : day })}
              onStep={step}
              onJump={jumpTo}
            />

            {data.items.length === 0 && (
              <EmptyState
                title={clubId ? 'Nothing on the calendar' : 'No events across your clubs yet'}
              />
            )}

            {selected !== null && (
              <View style={styles.daySection}>
                <Text style={styles.dayTitle}>{formatDayTitle(selected)}</Text>
                {dayItems.length === 0 ? (
                  <Text style={styles.meta}>Nothing on this day.</Text>
                ) : (
                  dayItems.map((item) => (
                    <DayRow
                      key={`${item.kind}:${item.id}`}
                      item={item}
                      showClub={clubId === undefined}
                    />
                  ))
                )}
              </View>
            )}
          </ScrollView>
        );
      }}
    </DataScreen>
  );
}

/** The tint for a feed row's badge. One vocabulary, so a race looks like a race everywhere. */
function badgeTint(kind: FeedItem['kind']): { background: string; text: string } {
  switch (kind) {
    case 'race':
      return { background: color.accent, text: color.onAccent };
    case 'meeting':
      return { background: color.inverseSurface, text: color.onInverseSurface };
    case 'poll':
      return { background: color.secondaryContainer, text: color.onSecondarySoft };
    case 'event':
      return { background: color.tertiarySoft, text: color.onTertiarySoft };
  }
}

/** Every kind on this feed now has somewhere to land, so this returns a string in every case. */
function targetFor(item: FeedItem): string {
  return item.kind === 'poll'
    ? `/polls/${item.id}`
    : item.kind === 'race'
      ? `/races/${item.id}`
      : item.kind === 'meeting'
        ? `/meetings/${item.id}`
        : `/events/${item.id}`;
}

/** One item under the selected day. */
function DayRow({ item, showClub }: { item: FeedItem; showClub: boolean }) {
  const router = useRouter();
  const tint = badgeTint(item.kind);
  const target = targetFor(item);

  const body = (
    <>
      <View style={styles.dayRowHead}>
        <Text style={[styles.badge, { backgroundColor: tint.background, color: tint.text }]}>
          {item.kind.toUpperCase()}
        </Text>
        {showClub && <Text style={styles.clubTag}>{item.clubName}</Text>}
        {/* A race the viewer can see but not enter still appears, and says so. */}
        {item.kind === 'race' && !item.accessible && <Text style={styles.clubTag}>NO ACCESS</Text>}
      </View>
      <Text style={styles.dayRowTitle}>{item.title}</Text>
      {/*
        An all-day item has no time to show, and inventing one is worse than showing nothing: a
        race's date read as an instant is UTC midnight, so every race carried a confident "7:00 PM"
        that was really the previous evening in New York.
      */}
      {item.at !== null && !item.allDay && (
        <Text style={styles.meta}>{formatTimeOfDay(item.at)}</Text>
      )}
    </>
  );

  return (
    <Pressable
      style={styles.dayRow}
      onPress={() => router.push(target)}
      accessibilityRole="button"
      accessibilityLabel={`${item.title}, ${item.kind}`}
    >
      {body}
    </Pressable>
  );
}

/**
 * The month grid, swipeable, with the arrows kept.
 *
 * **Three grids are rendered, not one**: the month either side of the current one is drawn off
 * screen so a drag reveals a real month rather than empty space. Anything less is a transition
 * pretending to be a swipe, and it shows the moment a finger moves slowly.
 *
 * The row is `3 * width` wide and rests at `-width`, so the middle page is the one on screen.
 * On release it settles to a neighbour, the cursor moves, and the offset snaps back to `-width` -
 * by which point the three grids have re-rendered around the new month, so the snap is invisible.
 *
 * **The gesture only claims clearly horizontal movement**, and never claims a touch at its start.
 * This grid lives inside a vertical ScrollView and every cell is a button: claiming early would
 * eat the day taps, and claiming a diagonal would fight the page scroll. `onMoveShouldSet` is
 * therefore the only hook that answers true.
 *
 * The arrows still work and are still the accessible path - a swipe is not announceable and
 * cannot be performed by anybody driving this with a switch or a keyboard.
 */
function MonthPager({
  cursor,
  byDay,
  today,
  selected,
  onSelect,
  onStep,
  onJump,
}: {
  cursor: MonthCursor;
  byDay: ReadonlyMap<string, FeedItem[]>;
  today: string;
  selected: string | null;
  onSelect: (day: string) => void;
  onStep: (delta: number) => void;
  onJump: (next: MonthCursor) => void;
}) {
  const [width, setWidth] = useState<number | null>(null);
  const [picking, setPicking] = useState(false);
  const pager = useRef<ScrollView>(null);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** True from the moment a page is committed until the recentre it causes has been absorbed. */
  const committing = useRef(false);
  /** The most recent offset, so a settle acts on where the pager IS, not where it was. */
  const lastX = useRef(0);
  /**
   * Which page the finger is over, as a delta from `cursor`. The TITLE reads this; nothing else
   * does.
   *
   * **The heading has to move with the grid, not after it.** Committing is deliberately late -
   * it waits for the scroll to come to rest - so a title driven by `cursor` alone stayed on the
   * old month for the whole animation and then snapped, about half a second behind the thing it
   * names. Naming the month you are moving to while you are moving to it is the difference
   * between a heading and a report.
   *
   * It flips at the halfway mark, which is also the point the snap commits to: the month that
   * owns most of the screen is the month named. A drag that falls short crosses nothing, so the
   * title never lies about a swipe that snapped back.
   */
  const [preview, setPreview] = useState(0);

  /** Put the viewport back on the middle page, where a swipe can go either way. */
  const recentre = (animated: boolean) => {
    if (width !== null) pager.current?.scrollTo({ x: width, y: 0, animated });
  };

  // Once the width is known, and again whenever it changes, rest on the middle page. Without
  // this the pager opens showing the PREVIOUS month, which is page zero.
  useEffect(() => {
    if (width === null) return;
    // After layout rather than during it: scrolling a view that has not been laid out is a no-op
    // on Android, and the pager would silently open on the wrong page there alone.
    const id = setTimeout(() => recentre(false), 0);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width]);

  // Recentre after the cursor moves for any reason - an arrow, or the picker - so the pages
  // either side of the new month are the ones a swipe reaches.
  useEffect(() => {
    recentre(false);
    // An arrow or the picker moves the cursor with no scroll behind it, so the preview has
    // nothing to reset it and would keep naming a month offset from the new one.
    setPreview(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor.year, cursor.month]);

  useEffect(() => () => (settle.current ? clearTimeout(settle.current) : undefined), []);

  /**
   * Commit a page once the scroll has come to rest.
   *
   * **Driven by a quiet period rather than by `onMomentumScrollEnd`.** That event is the obvious
   * hook and it is not dependable across platforms: a slow drag released without a flick produces
   * no momentum at all, and on web the paging is CSS scroll-snap, whose animation the event does
   * not describe. Waiting for the offset to stop changing is true on every platform, because it
   * is a statement about the offset rather than about how it got there.
   */
  /**
   * Act on where the pager came to rest.
   *
   * Reads `lastX` rather than an offset captured when the timer was scheduled. The captured
   * version acts on an offset up to 140ms old, which is most of a snap animation - it is only
   * ever right when the scroll happens to have already stopped.
   */
  const commitPage = () => {
    if (width === null || committing.current) return;
    const x = lastX.current;
    const page = Math.round(x / width);
    const delta = page - 1;
    // Ignore anything that has not landed on a neighbouring page: a drag that fell short snaps
    // back on its own and must not be read as a month.
    if (delta === 0 || Math.abs(x - page * width) > width * 0.1) return;
    committing.current = true;
    // Batched with the cursor move, so the title never flashes: it is already showing this month
    // from the preview, and `cursor + delta` with the preview back at zero is the same month.
    setPreview(0);
    onStep(delta);
    // Recentred here as well as by the `cursor` effect, because this is the path that must not be
    // left mid-page for even a frame; the effect is what covers an arrow or the picker.
    recentre(false);
    setTimeout(() => (committing.current = false), 200);
  };

  const onScroll = (x: number) => {
    if (width === null) return;
    /*
     * Deaf while committing.
     *
     * Committing recentres, recentring scrolls, and scrolling lands back here - so without this
     * one swipe can page twice, the second time from an offset the first has already acted on.
     */
    if (committing.current) return;
    lastX.current = x;

    // The title, live. `round` puts the boundary at half a page, so this is at most two state
    // changes across a whole swipe rather than one per frame.
    const over = Math.round(x / width) - 1;
    if (over !== preview) setPreview(over);

    /*
     * A quiet period, as the backstop.
     *
     * The scroll-end events below are the real signal and this covers what they miss: a slow
     * drag released without a flick produces no momentum event on some platforms, and on web the
     * paging is CSS scroll-snap, whose animation neither event describes. Waiting for the offset
     * to stop moving is true everywhere, because it is a statement about the offset rather than
     * about how it got there.
     */
    if (settle.current) clearTimeout(settle.current);
    settle.current = setTimeout(commitPage, 140);
  };

  const months = [shiftMonth(cursor, -1), cursor, shiftMonth(cursor, 1)];
  /** What the heading says: the month under the finger, which is `cursor` once at rest. */
  const shown = preview === 0 ? cursor : shiftMonth(cursor, preview);

  return (
    <View>
      <View style={styles.monthHead}>
        <Pressable
          onPress={() => onStep(-1)}
          hitSlop={space.sm}
          accessibilityRole="button"
          accessibilityLabel="Previous month"
        >
          <MaterialIcons name="chevron-left" size={26} color={color.textPrimary} />
        </Pressable>

        {/*
          The title is the way into the picker, rather than a separate control beside it. It is
          already the thing naming the month, and a list this long is reached by tapping what it
          is about - which is also why it carries a caret, so it does not read as a label.
        */}
        <Pressable
          onPress={() => setPicking(true)}
          hitSlop={space.sm}
          accessibilityRole="button"
          accessibilityLabel={`${formatMonthTitle(shown.year, shown.month)}, choose a month`}
          style={styles.monthTitleButton}
        >
          <Text style={styles.monthTitle}>{formatMonthTitle(shown.year, shown.month)}</Text>
          <MaterialIcons name="arrow-drop-down" size={24} color={color.textPrimary} />
        </Pressable>

        <Pressable
          onPress={() => onStep(1)}
          hitSlop={space.sm}
          accessibilityRole="button"
          accessibilityLabel="Next month"
        >
          <MaterialIcons name="chevron-right" size={26} color={color.textPrimary} />
        </Pressable>
      </View>

      <View style={styles.weekRow}>
        {WEEKDAYS.map((label, index) => (
          <Text key={`${label}${index}`} style={styles.weekLabel}>
            {label}
          </Text>
        ))}
      </View>

      <View onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
        <ScrollView
          ref={pager}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          // The parent is a vertical ScrollView, and the two arbitrate between themselves: a
          // horizontal drag belongs to this one, a vertical drag passes through. That is the
          // whole reason this is a ScrollView rather than a PanResponder - the arbitration is
          // the hard part, and it already exists.
          //
          // It also keeps day taps working, which a responder claiming the touch would not.
          scrollEventThrottle={16}
          onScroll={(event) => onScroll(event.nativeEvent.contentOffset.x)}
          /*
            The authoritative signals on a device, both handled because only one of them fires
            for any given gesture: a flick ends with momentum, a slow drag released in place
            ends without it. Each carries the settled offset, so neither waits on the backstop.
          */
          onMomentumScrollEnd={(event) => {
            lastX.current = event.nativeEvent.contentOffset.x;
            commitPage();
          }}
          onScrollEndDrag={(event) => {
            lastX.current = event.nativeEvent.contentOffset.x;
          }}
          // Turned off so a fast flick cannot cross two months in one gesture - there is no
          // third page to land on, and the pager would snap back looking broken.
          decelerationRate="fast"
        >
          {months.map((m) => (
            <MonthGrid
              key={`${m.year}-${m.month}`}
              year={m.year}
              month={m.month}
              byDay={byDay}
              today={today}
              // Only the month on screen can own the open day. Without this the same date
              // renders selected in two adjacent months, which is visible mid-swipe.
              selected={m.month === cursor.month && m.year === cursor.year ? selected : null}
              onSelect={onSelect}
              width={width}
            />
          ))}
        </ScrollView>
      </View>

      {picking && (
        <MonthYearPicker
          cursor={cursor}
          today={todayParts()}
          onDismiss={() => setPicking(false)}
          onPick={(next) => {
            setPicking(false);
            onJump(next);
          }}
        />
      )}
    </View>
  );
}

/** Short month names for the picker's grid, in calendar order. */
const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

/**
 * Jump to any month, without paging through the ones between.
 *
 * **A first pass, put up to be looked at.** The founder asked for a year and a month selector and
 * said explicitly that it might be reworked once seen, so this is the plainest version that
 * answers the question: a year on a stepper, twelve months in a grid, one tap to land.
 *
 * The year is a stepper rather than a scrolling list of years because a club calendar is used a
 * season either side of today, not in 2043 - a wheel of forty years would be a lot of furniture
 * for a control whose common case is "one back" or "one forward". If it turns out people jump
 * further than that, the stepper is the part to replace.
 *
 * Today's month is ringed and the open month filled, so the two questions the picker gets opened
 * with - "where am I" and "where is now" - are both answered before anything is tapped.
 */
function MonthYearPicker({
  cursor,
  today,
  onPick,
  onDismiss,
}: {
  cursor: MonthCursor;
  today: MonthCursor;
  onPick: (next: MonthCursor) => void;
  onDismiss: () => void;
}) {
  // The year being browsed, which is not yet the year chosen. Stepping the year alone changes
  // nothing on the calendar behind - only picking a month commits, so an accidental step is free.
  const [year, setYear] = useState(cursor.year);

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onDismiss}>
      <Pressable
        style={styles.pickerScrim}
        onPress={onDismiss}
        accessibilityRole="button"
        accessibilityLabel="Dismiss"
      />
      <View style={styles.pickerWrap} pointerEvents="box-none">
        <View style={styles.pickerCard}>
          <View style={styles.pickerYearRow}>
            <Pressable
              onPress={() => setYear((y) => y - 1)}
              hitSlop={space.sm}
              accessibilityRole="button"
              accessibilityLabel={`Go to ${year - 1}`}
            >
              <MaterialIcons name="chevron-left" size={26} color={color.textPrimary} />
            </Pressable>
            <Text style={styles.pickerYear}>{year}</Text>
            <Pressable
              onPress={() => setYear((y) => y + 1)}
              hitSlop={space.sm}
              accessibilityRole="button"
              accessibilityLabel={`Go to ${year + 1}`}
            >
              <MaterialIcons name="chevron-right" size={26} color={color.textPrimary} />
            </Pressable>
          </View>

          <View style={styles.pickerMonths}>
            {MONTH_NAMES.map((name, index) => {
              const month = index + 1;
              const open = year === cursor.year && month === cursor.month;
              const now = year === today.year && month === today.month;
              return (
                <Pressable
                  key={name}
                  style={[
                    styles.pickerMonth,
                    now && !open && styles.pickerMonthToday,
                    open && styles.pickerMonthOpen,
                  ]}
                  onPress={() => onPick({ year, month })}
                  accessibilityRole="button"
                  accessibilityLabel={`${name} ${year}`}
                >
                  <Text style={[styles.pickerMonthLabel, open && styles.pickerMonthLabelOpen]}>
                    {name}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {/* One tap back to now, from wherever the browsing went. */}
          <Pressable
            style={styles.pickerToday}
            onPress={() => onPick(today)}
            accessibilityRole="button"
            accessibilityLabel="Go to this month"
          >
            <Text style={styles.pickerTodayLabel}>This month</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

/**
 * One month's 42 cells. The header and the weekday row are the pager's, not this component's,
 * because they must stay still while this slides.
 *
 * **Memoised, because the heading now re-renders mid-gesture.** The live title flips the pager's
 * state as the finger crosses half a page, and without this that would rebuild 126 cells across
 * three grids during the one moment the frame budget is already being spent on a scroll. Only
 * the page whose `selected` changed does any work.
 */
const MonthGrid = memo(function MonthGrid({
  year,
  month,
  byDay,
  today,
  selected,
  onSelect,
  width,
}: {
  year: number;
  month: number;
  byDay: ReadonlyMap<string, FeedItem[]>;
  /** Passed in rather than read here, so the ring and the opened day cannot disagree about it. */
  today: string;
  selected: string | null;
  onSelect: (day: string) => void;
  /** The pager's measured width. Null before the first layout, when nothing is drawn yet. */
  width: number | null;
}) {
  const cells = useMemo(() => {
    // Built from components, never from a parsed ISO string: an ISO date is UTC midnight and
    // renders a day early in a negative-offset timezone.
    const first = new Date(year, month - 1, 1);
    const leading = first.getDay();
    const start = new Date(year, month - 1, 1 - leading);
    return Array.from({ length: CELLS }, (_, i) => {
      const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      return {
        date,
        key: toDateKey(date),
        inMonth: date.getMonth() === month - 1,
      };
    });
  }, [year, month]);

  return (
    <View style={width === null ? undefined : { width }}>
      <View style={styles.grid}>
        {cells.map((cell) => {
          // Gated on `inMonth` for BOTH the marker and the gesture: a filler day that happens to
          // carry something must not render the same solid marker a real day gets, or it reads as
          // a prominent control sitting in the wrong month that does nothing when tapped.
          const marked = cell.inMonth && byDay.has(cell.key);
          const isToday = cell.key === today;
          const isSelected = cell.key === selected;

          return (
            <Pressable
              key={cell.key}
              style={styles.cell}
              disabled={!marked}
              onPress={() => onSelect(cell.key)}
              accessibilityRole="button"
              accessibilityLabel={
                marked
                  ? `${formatDayTitle(cell.key)}, ${byDay.get(cell.key)?.length ?? 0} items`
                  : formatDayTitle(cell.key)
              }
              accessibilityState={{ selected: isSelected, disabled: !marked }}
            >
              <View
                style={[
                  styles.marker,
                  isToday && styles.markerToday,
                  marked && styles.markerFilled,
                  isSelected && styles.markerSelected,
                ]}
              >
                <Text
                  style={[
                    styles.day,
                    !cell.inMonth && styles.dayOutside,
                    marked && styles.dayFilled,
                  ]}
                >
                  {cell.date.getDate()}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: color.appBackground },
  content: { padding: space.md, paddingBottom: space.xl },
  meta: { ...type.bodySmall, color: color.textSecondary },

  monthHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: space.md,
  },
  monthTitle: { ...type.title, fontSize: 20, lineHeight: 26, color: color.textPrimary },
  monthTitleButton: { flexDirection: 'row', alignItems: 'center', gap: space.xs },

  pickerScrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  pickerWrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.md,
  },
  pickerCard: {
    width: '100%',
    maxWidth: 340,
    backgroundColor: color.card,
    borderRadius: radius.xl,
    padding: space.md,
    gap: space.md,
  },
  pickerYearRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  pickerYear: { ...type.title, fontSize: 20, lineHeight: 26, color: color.textPrimary },
  pickerMonths: { flexDirection: 'row', flexWrap: 'wrap' },
  pickerMonth: {
    width: `${100 / 4}%`,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Ringed, not filled: "now" is a reference point and the filled one is where you are.
  pickerMonthToday: { borderWidth: 2, borderColor: color.accent, borderRadius: radius.md },
  pickerMonthOpen: { backgroundColor: color.accent, borderRadius: radius.md },
  pickerMonthLabel: { ...type.body, color: color.textPrimary },
  pickerMonthLabelOpen: { color: color.onAccent },
  pickerToday: { alignItems: 'center', paddingVertical: space.sm },
  pickerTodayLabel: { ...type.body, color: color.accent },

  weekRow: { flexDirection: 'row' },
  weekLabel: {
    width: `${100 / 7}%`,
    textAlign: 'center',
    ...type.label,
    color: color.textSecondary,
    marginBottom: space.sm,
  },

  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  // A fixed height rather than `aspectRatio: 1`: on a wide viewport - and this app also runs
  // through react-native-web - a percentage-width cell with a square ratio grows as tall as it is
  // wide and blows the grid's height past the screen.
  cell: { width: `${100 / 7}%`, height: 56, alignItems: 'center', justifyContent: 'center' },
  marker: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  markerToday: { borderWidth: 2, borderColor: color.accent },
  markerFilled: { backgroundColor: color.textPrimary },
  markerSelected: { backgroundColor: color.accent },
  day: { ...type.bodySmall, color: color.textPrimary },
  dayOutside: { color: color.textSecondary, opacity: 0.4 },
  dayFilled: { color: color.appBackground },

  daySection: {
    marginTop: space.lg,
    paddingTop: space.md,
    borderTopWidth: 1,
    borderTopColor: color.hairline,
    gap: space.sm,
  },
  dayTitle: { ...type.title, fontSize: 18, lineHeight: 24, color: color.textPrimary },
  dayRow: {
    backgroundColor: color.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.hairline,
    padding: space.md,
    gap: space.xs,
  },
  dayRowHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  dayRowTitle: { ...type.headline, color: color.textPrimary },
  badge: {
    ...type.label,
    fontSize: 10,
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    overflow: 'hidden',
  },
  clubTag: { ...type.label, fontSize: 10, color: color.textSecondary },
});
