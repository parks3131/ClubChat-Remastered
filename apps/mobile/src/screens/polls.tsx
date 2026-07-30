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
 *     closes polls; the server evaluates it per read, so this screen never computes it.
 *  3. **Only the creator closes, reopens or deletes** - including an admin who did not create it.
 *     `isCreator` is the flag, never a role.
 */

import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { pollApi, type PollScope } from '../api.ts';
import type { PollView } from '../api-types.ts';
import { color, radius, space, type } from '../theme.ts';
import {
  Action,
  Badge,
  Body,
  Card,
  DataScreen,
  EmptyState,
  Field,
  Row,
  SectionHeader,
  Tabs,
} from '../ui.tsx';
import { useLoad } from '../use-load.ts';

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 10;

/**
 * The polls list for a scope.
 *
 * `PRD/15` gives this screen two tabs, ALL POLLS and MY VOTES, and the second is a filter over the
 * same read rather than a second request - the server already reports `votedByMe` per row.
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
  const [composing, setComposing] = useState(false);
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
          return rows.length === 0 ? (
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
              {rows.map((poll) => (
                <Row
                  key={poll.id}
                  title={poll.question}
                  href={`/polls/${poll.id}`}
                  right={
                    <>
                      {poll.votedByMe && <Badge label="Voted" tone="muted" />}
                      {poll.closed && <Badge label="Closed" tone="muted" />}
                    </>
                  }
                />
              ))}
            </Body>
          );
        }}
      </DataScreen>

      {canCreate && (
        <View style={styles.footer}>
          <Action label="Create a poll" onPress={() => setComposing(true)} />
        </View>
      )}
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
  const [showVoters, setShowVoters] = useState(false);
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
          <Body>
            <Text style={styles.question}>{poll.question}</Text>
            <View style={styles.badgeRow}>
              {poll.closed && <Badge label="Closed" tone="muted" />}
              {poll.allowMultiple && <Badge label="Multi-select" tone="muted" />}
              {poll.isPrivate && <Badge label="Voters hidden" tone="muted" />}
            </View>
            {poll.closesAt !== null && (
              <Text style={styles.meta}>
                {poll.closed ? 'Closed' : 'Closes'} {poll.closesAt.slice(0, 16).replace('T', ' ')}
              </Text>
            )}

            {poll.options.map((option) => (
              <Card key={option.id}>
                <Action
                  label={`${option.votedByMe ? 'Your vote  ' : ''}${option.label}`}
                  variant={option.votedByMe ? 'primary' : 'secondary'}
                  disabled={poll.closed || busy}
                  onPress={() => void vote(option.id)}
                  accessibilityLabel={
                    poll.closed
                      ? `${option.label}, ${option.voteCount} votes, poll closed`
                      : option.votedByMe
                        ? `Withdraw your vote for ${option.label}`
                        : `Vote for ${option.label}`
                  }
                />
                <View style={styles.tally}>
                  {/* Public on every poll, including one whose voters are hidden. */}
                  <Text style={styles.meta}>
                    {option.voteCount} {option.voteCount === 1 ? 'vote' : 'votes'}
                  </Text>
                  <View style={styles.barTrack}>
                    <View
                      style={[
                        styles.barFill,
                        { width: total === 0 ? 0 : `${(option.voteCount / total) * 100}%` },
                      ]}
                    />
                  </View>
                </View>

                {/* Null is "you may not see this", which is different from nobody having voted. */}
                {showVoters &&
                  (option.voters === null ? (
                    <Text style={styles.meta}>Voters are hidden on this poll.</Text>
                  ) : option.voters.length === 0 ? (
                    <Text style={styles.meta}>No votes yet.</Text>
                  ) : (
                    <Text style={styles.meta}>
                      {option.voters.map((voter) => voter.name).join(', ')}
                    </Text>
                  ))}
              </Card>
            ))}

            <Action
              label={showVoters ? 'Hide who voted' : 'Show who voted'}
              variant="secondary"
              onPress={() => setShowVoters((current) => !current)}
            />

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
                <DeletePoll pollId={pollId} question={poll.question} onDeleted={() => router.back()} />
              </>
            )}
          </Body>
        );
      }}
    </DataScreen>
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
  footer: {
    padding: space.md,
    backgroundColor: color.chrome,
    borderTopWidth: 1,
    borderTopColor: color.divider,
  },
  question: { ...type.title, color: color.textPrimary },
  badgeRow: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' },
  meta: { ...type.bodySmall, color: color.textSecondary },
  error: { ...type.bodySmall, color: color.error },
  tally: { gap: space.xs },
  barTrack: {
    height: 6,
    borderRadius: radius.pill,
    backgroundColor: color.fallback,
    overflow: 'hidden',
  },
  barFill: { height: 6, borderRadius: radius.pill, backgroundColor: color.accent },
  toggles: { gap: space.sm },
  actions: { flexDirection: 'row', gap: space.sm },
  actionButton: { flex: 1 },
});
