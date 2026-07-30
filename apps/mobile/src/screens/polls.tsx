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

import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { pollApi, type PollScope } from '../api.ts';
import type { PollSummary, PollView } from '../api-types.ts';
import { formatCountdown, formatInstant } from '../dates.ts';
import { color, radius, space, type } from '../theme.ts';
import {
  Action,
  Avatar,
  Body,
  Card,
  DataScreen,
  EmptyState,
  Fab,
  Field,
  ScreenHeading,
  SectionHeader,
  Tabs,
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
  const { create } = useLocalSearchParams<{ create?: string }>();
  const [composing, setComposing] = useState(create === '1' && canCreate);
  const load = useLoad(() => pollApi.list(scope, scopeId), [scope, scopeId]);

  if (composing) {
    return (
      <CreatePoll
        scope={scope}
        scopeId={scopeId}
        onCancel={() => setComposing(false)}
        onCreated={() => {
          setComposing(false);
          load.reload();
        }}
      />
    );
  }

  return (
    <View style={styles.flex}>
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
  const [multiple, setMultiple] = useState(false);
  const [isPrivate, setPrivate] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const filled = options.map((o) => o.trim()).filter((o) => o.length > 0);
  const valid = question.trim().length > 0 && filled.length >= MIN_OPTIONS;

  const submit = async () => {
    setBusy(true);
    setFailed(null);
    try {
      await pollApi.create(scope, scopeId, {
        question: question.trim(),
        options: filled,
        allowMultiple: multiple,
        isPrivate,
      });
      onCreated();
    } catch {
      setFailed('Could not create the poll. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Body>
      <SectionHeader title="New poll" />
      <Field label="Question" value={question} onChangeText={setQuestion} multiline />

      {options.map((option, index) => (
        <Field
          key={index}
          label={`Option ${index + 1}`}
          value={option}
          onChangeText={(next) =>
            setOptions((current) => current.map((o, i) => (i === index ? next : o)))
          }
        />
      ))}

      {/* Two minimum, ten maximum. An eleventh cannot be added rather than being rejected later. */}
      {options.length < MAX_OPTIONS && (
        <Action
          label="Add an option"
          variant="secondary"
          onPress={() => setOptions((current) => [...current, ''])}
        />
      )}

      <View style={styles.toggles}>
        <Toggle label="Allow multiple choices" on={multiple} onChange={setMultiple} />
        <Toggle label="Hide who voted" on={isPrivate} onChange={setPrivate} />
      </View>
      <Text style={styles.meta}>
        Counts are always visible. Hiding voters keeps names private from everyone but you.
      </Text>

      {failed !== null && <Text style={styles.error}>{failed}</Text>}
      <View style={styles.actions}>
        <Action label="Cancel" variant="secondary" style={styles.actionButton} onPress={onCancel} />
        <Action
          label={busy ? 'Creating' : 'Create'}
          style={styles.actionButton}
          disabled={!valid || busy}
          onPress={() => void submit()}
        />
      </View>
    </Body>
  );
}

function Toggle({
  label,
  on,
  onChange,
}: {
  label: string;
  on: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <Action
      label={`${on ? 'On' : 'Off'}  ${label}`}
      variant="secondary"
      onPress={() => onChange(!on)}
      accessibilityLabel={`${label}, currently ${on ? 'on' : 'off'}`}
    />
  );
}

/**
 * One poll, with inline voting.
 *
 * Tapping an option is the only write: it casts, moves or withdraws depending on what is already
 * there, and the server decides which. Deciding here would be a read-then-write across the network
 * racing the other device the same member is holding.
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
        const total = poll.options.reduce((sum, option) => sum + option.voteCount, 0);

        return (
          <View style={styles.flex}>
            <Body>
              <StatusRow closed={poll.closed} closesAt={poll.closesAt} />
              <Text style={styles.detailQuestion}>{poll.question}</Text>
              <Text style={styles.meta}>
                {poll.allowMultiple ? 'Multiple choice' : 'Single choice'}
                {poll.isPrivate ? '  ·  Private vote' : ''}
                {poll.closesAt !== null
                  ? `  ·  ${poll.closed ? 'Closed' : 'Closes'} ${formatInstant(poll.closesAt)}`
                  : ''}
              </Text>

              <View style={styles.options}>
                {poll.options.map((option) => (
                  <Pressable
                    key={option.id}
                    style={[styles.option, option.votedByMe && styles.optionChosen]}
                    disabled={poll.closed || busy}
                    onPress={() => void vote(option.id)}
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
                ))}
              </View>

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
  const chosen = poll.options.find((option) => option.id === optionId) ?? poll.options[0];
  const voters = chosen?.voters ?? null;

  return (
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

        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.sheetPicker}>
          {poll.options.map((option) => (
            <Pressable
              key={option.id}
              style={[styles.pickerChip, option.id === optionId && styles.pickerChipActive]}
              onPress={() => onPick(option.id)}
              accessibilityRole="button"
              accessibilityState={{ selected: option.id === optionId }}
              accessibilityLabel={`${option.label}, ${option.voteCount} votes`}
            >
              <Text
                style={[
                  styles.pickerChipLabel,
                  option.id === optionId && styles.pickerChipLabelActive,
                ]}
              >
                {option.label}  {option.voteCount}
              </Text>
            </Pressable>
          ))}
        </ScrollView>

        <ScrollView style={styles.sheetList}>
          {voters === null ? (
            <Text style={styles.meta}>Voters are hidden on this poll.</Text>
          ) : voters.length === 0 ? (
            <Text style={styles.meta}>No votes for this option yet.</Text>
          ) : (
            voters.map((voter) => (
              <View key={voter.userId} style={styles.voterRow}>
                <Avatar name={voter.name} size={32} />
                <Text style={styles.voterName}>{voter.name}</Text>
              </View>
            ))
          )}
        </ScrollView>
      </View>
    </View>
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
  toggles: { gap: space.sm },
  actions: { flexDirection: 'row', gap: space.sm },
  actionButton: { flex: 1 },

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
    justifyContent: 'flex-end',
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
    backgroundColor: color.card,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    padding: space.md,
    paddingBottom: space.xl,
    maxHeight: '70%',
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
