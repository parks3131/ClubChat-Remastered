/**
 * Edit a race: its name and its date.
 *
 * Manager tier, and refused server-side for anybody else - the pencil that reaches this screen is
 * hidden from a runner, and `updateRace` would refuse them anyway.
 *
 * **Meet Information is not here**, and that is not an omission. It is five fields saved as one
 * atomic form on its own screen, with the opposite rule about an absent value: there, blank means
 * "clear it"; here, an untouched field means "leave it". Putting them on one screen would put two
 * contradictory rules under one Save.
 */

import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { raceApi } from '../../../../../src/api.ts';
import { useDeclareRace } from '../../../../../src/current-space.tsx';
import { color, radius, space, type } from '../../../../../src/theme.ts';
import { DataScreen, DateField } from '../../../../../src/ui.tsx';
import { useLoad } from '../../../../../src/use-load.ts';

export default function EditRaceScreen() {
  const { raceId } = useLocalSearchParams<{ raceId: string }>();
  const router = useRouter();
  const load = useLoad(() => raceApi.detail(raceId), [raceId]);
  useDeclareRace(raceId, load.data?.race.clubId, load.data?.race.name, load.data?.race.image);

  return (
    <DataScreen load={load} errorMessage="Couldn't load this race.">
      {(data) => (
        <EditForm
          raceId={raceId}
          initial={data.race}
          onSaved={() => router.replace(`/races/${raceId}/profile`)}
        />
      )}
    </DataScreen>
  );
}

function EditForm({
  raceId,
  initial,
  onSaved,
}: {
  raceId: string;
  initial: { name: string; raceDate: string | null };
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial.name);
  // Empty box for a group with no date, which is the state clearing it returns to.
  const [raceDate, setRaceDate] = useState(initial.raceDate ?? '');
  const [failed, setFailed] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setFailed(null);
    if (name.trim().length === 0) {
      setFailed('A race needs a name.');
      return;
    }
    /*
     * A plain calendar day, checked here as well as on the server.
     *
     * Not because the server is untrusted, but because the refusal it sends is a status code and
     * this is the only place that can say WHICH field is wrong. The column is a DATE precisely so
     * a timestamp can never get in - a date-only value parsed as an instant becomes UTC midnight
     * and renders a day early in every negative-offset zone.
     */
    /*
     * No format check: `DateField` emits `YYYY-MM-DD` or nothing, so a malformed value cannot
     * reach here. The server still validates, because it does not get to assume its caller.
     */
    const dated = raceDate.trim();

    setSaving(true);
    try {
      /*
       * An empty box sends `null`, which CLEARS the date and takes this off the calendar.
       *
       * Sending nothing would mean "leave it alone", so emptying the field would silently do
       * nothing and the date would come back on the next load - a change somebody made and
       * watched fail to happen. The three states are distinct all the way to the column.
       */
      await raceApi.update(raceId, {
        name: name.trim(),
        raceDate: dated.length > 0 ? dated : null,
      });
      onSaved();
    } catch {
      setFailed('Could not save. Check your connection and try again.');
      setSaving(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.label}>Race name</Text>
        <TextInput
          style={styles.input}
          value={name}
          onChangeText={setName}
          accessibilityLabel="Race name"
        />

        <Text style={styles.label}>Date (optional)</Text>
        {/*
          The same picker the create form and the event form use. `optional` draws CLEAR, which
          is the control that takes this race off the calendar - the note below says so in words,
          and this is the thing that does it.
        */}
        <DateField label="date" value={raceDate} onChange={setRaceDate} optional />
        <Text style={styles.note}>
          A date puts this on the club calendar. Clear the field to take it off and leave it as an
          ordinary group.
        </Text>
        <Text style={styles.note}>
          Moving the date does not move anything already arranged around it - car groups and Meet
          Information stay exactly as they are.
        </Text>

        {failed !== null && <Text style={styles.error}>{failed}</Text>}
      </ScrollView>

      <View style={styles.footer}>
        <Pressable
          style={[styles.save, saving && styles.saveDisabled]}
          onPress={() => void submit()}
          disabled={saving}
          accessibilityRole="button"
          accessibilityLabel="Save the race"
        >
          {saving ? (
            <ActivityIndicator color={color.onAccent} />
          ) : (
            <Text style={styles.saveLabel}>Save</Text>
          )}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: color.appBackground },
  content: { padding: space.md, paddingBottom: space.lg, gap: space.xs },

  label: {
    ...type.label,
    color: color.textSecondary,
    textTransform: 'uppercase',
    marginTop: space.md,
  },
  input: {
    ...type.body,
    color: color.textPrimary,
    backgroundColor: color.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.hairline,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 4,
  },
  note: { ...type.bodySmall, color: color.textSecondary, marginTop: space.sm },
  error: { ...type.bodySmall, color: color.error, marginTop: space.sm },

  footer: {
    padding: space.md,
    backgroundColor: color.appBackground,
    borderTopWidth: 1,
    borderTopColor: color.divider,
  },
  save: {
    backgroundColor: color.accent,
    borderRadius: radius.pill,
    paddingVertical: space.md,
    alignItems: 'center',
  },
  saveDisabled: { opacity: 0.6 },
  saveLabel: { ...type.title, fontSize: 17, lineHeight: 22, color: color.onAccent },
});
