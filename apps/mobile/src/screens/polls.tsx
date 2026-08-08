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
 * The look is v1's: a status pill and countdown on top, the vote tally, the question at headline
 * weight, and a single full-width call to action whose wording changes with the state.
 */

import type { ReactNode } from 'react';
import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { pollApi, type PollScope } from '../api.ts';
import type { PollSummary, PollView } from '../api-types.ts';
import { formatCountdown, formatInstant } from '../dates.ts';
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
 * The Ends chips, and the units behind Custom. Both are v1's, verbatim.
 *
 * Everything is expressed in **minutes** because the server takes `closesInMinutes` and computes
 * the instant itself. v1 sent an absolute `closesAt` computed on the device, which makes the
 * deadline depend on the phone's clock agreeing with the server's - a handset an hour fast
 * silently creates a poll that closes an hour early. The duration crosses the wire instead, and
 * the only clock that matters is the one that writes the row.
 *
 * > v1's own note on why this section exists at all is worth keeping: the Stitch create-poll
 * > mockup had no deadline field, and relative duration chips rather than an absolute date and
 * > time picker was a decision confirmed with the founder before it was designed.
 */
const ENDS_CHIPS = [
  { key: 'none', label: 'No deadline', minutes: null },
  { key: '1d', label: '1 Day', minutes: 24 * 60 },
  { key: '3d', label: '3 Days', minutes: 3 * 24 * 60 },
  { key: '1w', label: '1 Week', minutes: 7 * 24 * 60 },
  { key: 'custom', label: 'Custom', minutes: null },
] as const;

type EndsChoice = (typeof ENDS_CHIPS)[number]['key'];

const CUSTOM_UNITS = [
  { key: 'minutes', label: 'Min', minutes: 1 },
  { key: 'hours', label: 'Hrs', minutes: 60 },
  { key: 'days', label: 'Days', minutes: 24 * 60 },
] as const;

type CustomUnit = (typeof CUSTOM_UNITS)[number]['key'];

