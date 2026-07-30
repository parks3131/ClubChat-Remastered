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

import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { calendarApi, clubApi, contentApi } from '../../../src/api.ts';
import type { EventType } from '../../../src/api-types.ts';
import { color, space, type } from '../../../src/theme.ts';
import {
  Action,
  Badge,
  Body,
  DataScreen,
  EmptyState,
  Field,
  Row,
  SectionHeader,
  Tabs,
} from '../../../src/ui.tsx';
import { useLoad } from '../../../src/use-load.ts';

const TYPES: readonly EventType[] = ['practice', 'team_bonding', 'volunteer', 'other', 'race'];

export default function ClubEventsScreen() {
  const { clubId } = useLocalSearchParams<{ clubId: string }>();
  const [when, setWhen] = useState<'upcoming' | 'past'>('upcoming');
  const [creating, setCreating] = useState(false);

  const feed = useLoad(() => calendarApi.feed({ club: clubId, when }), [clubId, when]);
  const club = useLoad(() => clubApi.detail(clubId), [clubId]);
  const isAdmin = club.data?.club.viewer.isAdmin === true;

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
              <Row
                key={`${item.kind}:${item.id}`}
                title={item.title}
                subtitle={item.at === null ? 'No deadline' : item.at.slice(0, 10)}
                href={
                  item.kind === 'poll'
                    ? `/polls/${item.id}`
                    : item.kind === 'race'
                      ? `/races/${item.id}`
                      : item.kind === 'meeting'
                        ? `/meetings/${item.id}`
                        : undefined
                }
                right={<Badge label={item.kind} tone="muted" />}
              />
            ))}
          </Body>
        )}
      </DataScreen>

      {isAdmin && (
        <View style={styles.footer}>
          <Action label="Add an event" onPress={() => setCreating(true)} />
        </View>
      )}
    </View>
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
  footer: {
    padding: space.md,
    backgroundColor: color.chrome,
    borderTopWidth: 1,
    borderTopColor: color.divider,
  },
  types: { flexDirection: 'row', gap: space.xs, flexWrap: 'wrap' },
  meta: { ...type.bodySmall, color: color.textSecondary },
  error: { ...type.bodySmall, color: color.error },
  actions: { flexDirection: 'row', gap: space.sm },
  actionButton: { flex: 1 },
});
