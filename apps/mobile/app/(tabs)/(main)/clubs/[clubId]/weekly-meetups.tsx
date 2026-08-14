/**
 * Weekly Meetups: Monday through Sunday.
 *
 * **The screen answers three questions and asks them in that order** - where the club is
 * meeting, when, and what they will be doing. The composer is phrased as the question rather
 * than as a form ("Where should we meet?"), because that is what somebody opens it to answer.
 *
 * Three rules the server owns and this screen must not second-guess:
 *
 *  - **A day with nothing on it says "Nothing planned", explicitly.** An empty day is otherwise
 *    ambiguous between "nothing is happening" and "nobody has posted yet", so the flag comes
 *    from the server rather than from an absence in the list.
 *  - **On the current week, past days are hidden.** The week is a plan, not a record. Paging
 *    back shows all seven, and the server decides which - this screen renders what it gets.
 *  - **A day may hold several meetups**, already in time order. A morning session and an evening
 *    social are two rows, and the day simply gets taller.
 *
 * Creating a meetup **notifies nobody and posts nothing**: it is reference material, and a week
 * authored in one sitting would otherwise fire seven notifications. That silence is why this is
 * a separate surface from the calendar rather than a view over it (PRD/08 rule 11).
 *
 * **Nudge is the one deliberate exception**, and it is a person choosing to send one rather than
 * the app deciding to buzz. Admins only, once an hour for the whole club - so the bell is shared
 * state, not per-meetup, and it renders disabled with the time it returns rather than looking
 * live and failing on tap.
 *
 * There is deliberately **no activity type** anywhere on this screen. See ADR-0029.
 *
 * > **Wearing the composer surface since 2026-08-14** (`DESIGN/06`), which was built for the poll
 * > composer and which the other create flows were always meant to follow. Sections are separated
 * > by air rather than by cards, the primary action is in the header, and the moment is picked on
 * > a wheel - the same control, in the same arrangement, so learning to make a poll teaches you
 * > this too.
 */

import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useDeclareClub } from '../../../../../src/current-space.tsx';
import { clubApi, contentApi } from '../../../../../src/api.ts';
import type { Meetup } from '../../../../../src/api-types.ts';
import {
  formatDayTitle,
  formatTimeOfDay,
  formatWallClock,
  fromDateKey,
  toDateKey,
} from '../../../../../src/dates.ts';
import {
  AddRow,
  ComposerField,
  HeaderAction,
  SectionLabel,
  SettingNote,
  SettingRow,
  SettingValue,
  Wheel,
} from '../../../../../src/composer-kit.tsx';
import { color, space, type } from '../../../../../src/theme.ts';
import { Action, ComposerHeader, DataScreen } from '../../../../../src/ui.tsx';
import { useLoad } from '../../../../../src/use-load.ts';

/** Minute granularity on the wheel. Five is the poll composer's, and 60 rows is not a picker. */
const MINUTE_STEP = 5;
/** How far either side of today the day column reaches. Back, because a past week is editable. */
const DAYS_BACK = 30;
const DAYS_AHEAD = 365;

/** The Monday of the week containing `date`, built from components rather than parsed. */
function mondayOf(date: Date): string {
  const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const weekday = copy.getDay();
  // Sunday is 0, and the week starts on Monday, so Sunday steps back six rather than forward one.
  copy.setDate(copy.getDate() - (weekday === 0 ? 6 : weekday - 1));
  return toDateKey(copy);
}

function shift(monday: string, weeks: number): string {
  const date = fromDateKey(monday);
  date.setDate(date.getDate() + weeks * 7);
  return mondayOf(date);
}

/** The moment a `{ day, hour, minute }` selection names, built from components rather than parsed. */
function momentFrom(dateKey: string, hour: number, minute: number): Date {
  const date = fromDateKey(dateKey);
  date.setHours(hour, minute, 0, 0);
  return date;
}

/** What the form is doing: adding to a given day, or editing one that exists. */
type Editing =
  | { mode: 'add'; date: string }
  | { mode: 'edit'; date: string; meetup: Meetup };

