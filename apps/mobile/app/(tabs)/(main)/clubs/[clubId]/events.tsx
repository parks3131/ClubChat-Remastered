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
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useDeclareClub } from '../../../../../src/current-club.tsx';
import { calendarApi, clubApi, contentApi } from '../../../../../src/api.ts';
import type { EventType, FeedItem } from '../../../../../src/api-types.ts';
import { bibParts, formatDateOnly, formatInstant } from '../../../../../src/dates.ts';
import { color, radius, space, type } from '../../../../../src/theme.ts';
import {
  Action,
  Body,
  DataScreen,
  EmptyState,
  Fab,
  Field,
  SectionHeader,
  Tabs,
} from '../../../../../src/ui.tsx';
import { useLoad } from '../../../../../src/use-load.ts';

const TYPES: readonly EventType[] = ['practice', 'team_bonding', 'volunteer', 'other', 'race'];

export default function ClubEventsScreen() {
  const { clubId, create } = useLocalSearchParams<{ clubId: string; create?: string }>();
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

  if (creating) {
    return (
      <CreateEvent
        clubId={clubId}
        onCancel={() => setCreating(false)}
        onCreated={() => {
          setCreating(false);
          feed.reload();
        }}
      />
    );
  }

  return (
    <View style={styles.flex}>
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
  const [starts, setStarts] = useState('');
  const [location, setLocation] = useState('');
  const [kind, setKind] = useState<EventType>('practice');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const valid = title.trim().length > 0 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(starts.trim());

  const submit = async () => {
    setBusy(true);
    setFailed(null);
    try {
      await contentApi.createEvent(clubId, {
        type: kind,
        title: title.trim(),
        startsAt: new Date(starts.trim()).toISOString(),
        location: location.trim().length > 0 ? location.trim() : null,
      });
      onCreated();
    } catch {
      setFailed('Could not create the event. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Body>
      <SectionHeader title="New event" />
      <Field label="Title" value={title} onChangeText={setTitle} placeholder="Track session" />
      <Field label="Starts" value={starts} onChangeText={setStarts} placeholder="2027-04-01T17:00" />
      <Field label="Location" value={location} onChangeText={setLocation} />

      <SectionHeader title="Type" />
      <View style={styles.types}>
        {TYPES.map((option) => (
          <Action
            key={option}
            label={option.replace('_', ' ')}
            variant={option === kind ? 'primary' : 'secondary'}
            onPress={() => setKind(option)}
          />
        ))}
      </View>
      {kind === 'race' && (
        // A label only, with no relationship to a real Race. Whether the type should exist at all
        // is an open question in PRD/17; saying so here stops somebody expecting a roster.
        <Text style={styles.meta}>
          A "race" event is a calendar label. It does not create a Race with a roster and chat - use
          Races & Meets for that.
        </Text>
      )}

      <Text style={styles.meta}>Creating an event tells every other member of the club.</Text>
      {failed !== null && <Text style={styles.error}>{failed}</Text>}
      <View style={styles.actions}>
        <Action label="Cancel" variant="secondary" style={styles.actionButton} onPress={onCancel} />
        <Action
          label={busy ? 'Creating' : 'Create'}
          style={styles.actionButton}
          disabled={!valid || busy}
          onPress={() => void submit()}
        />
      </View>
    </Body>
  );
}

const styles = StyleSheet.create({
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
