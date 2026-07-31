/**
 * The events list: Upcoming and Past, merged.
 *
 * It reads the same merged calendar feed as the grid rather than an events-only endpoint, which is
 * why races, meetings and polls appear here too - `PRD/07` calls for one merged list, and a separate
 * events read would be a second source of truth about what is happening.
 *
 * Creating is admin-only and lives here rather than on the calendar grid, because an event belongs
 * to a club and this screen already has one.
 */

import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useDeclareClub } from '../../../../../src/current-space.tsx';
import { calendarApi, clubApi, contentApi } from '../../../../../src/api.ts';
import type { FeedItem } from '../../../../../src/api-types.ts';
import { bibParts, formatDateOnly, formatInstant } from '../../../../../src/dates.ts';
import { color, radius, space, type } from '../../../../../src/theme.ts';
import {
  Action,
  Body,
  DataScreen,
  DateField,
  EmptyState,
  Fab,
  Field,
  SectionHeader,
  Tabs,
  TimeField,
} from '../../../../../src/ui.tsx';
import { useLoad } from '../../../../../src/use-load.ts';


export default function ClubEventsScreen() {
  const { clubId, create, from } = useLocalSearchParams<{
    clubId: string;
    create?: string;
    from?: string;
  }>();
  const backRouter = useRouter();

  /*
   * Where to go once it exists. Chat's "+" menu sends `from=/chat/:channelId`, and an event made
   * there belongs back there: the creation posts its own card into that conversation.
   *
   * **Only an in-app chat path is honoured**, because `from` arrives in a URL and a URL is user
   * input - an unchecked one is an open redirect a deep link could point anywhere.
   */
  const returnTo = from?.startsWith('/chat/') === true ? from : null;
  // Inside this club for as long as this screen is mounted, which is what the Clubs tab reads.
  useDeclareClub(clubId);
  const [when, setWhen] = useState<'upcoming' | 'past'>('upcoming');

  const feed = useLoad(() => calendarApi.feed({ club: clubId, when }), [clubId, when]);
  const club = useLoad(() => clubApi.detail(clubId), [clubId]);
  const isAdmin = club.data?.club.viewer.isAdmin === true;

  /*
   * `?create=1` opens straight into the composer, which is how chat's "+" menu offers "Event".
   * There is no separate create route - the composer lives here.
   *
   * Started closed and opened by the effect rather than seeded into `useState`, because unlike
   * polls this screen does not know whether the viewer is an admin until the club read lands.
   * Seeding from the initial (undefined) value would open the composer for everybody.
   */
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    if (create === '1' && isAdmin) setCreating(true);
  }, [create, isAdmin]);

  /*
   * The composer owns the screen, header included - and the option is stated in BOTH directions.
   * `<Stack.Screen options>` is `navigation.setOptions` underneath, so it mutates the route and
   * does not roll back on unmount; setting it only on the way in left the list with no header.
   * Same reasoning as the poll composer.
   */
  const header = <Stack.Screen options={{ headerShown: !creating }} />;

  if (creating) {
    return (
      <>
        {header}
      <CreateEvent
        clubId={clubId}
        onCancel={() => {
          if (returnTo !== null) backRouter.replace(returnTo);
          else setCreating(false);
        }}
        onCreated={() => {
          setCreating(false);
          if (returnTo !== null) {
            backRouter.replace(returnTo);
            return;
          }
          feed.reload();
        }}
        />
      </>
    );
  }

  return (
    <View style={styles.flex}>
      {header}
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
        empty={<EmptyState title={when === 'upcoming' ? 'Nothing coming up' : 'Nothing in the past'} />}
      >
        {(data) => (
          <Body>
            {data.items.map((item) => (
              <EventRow key={`${item.kind}:${item.id}`} item={item} faded={when === 'past'} />
            ))}
          </Body>
        )}
      </DataScreen>

      {/* Positioned absolutely, so the list's own bottom padding leaves room for it. */}
      {isAdmin && <Fab onPress={() => setCreating(true)} accessibilityLabel="Add an event" />}
    </View>
  );
}

