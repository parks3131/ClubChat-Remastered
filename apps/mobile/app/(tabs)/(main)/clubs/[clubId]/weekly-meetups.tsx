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
 *  - **All seven days are shown, and a past one carries no Add row.** The week stopped hiding the
 *    days that had gone on 2026-08-15, when the calendar started pointing at any day of it: a
 *    meetup on a past day could be tapped and then not shown, and paging could not reach it
 *    because the day sits inside the current week. The server marks a day `past`; this screen
 *    renders what it gets and only withholds the control.
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

import { useRef, useState } from 'react';
import { Keyboard, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useDeclareClub } from '../../../../../src/current-space.tsx';
import { clubApi, contentApi } from '../../../../../src/api.ts';
import { meetupHeadline, type Meetup } from '../../../../../src/api-types.ts';
import {
  formatDayTitle,
  formatTimeOfDay,
  formatWallClock,
  fromDateKey,
  toDateKey,
} from '../../../../../src/dates.ts';
import {
  ComposerField,
  HeaderAction,
  SectionLabel,
  SettingNote,
  SettingRow,
  SettingValue,
  Wheel,
} from '../../../../../src/composer-kit.tsx';
import { KeyboardAvoider } from '../../../../../src/keyboard-avoider.tsx';
import { longPressFeedback } from '../../../../../src/haptics.ts';
import { color, radius, space, type } from '../../../../../src/theme.ts';
import {
  Action,
  ComposerHeader,
  ContextMenu,
  DataScreen,
  Fab,
  measureRow,
  type PressAnchor,
} from '../../../../../src/ui.tsx';
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
  | { mode: 'add' }
  | { mode: 'edit'; date: string; meetup: Meetup };

export default function WeeklyMeetupsScreen() {
  const { clubId, date } = useLocalSearchParams<{ clubId: string; date?: string }>();
  // Inside this club for as long as this screen is mounted, which is what the Clubs tab reads.
  useDeclareClub(clubId);
  /*
   * The week to open on: the one holding `date` when the caller named a day, otherwise this one.
   *
   * > **The calendar is the caller that needs it.** A meetup's row there opens this screen, and
   * > until 2026-08-15 it always opened on the current week - so tapping something three weeks out
   * > landed on a week that did not contain it and left the reader to page. Reported from the
   * > phone with a video.
   *
   * Validated rather than trusted: a parameter is a string from a URL, and `fromDateKey` on
   * something that is not `YYYY-MM-DD` yields an Invalid Date, which would put the screen on a
   * week called "Week of NaN-NaN-NaN" with no way back but the arrows.
   */
  const [monday, setMonday] = useState(() =>
    typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
      ? mondayOf(fromDateKey(date))
      : mondayOf(new Date()),
  );
  const [editing, setEditing] = useState<Editing | null>(null);
  const [nudgeNote, setNudgeNote] = useState<string | null>(null);
  const [nudging, setNudging] = useState(false);
  /*
   * Edit and Remove live behind a long press, not as text under every row.
   *
   * They were inline links, and at two meetups a day the week became a wall of "Edit Remove
   * Nudge at 3:52 AM" repeated down the screen - reported from the device as clumsy, and it was.
   * A long press is the gesture this app already uses for row actions on the club list and on a
   * race (`PRD/09` rule 23), so the week stops being the one place that does it differently.
   */
  const [menuFor, setMenuFor] = useState<{ day: string; meetup: Meetup; anchor: PressAnchor } | null>(
    null,
  );

  const week = useLoad(() => contentApi.meetups(clubId, monday), [clubId, monday]);
  const club = useLoad(() => clubApi.detail(clubId), [clubId]);
  const isAdmin = club.data?.club.viewer.isAdmin === true;

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
                  <MeetupRow
                    key={meetup.id}
                    meetup={meetup}
                    isAdmin={isAdmin}
                    bellBusy={nudging}
                    onNudge={() => void nudge(meetup.id)}
                    onGrey={setNudgeNote}
                    onLongPress={(anchor) => {
                      longPressFeedback();
                      setMenuFor({ day: day.date, meetup, anchor });
                    }}
                  />
                ))}

              </View>
            ))}

            {/*
              "This week is over. Page back to see it." used to live here, for the Sunday evening
              when every day of the current week had been hidden and the screen was blank. The
              week returns all seven days since 2026-08-15, so there is no empty case left to
              explain - and the message would now be a sentence nobody can ever reach.
            */}
          </ScrollView>
        )}
      </DataScreen>

      {/*
        One plus for the whole week, the same control the club's events list uses, rather than an
        "Add a meetup" row under all seven days.

        > **The founder asked for this on 2026-08-15: "I don't want to add meetup on everywhere...
        > we have a small plus symbol on the right corner, so I want the same in this page too."**
        > Seven identical rows down a screen is seven times the same offer, and it pushed the days
        > apart so the week read as a form rather than as a plan.
        >
        > It works now because the composer asks for the date itself - "Set date" - which it could
        > not do while each row's plus was the only thing that knew which day was meant.
      */}
      {isAdmin && <Fab onPress={() => setEditing({ mode: 'add' })} accessibilityLabel="Add a meetup" />}

      {menuFor !== null && (
        <ContextMenu
          anchor={menuFor.anchor}
          onDismiss={() => setMenuFor(null)}
          items={[
            {
              label: 'Edit',
              icon: 'edit',
              onPress: () => {
                const { day, meetup } = menuFor;
                setMenuFor(null);
                setEditing({ mode: 'edit', date: day, meetup });
              },
            },
            {
              /* Red and last, per the menu's own rule for an action that ends something. */
              label: 'Remove',
              icon: 'delete-outline',
              destructive: true,
              onPress: () => {
                const { meetup } = menuFor;
                setMenuFor(null);
                void contentApi.deleteMeetup(meetup.id).then(week.reload, week.reload);
              },
            },
          ]}
        />
      )}
    </View>
  );
}

