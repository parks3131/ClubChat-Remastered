/**
 * The platform moderation queues: reports raised in direct messages, and reports about people.
 *
 * > **The server side of this has been complete and tested since Phase 3.5, and there was no
 * > screen at all.** A member reported a DM, the app told them it had gone to ClubChat
 * > moderators, the row was written correctly - and no human being could open it. The report
 * > button worked, the queue worked, and nobody was on the other end. That is the gap this
 * > closes, and it is the one place the product told somebody something untrue.
 *
 * **A DM has no admins**, which is why this exists separately from the per-space Reports tab.
 * PRD/14 rule 7 routes a DM report to platform moderators and to **no club admin ever** - a club
 * officer must never be able to read two members' private conversation, even their own members'.
 *
 * Three properties this screen has to preserve, all of them decided in TECH/05 rather than here:
 *
 *  1. **No message bodies in the list.** If the queue showed content, either every refresh would
 *     write an audit row per report, or private messages would be read with no log at all. The
 *     second silently defeats the rule; the first fills the log with noise. So the list is
 *     metadata - who reported whom, and when - and reading what was said is a separate, deliberate
 *     act.
 *  2. **Opening a report is audit-logged**, which is why the context lives behind a tap on
 *     another screen rather than being expanded inline. Nothing here prefetches it.
 *  3. **There is no door without a report.** The context read resolves through the report row, so
 *     a moderator cannot reach a conversation nobody complained about.
 *
 * **The two outcomes are shown but not offered.** A row says whether the message has been removed
 * and whether the account is suspended, because a queue that cannot say what has been done invites
 * the same report to be worked twice. Performing either is on the context screen, behind the
 * evidence - deciding to eject somebody from a list of names is deciding without looking.
 *
 * **The People tab arrived on 2026-08-15** with Report on the member card, and the three
 * properties above apply to it in a way worth stating: there is no content to withhold, no read to
 * log, and no door at all. A person report names an account and carries how many people named it.
 * That is deliberately less than a message report gives a reviewer, and it is why ADR-0035 sends
 * these to moderators rather than to a club's admins - a report with no evidence is a thing to
 * weigh against a pattern, not a thing to act on from inside the club it came from.
 */

import { useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { moderationApi } from '../../../../src/api.ts';
import type { DmReportRow, UserReportRow } from '../../../../src/api-types.ts';
import { timeAgo } from '../../../../src/dates.ts';
import { color, radius, space, type } from '../../../../src/theme.ts';
import { Action, Avatar, DataScreen, EmptyState, Tabs } from '../../../../src/ui.tsx';
import { useLoad } from '../../../../src/use-load.ts';

/**
 * The two queues, which are worked differently and so are not one list.
 *
 * A message report leads to an audited window onto a conversation; a person report has no
 * conversation to open and what a moderator acts on is the account. Mixing them would mean every
 * row having to explain which of those it is, and the "Read the messages" control appearing on
 * rows where there is nothing to read.
 */
type Queue = 'messages' | 'people';

export default function ModerationQueueScreen() {
  const router = useRouter();
  const [queueKind, setQueueKind] = useState<Queue>('messages');
  /**
   * Dismissed reports are hidden by default and can be shown.
   *
   * Hidden rather than deleted, because "this was reviewed and was nothing" is a different fact
   * from "this never happened", and a queue that forgets its decisions invites the same report to
   * be re-litigated by the next person to look.
   */
  const [showDismissed, setShowDismissed] = useState(false);

  /*
   * Only the visible queue is read. Loading both would double the work on a screen most
   * moderators open to find nothing waiting, and the tab is one tap.
   */
  const queue = useLoad(
    () =>
      queueKind === 'messages'
        ? moderationApi.queue(showDismissed)
        : Promise.resolve({ reports: [] as DmReportRow[] }),
    [queueKind, showDismissed],
  );
  const people = useLoad(
    () =>
      queueKind === 'people'
        ? moderationApi.userReports(showDismissed)
        : Promise.resolve({ reports: [] as UserReportRow[] }),
    [queueKind, showDismissed],
  );

  const header = (
    <View style={styles.header}>
      <Tabs
        tabs={[
          { key: 'messages' as Queue, label: 'Messages' },
          { key: 'people' as Queue, label: 'People' },
        ]}
        active={queueKind}
        onChange={setQueueKind}
        variant="pill"
      />
      <Text style={styles.blurb}>
        {queueKind === 'messages'
          ? 'Reports from direct messages. A club admin never sees these.'
          : 'Reports about a person, from anywhere in the app. There is nothing to read here - what was reported is the account.'}
      </Text>
      <Action
        label={showDismissed ? 'Hide reviewed' : 'Show reviewed'}
        variant="quiet"
        onPress={() => setShowDismissed((on) => !on)}
      />
    </View>
  );

  // The title and the back control are declared in the (main) layout, with every other screen's,
  // so a deep link with no history still arrives with a way out - PRD/15 rule 3.
  if (queueKind === 'people') {
    return (
      <DataScreen load={people}>
        {(data) => (
          <FlatList
            data={data.reports}
            keyExtractor={(row) => row.subjectId}
            contentContainerStyle={styles.list}
            ListEmptyComponent={
              <EmptyState
                title={showDismissed ? 'Nobody reported' : 'Nothing waiting'}
                body={
                  showDismissed
                    ? 'No member has been reported.'
                    : 'Reports about a person arrive here. Nothing needs review.'
                }
              />
            }
            ListHeaderComponent={header}
            renderItem={({ item }) => <PersonReportCard row={item} />}
          />
        )}
      </DataScreen>
    );
  }

  return (
    <DataScreen load={queue}>
        {(data) => (
          <FlatList
            data={data.reports}
            keyExtractor={(row) => row.messageId}
            contentContainerStyle={styles.list}
            ListEmptyComponent={
              <EmptyState
                title={showDismissed ? 'Nothing reported' : 'Nothing waiting'}
                body={
                  showDismissed
                    ? 'No direct message has been reported.'
                    : 'Reports from direct messages arrive here. Nothing needs review.'
                }
              />
            }
            ListHeaderComponent={header}
            renderItem={({ item }) => (
              <ReportCard
                row={item}
                onOpen={() => router.push(`/moderation/${item.messageId}`)}
              />
            )}
          />
      )}
    </DataScreen>
  );
}

/**
 * One reported person.
 *
 * > **There is no "Read the messages" control, and its absence is the whole difference from the
 * > card below.** A person report points at an account rather than at evidence, so there is no
 * > window to open and nothing to audit-log. A control here would have to lead somewhere, and
 * > the only somewhere would be a conversation nobody complained about.
 *
 * What it carries instead is the count of reporters, which is the strongest single fact this
 * queue has: one person reporting somebody is an opinion, and four is a pattern.
 *
 * Suspending happens on the account rather than from here, deliberately - the same call the DM
 * queue makes, and for the same reason: deciding to eject somebody from a list of names is
 * deciding without looking.
 */
function PersonReportCard({ row }: { row: UserReportRow }) {
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(row.dismissedAt !== null);

  return (
    <View style={[styles.card, dismissed && styles.cardDismissed]}>
      <View style={styles.who}>
        <Avatar name={row.subjectName} image={row.subjectImage} />
        <View style={styles.whoText}>
          <Text style={styles.name}>{row.subjectName}</Text>
          <Text style={styles.meta}>
            {row.reporters.length === 1
              ? `Reported by ${row.reporters[0]?.name ?? 'a member'}`
              : `Reported by ${row.reporters.length} people`}
            {' · '}
            {timeAgo(row.createdAt)}
          </Text>
        </View>
      </View>

      {row.subjectSuspended && (
        <View style={styles.outcomes}>
          <Text style={styles.outcome}>Account suspended</Text>
        </View>
      )}

      {dismissed && <Text style={styles.reviewed}>Reviewed</Text>}

      {!dismissed && (
        <View style={styles.actions}>
          <Action
            label={busy ? 'Dismissing…' : 'Dismiss'}
            variant="quiet"
            disabled={busy}
            onPress={() => {
              setBusy(true);
              void moderationApi
                .dismissUserReport(row.subjectId)
                // Local rather than a list reload, exactly as the card below does it: re-reading
                // would reorder the queue under somebody working down it.
                .then(() => setDismissed(true))
                .finally(() => setBusy(false));
            }}
          />
        </View>
      )}
    </View>
  );
}

/**
 * One report, as metadata.
 *
 * Everything drawn here is who, when, and what has already been done. **There is deliberately
 * nothing to read**: the message itself is behind the tap, on the screen whose opening is logged.
 */
function ReportCard({ row, onOpen }: { row: DmReportRow; onOpen: () => void }) {
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(row.dismissedAt !== null);

  return (
    <View style={[styles.card, dismissed && styles.cardDismissed]}>
      <View style={styles.who}>
        <Avatar name={row.senderName} image={null} />
        <View style={styles.whoText}>
          <Text style={styles.name}>{row.senderName}</Text>
          <Text style={styles.meta}>
            {/* Plural handled rather than "1 reporters", which reads as a bug in a queue. */}
            {row.reporters.length === 1
              ? `Reported by ${row.reporters[0]?.name ?? 'a member'}`
              : `Reported by ${row.reporters.length} people`}
            {' · '}
            {timeAgo(row.createdAt)}
          </Text>
        </View>
      </View>

      {/*
        What has been done, stated rather than implied. Both are metadata, so showing them does
        not turn this list into a content surface.
      */}
      {(row.removed || row.senderSuspended) && (
        <View style={styles.outcomes}>
          {row.removed && <Text style={styles.outcome}>Message removed</Text>}
          {row.senderSuspended && <Text style={styles.outcome}>Account suspended</Text>}
        </View>
      )}

      {dismissed && <Text style={styles.reviewed}>Reviewed</Text>}

      <View style={styles.actions}>
        {/*
          The wording is the honest one. "Read the messages" says what the tap does, where
          "View" or "Open" would hide that it is a deliberate look at private content that gets
          written down. It is also where removing and suspending live, for the same reason.
        */}
        <Action label="Read the messages" onPress={onOpen} />
        {!dismissed && (
          <Action
            label={busy ? 'Dismissing…' : 'Dismiss'}
            variant="quiet"
            disabled={busy}
            onPress={() => {
              setBusy(true);
              void moderationApi
                .dismiss(row.messageId)
                // Local rather than a list reload: re-reading would reorder the queue under
                // somebody working down it, and the row is finished either way.
                .then(() => setDismissed(true))
                .finally(() => setBusy(false));
            }}
          />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  list: { padding: space.md, gap: space.sm },
  header: { gap: space.xs, paddingBottom: space.sm },
  blurb: { ...type.bodySmall, color: color.textSecondary },

  card: {
    backgroundColor: color.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.hairline,
    padding: space.md,
    gap: space.sm,
    marginBottom: space.xs,
  },
  // Reviewed rows stay legible but visibly settled, so a moderator scanning the list can tell
  // what still needs them without reading every card.
  cardDismissed: { opacity: 0.6 },

  who: { flexDirection: 'row', alignItems: 'center', gap: space.sm + 2 },
  whoText: { flex: 1, gap: 2 },
  name: { ...type.headline, color: color.textPrimary },
  meta: { ...type.bodySmall, color: color.textSecondary },
  reviewed: { ...type.label, color: color.textSecondary, textTransform: 'none' },

  outcomes: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  outcome: {
    ...type.label,
    textTransform: 'none',
    color: color.onErrorContainer,
    backgroundColor: color.errorContainer,
    borderRadius: radius.sm,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
  },

  actions: { gap: space.xs },
});
