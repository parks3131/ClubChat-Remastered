/**
 * The Calendar destination: the cross-club merged feed.
 *
 * Two views over one read, which is the server's design and therefore this screen's: a month grid
 * for "what is happening when", and a list for "what is coming up". There is no calendar table for
 * anything to write into, so neither view can be stale relative to the other.
 *
 * **The cross-club view tags every row with its club and offers no create action** - creating an
 * event belongs to a club, and a cross-club create would have to ask which one, which is the club
 * calendar's job. The club-scoped version of this screen is the same component with a club id.
 */

import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Redirect } from 'expo-router';
import { calendarApi } from '../../src/api.ts';
import type { FeedItem } from '../../src/api-types.ts';
import { useSession } from '../../src/chat-provider.tsx';
import { color, radius, space, type } from '../../src/theme.ts';
import { Badge, Card, DataScreen, EmptyState, Row, SectionHeader, Tabs } from '../../src/ui.tsx';
import { useLoad } from '../../src/use-load.ts';

/** Local date parts, built from components rather than parsing an ISO string. */
function todayParts(): { year: number; month: number } {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

export default function CalendarScreen() {
  const { authState } = useSession();
  if (authState === 'checking') return <View style={styles.flex} />;
  if (authState === 'signed-out') return <Redirect href="/sign-in" />;
  return <CalendarView />;
}

/**
 * Shared by this destination and the club-scoped calendar.
 *
 * Exported so `clubs/[clubId]/calendar.tsx` renders the same component with a club id rather than
 * a second implementation - design-system rule 5.
 */
export function CalendarView({ clubId }: { clubId?: string } = {}) {
  const [when, setWhen] = useState<'upcoming' | 'past'>('upcoming');
  const [cursor, setCursor] = useState(todayParts());

  const feed = useLoad(
    () => calendarApi.feed({ ...(clubId ? { club: clubId } : {}), when }),
    [clubId, when],
  );
  const markers = useLoad(
    () => calendarApi.markers({ ...(clubId ? { club: clubId } : {}), ...cursor }),
    [clubId, cursor.year, cursor.month],
  );

  const step = (delta: number) => {
    setCursor((current) => {
      const zeroBased = current.month - 1 + delta;
      return {
        year: current.year + Math.floor(zeroBased / 12),
        month: ((zeroBased % 12) + 12) % 12 + 1,
      };
    });
  };

  return (
    <View style={styles.flex}>
      <View style={styles.gridWrap}>
        <MonthGrid
          year={cursor.year}
          month={cursor.month}
          marked={markers.data?.days ?? []}
          onPrev={() => step(-1)}
          onNext={() => step(1)}
        />
      </View>

      <View style={styles.tabsWrap}>
        <Tabs
          tabs={[
            { key: 'upcoming', label: 'Upcoming' },
            { key: 'past', label: 'Past' },
          ]}
          active={when}
          onChange={setWhen}
        />
      </View>

      <DataScreen
        load={feed}
        isEmpty={(data) => data.items.length === 0}
        empty={
          <EmptyState
            title={
              when === 'upcoming'
                ? clubId
                  ? 'Nothing coming up'
                  : 'No events across your clubs yet'
                : 'Nothing in the past yet'
            }
          />
        }
      >
        {(data) => (
          <View style={styles.list}>
            {data.items.map((item) => (
              <FeedRow key={`${item.kind}:${item.id}`} item={item} showClub={clubId === undefined} />
            ))}
          </View>
        )}
      </DataScreen>
    </View>
  );
}

function FeedRow({ item, showClub }: { item: FeedItem; showClub: boolean }) {
  const dayLabel =
    item.at === null
      ? // A poll has a deadline rather than a day. An open one with no deadline shows neither,
        // and must never read as overdue.
        'No deadline'
      : item.at.slice(0, 10);

  const target =
    item.kind === 'poll'
      ? `/polls/${item.id}`
      : item.kind === 'race'
        ? `/races/${item.id}`
        : item.kind === 'meeting'
          ? `/meetings/${item.id}`
          : undefined;

  return (
    <Row
      title={item.title}
      subtitle={`${dayLabel}${showClub ? `  ·  ${item.clubName}` : ''}`}
      {...(target ? { href: target } : {})}
      right={
        <>
          <Badge label={item.kind} tone="muted" />
          {/* A race the viewer can see but not enter still appears, and says so. */}
          {item.kind === 'race' && !item.accessible && <Badge label="No access" tone="muted" />}
          {item.kind === 'poll' && item.open === false && <Badge label="Closed" tone="muted" />}
        </>
      }
    />
  );
}

/**
 * The month grid.
 *
 * Two rules from the acceptance checklist live here: **exactly the days that carry something are
 * marked, with no filler days**, and **paging months does not change the grid's height**. The
 * second is why the cell count is always six weeks: a month that starts on a Sunday and one that
 * starts on a Saturday would otherwise render five rows and six.
 */
function MonthGrid({
  year,
  month,
  marked,
  onPrev,
  onNext,
}: {
  year: number;
  month: number;
  marked: readonly string[];
  onPrev: () => void;
  onNext: () => void;
}) {
  const markedSet = new Set(marked);
  // Built from components, never from a parsed ISO string: an ISO date is UTC midnight and
  // renders a day early in a negative-offset timezone.
  const first = new Date(year, month - 1, 1);
  const leading = first.getDay();
  const daysInMonth = new Date(year, month, 0).getDate();

  const cells: Array<{ day: number | null; iso: string }> = [];
  for (let i = 0; i < leading; i += 1) cells.push({ day: null, iso: '' });
  for (let day = 1; day <= daysInMonth; day += 1) {
    const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    cells.push({ day, iso });
  }
  // Fixed at six weeks so the grid's height never changes as months are paged.
  while (cells.length < 42) cells.push({ day: null, iso: '' });

  const monthName = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  return (
    <Card>
      <SectionHeader
        title={monthName}
        action={
          <View style={styles.monthNav}>
            <Text
              style={styles.monthStep}
              onPress={onPrev}
              accessibilityRole="button"
              accessibilityLabel="Previous month"
            >
              {'<'}
            </Text>
            <Text
              style={styles.monthStep}
              onPress={onNext}
              accessibilityRole="button"
              accessibilityLabel="Next month"
            >
              {'>'}
            </Text>
          </View>
        }
      />
      <View style={styles.weekHeader}>
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((label, index) => (
          <Text key={`${label}${index}`} style={styles.weekLabel}>
            {label}
          </Text>
        ))}
      </View>
      <View style={styles.grid}>
        {cells.map((cell, index) => (
          <View key={index} style={styles.cell}>
            {cell.day !== null && (
              <>
                <Text style={styles.cellDay}>{cell.day}</Text>
                {/* A marker only ever belongs to the month on screen: a filler day has no iso. */}
                {markedSet.has(cell.iso) && <View style={styles.dot} />}
              </>
            )}
          </View>
        ))}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: color.appBackground },
  gridWrap: { padding: space.md, paddingBottom: 0 },
  tabsWrap: { padding: space.md, paddingBottom: space.sm },
  list: { paddingHorizontal: space.md, gap: space.sm, paddingBottom: space.lg },
  monthNav: { flexDirection: 'row', gap: space.md },
  monthStep: { ...type.headline, color: color.accent, paddingHorizontal: space.sm },
  weekHeader: { flexDirection: 'row' },
  weekLabel: {
    ...type.label,
    color: color.textSecondary,
    flexBasis: '14.2857%',
    textAlign: 'center',
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: {
    flexBasis: '14.2857%',
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  cellDay: { ...type.bodySmall, color: color.textPrimary },
  dot: { width: 5, height: 5, borderRadius: radius.pill, backgroundColor: color.accent },
});
