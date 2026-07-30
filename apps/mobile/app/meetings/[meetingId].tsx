/**
 * One meeting.
 *
 * Read-only for everybody but its creator, and it says who added it - which is the point of the
 * rule rather than a nicety: "Added by <name>" is what makes creator-only editing legible instead
 * of arbitrary.
 */

import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { contentApi } from '../../src/api.ts';
import { color, space, type } from '../../src/theme.ts';
import {
  Action,
  Body,
  Card,
  DataScreen,
  DetailLine,
  Field,
  SectionHeader,
} from '../../src/ui.tsx';
import { useLoad } from '../../src/use-load.ts';

export default function MeetingScreen() {
  const { meetingId } = useLocalSearchParams<{ meetingId: string }>();
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const load = useLoad(() => contentApi.meeting(meetingId), [meetingId]);

  return (
    <DataScreen load={load}>
      {(data) => {
        const meeting = data.meeting;

        if (editing) {
          return (
            <EditMeeting
              meetingId={meetingId}
              initial={meeting}
              onDone={() => {
                setEditing(false);
                load.reload();
              }}
              onCancel={() => setEditing(false)}
            />
          );
        }

        return (
          <Body>
            <Text style={styles.title}>{meeting.title}</Text>
            <Text style={styles.when}>{meeting.startsAt.slice(0, 16).replace('T', ' ')}</Text>
            <Card>
              <DetailLine label="Added by" value={meeting.creatorName} />
              <DetailLine label="Details" value={meeting.description} />
              <DetailLine label="Link" value={meeting.link} />
            </Card>

            {/* Creator only. Everybody else in the space is view-only. */}
            {meeting.isCreator && (
              <>
                <SectionHeader title="Yours to manage" />
                <Action label="Edit" variant="secondary" onPress={() => setEditing(true)} />
                {confirming ? (
                  <Card>
                    <Text style={styles.meta}>
                      Delete "{meeting.title}"? Its card disappears from board chat and it leaves
                      the calendar.
                    </Text>
                    <View style={styles.actions}>
                      <Action
                        label="Keep"
                        variant="secondary"
                        style={styles.actionButton}
                        onPress={() => setConfirming(false)}
                      />
                      <Action
                        label="Delete"
                        variant="danger"
                        style={styles.actionButton}
                        onPress={() => {
                          void contentApi
                            .deleteMeeting(meetingId)
                            .then(() => router.back(), load.reload);
                        }}
                      />
                    </View>
                  </Card>
                ) : (
                  <Action label="Delete meeting" variant="danger" onPress={() => setConfirming(true)} />
                )}
              </>
            )}
          </Body>
        );
      }}
    </DataScreen>
  );
}

function EditMeeting({
  meetingId,
  initial,
  onDone,
  onCancel,
}: {
  meetingId: string;
  initial: { title: string; description: string | null; startsAt: string; link: string | null };
  onDone: () => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initial.title);
  const [description, setDescription] = useState(initial.description ?? '');
  const [starts, setStarts] = useState(initial.startsAt.slice(0, 16));
  const [link, setLink] = useState(initial.link ?? '');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setFailed(null);
    try {
      // A true partial update, unlike Meet Information: a meeting is a record with independently
      // editable parts rather than one atomic form.
      await contentApi.updateMeeting(meetingId, {
        title: title.trim(),
        description: description.trim().length > 0 ? description.trim() : null,
        startsAt: new Date(starts.trim()).toISOString(),
        link: link.trim().length > 0 ? link.trim() : null,
      });
      onDone();
    } catch {
      setFailed('Could not save. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Body>
      <SectionHeader title="Edit meeting" />
      <Field label="Title" value={title} onChangeText={setTitle} />
      <Field label="Starts" value={starts} onChangeText={setStarts} placeholder="2027-03-01T18:00" />
      <Field label="Details" value={description} onChangeText={setDescription} multiline />
      <Field label="Link" value={link} onChangeText={setLink} keyboardType="url" />
      {failed !== null && <Text style={styles.error}>{failed}</Text>}
      <View style={styles.actions}>
        <Action label="Cancel" variant="secondary" style={styles.actionButton} onPress={onCancel} />
        <Action
          label={busy ? 'Saving' : 'Save'}
          style={styles.actionButton}
          disabled={busy || title.trim().length === 0}
          onPress={() => void save()}
        />
      </View>
    </Body>
  );
}

const styles = StyleSheet.create({
  title: { ...type.title, color: color.textPrimary },
  when: { ...type.label, color: color.textSecondary, textTransform: 'uppercase' },
  meta: { ...type.bodySmall, color: color.textSecondary },
  error: { ...type.bodySmall, color: color.error },
  actions: { flexDirection: 'row', gap: space.sm },
  actionButton: { flex: 1 },
});
