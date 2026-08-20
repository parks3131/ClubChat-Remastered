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

import { memo, useMemo, useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { Redirect, useRouter } from 'expo-router';
import { useCurrentSpace } from '../../src/current-space.tsx';
import { calendarApi } from '../../src/api.ts';
import type { FeedItem } from '../../src/api-types.ts';
import { bucketByDay, dayInView, type DayChoice } from '../../src/calendar-days.ts';
import { useSession } from '../../src/chat-provider.tsx';
import { formatDayTitle, formatMonthTitle, formatTimeOfDay, toDateKey } from '../../src/dates.ts';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, radius, space, tabBarSpace, type } from '../../src/theme.ts';
import {
  WEEKDAYS,
  monthCells,
  shiftMonth,
  todayParts,
  useMonthPager,
  type MonthCursor,
} from '../../src/month-pager.tsx';
import { DataScreen, DestinationHeader, EmptyState } from '../../src/ui.tsx';
import { useFocusedValue, useLoad, useRefreshOnReturn } from '../../src/use-load.ts';

/*
 * The month vocabulary and the swipe both live in `src/month-pager.tsx` now, so this screen and
 * the date picker share one definition of each. `CELLS`, `WEEKDAYS`, `todayParts`, `MonthCursor`
 * and `shiftMonth` were all declared here until 2026-08-12; `WEEKDAYS` was declared here AND in
 * `ui.tsx`, which is the drift that extraction exists to end.
 */


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

  /*
   * Only the TITLE changes between the two.
   *
   * The tab bar label stays "Calendar" either way, so the destination never appears to move when
   * a club becomes current.
   *
   * > **This was `navigation.setOptions({ title })` against the tab navigator's own header until
   * > 2026-08-15.** That header was 20pt and centred while Chats and Notifications drew their own
   * > at 28pt on the left, so the four destinations disagreed about what a destination's name
   * > looks like. It is now the shared `DestinationHeader`, and the navigator's header is off for
   * > this tab. A club's name can be long, which is the reason that component truncates.
   */
  const title =
    currentClub === null || currentClub.name.length === 0
      ? 'Calendar'
      : `${currentClub.name} Calendar`;

  if (authState === 'checking') return <View style={styles.flex} />;
  if (authState === 'signed-out') return <Redirect href="/sign-in" />;

  return (
    <View style={styles.flex}>
      <DestinationHeader title={title} />
      <CalendarView {...(currentClub === null ? {} : { clubId: currentClub.clubId })} />
    </View>
  );
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
   *
   * **Keyed on the club as of the last time somebody LOOKED at this screen, not as of now.**
   *
   * > **This destination stays mounted and kept reading for a screen nobody was on.** It follows
   * > the current club by design (`PRD/15`), and a tab screen never unmounts once opened - so
   * > every step into a club and back out re-read the whole feed from behind the Clubs tab. The
   * > dev trace on 2026-08-19 has eighteen `GET /calendar` across eight minutes of walking in
   * > and out of one club, with the tab never once in front of the reader.
   *
   * `useFocusedValue` holds the change until the tab is focused, which is the first moment the
   * answer can be looked at and therefore the first moment it is worth having. The request is
   * built from the deferred id rather than from `clubId` so the two can never disagree: `read`
   * is re-created every render and `useLoad` calls the latest one, so a closure over the live
   * prop would fetch the new club under the old key.
   */
  const focusedClubId = useFocusedValue(clubId);
  const feed = useLoad(
    () => calendarApi.feed({ ...(focusedClubId ? { club: focusedClubId } : {}), when: 'all' }),
    [focusedClubId],
  );

  /*
   * Read again on RETURN, which this screen did not do at all.
   *
   * > **A tab screen stays mounted once it has been opened**, so `useLoad` above ran exactly once
   * > per club for the whole life of the session. Adding an event from chat's "+" menu, from the
   * > club's own events screen, or from another member's phone left this grid showing what it read
   * > the first time the tab was ever opened - and nothing here would have corrected it short of
   * > restarting the app. Found 2026-08-18 by asking why `GET /calendar` appeared once and never
   * > again.
   *
   * Quiet rather than a reload, and keyed by club so switching clubs still counts as a first open
   * for the new one. This is the same treatment the chat list and the club hub carry, for the
   * complaint stated in `use-load.ts`: coming back to a list and seeing what it said ten minutes
   * ago.
   *
   * **The LIVE club here, deliberately, where the read above takes the deferred one.**
   *
   * That difference is what keeps a club change to ONE request. On the focus that adopts a new
   * club this key has already changed, so this counts the focus as a first open and stays quiet
   * while the load above runs. Handed the deferred id instead, both would fire on that focus and
   * the screen would make the two round trips the deferral exists to remove.
   */
  useRefreshOnReturn(feed, clubId ?? 'all-clubs');

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
  // The tab bar floats OVER this screen, so the feed has to be able to scroll its last row clear
  // of it. From the same token the bar is built from, so the two cannot drift.
  const insets = useSafeAreaInsets();

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
          <ScrollView
            style={styles.flex}
            contentContainerStyle={[styles.content, { paddingBottom: tabBarSpace(insets.bottom) }]}
          >
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
    case 'event':
      return { background: color.tertiarySoft, text: color.onTertiarySoft };
    // The quietest of the four, and deliberately so: a meetup is the routine thing, and it is the
    // one most likely to appear several times in a week. The accent stays with the race.
    case 'meetup':
      return { background: color.secondaryContainer, text: color.onSecondarySoft };
  }
}