export default function WeeklyMeetupsScreen() {
  const { clubId } = useLocalSearchParams<{ clubId: string }>();
  // Inside this club for as long as this screen is mounted, which is what the Clubs tab reads.
  useDeclareClub(clubId);
  const [monday, setMonday] = useState(() => mondayOf(new Date()));
  const [editing, setEditing] = useState<Editing | null>(null);
  const [nudgeNote, setNudgeNote] = useState<string | null>(null);
  const [nudging, setNudging] = useState(false);

  const week = useLoad(() => contentApi.meetups(clubId, monday), [clubId, monday]);
  const club = useLoad(() => clubApi.detail(clubId), [clubId]);
  const isAdmin = club.data?.club.viewer.isAdmin === true;

  /*
   * One bell for the club, not one per meetup.
   *
   * The server owns the hour and returns when it lifts; this only decides whether to draw the
   * control as available. Re-reading the week after a nudge is what moves it, rather than the
   * screen keeping its own clock and drifting out of agreement with the server.
   */
  const blockedUntil = week.data?.nudgeBlockedUntil ?? null;
  const bellLive = blockedUntil === null || Date.parse(blockedUntil) <= Date.now();

  const nudge = async (meetupId: string) => {
    setNudging(true);
    setNudgeNote(null);
    try {
      await contentApi.nudgeMeetup(meetupId);
      setNudgeNote('Nudged. Everyone in the club has been notified.');
    } catch {
      // The refusal carries a time, but a failed fetch here has no body to read - so the reload
      // below is what tells the truth, and this line only has to not lie.
      setNudgeNote('Could not nudge. The club may have been nudged already.');
    } finally {
      setNudging(false);
      week.reload();
    }
  };

  if (editing !== null) {
    return (
      <MeetupComposer
        clubId={clubId}
        editing={editing}
        onCancel={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
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

      {nudgeNote !== null && <Text style={styles.note}>{nudgeNote}</Text>}

      <DataScreen load={week}>
        {(data) => (
          <ScrollView contentContainerStyle={styles.body}>
            {/*
              A day is a label with air above it, not a bordered card. Seven cards read as seven
              unrelated panels rather than as one week - `DESIGN/06` rule 1, the same reason the
              poll composer stopped putting each group in a box.
            */}
            {data.days.map((day) => (
              <View key={day.date}>
                <SectionLabel>{formatDayTitle(day.date)}</SectionLabel>

                {day.empty && <Text style={styles.empty}>Nothing planned</Text>}

                {day.meetups.map((meetup) => (
                  <View key={meetup.id} style={styles.meetup}>
                    {/* Where and when are the headline; what they are doing sits under it. */}
                    <Text style={styles.headline}>
                      {formatWallClock(meetup.time)} · {meetup.location}
                    </Text>
                    {meetup.description !== null && (
                      <Text style={styles.description}>{meetup.description}</Text>
                    )}

                    {/* Any admin edits any meetup, not only its author. */}
                    {isAdmin && (
                      <View style={styles.rowActions}>
                        <RowAction
                          label="Edit"
                          onPress={() => setEditing({ mode: 'edit', date: day.date, meetup })}
                          accessibilityLabel={`Edit the meetup at ${meetup.location}`}
                        />
                        <RowAction
                          label="Remove"
                          onPress={() => {
                            void contentApi.deleteMeetup(meetup.id).then(week.reload, week.reload);
                          }}
                          accessibilityLabel={`Remove the meetup at ${meetup.location}`}
                        />
                        {/* One bell per club. Disabled rather than hidden while cooling down, so
                            an admin can see it exists and when it comes back. */}
                        <RowAction
                          label={bellLive ? 'Nudge' : `Nudge at ${formatTimeOfDay(blockedUntil!)}`}
                          disabled={!bellLive || nudging}
                          onPress={() => void nudge(meetup.id)}
                          accessibilityLabel={
                            bellLive
                              ? `Nudge the club about the meetup at ${meetup.location}`
                              : `Nudging is unavailable until ${formatTimeOfDay(blockedUntil!)}`
                          }
                        />
                      </View>
                    )}
                  </View>
                ))}

                {isAdmin && (
                  <AddRow
                    label="Add a meetup"
                    onPress={() => setEditing({ mode: 'add', date: day.date })}
                  />
                )}
              </View>
            ))}

            {data.days.length === 0 && (
              <Text style={styles.empty}>This week is over. Page back to see it.</Text>
            )}
          </ScrollView>
        )}
      </DataScreen>
    </View>
  );
}

/** A quiet inline action on a meetup row. Text, not a filled box: nothing here is the primary act. */
function RowAction({
  label,
  onPress,
  disabled = false,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  accessibilityLabel: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={space.sm}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
    >
      <Text style={[styles.rowAction, disabled && styles.rowActionOff]}>{label}</Text>
    </Pressable>
  );
}

/**
 * Where, when, what - asked in that order, on the composer surface.
 *
 * The place is the filled field because it is what the header asks about; everything else is an
 * outline or a row (`DESIGN/06` rule 3). The primary action is in the header rather than at the
 * foot, for the reason the poll composer put it there: **the wheel expands in place**, and a
 * trailing button would be pushed off screen exactly as somebody finishes.
 */
function MeetupComposer({
  clubId,
  editing,
  onCancel,
  onSaved,
}: {
  clubId: string;
  editing: Editing;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const existing = editing.mode === 'edit' ? editing.meetup : null;
  const [location, setLocation] = useState(existing?.location ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  /*
   * Null until the wheel is opened, because the time is REQUIRED and a default is not a choice.
   * PRD/08 rule 7 refuses to save without one, so pre-filling would let an admin post a time
   * nobody picked.
   */
  const [when, setWhen] = useState<Date | null>(
    existing === null
      ? null
      : momentFrom(
          editing.date,
          Number(existing.time.slice(0, 2)),
          Number(existing.time.slice(3, 5)),
        ),
  );
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  /*
   * The day column, reaching back as well as forward.
   *
   * Built from `toDateKey` on split components rather than by adding milliseconds - a column
   * assembled by adding 86,400,000 a hundred times drifts across a daylight-saving boundary and
   * starts naming the wrong weekdays.
   */
  const today = new Date();
  const days = Array.from({ length: DAYS_BACK + DAYS_AHEAD }, (_, index) => {
    const offset = index - DAYS_BACK;
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset);
    return {
      key: toDateKey(date),
      label:
        offset === 0
          ? 'Today'
          : date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }),
    };
  });
  const hours = Array.from({ length: 24 }, (_, hour) => ({
    key: String(hour),
    label: String(hour).padStart(2, '0'),
  }));
  const minutes = Array.from({ length: 60 / MINUTE_STEP }, (_, index) => ({
    key: String(index * MINUTE_STEP),
    label: String(index * MINUTE_STEP).padStart(2, '0'),
  }));

  /* What the wheel shows while open but unchosen: the day that was tapped, at six in the evening. */
  const shown = when ?? momentFrom(editing.date, 18, 0);

  const setPart = (part: { dateKey?: string; hour?: number; minute?: number }) => {
    setWhen(
      momentFrom(
        part.dateKey ?? toDateKey(shown),
        part.hour ?? shown.getHours(),
        part.minute ?? Math.floor(shown.getMinutes() / MINUTE_STEP) * MINUTE_STEP,
      ),
    );
  };

  // Where and when are both required. "TBC" is a real answer for a place; a blank is not.
  const valid = location.trim().length > 0 && when !== null;

  const submit = async () => {
    if (when === null) return;
    setBusy(true);
    setFailed(null);
    const body = {
      // Split from ONE local moment. The wire carries a wall-clock date and time, never an
      // instant, because a club's week is its own day and not the reader's - see ADR-0029.
      meetupDate: toDateKey(when),
      meetupTime: `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`,
      location: location.trim(),
      description: description.trim().length > 0 ? description.trim() : null,
    };
    try {
      if (existing === null) await contentApi.createMeetup(clubId, body);
      else await contentApi.updateMeetup(existing.id, body);
      onSaved();
    } catch {
      setFailed('Could not save the meetup. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.flex}>
      <ComposerHeader
        title={existing === null ? 'New meetup' : 'Edit meetup'}
        discardLabel={existing === null ? 'Discard this meetup' : 'Discard these changes'}
        onCancel={onCancel}
        dismiss="close"
        action={
          <HeaderAction
            label="Save"
            busyLabel="Saving"
            busy={busy}
            disabled={!valid}
            onPress={() => void submit()}
          />
        }
      />

      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.composerBody}
        keyboardShouldPersistTaps="handled"
      >
        {/* No label above it. The placeholder says what it is, and a form whose first field is
            labelled "Place" above a box reading "Where should we meet?" says it twice. */}
        <ComposerField
          value={location}
          onChangeText={setLocation}
          placeholder="Where should we meet?"
          accessibilityLabel="Where the club is meeting"
          filled
        />

        <SectionLabel>When</SectionLabel>

        <SettingRow
          label="Time"
          /*
            Opening COMMITS the moment the wheel is showing (`DESIGN/06` rule 11). Without it the
            row reads "Pick a time" while the wheel underneath highlights six in the evening - the
            control contradicting its own value, which gets reported as "it will not save".
          */
          onPress={() => {
            if (picking) {
              setPicking(false);
              return;
            }
            if (when === null) setWhen(shown);
            setPicking(true);
          }}
          accessibilityLabel={
            when === null ? 'Time: not set. Pick one' : `Meeting at ${formatTimeOfDay(when.toISOString())}. Change`
          }
        >
          <SettingValue muted={when === null}>
            {when === null
              ? 'Pick a time'
              : `${days.find((d) => d.key === toDateKey(when))?.label ?? toDateKey(when)}, ${formatTimeOfDay(when.toISOString())}`}
          </SettingValue>
        </SettingRow>

        {/* In place, between the row it belongs to and the next thing - which is why the Save
            action lives in the header rather than at the foot of the form. */}
        {picking && (
          <Wheel
            columns={[
              {
                key: 'day',
                items: days,
                selectedKey: toDateKey(shown),
                onSelect: (key) => setPart({ dateKey: key }),
                accessibilityLabel: 'Day the club is meeting',
                flex: 3,
              },
              {
                key: 'hour',
                items: hours,
                selectedKey: String(shown.getHours()),
                onSelect: (key) => setPart({ hour: Number(key) }),
                accessibilityLabel: 'Hour the club is meeting',
                flex: 1,
              },
              {
                key: 'minute',
                items: minutes,
                selectedKey: String(Math.floor(shown.getMinutes() / MINUTE_STEP) * MINUTE_STEP),
                onSelect: (key) => setPart({ minute: Number(key) }),
                accessibilityLabel: 'Minute the club is meeting',
                flex: 1,
              },
            ]}
          />
        )}

        {/* One note, at the end of its section. */}
        <SettingNote>
          Adding a meetup notifies nobody. Use Nudge on the week to tell the club.
        </SettingNote>

        <ComposerField
          value={description}
          onChangeText={setDescription}
          placeholder="What are we doing?"
          accessibilityLabel="What the club is doing"
          multiline
        />

        {failed !== null && <Text style={styles.error}>{failed}</Text>}
      </ScrollView>
    </View>
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
  body: { padding: space.md, paddingBottom: space.xl },
  composerBody: { padding: space.md, paddingBottom: space.xl },
  meetup: { gap: space.xs, paddingVertical: space.sm },
  headline: { ...type.body, color: color.textPrimary },
  description: { ...type.bodySmall, color: color.textSecondary },
  rowActions: { flexDirection: 'row', gap: space.md, paddingTop: space.xs },
  rowAction: { ...type.label, color: color.accent },
  rowActionOff: { color: color.textSecondary },
  empty: { ...type.bodySmall, color: color.textSecondary, paddingVertical: space.sm },
  note: { ...type.bodySmall, color: color.textSecondary, paddingHorizontal: space.md },
  error: { ...type.bodySmall, color: color.error, paddingTop: space.sm },
});
