/**
 * One meeting.
 *
 * **Editing is creator-only; cancelling is not.** The screen shows "Added by <name>" either way,
 * which is what makes that pair legible rather than arbitrary: editing rewrites somebody's record
 * of what they called, and cancelling says a thing is not happening - a fact about the board's
 * week rather than about its author.
 *
 * Reaching this screen at all requires membership of the space, so there is no separate
 * permission to read here: everyone who can see it can cancel it, and only the name under
 * "Added by" can edit it.
 */

import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { contentApi } from '../../../../src/api.ts';
import { formatInstant } from '../../../../src/dates.ts';
import { color, space, type } from '../../../../src/theme.ts';
import {
  Action,
  Body,
  Card,
  ConfirmDialog,
  DataScreen,
  DateField,
  DetailLine,
  Field,
  SectionHeader,
  TimeField,
} from '../../../../src/ui.tsx';
import { useLoad } from '../../../../src/use-load.ts';

export default function MeetingScreen() {
  const { meetingId } = useLocalSearchParams<{ meetingId: string }>();
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const load = useLoad(() => contentApi.meeting(meetingId), [meetingId]);

  return (
    <DataScreen load={load} errorMessage="Couldn't load this meeting.">
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
            <Text style={styles.when}>{formatInstant(meeting.startsAt)}</Text>
            <Card>
              <DetailLine label="Added by" value={meeting.creatorName} />
              <DetailLine label="Agenda" value={meeting.description} />
              <DetailLine label="Link" value={meeting.link} />
            </Card>

            {/* Creator only. Everybody else in the space is view-only where EDITING is
                concerned - and can still cancel it, below. */}
            {meeting.isCreator && (
              <>
                <SectionHeader title="Yours to edit" />
                <Action label="Edit" variant="secondary" onPress={() => setEditing(true)} />
              </>
            )}

            {failed !== null && <Text style={styles.error}>{failed}</Text>}
            {/*
              Open to every member of the space, not only the creator. The confirm names what
              happens next, because it happens in front of the whole board: the card in chat is
              replaced by a line saying you called it off.
            */}
            <Action
              label="Cancel meeting"
              variant="danger"
              onPress={() => setConfirming(true)}
            />

            {confirming && (
              <ConfirmDialog
                title="Cancel this meeting?"
                body={`"${meeting.title}" leaves the calendar for everyone in the space, and board chat will show that you cancelled it. This cannot be undone.`}
                confirmLabel="Cancel meeting"
                // Not "Cancel": beside "Cancel meeting" it is a coin toss.
                dismissLabel="Keep it"
                onCancel={() => setConfirming(false)}
                onConfirm={() => {
                  setConfirming(false);
                  setFailed(null);
                  void contentApi.deleteMeeting(meetingId).then(
                    () => router.back(),
                    () => setFailed('Could not cancel the meeting. Try again.'),
                  );
                }}
              />
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
  const [link, setLink] = useState(initial.link ?? '');
  /*
   * Seeded in LOCAL time, not by slicing the ISO string.
   *
   * `startsAt` is UTC; `slice(0, 10)` on it is the UTC day, which is the wrong day for anyone
   * west of Greenwich after their evening. Reading it through a Date and formatting the parts is
   * what makes the form open showing the time the meeting actually starts for this reader.
   */
  const [startDate, setStartDate] = useState(() => localDate(initial.startsAt));
  const [startTime, setStartTime] = useState(() => localTime(initial.startsAt));
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const startsAt = (() => {
    if (startDate.length === 0 || startTime.length === 0) return null;
    const parsed = new Date(`${startDate}T${startTime}`);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  })();

  const save = async () => {
    if (startsAt === null) return;
    setBusy(true);
    setFailed(null);
    try {
      // A true partial update, unlike Meet Information: a meeting is a record with independently
      // editable parts rather than one atomic form.
      await contentApi.updateMeeting(meetingId, {
        title: title.trim(),
        description: description.trim().length > 0 ? description.trim() : null,
        startsAt,
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
      <View style={styles.scheduleRow}>
        <View style={styles.scheduleDate}>
          <DateField label="start date" value={startDate} onChange={setStartDate} />
        </View>
        <View style={styles.scheduleTime}>
          <TimeField label="Start time" value={startTime} onChange={setStartTime} />
        </View>
      </View>
      <Field label="Agenda" value={description} onChangeText={setDescription} multiline />
      <Field label="Link" value={link} onChangeText={setLink} keyboardType="url" />
      {failed !== null && <Text style={styles.error}>{failed}</Text>}
      <View style={styles.actions}>
        <Action label="Cancel" variant="secondary" style={styles.actionButton} onPress={onCancel} />
        <Action
          label={busy ? 'Saving' : 'Save'}
          style={styles.actionButton}
          disabled={busy || title.trim().length === 0 || startsAt === null}
          onPress={() => void save()}
        />
      </View>
    </Body>
  );
}

/** `YYYY-MM-DD` for an instant, in the reader's own zone. */
function localDate(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `HH:MM` for an instant, in the reader's own zone. */
function localTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const styles = StyleSheet.create({
  title: { ...type.title, color: color.textPrimary },
  when: { ...type.label, color: color.textSecondary, textTransform: 'none' },
  error: { ...type.bodySmall, color: color.error },
  actions: { flexDirection: 'row', gap: space.sm },
  actionButton: { flex: 1 },
  scheduleRow: { flexDirection: 'row', gap: space.sm },
  scheduleDate: { flex: 2 },
  scheduleTime: { flex: 1 },
});
