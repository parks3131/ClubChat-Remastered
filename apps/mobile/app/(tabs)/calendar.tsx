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

import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { Redirect, useNavigation, useRouter } from 'expo-router';
import { useCurrentSpace } from '../../src/current-space.tsx';
import { calendarApi } from '../../src/api.ts';
import type { FeedItem } from '../../src/api-types.ts';
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
  const [selected, setSelected] = useState<string | null>(null);

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

  const step = (delta: number) => {
    setSelected(null);
    setCursor((current) => {
      const zeroBased = current.month - 1 + delta;
      return {
        year: current.year + Math.floor(zeroBased / 12),
        month: (((zeroBased % 12) + 12) % 12) + 1,
      };
    });
  };

  return (
    <DataScreen load={feed}>
      {(data) => {
        // Polls are excluded from the grid: a poll has a closing deadline, not a day it happens
        // on. They stay in the events list, which is where PRD/07 puts them.
        const byDay = new Map<string, FeedItem[]>();
        for (const item of data.items) {
          if (item.kind === 'poll' || item.at === null) continue;
          const day = item.at.slice(0, 10);
          const bucket = byDay.get(day);
          if (bucket) bucket.push(item);
          else byDay.set(day, [item]);
        }

        const dayItems = selected === null ? [] : (byDay.get(selected) ?? []);

        return (
          <ScrollView style={styles.flex} contentContainerStyle={styles.content}>
            <MonthGrid
              year={cursor.year}
              month={cursor.month}
              byDay={byDay}
              selected={selected}
              onSelect={(day) => setSelected((current) => (current === day ? null : day))}
              onPrev={() => step(-1)}
              onNext={() => step(1)}
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
      {item.at !== null && <Text style={styles.meta}>{formatTimeOfDay(item.at)}</Text>}
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

function MonthGrid({
  year,
  month,
  byDay,
  selected,
  onSelect,
  onPrev,
  onNext,
}: {
  year: number;
  month: number;
  byDay: ReadonlyMap<string, FeedItem[]>;
  selected: string | null;
  onSelect: (day: string) => void;
  onPrev: () => void;
  onNext: () => void;
}) {
  const todayKey = toDateKey(new Date());

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
    <View>
      <View style={styles.monthHead}>
        <Pressable
          onPress={onPrev}
          hitSlop={space.sm}
          accessibilityRole="button"
          accessibilityLabel="Previous month"
        >
          <MaterialIcons name="chevron-left" size={26} color={color.textPrimary} />
        </Pressable>
        <Text style={styles.monthTitle}>{formatMonthTitle(year, month)}</Text>
        <Pressable
          onPress={onNext}
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

      <View style={styles.grid}>
        {cells.map((cell) => {
          // Gated on `inMonth` for BOTH the marker and the gesture: a filler day that happens to
          // carry something must not render the same solid marker a real day gets, or it reads as
          // a prominent control sitting in the wrong month that does nothing when tapped.
          const marked = cell.inMonth && byDay.has(cell.key);
          const isToday = cell.key === todayKey;
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
}

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