/**
 * Every kind on this feed has somewhere to land, so this returns a string in every case.
 *
 * **A meetup opened the club's WEEK for a few hours on 2026-08-15**, because it had no screen of
 * its own. It has one now - a name, location notes and a map do not fit a week row - so the
 * exception is gone and every kind opens a screen about itself again.
 */
function targetFor(item: FeedItem): string {
  return item.kind === 'race'
    ? `/races/${item.id}`
    : item.kind === 'meeting'
      ? `/meetings/${item.id}`
      : item.kind === 'meetup'
        ? `/meetups/${item.id}`
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
        Three cases, not two. An instant is formatted in the reader's own zone. An all-day item
        with no clock shows nothing, because inventing one is worse than silence: a race's date
        read as an instant is UTC midnight, so every race once carried a confident "7:00 PM" that
        was really the previous evening in New York. And a meetup is all-day WITH a clock, which
        is printed exactly as the club typed it and never parsed.
      */}
      {!item.allDay && <Text style={styles.meta}>{formatTimeOfDay(item.at)}</Text>}
      {item.allDay && item.timeOfDay !== null && (
        <Text style={styles.meta}>{item.timeOfDay}</Text>
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
  const [picking, setPicking] = useState(false);

  /*
   * The swipe, from the shared hook.
   *
   * > **This block used to be about a hundred lines here**, and it moved to `src/month-pager.tsx`
   * > on 2026-08-12 so the date picker could have the same gesture rather than a second copy of
   * > it. Every root cause the 2026-08-06 session found - the stale settle offset, the double
   * > commit, the late heading - lives there now, once. What stayed here is what is actually
   * > this screen's: the day cells, the event markers, and the month/year picker behind the title.
   */
  const pager = useMonthPager(cursor, onStep);
  const { width } = pager;

  /** What the heading says: the month under the finger, which is `cursor` once at rest. */
  const { months, shown } = pager;

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

      {/*
        The parent is a vertical ScrollView, and the two arbitrate between themselves: a
        horizontal drag belongs to the pager, a vertical drag passes through. That is the whole
        reason this is a ScrollView rather than a PanResponder - the arbitration is the hard
        part, and it already exists. It also keeps day taps working, which a responder claiming
        the touch would not.
      */}
      <View onLayout={pager.onLayout}>
        <ScrollView ref={pager.pagerRef} {...pager.pagerProps}>
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
  const cells = useMemo(
    () =>
      // `monthCells` owns the six-week span and the build-from-components rule that keeps an ISO
      // string from ever becoming UTC midnight and rendering a day early. Shared with the date
      // picker, which draws the same span with different cells in it.
      monthCells(year, month).map((date) => ({
        date,
        key: toDateKey(date),
        inMonth: date.getMonth() === month - 1,
      })),
    [year, month],
  );

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
