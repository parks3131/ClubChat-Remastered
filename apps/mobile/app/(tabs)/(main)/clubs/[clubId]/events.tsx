/**
 * The events list: Upcoming and Past, merged.
 *
 * It reads the same merged calendar feed as the grid rather than an events-only endpoint, which is
 * why races and meetings appear here too - `PRD/07` calls for one merged list, and a separate
 * events read would be a second source of truth about what is happening.
 *
 * **Polls are not on it**, since 2026-08-15. This list and the grid are now the same set of rows
 * rather than the grid being a subset, which is what the exception cost: a poll has a closing
 * deadline rather than a day, so it needed a nullable date, no bib, and an "upcoming" rule that
 * read open/closed. Polls live on the club, race and Eboard poll screens.
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
import { useReturnTo } from '../../../../../src/nav.tsx';
import { color, radius, space, type } from '../../../../../src/theme.ts';
import {
  Action,
  Body,
  ComposerHeader,
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
  const returnToSender = useReturnTo();

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
          if (returnTo !== null) returnToSender(returnTo);
          else setCreating(false);
        }}
        onCreated={() => {
          setCreating(false);
          if (returnTo !== null) {
            // Unwind to the conversation, never navigate to it - see `useReturnTo`.
            returnToSender(returnTo);
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
    case 'event':
      return { background: color.tertiarySoft, text: color.onTertiarySoft };
    // The quietest of the four: a meetup is the routine thing and appears most often, so the
    // accent stays with the race. Same vocabulary as the calendar's day list.
    case 'meetup':
      return { background: color.secondaryContainer, text: color.onSecondarySoft };
  }
}

/**
 * One row: a date "bib" beside the detail.
 *
 * v1's treatment, and it earns its space - a merged list of races, events and meetings is scanned
 * by date far more often than by kind, and a left-aligned column of days is scannable in a way a
 * date buried in a subtitle is not.
 *
 * **Every row carries a bib.** A poll was the one kind that could not: its `at` was a closing
 * deadline rather than a day it happens on, and an open-ended one had no date at all, so a day
 * chip would have stated something untrue. Polls left this list on 2026-08-15.
 */
