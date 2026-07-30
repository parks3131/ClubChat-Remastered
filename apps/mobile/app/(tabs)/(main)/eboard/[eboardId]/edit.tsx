/**
 * Edit Eboard & Council: what it is called and what it says about itself.
 *
 * Members only, and refused server-side for anybody else. A club admin standing outside the space
 * can read it - that read is how they find their way back in - and cannot rename it from there.
 *
 * The name is editable at all because "Eboard & Council" is a default rather than a fixture: some
 * clubs call it the board, some the captains. It is only the default that ships.
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
import { eboardApi } from '../../../../../src/api.ts';
import { useDeclareEboard } from '../../../../../src/current-space.tsx';
import { color, radius, space, type } from '../../../../../src/theme.ts';
import { DataScreen } from '../../../../../src/ui.tsx';
import { useLoad } from '../../../../../src/use-load.ts';

export default function EditEboardScreen() {
  const { eboardId } = useLocalSearchParams<{ eboardId: string }>();
  const router = useRouter();
  const load = useLoad(() => eboardApi.detail(eboardId), [eboardId]);
  useDeclareEboard(
    eboardId,
    load.data?.eboard.clubId,
    load.data?.eboard.name,
    load.data?.eboard.image,
  );

  return (
    <DataScreen load={load} errorMessage="Couldn't load Eboard & Council.">
      {(data) => (
        <EditForm
          eboardId={eboardId}
          initial={data.eboard}
          onSaved={() => router.replace(`/eboard/${eboardId}/profile`)}
        />
      )}
    </DataScreen>
  );
}

function EditForm({
  eboardId,
  initial,
  onSaved,
}: {
  eboardId: string;
  initial: { name: string; description: string | null };
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description ?? '');
  const [failed, setFailed] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setFailed(null);
    if (name.trim().length === 0) {
      setFailed('The space needs a name.');
      return;
    }

    setSaving(true);
    try {
      await eboardApi.update(eboardId, {
        name: name.trim(),
        // Null clears it; an empty string would store emptiness rather than absence.
        description: description.trim().length > 0 ? description.trim() : null,
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
        <Text style={styles.label}>Name</Text>
        <TextInput
          style={styles.input}
          value={name}
          onChangeText={setName}
          accessibilityLabel="Name"
        />

        <Text style={styles.label}>Description</Text>
        <TextInput
          style={[styles.input, styles.multiline]}
          value={description}
          onChangeText={setDescription}
          multiline
          accessibilityLabel="Description"
        />
        {/*
          Said plainly, because the space's privacy is easy to mistake for secrecy. Renaming it
          changes nothing about who can see it: only the club's admins ever could, and only the
          people inside it can read a word of what is in it.
        */}
        <Text style={styles.note}>
          Only this club's admins can see this space at all, and only its members can read what is
          in it. Renaming it does not change that.
        </Text>

        {failed !== null && <Text style={styles.error}>{failed}</Text>}
      </ScrollView>

      <View style={styles.footer}>
        <Pressable
          style={[styles.save, saving && styles.saveDisabled]}
          onPress={() => void submit()}
          disabled={saving}
          accessibilityRole="button"
          accessibilityLabel="Save"
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
  multiline: { minHeight: 110, textAlignVertical: 'top' },
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