/**
 * The composer, in v1's shape: four cards, then the call to action.
 *
 * **Every control here maps to a column that already existed.** `allowMultiple`, `isPrivate` and
 * `closesAt` were in the schema and on the wire before this screen drew them, so the whole of
 * this is a client change - no migration, no new route.
 *
 * Two deliberate departures from v1's file, both for reasons that outlive the look:
 *
 *  1. **The deadline goes over the wire as a duration, not a date.** See `ENDS_CHIPS`.
 *  2. **The back control lives in the screen.** v1 had a create route of its own and leaned on the
 *     navigation header; here the composer replaces the list inside one route, so a header back
 *     button would leave polls entirely rather than return to them.
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
  const [ends, setEnds] = useState<EndsChoice>('none');
  const [customAmount, setCustomAmount] = useState('');
  const [customUnit, setCustomUnit] = useState<CustomUnit>('hours');
  const [multiple, setMultiple] = useState(false);
  const [isPrivate, setPrivate] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const filled = options.map((o) => o.trim()).filter((o) => o.length > 0);

  /*
   * Parsed once and used for both the enabled state and the payload, so what the button says is
   * possible and what actually gets sent can never disagree.
   */
  const amount = Number(customAmount);
  const customValid = Number.isInteger(amount) && amount >= 1;

  const valid =
    question.trim().length > 0 && filled.length >= MIN_OPTIONS && (ends !== 'custom' || customValid);

  const closesInMinutes =
    ends === 'custom'
      ? customValid
        ? amount * (CUSTOM_UNITS.find((u) => u.key === customUnit)?.minutes ?? 60)
        : null
      : (ENDS_CHIPS.find((c) => c.key === ends)?.minutes ?? null);

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
        closesInMinutes,
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
      />

      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.composerBody}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.composerCard}>
          <Text style={styles.composerLabel}>Question</Text>
          <TextInput
            style={styles.questionInput}
            value={question}
            onChangeText={setQuestion}
            placeholder="What should we do for the team social?"
            placeholderTextColor={color.textSecondary}
            multiline
            accessibilityLabel="Poll question"
          />
        </View>

        <View style={styles.composerCard}>
          <View style={styles.composerCardHead}>
            <Text style={styles.composerCardTitle}>Options</Text>
            {/* Counts what would actually be sent, so a blank row never inflates it. */}
            <Text style={styles.optionsCount}>{filled.length} Options Added</Text>
          </View>

          {options.map((option, index) => (
            <View key={index} style={styles.optionRow}>
              <TextInput
                style={styles.optionInput}
                value={option}
                onChangeText={(next) =>
                  setOptions((current) => current.map((o, i) => (i === index ? next : o)))
                }
                placeholder={`Option ${index + 1}`}
                placeholderTextColor={color.textSecondary}
                accessibilityLabel={`Option ${index + 1}`}
              />
              {/* Only past the minimum: removing down to one answer is not a poll. */}
              {options.length > MIN_OPTIONS && (
                <Pressable
                  style={styles.removeOption}
                  onPress={() => setOptions((current) => current.filter((_, i) => i !== index))}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove option ${index + 1}`}
                >
                  <MaterialIcons name="close" size={16} color={color.onErrorContainer} />
                </Pressable>
              )}
            </View>
          ))}

          {/* Two minimum, ten maximum. An eleventh cannot be added rather than being rejected later. */}
          {options.length < MAX_OPTIONS && (
            <Pressable
              onPress={() => setOptions((current) => [...current, ''])}
              style={styles.addOption}
              accessibilityRole="button"
              accessibilityLabel="Add another option"
            >
              <Text style={styles.addOptionLabel}>+ ADD OPTION</Text>
            </Pressable>
          )}
        </View>

        <View style={styles.composerCard}>
          <Text style={styles.composerCardTitle}>Ends</Text>
          <View style={styles.chipRow}>
            {ENDS_CHIPS.map((chip) => {
              const on = ends === chip.key;
              return (
                <Pressable
                  key={chip.key}
                  onPress={() => setEnds(chip.key)}
                  style={[styles.chip, on && styles.chipOn]}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={`Ends: ${chip.label}`}
                >
                  <Text style={[styles.chipLabel, on && styles.chipLabelOn]}>{chip.label}</Text>
                </Pressable>
              );
            })}
          </View>

          {/*
            Revealed rather than always present: a field that only matters under one chip is
            noise under the other four.
          */}
          {ends === 'custom' && (
            <View style={styles.customRow}>
              <TextInput
                style={styles.customInput}
                value={customAmount}
                onChangeText={setCustomAmount}
                placeholder="30"
                placeholderTextColor={color.textSecondary}
                keyboardType="number-pad"
                accessibilityLabel="How long until this poll closes"
              />
              <View style={styles.unitRow}>
                {CUSTOM_UNITS.map((unit) => {
                  const on = customUnit === unit.key;
                  return (
                    <Pressable
                      key={unit.key}
                      onPress={() => setCustomUnit(unit.key)}
                      style={[styles.unitChip, on && styles.chipOn]}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: on }}
                      accessibilityLabel={unit.label}
                    >
                      <Text style={[styles.chipLabel, on && styles.chipLabelOn]}>{unit.label}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          )}
        </View>

        <View style={styles.composerCard}>
          <Text style={styles.composerCardTitle}>Poll Settings</Text>
          <Setting
            title="Allow selecting multiple options"
            body="Voters can pick more than one choice"
            on={multiple}
            onChange={setMultiple}
          />
          <View style={styles.settingDivider} />
          {/*
            "Only you" is literally true: counts stay public on a private poll, and its creator is
            the only person who may see identities. See the read rules at the top of this file.
          */}
          <Setting
            title="Private vote"
            body="Only you can see who voted for each option"
            on={isPrivate}
            onChange={setPrivate}
          />
        </View>

        {failed !== null && <Text style={styles.composerError}>{failed}</Text>}

        <Pressable
          style={[styles.createButton, (!valid || busy) && styles.createButtonOff]}
          disabled={!valid || busy}
          onPress={() => void submit()}
          accessibilityRole="button"
          accessibilityLabel="Create poll"
          accessibilityState={{ disabled: !valid || busy }}
        >
          <Text style={styles.createButtonLabel}>{busy ? 'CREATING' : 'CREATE POLL'}</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

/** One settings row: what it does, what that means, and the switch. */
function Setting({
  title,
  body,
  on,
  onChange,
}: {
  title: string;
  body: string;
  on: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <View style={styles.setting}>
      <View style={styles.settingText}>
        <Text style={styles.settingTitle}>{title}</Text>
        <Text style={styles.settingBody}>{body}</Text>
      </View>
      <ThemedSwitch value={on} onValueChange={onChange} accessibilityLabel={title} />
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
  byline,
  onSeeVoters,
}: {
  poll: PollView;
  busy: boolean;
  onVote: (optionId: string) => void;
  /** "Created by X", on the chat card. The detail screen has the header for that job. */
  byline?: string | null;
  /** Present on the chat card, where each option carries its own eye rather than one button. */
  onSeeVoters?: (optionId: string) => void;
}) {
  const total = poll.options.reduce((sum, option) => sum + option.voteCount, 0);

  return (
    <>
      <StatusRow closed={poll.closed} closesAt={poll.closesAt} />
      <Text style={styles.detailQuestion}>{poll.question}</Text>
      <Text style={styles.meta}>
        {byline != null && byline.length > 0 ? `Created by ${byline}  ·  ` : ''}
        {poll.allowMultiple ? 'Multiple choice' : 'Single choice'}
        {poll.isPrivate ? '  ·  Private vote' : ''}
        {poll.closesAt !== null
          ? `  ·  ${poll.closed ? 'Closed' : 'Closes'} ${formatInstant(poll.closesAt)}`
          : ''}
      </Text>

      <View style={styles.options}>
        {poll.options.map((option) => (
          /*
            A View wrapping two SIBLING pressables, never one inside the other.
            Voting and opening the voter list are different actions on the same row, and
            nesting their controls is failure mode 17: invalid on web, and on native the outer
            one swallows the inner. So the row owns the border and the two targets sit in it.
          */
          <View
            key={option.id}
            style={[styles.option, option.votedByMe && styles.optionChosen]}
          >
            <Pressable
              style={styles.optionTap}
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
              <View style={styles.optionHead}>
                <Text style={styles.optionLabel}>
                  {option.votedByMe ? '✓  ' : ''}
                  {option.label}
                </Text>
                {/* Public on every poll, including one whose voters are hidden. */}
                <Text style={styles.optionCount}>{option.voteCount}</Text>
              </View>
              <View style={styles.barTrack}>
                <View
                  style={[
                    styles.barFill,
                    { width: total === 0 ? 0 : `${(option.voteCount / total) * 100}%` },
                  ]}
                />
              </View>
            </Pressable>

            {/*
              The eye, only where identities may be seen. `voters === null` is "not allowed to
              see", which is a different thing from nobody having voted - so the control is
              absent rather than opening an empty sheet.
            */}
            {onSeeVoters !== undefined && option.voters !== null && option.voteCount > 0 && (
              <Pressable
                style={styles.optionEye}
                onPress={() => onSeeVoters(option.id)}
                /*
                  A 16pt glyph in `xs` padding is a ~24pt target, well under the 44pt minimum, and
                  it sits directly beside the option row - so a miss does not do nothing, it casts
                  or withdraws a vote. Slop rather than padding, because widening the control
                  itself would push the vote bar in.
                */
                hitSlop={space.md}
                accessibilityRole="button"
                accessibilityLabel={`See who voted for ${option.label}`}
              >
                <MaterialIcons name="visibility" size={16} color={color.textSecondary} />
              </Pressable>
            )}
          </View>
        ))}
      </View>
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
  authorName,
  fallback = null,
}: {
  pollId: string;
  authorName: string | null;
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
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const load = useLoad(() => pollApi.detail(pollId), [pollId]);

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
    <View style={styles.chatPollCard}>
      <PollBody
        poll={poll}
        busy={busy}
        onVote={(id) => void vote(id)}
        byline={authorName}
        onSeeVoters={setVotersFor}
      />

      {/* Creator only, and inline: leaving the conversation to close your own poll is a detour. */}
      {poll.isCreator && (
        <View style={styles.chatPollActions}>
          <Action
            label={poll.closed ? 'Reopen Poll' : 'Close Poll'}
            style={styles.chatPollAction}
            onPress={() => {
              void pollApi.setClosed(pollId, !poll.closed).then(load.reload, load.reload);
            }}
          />
          {/* Asks first. Deleting takes every vote with it and cannot be undone. */}
          <Action
            label="Delete"
            variant="danger"
            style={styles.chatPollAction}
            onPress={() => setConfirmingDelete(true)}
          />
        </View>
      )}

      {confirmingDelete && (
        <ConfirmDialog
          title="Delete this poll?"
          body={`"${poll.question}" and every vote cast in it go with it, and its card disappears from this conversation. This cannot be undone.`}
          confirmLabel="Delete poll"
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => {
            setConfirmingDelete(false);
            void pollApi.remove(pollId).then(load.reload, load.reload);
          }}
        />
      )}

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
              <PollBody poll={poll} busy={busy} onVote={(id) => void vote(id)} />

              {/*
                Null is "you may not see this", which is a different thing from nobody having
                voted - so the control is absent rather than opening an empty sheet.
              */}
              {poll.options.some((option) => option.voters !== null) ? (
                <Action
                  label="See who voted"
                  variant="secondary"
                  onPress={() => setVotersFor(poll.options[0]?.id ?? null)}
                />
              ) : (
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
  // The composer. v1's PollCreateScreen, expressed in this app's tokens.
  // -------------------------------------------------------------------------
  /* The trailing space clears the tab bar: without it CREATE POLL sits under it and is half a button. */
  composerBody: { padding: space.md, paddingBottom: space.xl, gap: space.md },
  composerCard: {
    backgroundColor: color.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.divider,
    padding: space.md,
    gap: space.sm,
  },
  /* Uppercased in style rather than in the string, so the label stays readable to a screen reader. */
  composerLabel: { ...type.label, color: color.textSecondary, textTransform: 'uppercase' },
  composerCardTitle: { ...type.headerTitle, fontSize: 18, lineHeight: 24, color: color.textPrimary },
  composerCardHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  composerError: { ...type.bodySmall, color: color.error, textAlign: 'center' },

  questionInput: {
    ...type.body,
    backgroundColor: color.cardSunken,
    borderRadius: radius.md,
    padding: space.md,
    color: color.textPrimary,
    minHeight: 72,
    textAlignVertical: 'top',
  },

  optionsCount: {
    ...type.label,
    fontSize: 11,
    color: color.textSecondary,
    backgroundColor: color.cardRaised,
    borderRadius: radius.sm,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    letterSpacing: 0,
  },
  optionRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  optionInput: {
    ...type.body,
    flex: 1,
    backgroundColor: color.cardSunken,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
    color: color.textPrimary,
  },
  removeOption: {
    width: 32,
    height: 32,
    borderRadius: radius.pill,
    backgroundColor: color.errorContainer,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addOption: { alignSelf: 'flex-start' },
  addOptionLabel: { ...type.label, color: color.accent },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: {
    borderWidth: 1,
    borderColor: color.divider,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    backgroundColor: color.cardSunken,
  },
  chipOn: { backgroundColor: color.accent, borderColor: color.accent },
  chipLabel: { ...type.label, color: color.textSecondary, letterSpacing: 0 },
  chipLabelOn: { color: color.onAccent },
  customRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: space.sm,
    marginTop: space.sm,
  },
  customInput: {
    ...type.body,
    width: 64,
    textAlign: 'center',
    backgroundColor: color.cardSunken,
    borderRadius: radius.md,
    paddingVertical: space.sm + 2,
    color: color.textPrimary,
  },
  unitRow: { flexDirection: 'row', gap: 6 },
  unitChip: {
    borderWidth: 1,
    borderColor: color.divider,
    borderRadius: radius.md,
    paddingHorizontal: space.sm + 2,
    paddingVertical: space.sm,
    backgroundColor: color.cardSunken,
  },

  setting: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: space.md,
  },
  settingText: { flex: 1 },
  settingTitle: { ...type.headline, fontSize: 15, color: color.textPrimary },
  settingBody: { ...type.label, fontSize: 11, color: color.textSecondary, letterSpacing: 0 },
  settingDivider: { height: 1, backgroundColor: color.divider },

  createButton: {
    backgroundColor: color.accent,
    borderRadius: radius.pill,
    paddingVertical: space.md,
    alignItems: 'center',
  },
  createButtonOff: { opacity: 0.6 },
  createButtonLabel: { ...type.headerTitle, fontSize: 16, color: color.onAccent },

  optionTap: { flex: 1, gap: space.sm },
  optionEye: { paddingLeft: space.sm, paddingVertical: space.xs },
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

  /* The poll bubble in chat. Full width, so the options are votable targets rather than a teaser. */
  chatPollCard: {
    backgroundColor: color.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.divider,
    padding: space.md,
    gap: space.sm,
  },

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
  option: {
    // A row: the vote target takes the width and the eye sits beside it on the same line,
    // rather than wrapping under the bar where it reads as a separate control.
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: color.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.hairline,
    padding: space.md,
    gap: space.sm,
  },
  optionChosen: { backgroundColor: color.accentSoft, borderColor: color.accent },
  optionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  optionLabel: { ...type.headline, color: color.textPrimary, flexShrink: 1 },
  optionCount: { ...type.numeric, fontSize: 15, color: color.accentPressed },
  barTrack: {
    height: 6,
    borderRadius: radius.pill,
    backgroundColor: color.fallback,
    overflow: 'hidden',
  },
  barFill: { height: 6, borderRadius: radius.pill, backgroundColor: color.accent },

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