/** The tint for a row's kind. Shared vocabulary with the calendar's day list. */
function tintFor(kind: FeedItem['kind']): { background: string; text: string } {
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

/**
 * One row: a date "bib" beside the detail.
 *
 * v1's treatment, and it earns its space - a merged list of races, events, meetings and polls is
 * scanned by date far more often than by kind, and a left-aligned column of days is scannable in a
 * way a date buried in a subtitle is not.
 *
 * **A poll gets no bib.** Its `at` is a closing deadline rather than a day it happens on, and an
 * open-ended one has no date at all - a day chip would state something untrue.
 */
function EventRow({ item, faded }: { item: FeedItem; faded: boolean }) {
  const router = useRouter();
  const tint = tintFor(item.kind);
  const bib = item.kind === 'poll' || item.at === null ? null : bibParts(item.at);
  const target =
    item.kind === 'poll'
      ? `/polls/${item.id}`
      : item.kind === 'race'
        ? `/races/${item.id}`
        : item.kind === 'meeting'
          ? `/meetings/${item.id}`
          : undefined;

  const body = (
    <>
      {bib === null ? (
        <View style={[styles.bib, styles.bibEmpty]}>
          <MaterialIcons name="how-to-vote" size={22} color={color.textSecondary} />
        </View>
      ) : (
        <View style={[styles.bib, { backgroundColor: tint.background }]}>
          <Text style={[styles.bibDay, { color: tint.text }]}>{bib.day}</Text>
          <Text style={[styles.bibMonth, { color: tint.text }]}>{bib.month}</Text>
        </View>
      )}
      <View style={styles.rowBody}>
        <Text style={[styles.badge, { backgroundColor: tint.background, color: tint.text }]}>
          {item.kind.toUpperCase()}
        </Text>
        <Text style={styles.rowTitle}>{item.title}</Text>
        <Text style={styles.meta}>
          {item.at === null
            ? 'No deadline'
            : item.kind === 'race'
              ? formatDateOnly(item.at)
              : formatInstant(item.at)}
        </Text>
        {/* A race the viewer can see but not enter still appears, and says so. */}
        {item.kind === 'race' && !item.accessible && (
          <Text style={styles.meta}>You are not on this roster.</Text>
        )}
      </View>
      <MaterialIcons name="chevron-right" size={22} color={color.border} />
    </>
  );

  if (target === undefined) {
    return <View style={[styles.row, faded && styles.rowFaded]}>{body}</View>;
  }

  return (
    <Pressable
      style={[styles.row, faded && styles.rowFaded]}
      onPress={() => router.push(target)}
      accessibilityRole="button"
      accessibilityLabel={`${item.title}, ${item.kind}`}
    >
      {body}
    </Pressable>
  );
}

function CreateEvent({
  clubId,
  onCancel,
  onCreated,
}: {
  clubId: string;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState('');
  const [location, setLocation] = useState('');
  const [description, setDescription] = useState('');
  const [startDate, setStartDate] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endDate, setEndDate] = useState('');
  const [endTime, setEndTime] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  /*
   * A date and a time are separate fields and one instant.
   *
   * They are joined WITHOUT a timezone suffix, so `new Date()` reads them in the device's own
   * zone - which is what "practice at 5pm" means to the person typing it. Appending `Z` would
   * book it in UTC and move it by the offset, and that is the classic way a 5pm session shows
   * up at midnight for half the club.
   */
  const instant = (date: string, time: string): string | null => {
    if (date.length === 0 || time.length === 0) return null;
    const parsed = new Date(`${date}T${time}`);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  };

  const startsAt = instant(startDate, startTime);
  const endsAt = instant(endDate, endTime);

  /*
   * Two rules, checked here and stated to the member rather than left to a failed save.
   *
   *  1. **An event cannot start in the past.** Scheduling backwards is never what anyone meant,
   *     and a club that "has" a session which already happened is noise on every calendar.
   *  2. **It cannot end before it starts.** An end date is optional; an end BEFORE the start is
   *     not a shorter event, it is a typo.
   *
   * A half-filled end counts as unset rather than invalid, so picking a date and not yet a time
   * does not shout at somebody mid-way through filling the form in.
   */
  const endHalfFilled =
    (endDate.length > 0) !== (endTime.length > 0);
  const startsInPast = startsAt !== null && new Date(startsAt).getTime() <= Date.now();
  const endsBeforeStart =
    startsAt !== null && endsAt !== null && new Date(endsAt).getTime() <= new Date(startsAt).getTime();

  const problem = startsInPast
    ? 'That start is in the past. Pick a date and time still to come.'
    : endsBeforeStart
      ? 'The end has to come after the start.'
      : endHalfFilled
        ? 'An end needs both a date and a time, or neither.'
        : null;

  const valid = title.trim().length > 0 && startsAt !== null && problem === null;

  const submit = async () => {
    if (startsAt === null) return;
    setBusy(true);
    setFailed(null);
    try {
      await contentApi.createEvent(clubId, {
        /*
         * Always `other`, because this screen no longer asks.
         *
         * `calendar_events.type` is NOT NULL under a check constraint, so something has to go in
         * it. `other` is the honest value for "uncategorised" - picking `practice` on the
         * member's behalf would file every event under a category nobody chose. The column and
         * its constraint stay, so a type selector can come back without a migration.
         */
        type: 'other',
        title: title.trim(),
        startsAt,
        endsAt,
        location: location.trim().length > 0 ? location.trim() : null,
        description: description.trim().length > 0 ? description.trim() : null,
      });
      onCreated();
    } catch {
      setFailed('Could not create the event. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.flex}>
      <View style={styles.composerHeader}>
        <Pressable
          onPress={onCancel}
          style={styles.composerBack}
          accessibilityRole="button"
          accessibilityLabel="Discard this event and go back"
        >
          <MaterialIcons name="arrow-back" size={22} color={color.accent} />
        </Pressable>
        <Text style={styles.composerTitle}>New event</Text>
      </View>

      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.composerBody}
        keyboardShouldPersistTaps="handled"
      >
        {/* v1's heading: the name at display weight over a short accent rule. */}
        <View>
          <Text style={styles.composerHeading}>NEW EVENT</Text>
          <View style={styles.composerRule} />
        </View>

        <Text style={styles.composerLabel}>Event Title</Text>
        <TextInput
          style={styles.composerInput}
          value={title}
          onChangeText={setTitle}
          placeholder="e.g. Morning Sprint Championship"
          placeholderTextColor={color.textSecondary}
          accessibilityLabel="Event title"
        />

        <Text style={styles.composerLabel}>Location</Text>
        <View style={styles.composerInputRow}>
          <MaterialIcons name="place" size={18} color={color.textSecondary} />
          <TextInput
            style={styles.composerInputInline}
            value={location}
            onChangeText={setLocation}
            placeholder="Where's it happening?"
            placeholderTextColor={color.textSecondary}
            accessibilityLabel="Location"
          />
        </View>

        <Text style={styles.composerLabel}>Description</Text>
        <TextInput
          style={[styles.composerInput, styles.composerInputTall]}
          value={description}
          onChangeText={setDescription}
          placeholder="Tell the team what to bring, the schedule, and any requirements..."
          placeholderTextColor={color.textSecondary}
          multiline
          accessibilityLabel="Description"
        />

        <View style={styles.scheduleCard}>
          <Text style={styles.scheduleTitle}>SCHEDULE</Text>

          <Text style={styles.scheduleLabel}>Starts</Text>
          <View style={styles.scheduleRow}>
            <View style={styles.scheduleDate}>
              <DateField label="start date" value={startDate} onChange={setStartDate} />
            </View>
            <View style={styles.scheduleTime}>
              <TimeField label="Start time" value={startTime} onChange={setStartTime} />
            </View>
          </View>

          <Text style={styles.scheduleLabel}>Ends (optional)</Text>
          <View style={styles.scheduleRow}>
            <View style={styles.scheduleDate}>
              <DateField label="end date" value={endDate} onChange={setEndDate} optional />
            </View>
            <View style={styles.scheduleTime}>
              <TimeField label="End time" value={endTime} onChange={setEndTime} />
            </View>
          </View>
        </View>

        <Text style={styles.meta}>Creating an event tells every other member of the club.</Text>
        {/* The reason SAVE EVENT is refusing, said before it is pressed rather than after. */}
        {problem !== null && <Text style={styles.error}>{problem}</Text>}
        {failed !== null && <Text style={styles.error}>{failed}</Text>}

        <Pressable
          style={[styles.saveButton, (!valid || busy) && styles.saveButtonOff]}
          disabled={!valid || busy}
          onPress={() => void submit()}
          accessibilityRole="button"
          accessibilityLabel="Save event"
          accessibilityState={{ disabled: !valid || busy }}
        >
          <Text style={styles.saveButtonLabel}>{busy ? 'SAVING' : 'SAVE EVENT'}</Text>
          <MaterialIcons name="arrow-forward" size={18} color={color.onAccent} />
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  composerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    backgroundColor: color.chrome,
    borderBottomWidth: 1,
    borderBottomColor: color.divider,
  },
  composerBack: { padding: space.xs },
  composerTitle: { ...type.headerTitle, color: color.textPrimary },
  composerBody: { padding: space.md, paddingBottom: space.xl, gap: space.sm },
  composerHeading: { ...type.title, color: color.textPrimary },
  composerRule: {
    height: 3,
    width: 88,
    backgroundColor: color.accent,
    borderRadius: radius.pill,
    marginTop: space.xs,
    marginBottom: space.sm,
  },
  /* The field labels are accent-coloured in v1, which is what separates them from body copy. */
  composerLabel: { ...type.label, color: color.accent, marginTop: space.sm },
  composerInput: {
    ...type.body,
    backgroundColor: color.card,
    borderWidth: 1,
    borderColor: color.hairline,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 4,
    color: color.textPrimary,
  },
  composerInputTall: { minHeight: 104, textAlignVertical: 'top' },
  composerInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: color.card,
    borderWidth: 1,
    borderColor: color.hairline,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
  },
  composerInputInline: {
    ...type.body,
    flex: 1,
    paddingVertical: space.sm + 4,
    color: color.textPrimary,
  },
  scheduleCard: {
    backgroundColor: color.chrome,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.divider,
    padding: space.md,
    gap: space.sm,
    marginTop: space.md,
  },
  scheduleTitle: { ...type.headerTitle, fontSize: 18, color: color.textPrimary },
  scheduleLabel: { ...type.headline, fontSize: 14, color: color.textPrimary },
  scheduleRow: { flexDirection: 'row', gap: space.sm },
  scheduleDate: { flex: 2 },
  scheduleTime: { flex: 1 },
  saveButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    backgroundColor: color.accent,
    borderRadius: radius.pill,
    paddingVertical: space.md,
    marginTop: space.md,
  },
  saveButtonOff: { opacity: 0.6 },
  saveButtonLabel: { ...type.headerTitle, fontSize: 16, color: color.onAccent },
  flex: { flex: 1, backgroundColor: color.appBackground },
  tabsWrap: { padding: space.md, paddingBottom: 0 },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.md,
    backgroundColor: color.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.hairline,
    padding: space.md,
  },
  rowFaded: { opacity: 0.6 },
  bib: {
    width: 52,
    height: 60,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bibEmpty: { backgroundColor: color.cardSunken },
  bibDay: { ...type.numeric, fontSize: 22, lineHeight: 24 },
  bibMonth: { ...type.label, fontSize: 10, marginTop: 2 },
  rowBody: { flex: 1, gap: space.xs },
  rowTitle: { ...type.headline, color: color.textPrimary },
  badge: {
    ...type.label,
    fontSize: 10,
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    alignSelf: 'flex-start',
    overflow: 'hidden',
  },
  types: { flexDirection: 'row', gap: space.xs, flexWrap: 'wrap' },
  meta: { ...type.bodySmall, color: color.textSecondary },
  error: { ...type.bodySmall, color: color.error },
  actions: { flexDirection: 'row', gap: space.sm },
  actionButton: { flex: 1 },
});
