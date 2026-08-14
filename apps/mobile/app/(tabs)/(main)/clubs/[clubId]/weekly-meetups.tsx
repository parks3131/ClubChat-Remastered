/**
 * Weekly Meetups: Monday through Sunday.
 *
 * **The screen answers three questions and asks them in that order** - where the club is
 * meeting, when, and what they will be doing. The create form is phrased as the question
 * rather than as a form ("Where should we meet on Friday, 14 August?"), because that is what
 * somebody opens it to answer.
 *
 * Three rules the server owns and this screen must not second-guess:
 *
 *  - **A day with nothing on it says "Nothing planned", explicitly.** An empty day is otherwise
 *    ambiguous between "nothing is happening" and "nobody has posted yet", so the flag comes
 *    from the server rather than from an absence in the list.
 *  - **On the current week, past days are hidden.** The week is a plan, not a record. Paging
 *    back shows all seven, and the server decides which - this screen renders what it gets.
 *  - **A day may hold several meetups**, already in time order. A morning session and an evening
 *    social are two rows, and the day simply gets taller.
 *
 * Creating a meetup **notifies nobody and posts nothing**: it is reference material, and a week
 * authored in one sitting would otherwise fire seven notifications. That silence is why this is
 * a separate surface from the calendar rather than a view over it (PRD/08 rule 11), and the one
 * deliberate exception to it - Nudge - is designed and not yet built.
 *
 * There is deliberately **no activity type** anywhere on this screen. See ADR-0029.
 */

import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useDeclareClub } from '../../../../../src/current-space.tsx';
import { clubApi, contentApi } from '../../../../../src/api.ts';
import type { Meetup } from '../../../../../src/api-types.ts';
import { formatDateLong, formatDayTitle, formatWallClock } from '../../../../../src/dates.ts';
import { color, space, type } from '../../../../../src/theme.ts';
import {
  Action,
  Badge,
  Body,
  Card,
  DataScreen,
  DateField,
  Field,
  SectionHeader,
  TimeField,
} from '../../../../../src/ui.tsx';
import { useLoad } from '../../../../../src/use-load.ts';

/** The Monday of the week containing `date`, built from components rather than parsed. */
function mondayOf(date: Date): string {
  const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const weekday = copy.getDay();
  // Sunday is 0, and the week starts on Monday, so Sunday steps back six rather than forward one.
  copy.setDate(copy.getDate() - (weekday === 0 ? 6 : weekday - 1));
  return `${copy.getFullYear()}-${String(copy.getMonth() + 1).padStart(2, '0')}-${String(copy.getDate()).padStart(2, '0')}`;
}

function shift(monday: string, weeks: number): string {
  const [y, m, d] = monday.split('-').map(Number);
  const date = new Date(y!, (m ?? 1) - 1, d ?? 1);
  date.setDate(date.getDate() + weeks * 7);
  return mondayOf(date);
}

/** What the form is doing: adding to a given day, or editing one that exists. */
type Editing =
  | { mode: 'add'; date: string }
  | { mode: 'edit'; date: string; meetup: Meetup };

export default function WeeklyMeetupsScreen() {
  const { clubId } = useLocalSearchParams<{ clubId: string }>();
  // Inside this club for as long as this screen is mounted, which is what the Clubs tab reads.
  useDeclareClub(clubId);
  const [monday, setMonday] = useState(() => mondayOf(new Date()));
  const [editing, setEditing] = useState<Editing | null>(null);

  const week = useLoad(() => contentApi.meetups(clubId, monday), [clubId, monday]);
  const club = useLoad(() => clubApi.detail(clubId), [clubId]);
  const isAdmin = club.data?.club.viewer.isAdmin === true;

  if (editing !== null) {
    return (
      <MeetupForm
        clubId={clubId}
        editing={editing}
        onCancel={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          week.reload();
        }}
      />
    );
  }

  return (
    <View style={styles.flex}>
      <View style={styles.weekNav}>
        <Action label="Previous" variant="secondary" onPress={() => setMonday(shift(monday, -1))} />
        <Text style={styles.weekLabel}>Week of {monday}</Text>
        <Action label="Next" variant="secondary" onPress={() => setMonday(shift(monday, 1))} />
      </View>

      <DataScreen load={week}>
        {(data) => (
          <Body>
            {data.days.map((day) => (
              <Card key={day.date}>
                <View style={styles.dayHeader}>
                  <Text style={styles.dayTitle}>{formatDayTitle(day.date)}</Text>
                  {/* Said explicitly, never left as an empty card. */}
                  {day.empty && <Badge label="Nothing planned" tone="muted" />}
                </View>

                {day.meetups.map((meetup) => (
                  <View key={meetup.id} style={styles.meetup}>
                    <View style={styles.meetupText}>
                      {/* Where and when are the headline; what they are doing sits under it. */}
                      <Text style={styles.meetupHeadline}>
                        {formatWallClock(meetup.time)} · {meetup.location}
                      </Text>
                      {meetup.description !== null && (
                        <Text style={styles.body}>{meetup.description}</Text>
                      )}
                    </View>
                    {/* Any admin edits any meetup, not only its author. */}
                    {isAdmin && (
                      <View style={styles.meetupActions}>
                        <Action
                          label="Edit"
                          variant="quiet"
                          onPress={() => setEditing({ mode: 'edit', date: day.date, meetup })}
                          accessibilityLabel={`Edit the meetup at ${meetup.location}`}
                        />
                        <Action
                          label="Remove"
                          variant="quiet"
                          onPress={() => {
                            void contentApi
                              .deleteMeetup(meetup.id)
                              .then(week.reload, week.reload);
                          }}
                          accessibilityLabel={`Remove the meetup at ${meetup.location}`}
                        />
                      </View>
                    )}
                  </View>
                ))}

                {isAdmin && (
                  <Action
                    label="Add a meetup"
                    variant="secondary"
                    onPress={() => setEditing({ mode: 'add', date: day.date })}
                    accessibilityLabel={`Add a meetup on ${formatDayTitle(day.date)}`}
                  />
                )}
              </Card>
            ))}
            {data.days.length === 0 && (
              <Text style={styles.meta}>This week is over. Page back to see it.</Text>
            )}
          </Body>
        )}
      </DataScreen>
    </View>
  );
}

