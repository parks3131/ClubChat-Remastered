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
import { toMeetupBody } from '../../../../../src/meetup-body.ts';
import {
  formatTimeOfDay,
  formatWallClock,
  formatWeekRange,
  fromDateKey,
  isToday,
  toDateKey,
  weekdayInitial,
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
import { goBackOr } from '../../../../../src/nav.tsx';
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

/**
 * What the composer needs to open on an existing meetup: the fields it actually edits.
 *
 * Narrower than `Meetup` on purpose. The week row hands it a full `Meetup` and the meetup's own
 * screen hands it a `MeetupDetail`, and those two differ - a detail read carries no nudge clock,
 * because nudging belongs to the week. Asking for the union of both would mean inventing
 * `nudgeable: false` at one call site to satisfy a type the form never reads, which is a lie a
 * later reader would have to disprove. Both shapes satisfy this one honestly.
 */
type MeetupEditable = Pick<
  Meetup,
  'id' | 'time' | 'description' | 'title' | 'locationNotes' | 'mapUrl'
>;

/** What the form is doing: adding to a given day, or editing one that exists. */
type Editing =
  | { mode: 'add' }
  | { mode: 'edit'; date: string; meetup: MeetupEditable };

export default function WeeklyMeetupsScreen() {
  const { clubId, date, edit } = useLocalSearchParams<{
    clubId: string;
    date?: string;
    /**
     * A meetup id to open the composer on, from the meetup's own screen.
     *
     * The composer lives here, so Edit arrives as a parameter rather than as a second copy of the
     * form on the detail screen. Same door the event composer grew on the same day.
     */
    edit?: string;
  }>();
  // Inside this club for as long as this screen is mounted, which is what the Clubs tab reads.
  useDeclareClub(clubId);
  const router = useRouter();
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

  /*
   * The meetup being edited, when the meetup's own screen sent one.
   *
   * Read here so the form opens filled rather than filling itself a beat later, and held as the
   * loaded meetup rather than as the id, so nothing opens until there is something to open on.
   */
  const editLoad = useLoad(
    async () => (edit === undefined || edit === '' ? null : await contentApi.meetup(edit)),
    [edit],
  );
  const editingFromLink: Editing | null =
    editLoad.data == null
      ? null
      : { mode: 'edit', date: editLoad.data.meetup.date, meetup: editLoad.data.meetup };

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

  // The screen's own state wins, so opening Add over an `?edit=` link does what it says.
  const composing = editing ?? editingFromLink;

  if (composing !== null) {
    return (
      <MeetupComposer
        clubId={clubId}
        editing={composing}
        onCancel={() => {
          // Arrived by link from the meetup's screen: going back is where that belongs.
          // Guarded: `?edit=` is a real URL somebody can land on directly. Read off
          // `editingFromLink` rather than off `composing`, which is also the 'add' case and
          // would build `/meetups/` out of it.
          if (editingFromLink !== null) goBackOr(router, `/meetups/${editingFromLink.meetup.id}`);
          else setEditing(null);
        }}
        onSaved={() => {
          if (editingFromLink !== null) {
            goBackOr(router, `/meetups/${editingFromLink.meetup.id}`);
            return;
          }
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
        {/*
          The span, not the raw key. It reads as a week rather than as a database value, and it
          now carries the dates that used to sit in seven per-day headers - see `formatWeekRange`.
        */}
        <Text style={styles.weekLabel}>{formatWeekRange(monday)}</Text>
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
            {data.days.map((day, dayIndex) => (
              /*
                One row per day, marked by its letter, rather than a headed section per day.

                The badge used to carry the meetup's time and the day was a header above it, which
                meant seven headers plus seven "Nothing planned" lines to show one meetup. The
                letter moved into the badge and the header went, so the day is marked once and the
                week is seven rows tall. `PRD/08` rules 2 and 3 still hold and are the reason an
                empty day is a row rather than nothing: all seven days are shown, and a day with
                nothing on it says so.

                The badge belongs to the DAY, so it is drawn once here rather than by the row - a
                Tuesday with a morning and an evening meetup is one T against two stacked rows,
                not the letter repeated down the column.
              */
              <View key={day.date} style={styles.day}>
                {/*
                  The rail, and the badge sitting on it as a station.

                  Two rules used to do this job - a heavier one between days, a hairline between
                  meetups inside one - and the rail plus the card edge replace both. What
                  `DESIGN/14` rule 4b was really protecting survives: the nesting still reads
                  before the colour does, because the rail is one continuous line the whole week
                  hangs off and a meetup is a bounded object sitting beside it.
                */}
                <View style={styles.station}>
                  {dayIndex > 0 && <View style={[styles.rail, styles.railUp]} />}
                  {dayIndex < data.days.length - 1 && (
                    <View style={[styles.rail, styles.railDown]} />
                  )}
                  <DayBadge date={day.date} hasMeetups={!day.empty} />
                </View>

                <View style={styles.dayBody}>
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
 * The day's letter, and the only thing marking which day a row belongs to.
 *
 * Three weights, and each one is a fact rather than decoration:
 *
 *  - **Today is solid accent.** The one day the reader is most often looking for, and the reason
 *    the badge is worth its width now that it no longer carries a time.
 *  - **A day with something on it is accent-soft.** `TECH/13` reserves the solid accent for the
 *    thing being pointed at; seven solid circles would point at nothing.
 *  - **An empty day is sunken and grey**, so the week's shape is legible before a single word is
 *    read - which is what the founder meant by scanning it.
 *
 * `shortClock` lived here until 2026-08-17, squeezing "6:30 PM" into "630P" because that was what
 * fitted a 46pt circle. The time moved out to its own chip, so it reads properly again and that
 * function is gone rather than kept for a caller that no longer exists.
 */
function DayBadge({ date, hasMeetups }: { date: string; hasMeetups: boolean }) {
  const today = isToday(date);
  return (
    <View
      style={[
        styles.dayBadge,
        today ? styles.dayBadgeToday : hasMeetups ? styles.dayBadgeActive : styles.dayBadgeEmpty,
      ]}
    >
      <Text
        style={[
          styles.dayBadgeText,
          today
            ? styles.dayBadgeTextToday
            : hasMeetups
              ? styles.dayBadgeTextActive
              : styles.dayBadgeTextEmpty,
        ]}
      >
        {weekdayInitial(date)}
      </Text>
    </View>
  );
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

  /*
    A plain View, with the tappable part and the bell as SIBLINGS inside it.

    The bell used to sit inside the row's own Pressable, which is a button inside a button: invalid
    HTML on web, where React reports a hydration error, and on native the kind of nesting where the
    inner control takes the responder and the outer gesture never arrives. It happened to behave,
    because the bell wants the press it was intercepting - but that is luck rather than design, and
    `AGENTS.md` failure mode 17 is explicit that only the outermost element in a row owns a gesture.

    Pre-existing rather than introduced by the redesign, and fixed here because this is the file.
  */
  return (
    <View style={styles.meetup}>
      <Pressable
        ref={ref}
        style={styles.meetupTap}
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
        The name, and nothing else.

        The place and the description sat under it until 2026-08-17 and made every row three lines
        deep, so a week with a meetup on each day was a wall of prose. They are one tap away on the
        meetup's own screen, which is where somebody deciding whether to go actually reads them.
        `meetupHeadline` still owns the no-name fallback, so a club that only fills in a place
        keeps a headline rather than an empty row.
      */}
      <Text style={styles.headline} numberOfLines={1}>
        {meetupHeadline(meetup)}
      </Text>

      {/*
        The time, out of the circle and into its own chip.

        It is the thing scanned for down a week - "what is at six" - and it kept that job when the
        badge took the day. Tinted rather than filled, because a row can carry one loud thing and
        on today's row that is already the badge.
      */}
        <View style={styles.timeChip}>
          <Text style={styles.timeChipText}>{formatWallClock(meetup.time)}</Text>
        </View>
      </Pressable>

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
    </View>
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
   * **Required**, since the place stopped being collected on 2026-08-15 and something has to
   * identify a meetup. It leads because it is what the week and the calendar show as the headline,
   * and because it is what lets this belong to a club that is not a running club: "morning book
   * reading", "swim practice night".
   */
  const [title, setTitle] = useState(existing?.title ?? '');
  const [mapUrl, setMapUrl] = useState(existing?.mapUrl ?? '');
  /*
   * How to find the club once you are there, which is a different fact from the place and one a
   * map pin cannot say: "meet at the wooden archway; parking is tight, so carpool from the union".
   *
   * **It had no field at all until 2026-08-17**, though ADR-0037 specified it, the route accepted
   * it and the meetup's own screen drew it - so the only way to set one was to call the API by
   * hand, and `updateMeetup` is a whole-form save, so opening the composer on a meetup that had
   * one and pressing Save silently wiped it. See the whole-form note in `meetup-body.ts`.
   */
  const [locationNotes, setLocationNotes] = useState(existing?.locationNotes ?? '');
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
    /*
     * Built by `toMeetupBody`, which is a module of its own so the rule inside it can be tested:
     * this is a WHOLE-FORM save, so any field the form does not send is a field it erases. See
     * `meetup-body.ts`, and the regression it exists to hold.
     */
    const body = toMeetupBody({ when, title, description, locationNotes, mapUrl });
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

        {/*
          How to find the club once the link has got somebody to the right car park. Labelled for
          the same reason the link above it is: it sits in that section rather than opening one of
          its own, because both answer "where" and a heading over a single field names it twice.
        */}
        <ComposerField
          value={locationNotes}
          onChangeText={setLocationNotes}
          placeholder="How to find us once you are there"
          accessibilityLabel="Notes on how to find this place"
          multiline
        />

        {/* One note, at the end of its section. */}
        <SettingNote>
          Adding a meetup notifies nobody. Use Nudge on the week to tell the club.
        </SettingNote>

        <ComposerField
          value={description}
          onChangeText={setDescription}
          placeholder="Description"
          accessibilityLabel="A description of this meetup"
          multiline
          tall
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
  /*
    The row, and since 2026-09-02 the card.

    A bounded object beside the rail rather than a line of text on the page, and that is what let
    both rules go: the card's own edge separates one meetup from the next, and the rail carries
    the week. `hairline` is the token every other card in the product outlines itself with, and
    the one this screen had never spent.

    The padding is the card's now, so the row does not also carry its own - two sources of vertical
    padding is how one card ends up taller than the same card on another screen.
  */
  meetup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    backgroundColor: color.card,
    borderWidth: 1,
    borderColor: color.hairline,
    borderRadius: radius.md,
  },
  /*
    The part of the row that opens the meetup, which is everything except the bell.

    It takes the remaining width so the tap target is the whole row rather than the words - and
    being a sibling of the bell rather than its ancestor is what stops a button nesting inside a
    button. See the note on the row itself.
  */
  meetupTap: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.sm },
  /*
    The time, as a circle down the left of the week.
    Fixed width so every row's text starts on the same line, which is the whole reason the chip
    beats a prefix: a column of names is scannable and a column of "6:00 PM · " is not.
  */
  /*
    The day: its badge on the left, everything that day holds stacked to the right of it.

    **`alignItems: center` is what puts the badge beside the MIDDLE of the stack**, and it was
    `flex-start` until 2026-08-17. Pinned to the top, a day with two meetups drew its letter level
    with the first one and left the second hanging off nothing, which the founder reported as
    disoriented and which is exactly what it looked like. Centred, two meetups put the letter
    between them and three put it beside the second - the middle, in both cases, without the
    layout having to count anything.

    The vertical padding is the room asked for in the same breath. A week is seven rows and can
    afford to breathe; it read as a list crushed against itself.
  */
  /*
    **`alignItems` became `stretch` on 2026-09-02, and the centring moved rather than went.** The
    rail has to span the whole row, so the station beside it must stretch; `justifyContent` on the
    station is what now puts the badge at the middle of the stack. Everything the paragraph above
    describes still holds, and is still the reason a day with two meetups puts its letter between
    them - only the property doing it changed. Do not put `center` back here without moving the
    centring somewhere else first.

    **The vertical padding moved to the body in the same change.** Left on the row it sat outside
    the station, so the rail stopped short at each end and the week read as a dashed line.
  */
  day: { flexDirection: 'row', alignItems: 'stretch', gap: space.md },
  /*
    `justifyContent` centres "Nothing planned" against the badge on a day that holds nothing.

    The gap is `sm` rather than `xs` since the meetups became cards: two bordered objects four
    points apart read as one object with a line through it rather than as two.
  */
  dayBody: {
    flex: 1,
    justifyContent: 'center',
    minHeight: 46,
    gap: space.sm,
    paddingVertical: space.md,
  },
  /*
    The station: the badge, and the rail passing through it.

    Fixed width so every day's body starts on the same line, which is the reason the badge column
    is a column at all. The row stretches it, so it is as tall as the day it marks.
  */
  station: { width: 46, alignItems: 'center', justifyContent: 'center' },
  /*
    The rail, drawn as two segments meeting at the badge's centre.

    Two rather than one full-height line because the week has to stop at its ends: nothing above
    Monday's badge and nothing below Sunday's. A single rail on every day would run past both, and
    hiding it with a background would only work while the background is flat.

    **`hairline`, which is the colour the meetup cards outline themselves with**, so the rail and
    the card edges are one material and the whole structure reads as one system rather than as a
    line that happens to pass some boxes.

    It was `cardSunken` for about ten minutes and that was wrong for a reason only the running
    screen shows: `cardSunken` is also the fill of an EMPTY day's badge, so on the five quiet days
    of a normal week the badge and the rail were the same grey and the badge stopped reading as a
    station on a line - it read as a bulge in the rail. The warm hairline separates them at every
    badge weight: sunken grey, accent-soft, and solid accent.

    Drawn BEFORE the badge, so the badge paints over it. No `zIndex`, deliberately - on Android it
    holds until some ancestor gets an elevation, and source order does not.
  */
  rail: { position: 'absolute', width: 2, backgroundColor: color.hairline },
  railUp: { top: 0, bottom: '50%' },
  railDown: { top: '50%', bottom: 0 },
  /*
    The two rules this screen used to draw - a heavier one between days, a hairline between
    meetups inside one - are gone as of 2026-09-02, replaced by the rail and the card edge. They
    are not kept here for a caller that no longer exists: the reasoning they carried moved to
    `station` and `rail` above, and `DESIGN/14` rule 4b records the swap.
  */
  dayBadge: {
    width: 46,
    height: 46,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** Today: the one solid circle on the screen. */
  dayBadgeToday: { backgroundColor: color.accent },
  /** A day with something on it. */
  dayBadgeActive: { backgroundColor: color.accentSoft },
  /** A day with nothing on it: present, and plainly quieter. */
  dayBadgeEmpty: { backgroundColor: color.cardSunken },
  /*
    `headline` rather than `bodySmallStrong`: 17pt bold instead of 14.

    The letter is the only thing naming the day now that the headers are gone, and at the smaller
    size it read as a caption on the circle rather than as the circle's whole content - "so slim
    and tiny". A token step rather than a hand-set size, so it stays with the scale.
  */
  dayBadgeText: { ...type.headline },
  dayBadgeTextToday: { color: color.onAccent },
  dayBadgeTextActive: { color: color.onAccentSoft },
  dayBadgeTextEmpty: { color: color.textSecondary },
  headline: { ...type.headline, color: color.textPrimary, flex: 1 },
  /** The time, tinted rather than filled. One loud thing per row, and the badge already is one. */
  timeChip: {
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    borderRadius: radius.pill,
    backgroundColor: color.accentSoft,
  },
  timeChipText: { ...type.bodySmallStrong, color: color.onAccentSoft },
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
