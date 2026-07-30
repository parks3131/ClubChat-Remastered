/**
 * New race channel.
 *
 * A race is a **mini-club**, not a calendar entry: it gets its own chat, roster and Meet
 * Information, and it is standalone from the club calendar. The screen says so in its own words,
 * because "Add Group" does not obviously mean "create a space with a conversation in it".
 *
 * Two rules worth knowing:
 *
 *  1. **The people picker is optional, and saying so matters.** Anyone left out can request access
 *     afterwards, and the creator always has it - so an admin who is not sure who is going can
 *     create the race now and let the roster fill itself. Without that sentence the field reads as
 *     a decision that has to be made up front.
 *  2. **Members are added one by one after the race exists**, because there is no bulk-add route
 *     and inventing one would put the same authorization in two places. A failure part-way through
 *     leaves the race created with fewer members rather than no race - which is the better half to
 *     fail on, since the roster is editable and the race is the thing that was asked for.
 */

import { useMemo, useState } from 'react';
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
import { clubApi, raceApi } from '../../../../../../src/api.ts';
import { useSession } from '../../../../../../src/chat-provider.tsx';
import { useDeclareClub } from '../../../../../../src/current-club.tsx';
import { toDateKey } from '../../../../../../src/dates.ts';
import { color, radius, space, type } from '../../../../../../src/theme.ts';
import { Avatar, DataScreen } from '../../../../../../src/ui.tsx';
import { useLoad } from '../../../../../../src/use-load.ts';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default function CreateRaceScreen() {
  const { clubId } = useLocalSearchParams<{ clubId: string }>();
  const { userId } = useSession();
  const router = useRouter();
  useDeclareClub(clubId);

  const [name, setName] = useState('');
  const [raceDate, setRaceDate] = useState('');
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Array<{ userId: string; name: string }>>([]);
  const [failed, setFailed] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  /*
   * The pool is this club's OWN roster, filtered here rather than searched over the wire.
   *
   * Deliberately not the add-member candidate search: that one answers "who could JOIN this club",
   * which is the opposite question. Everybody eligible for a race is already a club member, the
   * roster read is already authorized, and filtering a list in hand keeps working offline.
   */
  const roster = useLoad(() => clubApi.roster(clubId), [clubId]);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length < 2) return [];
    const taken = new Set([userId, ...picked.map((p) => p.userId)]);
    return (roster.data?.members ?? [])
      .filter((member) => !taken.has(member.userId))
      .filter((member) => member.name.toLowerCase().includes(needle))
      .slice(0, 8);
  }, [query, roster.data, picked, userId]);

  const submit = async () => {
    setFailed(null);
    if (name.trim().length === 0) {
      setFailed('Name is required.');
      return;
    }
    if (!DATE_RE.test(raceDate.trim())) {
      setFailed('Date must be YYYY-MM-DD.');
      return;
    }
    // Compared as strings against today's LOCAL key, so "today" is never rejected and no ISO
    // string is ever parsed into a Date - which would land on UTC midnight and shift the day.
    if (raceDate.trim() < toDateKey(new Date())) {
      setFailed("Date can't be in the past.");
      return;
    }

    setSaving(true);
    try {
      const created = await raceApi.create(clubId, {
        name: name.trim(),
        raceDate: raceDate.trim(),
      });
      for (const person of picked) {
        // Individually, and tolerated if one fails: the race exists either way and its roster
        // is editable. Aborting here would leave a created race the screen never navigated to.
        await raceApi.addMember(created.raceId, person.userId).catch(() => undefined);
      }
      // `replace`, not push: going back from the new race must not return to a form that would
      // create a second one.
      router.replace(`/races/${created.raceId}`);
    } catch {
      setFailed('Could not create the race. Check your connection and try again.');
      setSaving(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>New Race Channel</Text>
        <Text style={styles.subtitle}>
          Standalone from the calendar - its own chat, roster, and meet info.
        </Text>

        <Text style={styles.label}>Name</Text>
        <TextInput
          style={styles.input}
          placeholder="Nittany Lion Invitational"
          placeholderTextColor={color.textSecondary}
          value={name}
          onChangeText={setName}
          accessibilityLabel="Race name"
        />

        <Text style={styles.label}>Date</Text>
        <TextInput
          style={styles.input}
          placeholder="YYYY-MM-DD"
          placeholderTextColor={color.textSecondary}
          value={raceDate}
          onChangeText={setRaceDate}
          accessibilityLabel="Race date, year month day"
        />

        <Text style={styles.label}>Add people (optional)</Text>
        <Text style={styles.subtitle}>
          Anyone not added here can request to join once the race is created - you will always have
          access as the creator.
        </Text>

        {picked.length > 0 && (
          <View style={styles.chipRow}>
            {picked.map((person) => (
              <Pressable
                key={person.userId}
                style={styles.chip}
                onPress={() =>
                  setPicked((current) => current.filter((p) => p.userId !== person.userId))
                }
                accessibilityRole="button"
                accessibilityLabel={`Remove ${person.name}`}
              >
                <Text style={styles.chipLabel}>{person.name}  ✕</Text>
              </Pressable>
            ))}
          </View>
        )}

        <TextInput
          style={styles.input}
          placeholder="Search by name"
          placeholderTextColor={color.textSecondary}
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          accessibilityLabel="Search club members by name"
        />

        <DataScreen load={roster} errorMessage="Couldn't load the club's members.">
          {() => (
            <>
              {results.map((member) => (
                <Pressable
                  key={member.userId}
                  style={styles.result}
                  onPress={() => {
                    setPicked((current) => [...current, { userId: member.userId, name: member.name }]);
                    setQuery('');
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`Add ${member.name}`}
                >
                  <Avatar name={member.name} size={32} />
                  <Text style={styles.resultName}>{member.name}</Text>
                </Pressable>
              ))}
            </>
          )}
        </DataScreen>

        {failed !== null && <Text style={styles.error}>{failed}</Text>}

        <Pressable
          style={[styles.create, saving && styles.createDisabled]}
          onPress={() => void submit()}
          disabled={saving}
          accessibilityRole="button"
          accessibilityLabel="Create the race"
        >
          {saving ? (
            <ActivityIndicator color={color.onAccent} />
          ) : (
            <Text style={styles.createLabel}>Create</Text>
          )}
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: color.appBackground },
  content: { padding: space.md, gap: space.sm, paddingBottom: space.xl },

  title: { ...type.display, fontSize: 24, lineHeight: 30, color: color.textPrimary },
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
  error: { ...type.bodySmall, color: color.error, marginTop: space.sm },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: {
    backgroundColor: color.accentSoft,
    borderRadius: radius.pill,
    paddingHorizontal: space.sm + 4,
    paddingVertical: space.xs + 2,
  },
  chipLabel: { ...type.label, fontSize: 13, color: color.accent, textTransform: 'none' },

  result: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm + 4,
    backgroundColor: color.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.hairline,
    padding: space.md,
  },
  resultName: { ...type.headline, color: color.textPrimary },

  create: {
    backgroundColor: color.accent,
    borderRadius: radius.pill,
    paddingVertical: space.sm + 8,
    alignItems: 'center',
    marginTop: space.md,
  },
  createDisabled: { opacity: 0.6 },
  createLabel: { ...type.title, fontSize: 18, lineHeight: 24, color: color.onAccent },
});
