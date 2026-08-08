/**
 * The platform moderation queue: reports raised in direct messages.
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
 */

import { useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { moderationApi } from '../../../../src/api.ts';
import type { DmReportRow } from '../../../../src/api-types.ts';
import { timeAgo } from '../../../../src/dates.ts';
import { color, radius, space, type } from '../../../../src/theme.ts';
import { Action, Avatar, DataScreen, EmptyState } from '../../../../src/ui.tsx';
import { useLoad } from '../../../../src/use-load.ts';

export default function ModerationQueueScreen() {
  const router = useRouter();
  /**
   * Dismissed reports are hidden by default and can be shown.
   *
   * Hidden rather than deleted, because "this was reviewed and was nothing" is a different fact
   * from "this never happened", and a queue that forgets its decisions invites the same report to
   * be re-litigated by the next person to look.
   */
  const [showDismissed, setShowDismissed] = useState(false);
  const queue = useLoad(() => moderationApi.queue(showDismissed), [showDismissed]);

  // The title and the back control are declared in the (main) layout, with every other screen's,
  // so a deep link with no history still arrives with a way out - PRD/15 rule 3.
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
            ListHeaderComponent={
              <View style={styles.header}>
                <Text style={styles.blurb}>
                  Reports from direct messages. A club admin never sees these.
                </Text>
                <Action
                  label={showDismissed ? 'Hide reviewed' : 'Show reviewed'}
                  variant="quiet"
                  onPress={() => setShowDismissed((on) => !on)}
                />
              </View>
            }
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
 * One report, as metadata.
 *
 * Everything drawn here is who and when. **There is deliberately nothing to read**: the message
 * itself is behind the tap, on the screen whose opening is logged.
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

      {dismissed && <Text style={styles.reviewed}>Reviewed</Text>}

      <View style={styles.actions}>
        {/*
          The wording is the honest one. "Read the messages" says what the tap does, where
          "View" or "Open" would hide that it is a deliberate look at private content that gets
          written down.
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

  actions: { gap: space.xs },
});
