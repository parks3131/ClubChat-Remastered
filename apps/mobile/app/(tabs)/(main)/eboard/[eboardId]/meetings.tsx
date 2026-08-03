/**
 * Eboard meetings: Upcoming and Past.
 *
 * **Any member of the space creates one, and any member cancels one. Only the creator EDITS.**
 * The two halves of that are decided separately and neither is an oversight:
 *
 *  - Creator-only editing landed after two explicit founder follow-ups on a version where any
 *    member could edit any meeting, which is why `isCreator` is the flag and the detail view
 *    says who added it.
 *  - Open cancelling landed later and on purpose: a meeting only its absent author could call
 *    off is worse than one anybody can. What makes it safe is that cancelling **narrates
 *    itself** - board chat gets "X cancelled <title>" in the card's place.
 *
 * The split is by the clock, not by a stored flag: a meeting becomes past by time passing.
 */

import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams } from 'expo-router';
import { contentApi } from '../../../../../src/api.ts';
import { formatInstant } from '../../../../../src/dates.ts';
import { useReturnTo } from '../../../../../src/nav.tsx';
import { color, radius, space, type } from '../../../../../src/theme.ts';
import {
  Badge,
  Body,
  ComposerHeader,
  DataScreen,
  DateField,
  EmptyState,
  Fab,
  Row,
  Tabs,
  TimeField,
} from '../../../../../src/ui.tsx';
import { useLoad } from '../../../../../src/use-load.ts';

export default function MeetingsScreen() {
  const { eboardId, create, from } = useLocalSearchParams<{
    eboardId: string;
    create?: string;
    from?: string;
  }>();
  const returnToSender = useReturnTo();
  const [when, setWhen] = useState<'upcoming' | 'past'>('upcoming');
  /*
   * `?create=1` opens straight into the composer, which is how chat's "+" menu offers "Meeting".
   * There is no separate create route - the composer lives here.
   *
   * Seeded directly, with no role check, because there is no role to check: every member of an
   * Eboard space may schedule a meeting, and reaching this screen at all already requires
   * membership. The server refuses a non-member regardless.
   */
  const [composing, setComposing] = useState(create === '1');
  // Re-honoured if the param arrives after mount, which it does when chat's "+" navigates here
  // with the screen already in the stack.
  useEffect(() => {
    if (create === '1') setComposing(true);
  }, [create]);

  /*
   * Where to go once it exists. Chat's "+" menu sends `from=/chat/:channelId`, and a thing made
   * there belongs back there: the creation posts its own card into that conversation.
   *
   * **Only an in-app chat path is honoured**, because `from` arrives in a URL and a URL is user
   * input - an unchecked one is an open redirect a deep link could point anywhere.
   */
  const returnTo = from?.startsWith('/chat/') === true ? from : null;

  const load = useLoad(() => contentApi.meetings(eboardId, when), [eboardId, when]);

  /*
   * The composer owns the screen, header included - and the option is stated in BOTH directions.
   * `<Stack.Screen options>` is `navigation.setOptions` underneath, so it mutates the route and
   * does not roll back on unmount; setting it only on the way in left the list with no header.
   * Same reasoning as the event and poll composers.
   */
  const header = <Stack.Screen options={{ headerShown: !composing }} />;

  if (composing) {
    return (
      <>
        {header}
        <NewMeeting
          eboardId={eboardId}
          onCancel={() => {
            if (returnTo !== null) returnToSender(returnTo);
            else setComposing(false);
          }}
          onCreated={() => {
            setComposing(false);
            if (returnTo !== null) {
              // Unwind to the conversation, never navigate to it - see `useReturnTo`.
              returnToSender(returnTo);
              return;
            }
            load.reload();
          }}
        />
      </>
    );
  }

  return (
    <View style={styles.flex}>
      {header}
      <View style={styles.tabsWrap}>
        <Tabs
          tabs={[
            { key: 'upcoming', label: 'Upcoming' },
            { key: 'past', label: 'Past' },
          ]}
          active={when}
          onChange={setWhen}
        />
      </View>

      <DataScreen
        load={load}
        isEmpty={(data) => data.meetings.length === 0}
        empty={
          <EmptyState
            title={when === 'upcoming' ? 'No meetings scheduled' : 'No past meetings'}
            body={when === 'upcoming' ? 'Any member of this space can add one.' : undefined}
          />
        }
      >
        {(data) => (
          <Body>
            {data.meetings.map((meeting) => (
              <Row
                key={meeting.id}
                title={meeting.title}
                subtitle={`${formatInstant(meeting.startsAt)}  ·  added by ${meeting.creatorName}`}
                href={`/meetings/${meeting.id}`}
                right={meeting.isCreator ? <Badge label="Yours" tone="muted" /> : undefined}
              />
            ))}
          </Body>
        )}
      </DataScreen>

      {/*
        A Fab, matching the events list. No role check around it: every member of an Eboard space
        may schedule a meeting, and reaching this screen at all already requires membership.
      */}
      <Fab onPress={() => setComposing(true)} accessibilityLabel="Add a meeting" />
    </View>
  );
}

