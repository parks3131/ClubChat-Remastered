/**
 * Eboard meetings: Upcoming and Past.
 *
 * **Any member of the space creates one; only the creator edits or deletes it.** That asymmetry
 * landed after two explicit founder follow-ups on a version where any member could edit any
 * meeting, which is why `isCreator` is the flag and the detail view says who added it.
 *
 * The split is by the clock, not by a stored flag: a meeting becomes past by time passing.
 */

import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { contentApi } from '../../../src/api.ts';
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

export default function MeetingsScreen() {
  const { eboardId } = useLocalSearchParams<{ eboardId: string }>();
  const [when, setWhen] = useState<'upcoming' | 'past'>('upcoming');
  const [composing, setComposing] = useState(false);

  const load = useLoad(() => contentApi.meetings(eboardId, when), [eboardId, when]);

  if (composing) {
    return (
      <NewMeeting
        eboardId={eboardId}
        onCancel={() => setComposing(false)}
        onCreated={() => {
          setComposing(false);
          load.reload();
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
        load={load}
        isEmpty={(data) => data.meetings.length === 0}
        empty={
          <EmptyState
            title={when === 'upcoming' ? 'No meetings scheduled' : 'No past meetings'}
            body={when === 'upcoming' ? 'Any member of this space can add one.' : undefined}
          />
        }
      >
        {(data) => (
          <Body>
            {data.meetings.map((meeting) => (
              <Row
                key={meeting.id}
                title={meeting.title}
                subtitle={`${meeting.startsAt.slice(0, 16).replace('T', ' ')}  ·  added by ${meeting.creatorName}`}
                href={`/meetings/${meeting.id}`}
                right={meeting.isCreator ? <Badge label="Yours" tone="muted" /> : undefined}
              />
            ))}
          </Body>
        )}
      </DataScreen>

      <View style={styles.footer}>
        <Action label="Add a meeting" onPress={() => setComposing(true)} />
      </View>
    </View>
  );
}

function NewMeeting({
  eboardId,
  onCancel,
  onCreated,
}: {
  eboardId: string;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [starts, setStarts] = useState('');
  const [link, setLink] = useState('');
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A meeting has a time, unlike a race which has only a day - so this is a full timestamp.
  const valid = title.trim().length > 0 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(starts.trim());

  const submit = async () => {
    setBusy(true);
    setFailed(null);
    try {
      await contentApi.createMeeting(eboardId, {
        title: title.trim(),
        description: description.trim().length > 0 ? description.trim() : null,
        // Sent as a full ISO instant. The local value is interpreted in the caller's zone, which
        // is correct: somebody typing 18:00 means six in the evening where they are.
        startsAt: new Date(starts.trim()).toISOString(),
        link: link.trim().length > 0 ? link.trim() : null,
      });
      onCreated();
    } catch {
      setFailed('Could not create the meeting. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Body>
      <SectionHeader title="New meeting" />
      <Field label="Title" value={title} onChangeText={setTitle} placeholder="Budget review" />
      <Field label="Starts" value={starts} onChangeText={setStarts} placeholder="2027-03-01T18:00" />
      <Field label="Details" value={description} onChangeText={setDescription} multiline />
      <Field label="Link" value={link} onChangeText={setLink} keyboardType="url" />
      <Text style={styles.meta}>
        Creating this tells the other members and posts a card into board chat. It appears on the
        calendar of members only.
      </Text>
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
  meta: { ...type.bodySmall, color: color.textSecondary },
  error: { ...type.bodySmall, color: color.error },
  actions: { flexDirection: 'row', gap: space.sm },
  actionButton: { flex: 1 },
});
