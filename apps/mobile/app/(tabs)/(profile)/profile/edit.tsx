/**
 * Edit profile.
 *
 * Its own screen rather than a mode inside Profile, which is what makes it a place with a back
 * control: a form you can leave without saving is a destination, and a mode is not.
 *
 * **Every field is optional except the name.** A profile is somebody's own description of
 * themselves, and demanding a city or a school to save one is the product asking questions it has
 * no business asking. Clearing a field sends `null`, which is what removes it - an empty string
 * would store emptiness rather than absence.
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
import { useRouter } from 'expo-router';
import { accountApi } from '../../../../src/api.ts';
import { useSession } from '../../../../src/chat-provider.tsx';
import { color, radius, space, type } from '../../../../src/theme.ts';
import { DataScreen } from '../../../../src/ui.tsx';
import { useLoad } from '../../../../src/use-load.ts';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default function EditProfileScreen() {
  const { userId } = useSession();
  const router = useRouter();

  const load = useLoad(
    () => (userId ? accountApi.profile(userId) : Promise.reject(new Error('no session'))),
    [userId],
  );

  return (
    <DataScreen load={load} errorMessage="Couldn't load your profile.">
      {(data) => <EditForm initial={data.profile} onSaved={() => router.replace('/profile')} />}
    </DataScreen>
  );
}

function EditForm({
  initial,
  onSaved,
}: {
  initial: {
    name: string;
    bio: string | null;
    city: string | null;
    school: string | null;
    dob?: string | null;
  };
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [bio, setBio] = useState(initial.bio ?? '');
  const [city, setCity] = useState(initial.city ?? '');
  const [dob, setDob] = useState(initial.dob ?? '');
  const [school, setSchool] = useState(initial.school ?? '');
  const [failed, setFailed] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setFailed(null);
    if (name.trim().length === 0) {
      setFailed('Name is required.');
      return;
    }
    if (dob.trim().length > 0 && !DATE_RE.test(dob.trim())) {
      setFailed('Date of birth must be YYYY-MM-DD.');
      return;
    }

    setSaving(true);
    try {
      // An empty field clears the value rather than storing "", which is the difference between
      // "I removed my city" and "my city is the empty string".
      const orNull = (value: string) => (value.trim().length > 0 ? value.trim() : null);
      await accountApi.saveProfile({
        name: name.trim(),
        bio: orNull(bio),
        city: orNull(city),
        school: orNull(school),
        dob: orNull(dob),
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
          placeholder="Your name"
          placeholderTextColor={color.textSecondary}
          accessibilityLabel="Name"
        />

        <Text style={styles.label}>Description</Text>
        <TextInput
          style={[styles.input, styles.multiline]}
          value={bio}
          onChangeText={setBio}
          placeholder="A line about you"
          placeholderTextColor={color.textSecondary}
          multiline
          accessibilityLabel="Description"
        />

        <Text style={styles.label}>City</Text>
        <TextInput
          style={styles.input}
          value={city}
          onChangeText={setCity}
          placeholder="New York"
          placeholderTextColor={color.textSecondary}
          accessibilityLabel="City"
        />

        <Text style={styles.label}>Date of birth (YYYY-MM-DD)</Text>
        <TextInput
          style={styles.input}
          value={dob}
          onChangeText={setDob}
          placeholder="2004-08-20"
          placeholderTextColor={color.textSecondary}
          accessibilityLabel="Date of birth, year month day"
        />

        <Text style={styles.label}>School</Text>
        <TextInput
          style={styles.input}
          value={school}
          onChangeText={setSchool}
          placeholder="Binghamton University"
          placeholderTextColor={color.textSecondary}
          accessibilityLabel="School"
        />

        {failed !== null && <Text style={styles.error}>{failed}</Text>}
      </ScrollView>

      {/* Pinned rather than scrolled to, so Save is reachable without hunting for it. */}
      <View style={styles.footer}>
        <Pressable
          style={[styles.save, saving && styles.saveDisabled]}
          onPress={() => void submit()}
          disabled={saving}
          accessibilityRole="button"
          accessibilityLabel="Save your profile"
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

  label: { ...type.bodySmall, color: color.textSecondary, marginTop: space.sm },
  input: {
    ...type.body,
    color: color.textPrimary,
    backgroundColor: color.cardRaised,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 4,
  },
  multiline: { minHeight: 120, textAlignVertical: 'top' },
  error: { ...type.bodySmall, color: color.error, marginTop: space.sm },

  footer: {
    padding: space.md,
    backgroundColor: color.appBackground,
    borderTopWidth: 1,
    borderTopColor: color.divider,
  },
  save: {
    backgroundColor: color.accent,
    borderRadius: radius.sm,
    paddingVertical: space.md,
    alignItems: 'center',
  },
  saveDisabled: { opacity: 0.6 },
  saveLabel: {
    ...type.label,
    fontSize: 15,
    color: color.onAccent,
    textTransform: 'uppercase',
  },
});
