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
import { DataScreen } from '../../../../../src/ui.tsx';
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
  initial: { name: string; raceDate: string };
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [raceDate, setRaceDate] = useState(initial.raceDate);
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
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raceDate.trim())) {
      setFailed('Use a date like 2026-09-15.');
      return;
    }

    setSaving(true);
    try {
      await raceApi.update(raceId, { name: name.trim(), raceDate: raceDate.trim() });
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

        <Text style={styles.label}>Date</Text>
        <TextInput
          style={styles.input}
          value={raceDate}
          onChangeText={setRaceDate}
          placeholder="2026-09-15"
          placeholderTextColor={color.textSecondary}
          autoCapitalize="none"
          accessibilityLabel="Race date, as year-month-day"
        />
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
