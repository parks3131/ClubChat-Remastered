/**
 * Create a club - v1's "Build Your Squad".
 *
 * **All four of `PRD/04` rule 1's inputs, which is two more than this screen used to collect.**
 * It asked for a name and a sport and silently let the server default the join policy to `open`,
 * so every club created in the app was public and the description - a field the wire, the route
 * and the table all already carried - was unreachable from the product. The form was the only
 * missing link, which is why it reads as a redesign and is really a completion.
 *
 * **The join policy is a pair of cards rather than a switch**, because the two options are not
 * more-and-less of one thing: one is "anybody walks in" and the other is "an admin decides", and
 * a member choosing between them needs both consequences stated. It defaults to **Request**, as
 * v1 does - the safer half to land on when somebody taps past this without reading.
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
import { useRouter } from 'expo-router';
import type { JoinPolicy } from '@clubchat/shared';
import { clubApi } from '../../../../src/api.ts';
import { useSession } from '../../../../src/chat-provider.tsx';
import { color, radius, space, type } from '../../../../src/theme.ts';

const POLICIES: ReadonlyArray<{
  value: JoinPolicy;
  icon: React.ComponentProps<typeof MaterialIcons>['name'];
  title: string;
  hint: string;
}> = [
  {
    value: 'open',
    icon: 'public',
    title: 'Open',
    hint: 'Anyone can find and join the club immediately.',
  },
  {
    value: 'request',
    icon: 'lock-open',
    title: 'Request',
    hint: "Admin must approve each member's request.",
  },
];

export default function CreateClubScreen() {
  const router = useRouter();
  const { client } = useSession();

  const [name, setName] = useState('');
  const [sport, setSport] = useState('');
  const [description, setDescription] = useState('');
  const [joinPolicy, setJoinPolicy] = useState<JoinPolicy>('request');
  const [failed, setFailed] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const canSubmit = name.trim().length > 0 && sport.trim().length > 0;

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setFailed(null);
    try {
      const created = await clubApi.create({
        name: name.trim(),
        sport: sport.trim(),
        // Omitted rather than sent empty: the column is nullable and "" is not a description.
        ...(description.trim().length > 0 ? { description: description.trim() } : {}),
        joinPolicy,
      });
      // Resubscribe before navigating, so the brand-new club's channel is live on arrival
      // rather than after the next reconnect.
      await client?.reconnect().catch(() => undefined);
      // `replace`, not push: going back from the new club must not return to a form that
      // would create a second one.
      router.replace(`/clubs/${created.clubId}`);
    } catch {
      setFailed('Could not create the club. Check your connection and try again.');
      setSaving(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Build Your Squad</Text>
        <Text style={styles.subtitle}>
          Create a home for your team, track events, and stay connected.
        </Text>

        <Text style={styles.label}>Club name</Text>
        <TextInput
          style={styles.input}
          placeholder="e.g. Westside Spartans"
          placeholderTextColor={color.textSecondary}
          value={name}
          onChangeText={setName}
          accessibilityLabel="Club name"
        />

        <Text style={styles.label}>Sport</Text>
        <TextInput
          style={styles.input}
          placeholder="e.g. Running, Swimming"
          placeholderTextColor={color.textSecondary}
          value={sport}
          onChangeText={setSport}
          accessibilityLabel="Sport"
        />

        <Text style={styles.label}>Description</Text>
        <TextInput
          style={[styles.input, styles.multiline]}
          placeholder="Tell the community what your club is about..."
          placeholderTextColor={color.textSecondary}
          value={description}
          onChangeText={setDescription}
          multiline
          accessibilityLabel="Description, optional"
        />

        <Text style={styles.label}>Join policy</Text>
        <View style={styles.policyRow}>
          {POLICIES.map((policy) => {
            const chosen = joinPolicy === policy.value;
            return (
              <Pressable
                key={policy.value}
                style={[styles.policy, chosen && styles.policyChosen]}
                onPress={() => setJoinPolicy(policy.value)}
                accessibilityRole="radio"
                accessibilityState={{ checked: chosen }}
                accessibilityLabel={`${policy.title}. ${policy.hint}`}
              >
                <View style={styles.policyHead}>
                  <View style={styles.policyIcon}>
                    <MaterialIcons name={policy.icon} size={20} color={color.accent} />
                  </View>
                  {/* A real radio, because two cards side by side do not say "pick one" alone. */}
                  <View style={[styles.radio, chosen && styles.radioChosen]}>
                    {chosen && <View style={styles.radioDot} />}
                  </View>
                </View>
                <Text style={styles.policyTitle}>{policy.title}</Text>
                <Text style={styles.policyHint}>{policy.hint}</Text>
              </Pressable>
            );
          })}
        </View>

        {failed !== null && <Text style={styles.error}>{failed}</Text>}

        <Pressable
          style={[styles.create, (!canSubmit || saving) && styles.createDisabled]}
          onPress={() => void submit()}
          disabled={!canSubmit || saving}
          accessibilityRole="button"
          accessibilityLabel="Create the club"
        >
          {saving ? (
            <ActivityIndicator color={color.onAccent} />
          ) : (
            <Text style={styles.createLabel}>Create Club</Text>
          )}
        </Pressable>

        <Text style={styles.footnote}>
          You become the Owner, with a main chat and an Eboard space created for you.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: color.appBackground },
  content: { padding: space.md, gap: space.sm, paddingBottom: space.xl },

  title: { ...type.display, fontSize: 26, lineHeight: 32, color: color.textPrimary },
  subtitle: { ...type.bodySmall, color: color.textSecondary, marginTop: -space.xs },
  label: {
    ...type.label,
    color: color.textSecondary,
    textTransform: 'uppercase',
    marginTop: space.sm,
  },
  input: {
    ...type.body,
    color: color.textPrimary,
    borderWidth: 1,
    borderColor: color.hairline,
    backgroundColor: color.card,
    borderRadius: radius.lg,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 6,
  },
  multiline: { height: 96, textAlignVertical: 'top' },

  policyRow: { flexDirection: 'row', gap: space.sm },
  policy: {
    flex: 1,
    // Two, not one: the chosen card changes colour rather than thickness, so nothing reflows
    // and the pair does not jitter as the choice moves between them.
    borderWidth: 2,
    borderColor: color.hairline,
    borderRadius: radius.lg,
    backgroundColor: color.card,
    padding: space.sm + 4,
    gap: space.sm,
  },
  policyChosen: { borderColor: color.accent, backgroundColor: color.accentSoft },
  policyHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  policyIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: color.cardSunken,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: color.hairline,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioChosen: { borderColor: color.accent },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: color.accent },
  policyTitle: { ...type.numeric, fontSize: 20, color: color.textPrimary },
  policyHint: { ...type.bodySmall, fontSize: 13, lineHeight: 18, color: color.textSecondary },

  error: { ...type.bodySmall, color: color.error, marginTop: space.sm },

  create: {
    backgroundColor: color.accent,
    borderRadius: radius.pill,
    paddingVertical: space.sm + 8,
    alignItems: 'center',
    marginTop: space.md,
  },
  createDisabled: { opacity: 0.6 },
  createLabel: { ...type.title, fontSize: 18, lineHeight: 24, color: color.onAccent },
  footnote: { ...type.bodySmall, color: color.textSecondary, textAlign: 'center' },
});
