/**
 * The routines week: Monday through Sunday.
 *
 * Two rules the server owns and this screen must not second-guess:
 *
 *  - **A day with no workout is a "Rest day", explicitly.** An empty day is otherwise ambiguous
 *    between "rest" and "not posted yet", so the flag comes from the server rather than from an
 *    absence in the list.
 *  - **On the current week, past days are hidden.** The week is a plan, not a record. Paging back
 *    shows all seven, and the server decides which - this screen just renders what it gets.
 *
 * Creating a workout **notifies nobody and posts nothing**: a routine is reference material, and a
 * week authored in one sitting would otherwise fire seven notifications.
 */

import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { clubApi, contentApi } from '../../../src/api.ts';
import type { ActivityType } from '../../../src/api-types.ts';
import { color, space, type } from '../../../src/theme.ts';
import {
  Action,
  Badge,
  Body,
  Card,
  DataScreen,
  Field,
  SectionHeader,
} from '../../../src/ui.tsx';
import { useLoad } from '../../../src/use-load.ts';

const ACTIVITIES: readonly ActivityType[] = [
  'run',
  'trail_run',
  'bike',
  'swim',
  'strength',
  'hybrid_fitness',
  'indoor_climb',
  'bouldering',
  'xc_ski',
  'other',
];

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

export default function RoutinesScreen() {
  const { clubId } = useLocalSearchParams<{ clubId: string }>();
  const [monday, setMonday] = useState(() => mondayOf(new Date()));
  const [adding, setAdding] = useState<string | null>(null);

  const week = useLoad(() => contentApi.routines(clubId, monday), [clubId, monday]);
  const club = useLoad(() => clubApi.detail(clubId), [clubId]);
  const isAdmin = club.data?.club.viewer.isAdmin === true;

  if (adding !== null) {
    return (
      <AddWorkout
        clubId={clubId}
        date={adding}
        onCancel={() => setAdding(null)}
        onAdded={() => {
          setAdding(null);
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
                  <Text style={styles.dayTitle}>{day.date}</Text>
                  {/* Said explicitly, never left as an empty card. */}
                  {day.restDay && <Badge label="Rest day" tone="muted" />}
                </View>

                {day.workouts.map((workout) => (
                  <View key={workout.id} style={styles.workout}>
                    <View style={styles.workoutText}>
                      <Text style={styles.workoutTitle}>{workout.title}</Text>
                      <Text style={styles.meta}>{workout.activityType.replace('_', ' ')}</Text>
                      {workout.description !== null && (
                        <Text style={styles.body}>{workout.description}</Text>
                      )}
                    </View>
                    {/* Any admin can edit any workout, not only its author. */}
                    {isAdmin && (
                      <Action
                        label="Remove"
                        variant="quiet"
                        onPress={() => {
                          void contentApi
                            .deleteWorkout(workout.id)
                            .then(week.reload, week.reload);
                        }}
                        accessibilityLabel={`Remove ${workout.title}`}
                      />
                    )}
                  </View>
                ))}

                {isAdmin && (
                  <Action
                    label="Add a workout"
                    variant="secondary"
                    onPress={() => setAdding(day.date)}
                    accessibilityLabel={`Add a workout on ${day.date}`}
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

function AddWorkout({
  clubId,
  date,
  onCancel,
  onAdded,
}: {
  clubId: string;
  date: string;
  onCancel: () => void;
  onAdded: () => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [activity, setActivity] = useState<ActivityType>('run');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setFailed(null);
    try {
      await contentApi.createWorkout(clubId, {
        workoutDate: date,
        activityType: activity,
        title: title.trim(),
        description: description.trim().length > 0 ? description.trim() : null,
      });
      onAdded();
    } catch {
      setFailed('Could not add the workout. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Body>
      <SectionHeader title={`Workout on ${date}`} />
      <Field label="Title" value={title} onChangeText={setTitle} placeholder="Easy 5k" />
      <Field label="Details" value={description} onChangeText={setDescription} multiline />

      <SectionHeader title="Activity" />
      <View style={styles.activities}>
        {ACTIVITIES.map((option) => (
          <Action
            key={option}
            label={option.replace('_', ' ')}
            variant={option === activity ? 'primary' : 'secondary'}
            onPress={() => setActivity(option)}
          />
        ))}
      </View>

      <Text style={styles.meta}>Adding a workout notifies nobody and posts nothing.</Text>
      {failed !== null && <Text style={styles.error}>{failed}</Text>}
      <View style={styles.actions}>
        <Action label="Cancel" variant="secondary" style={styles.actionButton} onPress={onCancel} />
        <Action
          label={busy ? 'Adding' : 'Add'}
          style={styles.actionButton}
          disabled={busy || title.trim().length === 0}
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
  workout: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  workoutText: { flex: 1, gap: space.xs },
  workoutTitle: { ...type.body, color: color.textPrimary },
  body: { ...type.bodySmall, color: color.textPrimary },
  meta: { ...type.bodySmall, color: color.textSecondary },
  error: { ...type.bodySmall, color: color.error },
  activities: { flexDirection: 'row', gap: space.xs, flexWrap: 'wrap' },
  actions: { flexDirection: 'row', gap: space.sm },
  actionButton: { flex: 1 },
});