/**
 * The composer, in the shape the event one uses.
 *
 * > **`YYYY-MM-DDTHH:MM` in a text box was a format quiz, and this screen set it.** The date and
 * > the time are now picked from a grid and a pair of columns, which cannot produce a value the
 * > validator rejects. The old field accepted exactly one spelling and refused everything a
 * > person would naturally type.
 */
function NewMeeting({
  eboardId,
  onCancel,
  onCreated,
}: {
  eboardId: string;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [link, setLink] = useState('');
  const [startDate, setStartDate] = useState('');
  const [startTime, setStartTime] = useState('');
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /*
   * A date and a time are separate fields and one instant.
   *
   * Joined WITHOUT a timezone suffix, so `new Date()` reads them in the device's own zone - which
   * is what "the board meets at 6" means to the person picking it. Appending `Z` would book it in
   * UTC and move it by the offset, which is the classic way an evening meeting lands at midnight
   * for half the board.
   */
  const startsAt = (() => {
    if (startDate.length === 0 || startTime.length === 0) return null;
    const parsed = new Date(`${startDate}T${startTime}`);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  })();

  /*
   * A meeting cannot be scheduled in the past. Said before SAVE is pressed rather than after a
   * failed round trip - and a meeting the board "has" which already happened is noise on the
   * calendar of everyone in the space.
   */
  const startsInPast = startsAt !== null && new Date(startsAt).getTime() <= Date.now();
  const problem = startsInPast
    ? 'That start is in the past. Pick a date and time still to come.'
    : null;

  const valid = title.trim().length > 0 && startsAt !== null && problem === null;

  const submit = async () => {
    if (startsAt === null) return;
    setBusy(true);
    setFailed(null);
    try {
      await contentApi.createMeeting(eboardId, {
        title: title.trim(),
        description: description.trim().length > 0 ? description.trim() : null,
        startsAt,
        link: link.trim().length > 0 ? link.trim() : null,
      });
      onCreated();
    } catch {
      setFailed('Could not create the meeting. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.flex}>
      <ComposerHeader
        title="New meeting"
        discardLabel="Discard this meeting and go back"
        onCancel={onCancel}
      />

      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.composerBody}
        keyboardShouldPersistTaps="handled"
      >
        {/* The heading treatment the event composer uses: the name at display weight over a
            short accent rule. */}
        <View>
          <Text style={styles.composerHeading}>NEW MEETING</Text>
          <View style={styles.composerRule} />
        </View>

        <Text style={styles.composerLabel}>Meeting Title</Text>
        <TextInput
          style={styles.composerInput}
          value={title}
          onChangeText={setTitle}
          placeholder="e.g. Budget review"
          placeholderTextColor={color.textSecondary}
          accessibilityLabel="Meeting title"
        />

        <Text style={styles.composerLabel}>Joining Link</Text>
        <View style={styles.composerInputRow}>
          <MaterialIcons name="videocam" size={18} color={color.textSecondary} />
          <TextInput
            style={styles.composerInputInline}
            value={link}
            onChangeText={setLink}
            placeholder="Video call or room, if there is one"
            placeholderTextColor={color.textSecondary}
            keyboardType="url"
            autoCapitalize="none"
            accessibilityLabel="Joining link"
          />
        </View>

        <Text style={styles.composerLabel}>Agenda</Text>
        <TextInput
          style={[styles.composerInput, styles.composerInputTall]}
          value={description}
          onChangeText={setDescription}
          placeholder="What the board needs to decide, and anything to read beforehand..."
          placeholderTextColor={color.textSecondary}
          multiline
          accessibilityLabel="Agenda"
        />

        <View style={styles.scheduleCard}>
          <Text style={styles.scheduleTitle}>SCHEDULE</Text>
          <Text style={styles.scheduleLabel}>Starts</Text>
          <View style={styles.scheduleRow}>
            <View style={styles.scheduleDate}>
              <DateField label="start date" value={startDate} onChange={setStartDate} />
            </View>
            <View style={styles.scheduleTime}>
              <TimeField label="Start time" value={startTime} onChange={setStartTime} />
            </View>
          </View>
          {/* No end. A meeting has a start and runs until it is over, which is how the board
              already talks about it - and an end nobody fills in is a field for its own sake. */}
        </View>

        <Text style={styles.meta}>
          Creating this tells the other members of the space and posts a card into board chat. It
          appears on the calendar of members only.
        </Text>
        {problem !== null && <Text style={styles.error}>{problem}</Text>}
        {failed !== null && <Text style={styles.error}>{failed}</Text>}

        <Pressable
          style={[styles.saveButton, (!valid || busy) && styles.saveButtonOff]}
          disabled={!valid || busy}
          onPress={() => void submit()}
          accessibilityRole="button"
          accessibilityLabel="Save meeting"
          accessibilityState={{ disabled: !valid || busy }}
        >
          <Text style={styles.saveButtonLabel}>{busy ? 'SAVING' : 'SAVE MEETING'}</Text>
          <MaterialIcons name="arrow-forward" size={18} color={color.onAccent} />
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: color.appBackground },
  tabsWrap: { padding: space.md, paddingBottom: 0 },
  meta: { ...type.bodySmall, color: color.textSecondary },
  error: { ...type.bodySmall, color: color.error },

  composerBody: { padding: space.md, paddingBottom: space.xl, gap: space.sm },
  composerHeading: { ...type.title, color: color.textPrimary },
  composerRule: {
    height: 3,
    width: 108,
    backgroundColor: color.accent,
    borderRadius: radius.pill,
    marginTop: space.xs,
    marginBottom: space.sm,
  },
  /* Accent-coloured, which is what separates a field label from body copy. */
  composerLabel: { ...type.label, color: color.accent, marginTop: space.sm },
  composerInput: {
    ...type.body,
    backgroundColor: color.card,
    borderWidth: 1,
    borderColor: color.hairline,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 4,
    color: color.textPrimary,
  },
  composerInputTall: { minHeight: 104, textAlignVertical: 'top' },
  composerInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: color.card,
    borderWidth: 1,
    borderColor: color.hairline,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
  },
  composerInputInline: {
    ...type.body,
    flex: 1,
    paddingVertical: space.sm + 4,
    color: color.textPrimary,
  },
  scheduleCard: {
    backgroundColor: color.chrome,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.divider,
    padding: space.md,
    gap: space.sm,
    marginTop: space.md,
  },
  scheduleTitle: { ...type.headerTitle, fontSize: 18, color: color.textPrimary },
  scheduleLabel: { ...type.headline, fontSize: 14, color: color.textPrimary },
  scheduleRow: { flexDirection: 'row', gap: space.sm },
  scheduleDate: { flex: 2 },
  scheduleTime: { flex: 1 },
  saveButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    backgroundColor: color.accent,
    borderRadius: radius.pill,
    paddingVertical: space.md,
    marginTop: space.md,
  },
  saveButtonOff: { opacity: 0.6 },
  saveButtonLabel: { ...type.headerTitle, fontSize: 16, color: color.onAccent },
});
