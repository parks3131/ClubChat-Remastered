/**
 * Polls: **one implementation, three scopes.**
 *
 * Design-system rule 5, and the client half of the channel abstraction. The scope reaches this
 * component as two strings and changes nothing about how it behaves - if a `switch (scope)`ever
 * appears in here, the abstraction that survived intact through the whole server has been broken in
 * the client.
 *
 * The three rules worth knowing before changing anything:
 *
 *  1. **Counts are public, voter identity is gated, and a voter always sees their own vote.** So
 *     `voteCount` renders unconditionally, `voters === null` means "not allowed to see" rather than
 *     "nobody", and `votedByMe` comes from the server rather than from scanning a voter list this
 *     viewer may not have.
 *  2. **A passed deadline reads as closed with nobody having closed it.** There is no job that
 *     closes polls; the server evaluates it per read, so this screen never computes it. The
 *     countdown badge is display only and must never gate the vote control.
 *  3. **Only the creator closes, reopens or deletes** - including an admin who did not create it.
 *     `isCreator` is the flag, never a role.
 *
 * **Two surfaces, two references, and neither is v1's any more.** A poll being *read* is a
 * [content card](../content-card.tsx) - the eyebrow, the question, and option rows that are
 * themselves the tally bars. A poll being *made* is the composer below, built from
 * [the composer kit](../composer-kit.tsx): small type, sections separated by air, and the action
 * in the header. Both came from founder references on 2026-08-13.
 */

import type { ReactNode } from 'react';
import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { pollApi, type PollScope } from '../api.ts';
import type { PollSummary, PollView } from '../api-types.ts';
import { useSession } from '../chat-provider.tsx';
import { formatCountdown, formatInstant, fromDateKey, toDateKey } from '../dates.ts';
import { CardEyebrow, CardMeta, CardTitle, ContentCard } from '../content-card.tsx';
import {
  AddRow,
  ComposerField,
  HeaderAction,
  SectionLabel,
  SettingNote,
  SettingRow,
  SettingValue,
  Wheel,
} from '../composer-kit.tsx';
import { useReturnTo } from '../nav.tsx';
import { color, radius, space, type } from '../theme.ts';
import {
  Action,
  Avatar,
  Body,
  Card,
  ComposerHeader,
  ConfirmDialog,
  DataScreen,
  EmptyState,
  Fab,
  ScreenHeading,
  SectionHeader,
  Tabs,
  ThemedSwitch,
} from '../ui.tsx';
import { useLoad } from '../use-load.ts';

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 10;

/**
 * The gutter the eye sits in, at the right end of an option row.
 *
 * A shared number because two styles have to agree about it: the eye is absolutely positioned in
 * it, and the vote target reserves exactly this much padding so the count never slides under the
 * glyph. Written twice, the two drift and the collision reappears at some option count nobody
 * tested.
 */
const EYE_GUTTER = 40;

/**
 * The status pill, and the countdown beside it.
 *
 * Shared by the list card and the detail screen so the two can never disagree about what "closed"
 * looks like - which they would, being written twice, the moment one of them gained a state.
 */
function StatusRow({ closed, closesAt }: { closed: boolean; closesAt: string | null }) {
  return (
    <View style={styles.statusRow}>
      {closed ? (
        <View style={styles.closedPill}>
          <MaterialIcons name="lock" size={12} color={color.textPrimary} />
          <Text style={styles.closedPillLabel}>CLOSED</Text>
        </View>
      ) : (
        <View style={styles.activePill}>
          <Text style={styles.activePillLabel}>ACTIVE</Text>
        </View>
      )}
      {/* Only while it is still running: a countdown on a closed poll is noise. */}
      {!closed && closesAt !== null && (
        <View style={styles.countdownPill}>
          <MaterialIcons name="timer" size={12} color={color.onInverseSurface} />
          <Text style={styles.countdownLabel}>{formatCountdown(closesAt)}</Text>
        </View>
      )}
    </View>
  );
}

/**
 * The polls list for a scope.
 *
 * `PRD/15` gives this screen two tabs, ALL POLLS and MY VOTES, and the second is a filter over the
 * same read rather than a second request - the server already reports `votedByMe` per row.
 *
 * Ordering is open polls first, each group newest first. v1 arrived at this because a months-old
 * still-open poll should not bury yesterday's closed one, and it does it without section headers
 * the design does not have.
 */