/**
 * One meetup on the week.
 *
 * **The bell is the only control on the row**, because it is the only one an admin reaches for
 * often. Edit and Remove are behind a long press: they were inline text links, and two meetups a
 * day turned the week into a wall of repeated words.
 */
/**
 * `18:30` as `6P`, for the chip.
 *
 * Deliberately not `formatWallClock`, which produces "6:30 PM" - that does not fit a circle, and
 * the circle is what makes a week scannable. The minutes are dropped only when they are zero, so
 * `6:30` stays `630P` rather than claiming a meetup is at six.
 */
function shortClock(hhmm: string): string {
  const [rawHour, rawMinute] = hhmm.split(':').map(Number);
  const hour = rawHour ?? 0;
  const minute = rawMinute ?? 0;
  const suffix = hour < 12 ? 'A' : 'P';
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return minute === 0 ? `${twelve}${suffix}` : `${twelve}:${String(minute).padStart(2, '0')}`;
}

function MeetupRow({
  meetup,
  isAdmin,
  bellBusy,
  onNudge,
  onGrey,
  onLongPress,
}: {
  meetup: Meetup;
  isAdmin: boolean;
  bellBusy: boolean;
  onNudge: () => void;
  /** Tapped while grey. Carries the reason, because there are two and they read differently. */
  onGrey: (reason: string) => void;
  onLongPress: (anchor: PressAnchor) => void;
}) {
  const ref = useRef<View>(null);
  const router = useRouter();
  /*
   * This meetup's own clock. Four meetups in a day are four bells, so none of this comes from
   * the screen - nudging the morning run must leave the evening social's bell alone.
   */
  const blockedUntil = meetup.nudgeBlockedUntil;
  const cooling = blockedUntil !== null && Date.parse(blockedUntil) > Date.now();

  /*
   * Accent only when it can actually be rung: today's meetup, not already nudged.
   *
   * Two ways to be grey and they read differently, so the bell carries the sentence rather than
   * the screen guessing. `nudgeable` is the server's answer to "is this today" - the client does
   * not compare dates itself, or the two could disagree across midnight.
   */
  const greyReason = !meetup.nudgeable
    ? 'Only today\'s meetups can be nudged.'
    : cooling
      ? `Someone already nudged this meetup. You can nudge it again at ${formatTimeOfDay(blockedUntil!)}.`
      : null;

  return (
    <Pressable
      ref={ref}
      style={styles.meetup}
      onLongPress={(event) =>
        measureRow(
          ref.current,
          { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY },
          onLongPress,
        )
      }
      /*
        Everybody can open it now. Until 2026-08-15 a member could not press this row at all -
        there was nothing behind it, because a meetup had no screen. It has one, so the row leads
        there for everybody and the long press stays what it always was: an admin's shortcut.
      */
      onPress={() => router.push(`/meetups/${meetup.id}`)}
      accessibilityRole="button"
      accessibilityLabel={`${meetupHeadline(meetup)} at ${formatWallClock(meetup.time)}${
        isAdmin ? '. Hold for options' : ''
      }`}
    >
      {/*
        The time as a chip rather than a prefix on the headline, from the founder's design.
        It is the thing scanned for down a week - "what is at six" - and as a prefix it competed
        with the name for the start of the line.
      */}
      <View style={styles.clock}>
        <Text style={styles.clockText}>{shortClock(meetup.time)}</Text>
      </View>

      <View style={styles.meetupText}>
        {/*
          The NAME is the headline, and the place sits under it. Without a name the place is the
          headline and there is no second line - `meetupHeadline` owns that fallback so every
          surface makes the same choice.
        */}
        <Text style={styles.headline}>{meetupHeadline(meetup)}</Text>
        {/* Only the meetups made before the place stopped being collected still carry one. */}
        {meetup.location !== null && meetup.location.trim().length > 0 && (
          <Text style={styles.description}>{meetup.location}</Text>
        )}
        {meetup.description !== null && (
          <Text style={styles.description} numberOfLines={2}>
            {meetup.description}
          </Text>
        )}
      </View>

      {/*
        Always drawn for an admin, and grey when it cannot be rung. Hiding it on other days made
        the control appear and disappear down the week, which reads as a rendering fault rather
        than as a rule - and left no way to ask why.
      */}
      {isAdmin && (
        <View style={styles.bellWrap}>
          {/* Only the meetup actually cooling down says when - which is one row, not all of them. */}
          {cooling && meetup.nudgeable && (
            <Text style={styles.bellTime}>{formatTimeOfDay(blockedUntil!)}</Text>
          )}
          {/*
            Grey, and still pressable.

            A spent bell that does nothing when tapped is indistinguishable from a broken one -
            the admin learns only that the app ignored them. Pressing it says somebody has already
            nudged and until when, which is the whole reason it is grey rather than gone.
          */}
          <Pressable
            onPress={() => (greyReason === null ? onNudge() : onGrey(greyReason))}
            disabled={bellBusy}
            hitSlop={space.sm}
            style={[styles.bell, greyReason !== null && styles.bellOff]}
            accessibilityRole="button"
            accessibilityLabel={
              greyReason ?? `Nudge the club about ${meetupHeadline(meetup)}`
            }
          >
            <MaterialIcons
              name="notifications-active"
              size={18}
              /* Accent only when today and unrung. Grey is the rule showing, not a dead control. */
              color={greyReason === null ? color.accent : color.textSecondary}
            />
          </Pressable>
        </View>
      )}
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
  const [description, setDescription] = useState(existing?.description ?? '');
  /*
   * The name, and it is FIRST on the form rather than last.
   *
   * Optional, so the form still saves with a place and a time alone - which is how this shipped
   * and how somebody in a hurry uses it. It leads because it is what the week and the calendar
   * show as the headline, and because it is what lets this belong to a club that is not a running
   * club: "morning book reading", "swim practice night".
   */
  const [title, setTitle] = useState(existing?.title ?? '');
  const [mapUrl, setMapUrl] = useState(existing?.mapUrl ?? '');
  /*
   * Null until the wheel is opened, because the time is REQUIRED and a default is not a choice.
   * PRD/08 rule 7 refuses to save without one, so pre-filling would let an admin post a time
   * nobody picked.
   */
  const [when, setWhen] = useState<Date | null>(
    editing.mode === 'edit'
      ? momentFrom(
          editing.date,
          Number(editing.meetup.time.slice(0, 2)),
          Number(editing.meetup.time.slice(3, 5)),
        )
      : null,
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
  const todayKey = toDateKey(today);

  /*
   * The wheel offers today onwards, and never a moment that has already been.
   *
   * > **Asked for on 2026-08-15: "just show dates from today and the time after right now so that
   * > people don't have a chance to create an old event".** It used to reach thirty days back,
   * > which existed for editing a meetup that had already happened - and that is still why the
   * > column starts EARLIER when this form is editing one. A meetup last Tuesday must remain
   * > editable on its own date; what must not happen is authoring a new one into the past.
   *
   * The columns narrow together and in order: the day decides which hours exist, and the hour
   * decides which minutes do. Anything else lets 14:00 stay selectable at 15:30 today simply
   * because it was legal when the wheel opened.
   */
  /*
   * The default moment, and it has to be a legal one.
   *
   * Six in the evening while six in the evening is still ahead, and the next step of the clock
   * otherwise - because a wheel that opens on a time it will not offer is the control
   * contradicting itself, which is how "it will not save" gets reported.
   */
  /*
   * The soonest moment the wheel may offer: now, rounded UP to the step.
   *
   * Rounding up rather than down is what makes "after right now" true - and it may roll into
   * tomorrow, which is the case that has to be handled rather than clamped. At 23:58 with a
   * five-minute step there is no legal slot left today, so today stops being offered at all.
   * Clamping to 23:55 instead would put a time in the past back on the wheel, which is the whole
   * thing this is here to prevent.
   */
  const soonest = new Date(today);
  soonest.setMinutes(Math.ceil(soonest.getMinutes() / MINUTE_STEP) * MINUTE_STEP, 0, 0);
  const soonestKey = toDateKey(soonest);

  const defaultMoment = (() => {
    if (editing.mode === 'edit') return momentFrom(editing.date, 18, 0);
    const six = momentFrom(soonestKey, 18, 0);
    return six.getTime() > soonest.getTime() ? six : soonest;
  })();
  const shown = when ?? defaultMoment;

  const earliestKey =
    editing.mode === 'edit' && editing.date < soonestKey ? editing.date : soonestKey;
  const earliest = fromDateKey(earliestKey);
  const days = Array.from({ length: DAYS_BACK + DAYS_AHEAD }, (_, index) => {
    const date = new Date(earliest.getFullYear(), earliest.getMonth(), earliest.getDate() + index);
    return { date, key: toDateKey(date) };
  })
    .filter(({ key }) => key >= earliestKey)
    .map(({ date, key }) => ({
      key,
      label:
        key === todayKey
          ? 'Today'
          : date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }),
    }));

  /* On the soonest day, the hours that have gone are not offered. On any later one, all of them. */
  const onToday = toDateKey(shown) === soonestKey;
  const firstHour = onToday ? soonest.getHours() : 0;
  const hours = Array.from({ length: 24 - firstHour }, (_, index) => ({
    key: String(firstHour + index),
    label: String(firstHour + index).padStart(2, '0'),
  }));

  /* And within the current hour, the minutes that have gone. Rounded UP to the step. */
  const firstMinute = onToday && shown.getHours() === soonest.getHours() ? soonest.getMinutes() : 0;
  const minutes = Array.from(
    { length: Math.max(1, (60 - firstMinute) / MINUTE_STEP) },
    (_, index) => ({
      key: String(firstMinute + index * MINUTE_STEP),
      label: String(firstMinute + index * MINUTE_STEP).padStart(2, '0'),
    }),
  );

  const setPart = (part: { dateKey?: string; hour?: number; minute?: number }) => {
    setWhen(
      momentFrom(
        part.dateKey ?? toDateKey(shown),
        part.hour ?? shown.getHours(),
        part.minute ?? Math.floor(shown.getMinutes() / MINUTE_STEP) * MINUTE_STEP,
      ),
    );
  };

  /*
   * A name and a moment. **The place stopped being required on 2026-08-15** and stopped being
   * asked for at all - the founder's redesign replaced it with a pasted link, "the link is the
   * place" - so the name is what a blank is refused for now. The shape of the rule did not
   * change: something has to identify a meetup, and whitespace does not.
   */
  const valid = title.trim().length > 0 && when !== null;

  const submit = async () => {
    if (when === null) return;
    setBusy(true);
    setFailed(null);
    const body = {
      // Split from ONE local moment. The wire carries a wall-clock date and time, never an
      // instant, because a club's week is its own day and not the reader's - see ADR-0029.
      meetupDate: toDateKey(when),
      meetupTime: `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`,
      title: title.trim(),
      /*
       * Blank is null, not "". An empty string is a value the row would then hold, and every
       * reader downstream would have to know that "" means the same as absent.
       */
      description: description.trim().length > 0 ? description.trim() : null,
      /*
       * The link, and no coordinates. This client places no pin: the map picture was taken out on
       * 2026-08-15 and Directions opens the link itself, which is exact. The server still reads a
       * point out of a link that carries one, and the route still accepts a hand-placed pair - see
       * `ADR-0037` - so the map can return without touching either end.
       */
      mapUrl: mapUrl.trim().length > 0 ? mapUrl.trim() : null,
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
            /* "Create" on a new one, from the founder's sketch. Editing still saves. */
            label={existing === null ? 'Create' : 'Save'}
            busyLabel={existing === null ? 'Creating' : 'Saving'}
            busy={busy}
            disabled={!valid}
            onPress={() => void submit()}
          />
        }
      />

      {/*
        Keeps the bottom of the form above the keys. Without it the last field - "What are we
        doing?" - sat under the keyboard with nothing to scroll it into view, so it could be
        focused and not seen.
      */}
      <KeyboardAvoider style={styles.flex}>
      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.composerBody}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        {/* No label above either. The placeholder says what it is, and a form whose first field
            is labelled "Place" above a box reading "Where should we meet?" says it twice. */}
        <ComposerField
          value={title}
          onChangeText={setTitle}
          placeholder="Untitled"
          accessibilityLabel="What this meetup is called"
          filled
        />

        {/*
          "Set date", one row with a chevron, from the founder's sketch on 2026-08-15. It carries
          no section label above it: the form is four controls now, and a heading over a single
          row names the row twice.
        */}
        <SettingRow
          label="Set date"
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
            /*
             * The keyboard has to go before the wheel arrives.
             *
             * Both want the bottom of the screen. Left up, the keys sat on top of the wheel and
             * of the field below it, so the day column could not be reached and "What are we
             * doing?" could not be typed into at all - which is exactly how it was reported.
             */
            Keyboard.dismiss();
            if (when === null) setWhen(shown);
            setPicking(true);
          }}
          accessibilityLabel={
            when === null
              ? 'Date and time: not set. Pick them'
              : `Meeting at ${formatTimeOfDay(when.toISOString())}. Change`
          }
        >
          <SettingValue muted={when === null}>
            {when === null
              ? 'Not set'
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

        {picking && (
          /*
             The way out of the wheel, said plainly.

             `DESIGN/06` rule 11 has opening commit the value, so there is nothing to confirm -
             but a picker with no visible way to close it reads as unfinished, and tapping the row
             again to collapse it is not a thing anybody discovers. A poll's equivalent is its
             "No deadline" clear; a meetup's time is required, so this only closes.
          */
          <Pressable
            style={styles.done}
            onPress={() => setPicking(false)}
            accessibilityRole="button"
            accessibilityLabel="Done choosing the time"
          >
            <Text style={styles.doneLabel}>Done</Text>
          </Pressable>
        )}

        {/*
          The place, as a link. It is LABELLED even though the field above it is not, and that is
          the lesson from the morning: a placeholder is the only thing naming a field and it
          vanishes the moment anybody types. The founder pasted a maps link into two adjacent
          unlabelled boxes and then asked why the meetup had two links on it. A field holding
          something opaque - a URL rather than a sentence - has to say what it is even when full.
        */}
        <SectionLabel>Location link</SectionLabel>

        <SettingNote>
          Paste a link from Google or Apple Maps. It becomes a Directions button on the meetup.
        </SettingNote>

        <ComposerField
          value={mapUrl}
          onChangeText={setMapUrl}
          placeholder="Add a location link"
          accessibilityLabel="A map link for this place"
          autoCapitalize="none"
          autoCorrect={false}
        />

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
      </KeyboardAvoider>
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
  meetup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.sm,
  },
  /*
    The time, as a circle down the left of the week.
    Fixed width so every row's text starts on the same line, which is the whole reason the chip
    beats a prefix: a column of names is scannable and a column of "6:00 PM · " is not.
  */
  clock: {
    width: 46,
    height: 46,
    borderRadius: radius.pill,
    backgroundColor: color.cardSunken,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clockText: { ...type.bodySmallStrong, color: color.textPrimary },
  meetupText: { flex: 1, gap: space.xs },
  headline: { ...type.headline, color: color.textPrimary },
  description: { ...type.bodySmall, color: color.textSecondary },
  bellWrap: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  bellTime: { ...type.bodySmall, color: color.textSecondary },
  bell: { padding: space.xs },
  bellOff: { opacity: 0.4 },
  done: {
    alignSelf: 'center',
    paddingVertical: space.sm,
    paddingHorizontal: space.lg,
  },
  doneLabel: { ...type.label, color: color.accent },
  empty: { ...type.bodySmall, color: color.textSecondary, paddingVertical: space.sm },
  note: { ...type.bodySmall, color: color.textSecondary, paddingHorizontal: space.md },
  error: { ...type.bodySmall, color: color.error, paddingTop: space.sm },
});
