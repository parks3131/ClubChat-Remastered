/**
 * Edit club: its name, description and join policy.
 *
 * Admin tier, and refused server-side for anybody else - the screen hides itself from a member,
 * and `updateClub` would refuse them anyway.
 *
 * **The join policy is a choice between two described options, not a switch.** "Open" and
 * "Request" each say what they mean for whoever tries to join, because the difference is about
 * other people rather than about a preference, and a toggle labelled "require approval" makes the
 * reader work out the consequence themselves.
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
import { MaterialIcons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { JoinPolicy } from '@clubchat/shared';
import { clubApi } from '../../../../../src/api.ts';
import { useDeclareClub } from '../../../../../src/current-club.tsx';
import { color, radius, space, type } from '../../../../../src/theme.ts';
import { DataScreen } from '../../../../../src/ui.tsx';
import { useLoad } from '../../../../../src/use-load.ts';

export default function EditClubScreen() {
  const { clubId } = useLocalSearchParams<{ clubId: string }>();
  useDeclareClub(clubId);
  const router = useRouter();
  const load = useLoad(() => clubApi.detail(clubId), [clubId]);

  return (
    <DataScreen load={load} errorMessage="Couldn't load this club.">
      {(data) => (
        <EditForm
          clubId={clubId}
          initial={data.club}
          onSaved={() => router.replace(`/clubs/${clubId}/profile`)}
        />
      )}
    </DataScreen>
  );
}

function EditForm({
  clubId,
  initial,
  onSaved,
}: {
  clubId: string;
  initial: { name: string; description: string | null; joinPolicy: JoinPolicy };
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description ?? '');
  const [policy, setPolicy] = useState<JoinPolicy>(initial.joinPolicy);
  const [failed, setFailed] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setFailed(null);
    if (name.trim().length === 0) {
      setFailed('A club needs a name.');
      return;
    }

    setSaving(true);
    try {
      await clubApi.update(clubId, {
        name: name.trim(),
        // Null clears it; an empty string would store emptiness rather than absence.
        description: description.trim().length > 0 ? description.trim() : null,
        // Sent only when it actually changed, because switching to open admits everybody
        // currently waiting - an effect nobody should trigger by saving a renamed club.
        ...(policy === initial.joinPolicy ? {} : { joinPolicy: policy }),
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
        <Text style={styles.label}>Club name</Text>
        <TextInput
          style={styles.input}
          value={name}
          onChangeText={setName}
          accessibilityLabel="Club name"
        />

        <Text style={styles.label}>Description</Text>
        <TextInput
          style={[styles.input, styles.multiline]}
          value={description}
          onChangeText={setDescription}
          multiline
          accessibilityLabel="Description"
        />

        <Text style={styles.label}>Join policy</Text>
        <View style={styles.policyRow}>
          <PolicyCard
            icon="public"
            title="Open"
            body="Anyone can find and join the club immediately."
            selected={policy === 'open'}
            onPress={() => setPolicy('open')}
          />
          <PolicyCard
            icon="lock"
            title="Request"
            body="Admin must approve each member's request."
            selected={policy === 'request'}
            onPress={() => setPolicy('request')}
          />
        </View>

        {/*
          Said before saving rather than after. It is the one consequence of this screen that
          reaches other people, and finding out afterwards that nine pending requests were
          admitted is not a thing anybody should learn from the roster.
        */}
        {policy === 'open' && initial.joinPolicy === 'request' && (
          <Text style={styles.note}>
            Switching to Open will automatically approve anyone with a pending join request.
          </Text>
        )}

        {failed !== null && <Text style={styles.error}>{failed}</Text>}
      </ScrollView>

      <View style={styles.footer}>
        <Pressable
          style={[styles.save, saving && styles.saveDisabled]}
          onPress={() => void submit()}
          disabled={saving}
          accessibilityRole="button"
          accessibilityLabel="Save the club"
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

/** One of the two join policies, described rather than named. */
function PolicyCard({
  icon,
  title,
  body,
  selected,
  onPress,
}: {
  icon: React.ComponentProps<typeof MaterialIcons>['name'];
  title: string;
  body: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={[styles.policyCard, selected && styles.policyCardSelected]}
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={`${title}. ${body}`}
    >
      <View style={styles.policyHead}>
        <MaterialIcons
          name={icon}
          size={18}
          color={selected ? color.accent : color.textSecondary}
        />
        <View style={[styles.radio, selected && styles.radioOn]}>
          {selected && <View style={styles.radioDot} />}
        </View>
      </View>
      <Text style={styles.policyTitle}>{title}</Text>
      <Text style={styles.policyBody}>{body}</Text>
    </Pressable>
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

  policyRow: { flexDirection: 'row', gap: space.sm },
  policyCard: {
    flex: 1,
    gap: space.xs,
    backgroundColor: color.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.hairline,
    padding: space.md,
  },
  policyCardSelected: { borderColor: color.accent, backgroundColor: color.accentSoft },
  policyHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  radio: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: color.hairline,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioOn: { borderColor: color.accent },
  radioDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: color.accent },
  policyTitle: { ...type.headline, color: color.textPrimary },
  policyBody: { ...type.bodySmall, color: color.textSecondary },

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