function EventRow({ item, faded }: { item: FeedItem; faded: boolean }) {
  const router = useRouter();
  const tint = tintFor(item.kind);
  const bib = bibParts(item.at, item.allDay);
  // Every kind on this merged feed opens a screen about itself, meetups included since they got
  // one on 2026-08-15. See the calendar's copy of this.
  const target =
    item.kind === 'race'
      ? `/races/${item.id}`
      : item.kind === 'meeting'
        ? `/meetings/${item.id}`
        : item.kind === 'meetup'
          ? `/meetups/${item.id}`
          : `/events/${item.id}`;

  const body = (
    <>
      <View style={[styles.bib, { backgroundColor: tint.background }]}>
        <Text style={[styles.bibDay, { color: tint.text }]}>{bib.day}</Text>
        <Text style={[styles.bibMonth, { color: tint.text }]}>{bib.month}</Text>
      </View>
      <View style={styles.rowBody}>
        <Text style={[styles.badge, { backgroundColor: tint.background, color: tint.text }]}>
          {item.kind.toUpperCase()}
        </Text>
        <Text style={styles.rowTitle}>{item.title}</Text>
        {/*
          Branched on `allDay`, NOT on the kind. Those were the same thing for as long as a race
          was the only date-only kind, and stopped being the same thing the moment a meetup
          arrived: `formatInstant` on a date-only value reads it as UTC midnight, which is the
          dated bug `FeedItem.allDay` exists to prevent. A meetup adds its own clock after the
          date, printed as the club typed it.
        */}
        <Text style={styles.meta}>
          {item.allDay ? formatDateOnly(item.at) : formatInstant(item.at)}
          {item.timeOfDay !== null && ` at ${item.timeOfDay}`}
        </Text>
        {/* A race the viewer can see but not enter still appears, and says so. */}
        {item.kind === 'race' && !item.accessible && (
          <Text style={styles.meta}>You are not on this roster.</Text>
        )}
      </View>
      <MaterialIcons name="chevron-right" size={22} color={color.border} />
    </>
  );

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
  /*
   * The map link, beside the place rather than instead of it.
   *
   * Two fields because they answer two questions: `location` is where in the club's own words -
   * "the wooden archway", "Room 204" - and this is what a phone can open. ADR-0039 settled that
   * for a meetup and the reasoning carries over unchanged; an event is the other surface that
   * says where, and a member who has learned that a pasted link becomes Directions must not find
   * it missing here.
   */
  const [mapUrl, setMapUrl] = useState('');
  const [description, setDescription] = useState('');
  const [startDate, setStartDate] = useState('');
  const [startTime, setStartTime] = useState('');
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

  /*
   * One rule now, stated to the member rather than left to a failed save: **an event cannot start
   * in the past.** Scheduling backwards is never what anyone meant, and a club that "has" a
   * session which already happened is noise on every calendar.
   *
   * > **The end time was removed from this form on 2026-08-17, at the founder's request** - "I
   * > don't want the end option nowadays". Two of the three rules that used to live here were
   * > about it, and both are gone with it: an end before the start, and an end half-filled with a
   * > date but no time.
   * >
   * > **The column stays and so does everything that reads it.** `ends_at` is nullable, events
   * > created before today still carry one, and `eventWhen` still renders a range when it finds
   * > one. Dropping the field from a form is not a reason to destroy data somebody entered, and a
   * > migration removing it would be exactly that.
   */
  const startsInPast = startsAt !== null && new Date(startsAt).getTime() <= Date.now();

  const problem = startsInPast
    ? 'That start is in the past. Pick a date and time still to come.'
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
        // No end is sent at all, rather than an empty one - the field is gone from this form and
        // the column is left to the events that already have one.
        location: location.trim().length > 0 ? location.trim() : null,
        // Sent as typed. The server validates the host and stores nothing it does not recognise,
        // so a mistyped link is a missing Directions button rather than a refused event.
        mapUrl: mapUrl.trim().length > 0 ? mapUrl.trim() : null,
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
      {/*
        One title, and it names the act rather than the noun.

        This screen said "New event" in the header AND "NEW EVENT" again as the first thing in the
        body, in two different treatments, so the top of the form was the same two words twice.
        The header is the copy that survives, because it is the one carrying the way out.
      */}
      <ComposerHeader
        title="Create event"
        discardLabel="Discard this event and go back"
        onCancel={onCancel}
      />

      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.composerBody}
        keyboardShouldPersistTaps="handled"
      >
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

        {/*
          The link, under the place it belongs to.

          Its own field rather than a second use of the one above, because the two are different
          answers: one is where in the club's own words and the other is what a phone can open.
          The placeholder says what pasting one BUYS you, since a URL field with no explanation
          reads as homework - and the whole point is that it is optional.

          `autoCapitalize` and `autoCorrect` off, which is not fussiness: iOS capitalises the first
          letter and autocorrects what it takes for words, and "Https://Maps.app.goo.gl" is a link
          the server will not recognise. The meetup composer learned this first.
        */}
        <Text style={styles.composerLabel}>Location link (optional)</Text>
        <View style={styles.composerInputRow}>
          <MaterialIcons name="link" size={18} color={color.textSecondary} />
          <TextInput
            style={styles.composerInputInline}
            value={mapUrl}
            onChangeText={setMapUrl}
            placeholder="Paste a Google or Apple Maps link"
            placeholderTextColor={color.textSecondary}
            accessibilityLabel="A map link for this event"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
        </View>
        <Text style={styles.meta}>
          Paste a map link and the event gets a Directions button, the same as a meetup.
        </Text>

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
  composerBody: { padding: space.md, paddingBottom: space.xl, gap: space.sm },
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