/**
 * Where, when, what - asked in that order and phrased as a question.
 *
 * The place comes first and is the only field with a placeholder, because it is the one the
 * heading asks about. The date is editable rather than fixed: the day that was tapped is the
 * answer nine times out of ten, and moving a meetup to Thursday should not mean deleting it.
 */
function MeetupForm({
  clubId,
  editing,
  onCancel,
  onSaved,
}: {
  clubId: string;
  editing: Editing;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const existing = editing.mode === 'edit' ? editing.meetup : null;
  const [location, setLocation] = useState(existing?.location ?? '');
  const [date, setDate] = useState(editing.date);
  const [time, setTime] = useState(existing?.time ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  // Where and when are both required. "TBC" is a real answer; a blank is not.
  const ready = location.trim().length > 0 && time.length > 0;

  const submit = async () => {
    setBusy(true);
    setFailed(null);
    const body = {
      meetupDate: date,
      meetupTime: time,
      location: location.trim(),
      description: description.trim().length > 0 ? description.trim() : null,
    };
    try {
      if (existing === null) await contentApi.createMeetup(clubId, body);
      else await contentApi.updateMeetup(existing.id, body);
      onSaved();
    } catch {
      setFailed('Could not save the meetup. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Body>
      <SectionHeader title={`Where should we meet on ${formatDateLong(date)}?`} />
      <Field
        label="Place"
        value={location}
        onChangeText={setLocation}
        placeholder="Memorial Park gate"
      />

      <SectionHeader title="When" />
      <DateField label="Date" value={date} onChange={setDate} />
      <TimeField label="Time" value={time} onChange={setTime} />

      <SectionHeader title="What are we doing?" />
      <Field label="Details" value={description} onChangeText={setDescription} multiline />

      <Text style={styles.meta}>
        {existing === null
          ? 'Adding a meetup notifies nobody and posts nothing.'
          : 'Editing a meetup notifies nobody and posts nothing.'}
      </Text>
      {failed !== null && <Text style={styles.error}>{failed}</Text>}
      <View style={styles.actions}>
        <Action label="Cancel" variant="secondary" style={styles.actionButton} onPress={onCancel} />
        <Action
          label={busy ? 'Saving' : 'Save'}
          style={styles.actionButton}
          disabled={busy || !ready}
          onPress={() => void submit()}
        />
      </View>
    </Body>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: color.appBackground },
  weekNav: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    padding: space.md,
    paddingBottom: 0,
  },
  weekLabel: { ...type.label, color: color.textSecondary, flex: 1, textAlign: 'center' },
  dayHeader: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  dayTitle: { ...type.headline, color: color.textPrimary, flex: 1 },
  meetup: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  meetupText: { flex: 1, gap: space.xs },
  meetupHeadline: { ...type.body, color: color.textPrimary },
  meetupActions: { flexDirection: 'row', gap: space.xs },
  body: { ...type.bodySmall, color: color.textPrimary },
  meta: { ...type.bodySmall, color: color.textSecondary },
  error: { ...type.bodySmall, color: color.error },
  actions: { flexDirection: 'row', gap: space.sm },
  actionButton: { flex: 1 },
});