export function PollsList({
  scope,
  scopeId,
  canCreate,
}: {
  scope: PollScope;
  scopeId: string;
  /** Club: any admin. Race: an admin ON the roster. Eboard: any member. Decided by the caller. */
  canCreate: boolean;
}) {
  const [tab, setTab] = useState<'all' | 'mine'>('all');
  /*
   * `?create=1` opens straight into the composer.
   *
   * Chat's "+" menu offers "Poll", and there is no separate create route to send it to - the
   * composer lives here. So the param is how chat asks for it, and it costs the sender one tap
   * rather than landing them on a list they then have to find the button on.
   *
   * Guarded by `canCreate` so the param cannot conjure a composer for somebody who may not use
   * it - a URL is user input, and this one arrives from a deep link as readily as from chat.
   */
  const { create, from } = useLocalSearchParams<{ create?: string; from?: string }>();
  const [composing, setComposing] = useState(create === '1' && canCreate);
  const load = useLoad(() => pollApi.list(scope, scopeId), [scope, scopeId]);
  const router = useRouter();
  const returnToSender = useReturnTo();

  /*
   * Where to go once the poll exists.
   *
   * Chat's "+" menu sends `from=/chat/:channelId`, and a poll made there belongs back there: the
   * creation posts its own card into that conversation, so the list is a detour past the thing
   * the member actually wanted to see.
   *
   * **Only an in-app chat path is honoured.** `from` arrives in a URL, and a URL is user input -
   * an unchecked one turns this into an open redirect that a deep link could point anywhere.
   */
  const returnTo = from?.startsWith('/chat/') === true ? from : null;

  /*
   * The composer owns the whole screen, header included.
   *
   * `(main)/_layout` gives every screen inside a club that club's avatar and name as its title,
   * which is right for a screen you are reading and wrong for one you are filling in: it leaves
   * two headers and two back arrows stacked, and the top one walks out of polls entirely rather
   * than back to the list.
   *
   * > **Rendered in both branches, driven by `composing`, and not only in the composing one.**
   *   `<Stack.Screen options>` is `navigation.setOptions` under the hood, so it MUTATES the
   *   route and does not roll back when the element unmounts. Setting `headerShown: false` on
   *   the way in and then simply not rendering it on the way out left the list with no header at
   *   all until the route was remounted. The option has to be stated in both directions.
   */
  const header = <Stack.Screen options={{ headerShown: !composing }} />;

  if (composing) {
    return (
      <>
        {header}
        <CreatePoll
          scope={scope}
          scopeId={scopeId}
          onCancel={() => {
            // Backing out of a composer opened from chat returns there too, empty-handed.
            if (returnTo !== null) returnToSender(returnTo);
            else setComposing(false);
          }}
          onCreated={() => {
            setComposing(false);
            if (returnTo !== null) {
              /*
               * UNWIND to the conversation rather than navigating to it. The composer was pushed
               * on top of it, so `replace` swapped the composer for a SECOND copy of the chat and
               * back then popped one to reveal the other - a back arrow that moved every time and
               * never changed the screen. See `useReturnTo`.
               */
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
      <ScreenHeading eyebrow="Community voice" title="Active conversations" />

      <View style={styles.tabsWrap}>
        <Tabs
          tabs={[
            { key: 'all', label: 'All polls' },
            { key: 'mine', label: 'My votes' },
          ]}
          active={tab}
          onChange={setTab}
        />
      </View>

      <DataScreen load={load}>
        {(data) => {
          const rows = tab === 'mine' ? data.polls.filter((poll) => poll.votedByMe) : data.polls;
          // Open first, then closed. Within each group the server's own newest-first order stands.
          const sorted = [...rows].sort((a, b) => Number(a.closed) - Number(b.closed));

          return sorted.length === 0 ? (
            <EmptyState
              title={tab === 'mine' ? 'You have not voted yet' : 'No polls yet'}
              body={
                tab === 'mine'
                  ? 'Polls you vote in appear here.'
                  : canCreate
                    ? 'Create one to ask everyone a question.'
                    : undefined
              }
            />
          ) : (
            <Body>
              {sorted.map((poll) => (
                <PollCard key={poll.id} poll={poll} />
              ))}
              {canCreate && <NewPollPrompt onPress={() => setComposing(true)} />}
            </Body>
          );
        }}
      </DataScreen>

      {canCreate && (
        <Fab onPress={() => setComposing(true)} accessibilityLabel="Create a poll" />
      )}
    </View>
  );
}

/** One row in the list. The whole card is the gesture, so nothing inside it is pressable. */
function PollCard({ poll }: { poll: PollSummary }) {
  const router = useRouter();

  return (
    <Pressable
      style={[styles.pollCard, poll.closed && styles.pollCardClosed]}
      onPress={() => router.push(`/polls/${poll.id}`)}
      accessibilityRole="button"
      accessibilityLabel={`${poll.question}. ${poll.voteCount} ${
        poll.voteCount === 1 ? 'vote' : 'votes'
      }. ${poll.closed ? 'Closed, view results' : 'Open, vote now'}`}
    >
      <StatusRow closed={poll.closed} closesAt={poll.closesAt} />

      <View style={styles.tallyRow}>
        <MaterialIcons
          name={poll.closed ? 'group' : 'poll'}
          size={18}
          color={poll.closed ? color.secondary : color.accentPressed}
        />
        <Text style={[styles.tallyLabel, poll.closed && styles.tallyLabelClosed]}>
          {poll.voteCount} VOTE{poll.voteCount === 1 ? '' : 'S'}
        </Text>
      </View>

      <Text style={styles.pollQuestion}>{poll.question}</Text>

      {/*
        A View rather than an `Action`: this is the card's own affordance, and a real button here
        would be a pressable inside a pressable - invalid on web and swallowing the outer gesture
        on native (failure mode 17).
      */}
      {poll.closed ? (
        <View style={styles.resultsCta}>
          <Text style={styles.resultsCtaLabel}>VIEW RESULTS</Text>
          <MaterialIcons name="assessment" size={16} color={color.textSecondary} />
        </View>
      ) : (
        <View style={styles.voteCta}>
          <Text style={styles.voteCtaLabel}>VOTE NOW</Text>
          <MaterialIcons name="chevron-right" size={18} color={color.onAccentPressed} />
        </View>
      )}
    </Pressable>
  );
}

/** v1's create prompt: the invitation that sits under the list, alongside the floating control. */
function NewPollPrompt({ onPress }: { onPress: () => void }) {
  return (
    <View style={styles.prompt}>
      <View style={styles.promptIcon}>
        <MaterialIcons name="add-chart" size={26} color={color.onAccent} />
      </View>
      <Text style={styles.promptTitle}>Have a new idea?</Text>
      <Text style={styles.promptBody}>
        Gather feedback from your teammates instantly. Create a poll to decide what is next.
      </Text>
      <Pressable
        style={styles.promptButton}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel="Create a poll"
      >
        <Text style={styles.promptButtonLabel}>CREATE POLL</Text>
      </Pressable>
    </View>
  );
}
/**
 * How long from now the deadline is, given the moment the composer is showing.
 *
 * **The wire still carries a duration, and that has not changed.** The server takes
 * `closesInMinutes` and computes the instant itself, so the only clock that decides when a poll
 * shuts is the one that writes the row. v1 sent an absolute `closesAt` from the device, which
 * makes the deadline depend on the handset agreeing with the server - a phone an hour fast
 * silently created a poll that closed an hour early.
 *
 * > **The picker in front of it went the other way on 2026-08-13.** Relative chips rather than a
 * > date and time picker had been "a decision confirmed with the founder before it was designed";
 * > he sent a reference with an absolute wheel and chose it over keeping the chips. So the screen
 * > now asks for a moment and this function turns it back into a duration.
 *
 * Both sides of the subtraction read the same clock, so a skewed phone still produces the right
 * *elapsed* time - the poll runs for as long as the member meant it to. What skew now costs is
 * that the wall-clock moment it closes at can differ from the label they picked, by however wrong
 * their phone is. That is the better of the two failures and worth stating plainly: the previous
 * one silently truncated the poll, this one lands it a little off a time nobody but the picker
 * ever sees.
 *
 * **Whole minutes, so the stored instant sits within 30 seconds of the one that was picked.**
 * Measured: a poll set for 10:15 was written as 10:15:15. The wheel's own granularity is five
 * minutes, so this is well inside what the control can express - but it is why the deadline is
 * not exactly the second on the label, and why nothing here should ever start displaying seconds.
 */
function minutesUntil(target: Date, now: number): number | null {
  const minutes = Math.round((target.getTime() - now) / 60_000);
  return minutes >= 1 ? minutes : null;
}

/** Minute granularity on the wheel. Five is v1's, and 60 rows of minutes is not a picker. */
const MINUTE_STEP = 5;
/** How far ahead a deadline can be set. A club decides things inside a season. */
const DAYS_AHEAD = 365;

/** The moment a `{ day, hour, minute }` selection names, built from components rather than parsed. */
function momentFrom(dateKey: string, hour: number, minute: number): Date {
  const date = fromDateKey(dateKey);
  date.setHours(hour, minute, 0, 0);
  return date;
}

/**
 * The composer.
 *
 * **Every control here maps to a column that already existed.** `allowMultiple`, `isPrivate` and
 * `closesAt` were in the schema and on the wire before this screen drew them, so the whole of
 * this is a client change - no migration, no new route.
 *
 * The shape is the founder's 2026-08-13 reference, in this app's tokens: small type, sections
 * separated by air rather than by cards, and the primary action in the header. That last one is
 * not only a look - the deadline wheel expands in place, and a trailing button would be pushed
 * off screen exactly when somebody is finishing the form.
 *
 * The back control lives in the screen rather than in a navigation header, because the composer
 * replaces the list inside one route - a header back button would leave polls entirely rather
 * than return to them.
 */
function CreatePoll({
  scope,
  scopeId,
  onCancel,
  onCreated,
}: {
  scope: PollScope;
  scopeId: string;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState<string[]>(['', '']);
  /** Null is "no deadline", which `PRD/11` rule 8 says a poll is allowed to have. */
  const [endsAt, setEndsAt] = useState<Date | null>(null);
  const [pickingEnd, setPickingEnd] = useState(false);
  const [multiple, setMultiple] = useState(false);
  const [isPrivate, setPrivate] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const filled = options.map((o) => o.trim()).filter((o) => o.length > 0);

  /*
   * The wheel's day column: today, then a year of days.
   *
   * Built once per render from `toDateKey`, which is the local-date rule this app already holds -
   * a day column assembled by adding 86,400,000 milliseconds a hundred times drifts across a
   * daylight-saving boundary and starts naming the wrong weekdays.
   */
  const today = new Date();
  const days = Array.from({ length: DAYS_AHEAD }, (_, offset) => {
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

  /*
   * What the wheel shows while it is open but nothing has been chosen: tomorrow, at this hour.
   *
   * A wheel that opens on "now" is a deadline that has already passed by the time anybody scrolls
   * it, and one that opens on nothing has no rows lit at all.
   */
  const shown = endsAt ?? momentFrom(days[1]?.key ?? days[0]!.key, today.getHours(), 0);

  const setPart = (part: { dateKey?: string; hour?: number; minute?: number }) => {
    setEndsAt(
      momentFrom(
        part.dateKey ?? toDateKey(shown),
        part.hour ?? shown.getHours(),
        part.minute ?? Math.floor(shown.getMinutes() / MINUTE_STEP) * MINUTE_STEP,
      ),
    );
  };

  /*
   * Parsed once and used for both the enabled state and the payload, so what the button offers
   * and what actually gets sent can never disagree.
   */
  const closesInMinutes = endsAt === null ? null : minutesUntil(endsAt, Date.now());
  /* A deadline in the past is the one way this form can be filled in and still be wrong. */
  const endHasPassed = endsAt !== null && closesInMinutes === null;
  const valid = question.trim().length > 0 && filled.length >= MIN_OPTIONS && !endHasPassed;

  const submit = async () => {
    setBusy(true);
    setFailed(null);
    try {
      await pollApi.create(scope, scopeId, {
        question: question.trim(),
        // `filled`, not `options`: a blank row between two answers is a typo, not an option.
        options: filled,
        allowMultiple: multiple,
        isPrivate,
        // Recomputed at the moment of sending rather than reused from the render that drew the
        // button, so a form left open for ten minutes does not shorten the poll by ten minutes.
        closesInMinutes: endsAt === null ? null : minutesUntil(endsAt, Date.now()),
      });
      onCreated();
    } catch {
      setFailed('Could not create the poll. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.flex}>
      <ComposerHeader
        title="New poll"
        discardLabel="Discard this poll and go back"
        onCancel={onCancel}
        dismiss="close"
        action={
          <HeaderAction
            label="Create"
            busyLabel="Creating"
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
            labelled "Question" above a box reading "What's your question?" says it twice. */}
        <ComposerField
          value={question}
          onChangeText={setQuestion}
          placeholder="What's your question?"
          accessibilityLabel="Poll question"
          filled
          multiline
        />

        <SectionLabel>Choices</SectionLabel>
        <View style={styles.choices}>
          {options.map((option, index) => (
            <ComposerField
              key={index}
              value={option}
              onChangeText={(next) =>
                setOptions((current) => current.map((o, i) => (i === index ? next : o)))
              }
              placeholder={`Choice ${index + 1}`}
              accessibilityLabel={`Option ${index + 1}`}
              trailing={
                /* Only past the minimum: removing down to one answer is not a poll. */
                options.length > MIN_OPTIONS ? (
                  <Pressable
                    onPress={() => setOptions((current) => current.filter((_, i) => i !== index))}
                    hitSlop={space.sm}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove option ${index + 1}`}
                  >
                    <MaterialIcons name="close" size={18} color={color.textSecondary} />
                  </Pressable>
                ) : null
              }
            />
          ))}

          {/* Two minimum, ten maximum. An eleventh cannot be added rather than being rejected later. */}
          {options.length < MAX_OPTIONS && (
            <AddRow label="Add more" onPress={() => setOptions((current) => [...current, ''])} />
          )}
        </View>

        <SectionLabel>Settings</SectionLabel>

        <SettingRow
          label="Ends"
          /*
            Opening COMMITS the default the wheel is showing.

            Without it the row read "No deadline" while the wheel underneath highlighted tomorrow
            at ten - the control contradicting its own value, which is the reading somebody would
            report as "it will not save the time". The way back out is the clear directly beneath
            the wheel, not a state where nothing is chosen and something looks chosen.
          */
          onPress={() => {
            if (pickingEnd) {
              setPickingEnd(false);
              return;
            }
            if (endsAt === null) setEndsAt(shown);
            setPickingEnd(true);
          }}
          accessibilityLabel={
            endsAt === null ? 'Ends: no deadline. Set one' : `Ends ${formatInstant(endsAt.toISOString())}. Change`
          }
        >
          <SettingValue muted={endsAt === null}>
            {endsAt === null ? 'No deadline' : formatInstant(endsAt.toISOString())}
          </SettingValue>
        </SettingRow>

        {/*
          In place, between the row it belongs to and the next one - the reference's arrangement,
          and the reason the Create action had to leave the foot of the form.
        */}
        {pickingEnd && (
          <>
            <Wheel
              columns={[
                {
                  key: 'day',
                  items: days,
                  selectedKey: toDateKey(shown),
                  onSelect: (key) => setPart({ dateKey: key }),
                  accessibilityLabel: 'Day the poll closes',
                  flex: 3,
                },
                {
                  key: 'hour',
                  items: hours,
                  selectedKey: String(shown.getHours()),
                  onSelect: (key) => setPart({ hour: Number(key) }),
                  accessibilityLabel: 'Hour the poll closes',
                  flex: 1,
                },
                {
                  key: 'minute',
                  items: minutes,
                  selectedKey: String(Math.floor(shown.getMinutes() / MINUTE_STEP) * MINUTE_STEP),
                  onSelect: (key) => setPart({ minute: Number(key) }),
                  accessibilityLabel: 'Minute the poll closes',
                  flex: 1,
                },
              ]}
            />
            {/* The way back to open-ended, which the reference has no need for and this app does. */}
            <Pressable
              style={styles.clearEnd}
              onPress={() => {
                setEndsAt(null);
                setPickingEnd(false);
              }}
              accessibilityRole="button"
              accessibilityLabel="Leave this poll open with no deadline"
            >
              <Text style={styles.clearEndLabel}>No deadline</Text>
            </Pressable>
          </>
        )}

        {endHasPassed && (
          <Text style={styles.composerError}>
            That time has already passed. Pick a later one, or clear the deadline.
          </Text>
        )}

        <SettingRow label="Multiple answers">
          <ThemedSwitch
            value={multiple}
            onValueChange={setMultiple}
            accessibilityLabel="Allow selecting multiple options"
          />
        </SettingRow>

        <SettingRow label="Private vote">
          <ThemedSwitch
            value={isPrivate}
            onValueChange={setPrivate}
            accessibilityLabel="Private vote"
          />
        </SettingRow>

        {/*
          One note for the section rather than a line under each row.

          "Only you" is literally true, and the second sentence is the half people get wrong:
          counts are public on every poll, including this one. See the read rules at the top of
          this file.
        */}
        <SettingNote>
          On a private poll only you can see who chose what. Vote counts are public either way.
        </SettingNote>

        {failed !== null && <Text style={styles.composerError}>{failed}</Text>}
      </ScrollView>
    </View>
  );
}

/**
 * A poll's status, question and votable options.
 *
 * Extracted so the **chat card and the detail screen are the same view**, rather than a full
 * screen and a condensed link-out that drift apart. v1 did the same, on an explicit founder
 * request that chat's poll bubble look and behave like the real thing; the remaster inherits both
 * the arrangement and the reason.
 *
 * Tapping an option is the only write: it casts, moves or withdraws depending on what is already
 * there, and the server decides which. Deciding here would be a read-then-write across the network
 * racing the other device the same member is holding.
 */
function PollBody({
  poll,
  busy,
  onVote,
  onSeeVoters,
}: {
  poll: PollView;
  busy: boolean;
  onVote: (optionId: string) => void;
  /** Present on the chat card, where each option carries its own eye rather than one button. */
  onSeeVoters?: (optionId: string) => void;
}) {
  const total = poll.options.reduce((sum, option) => sum + option.voteCount, 0);
  /*
    Whether this poll shows voters AT ALL, asked once for the whole card rather than per row.
    The eye's gutter is then reserved on every row, so the counts sit in a column instead of
    stepping in and out as options cross their first vote.
  */
  const showsVoters =
    onSeeVoters !== undefined && poll.options.some((option) => option.voters !== null);

  return (
    <>
      <CardEyebrow label="POLL" chip={poll.closed ? 'CLOSED' : null} />
      <CardTitle>{poll.question}</CardTitle>

      <View style={styles.options}>
        {poll.options.map((option) => {
          /*
            Share of the votes CAST, which is what the number beside it counts. On a multiple-
            choice poll the shares therefore still sum to 100 while exceeding the number of
            people who voted, and that is the honest reading of "12 of the 20 votes".
          */
          const share = total === 0 ? 0 : (option.voteCount / total) * 100;
          /*
            The eye, only where identities may be seen. `voters === null` is "not allowed to
            see", which is a different thing from nobody having voted - so the control is
            absent rather than opening an empty sheet.
          */
          const canSeeVoters =
            onSeeVoters !== undefined && option.voters !== null && option.voteCount > 0;

          return (
            /*
              A View wrapping two SIBLING pressables, never one inside the other.
              Voting and opening the voter list are different actions on the same row, and
              nesting their controls is failure mode 17: invalid on web, and on native the outer
              one swallows the inner. So the row owns the track and the two targets sit in it.
            */
            <View
              key={option.id}
              style={[
                styles.option,
                option.votedByMe && (poll.closed ? styles.optionChosenClosed : styles.optionChosen),
              ]}
            >
              <View
                style={[
                  styles.optionFill,
                  { width: `${share}%` },
                  poll.closed
                    ? styles.optionFillClosed
                    : option.votedByMe
                      ? styles.optionFillChosen
                      : null,
                ]}
              />
              <Pressable
                style={[styles.optionTap, showsVoters && styles.optionTapReserved]}
                disabled={poll.closed || busy}
                onPress={() => onVote(option.id)}
                accessibilityRole="button"
                accessibilityState={{ selected: option.votedByMe, disabled: poll.closed }}
                accessibilityLabel={
                  poll.closed
                    ? `${option.label}, ${option.voteCount} votes, poll closed`
                    : option.votedByMe
                      ? `Withdraw your vote for ${option.label}`
                      : `Vote for ${option.label}`
                }
              >
                {/* No tick beside the label: the accent ring around the row is what says "yours",
                    and a glyph that shifts the text as it appears is a second signal doing the
                    first one's job. The selected state still reaches a screen reader above. */}
                <Text style={styles.optionLabel} numberOfLines={2}>
                  {option.label}
                </Text>
                {/* Public on every poll, including one whose voters are hidden. */}
                <Text style={styles.optionCount}>{option.voteCount}</Text>
              </Pressable>

              {canSeeVoters && (
                <Pressable
                  style={styles.optionEye}
                  onPress={() => onSeeVoters(option.id)}
                  accessibilityRole="button"
                  accessibilityLabel={`See who voted for ${option.label}`}
                >
                  <MaterialIcons name="visibility" size={18} color={color.textSecondary} />
                </Pressable>
              )}
            </View>
          );
        })}
      </View>

      {/*
        Everything about the poll that is not the question, on one quiet line under it.

        Only what is remarkable: single choice is the assumption a reader already holds, so saying
        it costs a line and adds nothing, while "multiple choice" and "private" change how the
        thing works. The parts go in unjoined so an absent one leaves no stranded separator.

        **No creator here.** Who asked the question is said once, by the avatar and name above the
        card, and a card that repeats it is saying the same thing twice in one glance.
      */}
      <CardMeta
        parts={[
          `${total} ${total === 1 ? 'vote' : 'votes'}`,
          poll.allowMultiple ? 'multiple choice' : null,
          poll.isPrivate ? 'private' : null,
          poll.closesAt === null
            ? null
            : `${poll.closed ? 'closed' : 'closes'} ${formatInstant(poll.closesAt)}`,
        ]}
      />
    </>
  );
}

/**
 * The poll card that sits in chat, for a `card` message carrying a `linkedPollId`.
 *
 * **It votes in place.** A poll created from chat posts itself here, and making the reader leave
 * the conversation to answer it is most of the reason the card exists at all.
 *
 * The poll is fetched by id rather than carried on the message, because the tally moves after the
 * card is written and a copy would be stale by the first vote. That the read is authorized is the
 * other half: a member who may not see this poll gets nothing back, and the card renders as its
 * sentence alone rather than leaking a question through chat.
 */
export function ChatPollCard({
  pollId,
  fallback = null,
}: {
  pollId: string;
  /**
   * What to draw when the poll cannot be drawn - the message's own sentence.
   *
   * > **Returning `null` here used to make the whole message vanish.** The comment below said a
   * > pending or failed read should "leave the message reading as it did before cards existed",
   * > and that was never true: the chat screen suppresses the body sentence for ANY message
   * > carrying a linked id, whether or not the card actually rendered. So a card that could not
   * > load left an empty bubble - invisible in the conversation, while the unread count still
   * > counted it. Reported as "the notification says something is in the chat but nothing is".
   *
   * The caller passes the sentence because only it knows whether this is the reader's own bubble
   * and which text style that implies.
   */
  fallback?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [votersFor, setVotersFor] = useState<string | null>(null);
  /*
   * Re-read whenever anything in the session changes, which is what makes this card current.
   *
   * The creator's Close and Delete moved into the hold sheet on 2026-08-13, and the sheet has no
   * way to reach into this component - so it calls `notifyChanged` after its write lands and this
   * follows, exactly as the badge does. `revision` is the door `chat-provider` documents for
   * writes the socket raises no frame for.
   *
   * It also bumps on every socket event, which means a tally now moves when SOMEBODY ELSE votes
   * rather than only when you do. That is a gain rather than a cost of the arrangement, and the
   * traffic it implies is one small authorized read per visible poll card - and a conversation
   * rarely has more than one.
   */
  const { revision } = useSession();
  const load = useLoad(() => pollApi.detail(pollId), [pollId, revision]);

  const vote = async (optionId: string) => {
    setBusy(true);
    try {
      await pollApi.vote(optionId);
    } finally {
      load.reload();
      setBusy(false);
    }
  };

  // No spinner and no error text: this is a bubble in a conversation, so a failed or pending read
  // falls back to the message's own sentence rather than shouting in the log - or vanishing.
  if (load.data === null) return <>{fallback}</>;
  const poll = load.data.poll;

  /*
   * A View, never a Pressable.
   *
   * **Failure mode 17: a pressable inside a pressable.** Every option in `PollBody` is its own
   * button, so wrapping the card in one nests them - invalid HTML on web, where React logs
   * "<button> cannot contain a nested <button>", and on native the outer press swallows the
   * gesture so tapping an option votes for nothing. The card needs no press target of its own
   * anyway: voting in place is the whole point of it, and the sentence above it is the link.
   */
  return (
    <ContentCard>
      <PollBody
        poll={poll}
        busy={busy}
        onVote={(id) => void vote(id)}
        onSeeVoters={setVotersFor}
      />

      {/*
        No creator controls here.

        > **They were two filled buttons at the foot of the card** - Close Poll in the accent and
        > Delete in the danger colour - which made a member's own poll the loudest object in the
        > conversation, under content that is deliberately quiet grey bars. They moved into the
        > hold sheet on 2026-08-13: holding a card already opens the react-and-report menu, so the
        > same gesture that reports somebody else's card manages your own.

        This is what `PRD/11` rule 11 asked for all along - the card holds what it can act on
        inline, and the creator's close, reopen and delete are reached another way. The rule named
        a "View Poll" link because the hold sheet did not exist when it was written; it now names
        the sheet, and the card is purely the poll.
      */}
      {votersFor !== null && (
        <VoterSheet
          poll={poll}
          optionId={votersFor}
          onPick={setVotersFor}
          onDismiss={() => setVotersFor(null)}
        />
      )}
    </ContentCard>
  );
}

/**
 * One poll, with inline voting.
 *
 * **Opening the voter list casts nothing** - it is the same read that drew the screen.
 */
export function PollDetail({ pollId }: { pollId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [votersFor, setVotersFor] = useState<string | null>(null);
  const load = useLoad(() => pollApi.detail(pollId), [pollId]);

  const vote = async (optionId: string) => {
    setBusy(true);
    try {
      await pollApi.vote(optionId);
      load.reload();
    } catch {
      load.reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <DataScreen load={load}>
      {(data) => {
        const poll = data.poll;

        return (
          <View style={styles.flex}>
            <Body>
              {/*
                `onSeeVoters` on the screen too, so the eye is per OPTION in both places.

                > It used to be a single "See who voted" button under the card, which opened the
                > sheet on whichever option happened to be first and left the reader to change it
                > inside. `PRD/11` rule 5 asks for a control on the option, and the card already
                > had one - so the screen was the odd one out, and the two renderings of one read
                > disagreed about how you reach the same list.
              */}
              <PollBody
                poll={poll}
                busy={busy}
                onVote={(id) => void vote(id)}
                onSeeVoters={setVotersFor}
              />

              {/*
                Null is "you may not see this", which is a different thing from nobody having
                voted - so the eyes are absent and the screen says why, rather than leaving a
                reader to wonder whether the poll simply has no votes yet.
              */}
              {!poll.options.some((option) => option.voters !== null) && (
                <Text style={styles.meta}>
                  This is a private vote. Only its creator can see who chose what.
                </Text>
              )}

              {/* Creator only, in every scope - including an admin who did not create it. */}
              {poll.isCreator && (
                <>
                  <SectionHeader title="Yours to manage" />
                  <Action
                    label={poll.closed ? 'Reopen poll' : 'Close poll'}
                    variant="secondary"
                    onPress={() => {
                      void pollApi.setClosed(pollId, !poll.closed).then(load.reload, load.reload);
                    }}
                  />
                  <DeletePoll
                    pollId={pollId}
                    question={poll.question}
                    onDeleted={() => router.back()}
                  />
                </>
              )}
            </Body>

            {votersFor !== null && (
              <VoterSheet
                poll={poll}
                optionId={votersFor}
                onPick={setVotersFor}
                onDismiss={() => setVotersFor(null)}
              />
            )}
          </View>
        );
      }}
    </DataScreen>
  );
}

/**
 * Who voted, one option at a time.
 *
 * v1 opens a sheet with an option picker at the top rather than a list per option inline, because
 * a poll with eight options would otherwise push the vote controls off the screen. The names are
 * already in hand from the read that drew the screen - opening this fetches nothing and, crucially,
 * casts nothing.
 */
function VoterSheet({
  poll,
  optionId,
  onPick,
  onDismiss,
}: {
  poll: PollView;
  optionId: string;
  onPick: (id: string) => void;
  onDismiss: () => void;
}) {
  const [open, setOpen] = useState(false);
  const chosen = poll.options.find((option) => option.id === optionId) ?? poll.options[0];
  const voters = chosen?.voters ?? null;

  /*
   * A Modal, so the sheet escapes whatever drew it.
   *
   * `sheetBackdrop` is absolutely positioned, which fills the SCREEN from the detail screen and
   * fills a chat bubble from the poll card - so opening voters from a card produced a sheet
   * squeezed inside the bubble. A modal has no parent to be trapped by. v1 uses one for the same
   * reason.
   */
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onDismiss}>
      <View style={styles.sheetBackdrop}>
        <Pressable
          style={styles.sheetScrim}
          onPress={onDismiss}
          accessibilityRole="button"
          accessibilityLabel="Close"
        />
      <View style={styles.sheet}>
        <View style={styles.sheetHead}>
          <Text style={styles.sheetTitle}>Voters</Text>
          <Pressable
            onPress={onDismiss}
            hitSlop={space.sm}
            accessibilityRole="button"
            accessibilityLabel="Close"
          >
            <MaterialIcons name="close" size={22} color={color.textPrimary} />
          </Pressable>
        </View>

        {/*
          v1's control exactly: a collapsed row naming the option you are looking at, which
          expands into every option with its count. A horizontal chip rail was here before and
          is not what shipped - with long option labels it scrolls sideways and hides the ones
          off-screen, which is the opposite of a picker.
        */}
        <Pressable
          style={styles.dropdownHead}
          onPress={() => setOpen((v) => !v)}
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          accessibilityLabel={`Showing voters for ${chosen?.label ?? ''}. Change option`}
        >
          <Text style={styles.dropdownHeadLabel}>{chosen?.label ?? ''}</Text>
          <MaterialIcons
            name={open ? 'arrow-drop-up' : 'arrow-drop-down'}
            size={22}
            color={color.textPrimary}
          />
        </Pressable>

        {open && (
          <View style={styles.dropdownList}>
            {poll.options.map((option) => (
              <Pressable
                key={option.id}
                style={styles.dropdownItem}
                onPress={() => {
                  onPick(option.id);
                  setOpen(false);
                }}
                accessibilityRole="button"
                accessibilityState={{ selected: option.id === optionId }}
                accessibilityLabel={`${option.label}, ${option.voteCount} votes`}
              >
                <Text style={styles.dropdownItemLabel}>{option.label}</Text>
                <Text style={styles.dropdownItemCount}>{option.voteCount}</Text>
              </Pressable>
            ))}
          </View>
        )}

        <ScrollView style={styles.sheetList}>
          {voters === null ? (
            <Text style={styles.meta}>Voters are hidden on this poll.</Text>
          ) : voters.length === 0 ? (
            <Text style={styles.meta}>No votes for this option yet.</Text>
          ) : (
            voters.map((voter) => (
              <View key={voter.userId} style={styles.voterRow}>
                <Avatar name={voter.name} image={voter.image} size={32} />
                <Text style={styles.voterName}>{voter.name}</Text>
              </View>
            ))
          )}
        </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function DeletePoll({
  pollId,
  question,
  onDeleted,
}: {
  pollId: string;
  question: string;
  onDeleted: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <Action
        label="Delete poll"
        variant="danger"
        onPress={() => setConfirming(true)}
        accessibilityLabel={`Delete the poll "${question}"`}
      />
    );
  }

  return (
    <Card>
      {/* Names the thing and states what is lost. */}
      <Text style={styles.meta}>
        Delete "{question}"? Every vote goes with it, and its card disappears from chat.
      </Text>
      <View style={styles.actions}>
        <Action
          label="Keep"
          variant="secondary"
          style={styles.actionButton}
          onPress={() => setConfirming(false)}
        />
        <Action
          label="Delete"
          variant="danger"
          style={styles.actionButton}
          onPress={() => {
            void pollApi.remove(pollId).then(onDeleted, onDeleted);
          }}
        />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: color.appBackground },
  tabsWrap: { padding: space.md, paddingBottom: 0 },
  meta: { ...type.bodySmall, color: color.textSecondary },
  error: { ...type.bodySmall, color: color.error },
  actions: { flexDirection: 'row', gap: space.sm },
  actionButton: { flex: 1 },

  // -------------------------------------------------------------------------
  // The composer. The founder's 2026-08-13 reference, in this app's tokens.
  // -------------------------------------------------------------------------
  /*
    No `gap`, deliberately. The spacing here is the design: a section label carries its own air
    above it, and one uniform gap between every element is what made the old composer read as a
    stack of cards rather than as a form with sections.
  */
  composerBody: { padding: space.md, paddingBottom: space.xl },
  choices: { gap: space.sm },
  clearEnd: { alignSelf: 'center', paddingVertical: space.sm, paddingHorizontal: space.md },
  clearEndLabel: { ...type.label, color: color.accent },
  /* Uppercased in style rather than in the string, so the label stays readable to a screen reader. */
  composerError: { ...type.bodySmall, color: color.error, textAlign: 'center' },






  optionTap: {
    /*
      **`zIndex` is load-bearing, and only on web.** An absolutely positioned sibling paints above
      a statically positioned one in CSS regardless of source order, so without this the fill
      covers the label in a browser and nowhere else - the shape of failure mode 6, where the
      whole suite and the device both pass.
    */
    zIndex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    // Comfortably over the 44pt minimum, since the row is now the whole target.
    minHeight: 44,
  },
  /* Reserved for every row of a poll that shows voters at all, so the counts stay in a column. */
  optionTapReserved: { paddingRight: EYE_GUTTER },
  optionEye: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    width: EYE_GUTTER,
    zIndex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chatPollActions: { flexDirection: 'row', gap: space.sm },
  chatPollAction: { flex: 1 },
  dropdownHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: color.cardSunken,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
  },
  dropdownHeadLabel: { ...type.body, color: color.textPrimary },
  dropdownList: {
    borderWidth: 1,
    borderColor: color.hairline,
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  dropdownItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
    borderBottomWidth: 1,
    borderBottomColor: color.hairline,
  },
  dropdownItemLabel: { ...type.body, color: color.textPrimary },
  dropdownItemCount: { ...type.bodySmall, color: color.accent },

  statusRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  activePill: {
    backgroundColor: color.accent,
    borderRadius: radius.xs,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
  },
  activePillLabel: { ...type.label, fontSize: 10, color: color.onAccent },
  closedPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    backgroundColor: color.cardSunken,
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
  },
  closedPillLabel: { ...type.label, fontSize: 10, color: color.textPrimary },
  countdownPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    backgroundColor: color.inverseSurface,
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
  },
  countdownLabel: { ...type.label, fontSize: 10, color: color.onInverseSurface },

  pollCard: {
    backgroundColor: color.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.hairline,
    padding: space.md,
    gap: space.sm,
  },
  pollCardClosed: { backgroundColor: color.chrome },
  tallyRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs + 2 },
  tallyLabel: { ...type.numeric, fontSize: 15, color: color.textSecondary },
  tallyLabelClosed: { color: color.secondary },
  pollQuestion: { ...type.title, fontSize: 20, lineHeight: 26, color: color.textPrimary },
  voteCta: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: space.xs + 2,
    backgroundColor: color.accentPressed,
    borderRadius: radius.md,
    paddingVertical: space.sm + 4,
    marginTop: space.xs,
  },
  voteCtaLabel: { ...type.label, fontSize: 13, color: color.onAccentPressed },
  resultsCta: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: space.xs + 2,
    borderWidth: 2,
    borderColor: color.border,
    borderRadius: radius.md,
    paddingVertical: space.sm + 2,
    marginTop: space.xs,
  },
  resultsCtaLabel: { ...type.label, fontSize: 13, color: color.textSecondary },

  prompt: {
    marginTop: space.sm,
    backgroundColor: color.accentSoft,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.hairline,
    padding: space.lg,
    alignItems: 'center',
    gap: space.sm,
  },
  promptIcon: {
    width: 52,
    height: 52,
    borderRadius: radius.md,
    backgroundColor: color.accent,
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ rotate: '3deg' }],
  },
  promptTitle: { ...type.title, fontSize: 18, lineHeight: 24, color: color.accent },
  promptBody: { ...type.bodySmall, color: color.textSecondary, textAlign: 'center' },
  promptButton: {
    backgroundColor: color.textPrimary,
    borderRadius: radius.pill,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm + 4,
  },
  promptButtonLabel: { ...type.label, fontSize: 13, color: color.appBackground },

  detailQuestion: { ...type.title, color: color.textPrimary },
  options: { gap: space.sm },
  /*
    **The row IS the bar.** A track holding a proportional fill, with the label and the count
    sitting on top of it - rather than a label line with a thin 6pt bar underneath, which is what
    this was until 2026-08-13. One object per option instead of two, and the tally is readable at
    a glance down the card because every row is the same shape.
  */
  option: {
    position: 'relative',
    justifyContent: 'center',
    backgroundColor: color.cardRaised,
    borderRadius: radius.md,
    // Clips the fill to the rounded corners. Without it the fill squares off the row's left edge.
    overflow: 'hidden',
    /*
      Present and track-coloured rather than absent, so choosing an option changes a colour and
      never a height. A border that appears on selection moves every row below it by 4pt.
    */
    borderWidth: 2,
    borderColor: color.cardRaised,
  },
  optionChosen: { borderColor: color.accent },
  /* Still legible as your vote once the poll is closed, but no longer the loudest thing on it. */
  optionChosenClosed: { borderColor: color.accentSoftBorder },
  optionFill: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: color.accentSoft },
  optionFillChosen: { backgroundColor: color.accentSoftBorder },
  /* Muted, per `PRD/11` rule 14. The tally is still the point of a closed poll, so it greys rather
     than disappears. */
  optionFillClosed: { backgroundColor: color.fallback },
  optionLabel: { ...type.body, color: color.textPrimary, flexShrink: 1 },
  optionCount: { ...type.body, color: color.textSecondary },

  sheetBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    // Centred, which is what v1 draws: a card floating over the conversation rather than a
    // bottom sheet clinging to the composer.
    justifyContent: 'center',
    alignItems: 'center',
    padding: space.md,
    zIndex: 100,
  },
  sheetScrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  sheet: {
    // Rounded on all four corners now that it floats in the middle rather than rising from the
    // bottom edge, and width-bounded so it does not stretch edge to edge on a tablet.
    backgroundColor: color.card,
    borderRadius: radius.xl,
    padding: space.md,
    width: '100%',
    maxWidth: 460,
    maxHeight: '70%',
    gap: space.sm,
  },
  sheetHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: space.sm,
  },
  sheetTitle: { ...type.title, fontSize: 18, lineHeight: 24, color: color.textPrimary },
  sheetPicker: { flexGrow: 0, marginBottom: space.sm },
  pickerChip: {
    backgroundColor: color.cardSunken,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: space.xs + 2,
    marginRight: space.sm,
  },
  pickerChipActive: { backgroundColor: color.accentSoft },
  pickerChipLabel: { ...type.label, color: color.textSecondary, textTransform: 'none' },
  pickerChipLabelActive: { color: color.onAccentSoft },
  sheetList: { marginTop: space.xs },
  voterRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm + 4, paddingVertical: space.xs + 2 },
  voterName: { ...type.body, color: color.textPrimary },
});
