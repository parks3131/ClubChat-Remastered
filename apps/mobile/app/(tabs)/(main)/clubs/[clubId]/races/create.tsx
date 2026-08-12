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
 *  2. **Members are added after the race exists, in one call**, because the race has to have an id
 *     before anybody can be put on its roster. A failure there leaves the race created with fewer
 *     members rather than no race - which is the better half to fail on, since the roster is
 *     editable and the race is the thing that was asked for.
 *
 *     > It used to be one request per person, on the reasoning that a bulk route "would put the
 *     > same authorization in two places". It did not have to: `addRaceMembers` is now the single
 *     > implementation and the singular add calls it with a list of one, so there is one
 *     > authorization and one transaction. The loop also produced one "was added by" line per
 *     > person, so a race created with eight people opened onto eight near-identical lines.
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
import { MemberPicker } from '../../../../../../src/screens/member-picker.tsx';
import { useSession } from '../../../../../../src/chat-provider.tsx';
import { useDeclareClub } from '../../../../../../src/current-space.tsx';
import { toDateKey } from '../../../../../../src/dates.ts';
import { color, radius, space, type } from '../../../../../../src/theme.ts';
import { ARRIVED_FORWARD } from '../../../../../../src/nav.tsx';
import { DataScreen, DateField } from '../../../../../../src/ui.tsx';
import { useLoad } from '../../../../../../src/use-load.ts';

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

  /*
   * The whole club, shown at once and narrowed by the search rather than revealed by it.
   *
   * It used to require two characters before showing anybody and then hide whoever was already
   * picked, which made choosing eight people eight searches and left no way to see who you had
   * chosen except a row of chips. Now the list is simply the club, and the people you have
   * picked stay in it wearing the selected tint - so the answer to "who is coming" is the
   * screen you are already looking at.
   *
   * Still filtered in hand rather than searched over the wire: everybody eligible for a race is
   * already a club member, the roster read is authorized, and this keeps working offline.
   */
  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (roster.data?.members ?? [])
      // The creator is auto-rostered by `createRace`, so offering them would be a row that
      // does nothing.
      .filter((member) => member.userId !== userId)
      .filter((member) => needle.length === 0 || member.name.toLowerCase().includes(needle))
      .map((member) => ({ userId: member.userId, name: member.name, image: member.image }));
  }, [query, roster.data, userId]);

  const pickedIds = useMemo(() => new Set(picked.map((p) => p.userId)), [picked]);

  const submit = async () => {
    setFailed(null);
    if (name.trim().length === 0) {
      setFailed('Name is required.');
      return;
    }
    /*
     * The date is OPTIONAL, and blank is a real answer rather than an unfinished form.
     *
     * Blank means "this is an ordinary group", which is the common case - most of what a club
     * creates here is a side conversation with no day attached. It is only validated when
     * somebody actually typed something, so an empty box can never produce an error message.
     */
    const dated = raceDate.trim();
    /*
     * Only the past-date check survives, and the format check is gone deliberately.
     *
     * `DateField` emits `YYYY-MM-DD` or the empty string and nothing else, so a malformed value
     * cannot reach here at all - the check would be dead code asserting something the type of the
     * control already guarantees. The server still validates the format, because the server does
     * not get to assume which client is calling it.
     *
     * A past day IS reachable: the picker offers every month in both directions.
     */
    if (dated.length > 0 && dated < toDateKey(new Date())) {
      // Compared as strings against today's LOCAL key, so "today" is never rejected and no ISO
      // string is ever parsed into a Date - which would land on UTC midnight and shift the day.
      setFailed("Date can't be in the past.");
      return;
    }

    setSaving(true);
    try {
      const created = await raceApi.create(clubId, {
        name: name.trim(),
        // Null rather than omitted, so the server is told plainly that there is no date rather
        // than being left to infer it from a missing field.
        raceDate: dated.length > 0 ? dated : null,
      });
      if (picked.length > 0) {
        /*
         * One call, and tolerated if it fails: the race exists either way and its roster is
         * editable, so aborting here would strand a created race the screen never navigated to.
         *
         * It used to be one request per person, which also meant one "was added by" line in the
         * new race's chat per person. A race created with eight people opened onto eight
         * near-identical lines before anybody had said anything.
         */
        await raceApi.addMembers(created.raceId, picked.map((p) => p.userId)).catch(() => undefined);
      }
      // `replace`, not push: going back from the new race must not return to a form that would
      // create a second one.
      router.replace(`/races/${created.raceId}?${ARRIVED_FORWARD}`);
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
        {/*
          > **This used to say "Standalone from the calendar", and that stopped being true.**
          > A date now puts the race ON the club calendar, so the old line contradicted the field
          > directly below it - the screen would have been telling somebody the opposite of what
          > the date box tells them, two inches apart. What it was really there to say is that
          > this is a space rather than a diary entry, which the remaining words carry on their
          > own.
        */}
        <Text style={styles.subtitle}>
          A space of its own - chat, roster, and meet info.
        </Text>

        <Text style={styles.label}>Name</Text>
        {/*
          A generic placeholder rather than a named race. "Nittany Lion Invitational" read as an
          instruction to name a race, which is only half of what this screen makes: most of these
          are ordinary groups.
        */}
        <TextInput
          style={styles.input}
          placeholder="Group name"
          placeholderTextColor={color.textSecondary}
          value={name}
          onChangeText={setName}
          accessibilityLabel="Group name"
        />

        <Text style={styles.label}>Date (optional)</Text>
        {/*
          > **The one sentence this screen has to get right.** The date is not decoration and it
          > is not required: it is the single thing that decides whether this appears on the club
          > calendar. Leaving that to be discovered means either a group nobody can find on the
          > calendar, or a made-up date invented to satisfy a required field - which is what the
          > form used to force, and it put fictional entries on the calendar.
        */}
        <Text style={styles.subtitle}>
          Add a date to put this on the club calendar. Leave it blank for an ordinary group.
        </Text>
        {/*
          The same picker the event form uses, rather than a typed `YYYY-MM-DD` box.

          > **Reused, not rebuilt.** `DateField` already owns the month grid, the format it emits
          > and the CLEAR action, and it is what every other date in the product is chosen with -
          > a second picker here would be a second thing to keep in step, and a typed box was the
          > odd one out rather than a deliberate choice.

          `optional` is what draws CLEAR, which is exactly the affordance this field needs: a
          date can be added and then taken away again, and taking it away is what returns this
          to being an ordinary group.
        */}
        <DateField label="date" value={raceDate} onChange={setRaceDate} optional />

        <Text style={styles.label}>Add people (optional)</Text>
        <Text style={styles.subtitle}>
          Anyone not added here can request to join once the race is created - you will always have
          access as the creator.
        </Text>

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
            <MemberPicker
              candidates={results}
              selectedIds={pickedIds}
              disabled={saving}
              onToggle={(candidate) =>
                setPicked((current) =>
                  current.some((p) => p.userId === candidate.userId)
                    ? current.filter((p) => p.userId !== candidate.userId)
                    : [...current, { userId: candidate.userId, name: candidate.name }],
                )
              }
              emptyText={
                query.trim().length > 0
                  ? 'Nobody in this club by that name.'
                  : 'Nobody else in this club yet.'
              }
            />
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
