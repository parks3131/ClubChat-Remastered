/**
 * Highlights: **Pinned | Announcements | Reports.**
 *
 * One implementation for club, race and Eboard chat - design-system rule 5. The scope reaches this
 * screen as a channel id and changes nothing, which is the client half of the channel abstraction.
 *
 * Two things worth knowing:
 *
 *  - **Both lists are queried over the whole channel**, not over the loaded page. v1 computed them
 *    from a bounded slice of history, so a pin older than what chat had loaded silently vanished
 *    from the list whose entire job is to keep it findable.
 *  - **A DM has no Reports tab**, because there is no admin of the conversation to read it. A DM
 *    report goes to a platform moderator through a separate queue instead.
 */

import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { channelApi } from '../../../../../src/api.ts';
import { color, space, type } from '../../../../../src/theme.ts';
import { Badge, Body, Card, DataScreen, EmptyState, Row, Tabs } from '../../../../../src/ui.tsx';
import { useLoad } from '../../../../../src/use-load.ts';

type Tab = 'pinned' | 'announcements' | 'reports';

export default function HighlightsScreen() {
  const { channelId } = useLocalSearchParams<{ channelId: string }>();
  const [tab, setTab] = useState<Tab>('pinned');
  const router = useRouter();

  const meta = useLoad(() => channelApi.meta(channelId), [channelId]);
  const isDm = meta.data?.scope === 'dm';
  /*
   * Offered only to somebody who can actually read them, which the server answers. A DM has no
   * Reports tab at all - there is no admin of the conversation to read one, and a DM report goes to
   * a platform moderator through a separate queue.
   */
  const showReports = isDm === false && meta.data?.canReadReports === true;

  const pinned = useLoad(() => channelApi.pinned(channelId), [channelId]);
  const announcements = useLoad(() => channelApi.announcements(channelId), [channelId]);
  const reports = useLoad(
    () => (showReports ? channelApi.reports(channelId) : Promise.resolve({ reports: [] })),
    [channelId, showReports],
  );

  /** Jump to a message. One tap, because the window read exists for exactly this. */
  const jumpTo = (seq: number) => {
    router.push(`/chat/${channelId}?around=${seq}`);
  };

  const tabs: Array<{ key: Tab; label: string }> = [
    { key: 'pinned', label: 'Pinned' },
    { key: 'announcements', label: 'Announcements' },
    // Absent rather than empty for anybody who cannot read them: a DM has nobody it could be
    // for, and a plain club member is not the audience.
    ...(showReports ? [{ key: 'reports' as Tab, label: 'Reports' }] : []),
  ];

  return (
    <View style={styles.flex}>
      <View style={styles.tabsWrap}>
        <Tabs tabs={tabs} active={tab} onChange={setTab} />
      </View>

      {tab === 'pinned' && (
        <DataScreen
          load={pinned}
          isEmpty={(data) => data.messages.length === 0}
          empty={<EmptyState title="Nothing pinned" body="Admins pin a message for reference." />}
        >
          {(data) => (
            <Body>
              {data.messages.map((message) => (
                <Row
                  key={message.seq}
                  title={message.body ?? '(no text)'}
                  subtitle={message.createdAt.slice(0, 16).replace('T', ' ')}
                  onPress={() => jumpTo(message.seq)}
                  accessibilityLabel={`Jump to the pinned message from ${message.createdAt.slice(0, 10)}`}
                />
              ))}
            </Body>
          )}
        </DataScreen>
      )}

      {tab === 'announcements' && (
        <DataScreen
          load={announcements}
          isEmpty={(data) => data.messages.length === 0}
          empty={<EmptyState title="No announcements" body="An announcement notifies everybody in this chat." />}
        >
          {(data) => (
            <Body>
              {data.messages.map((message) => (
                <Row
                  key={message.seq}
                  title={message.body ?? '(no text)'}
                  subtitle={message.createdAt.slice(0, 16).replace('T', ' ')}
                  onPress={() => jumpTo(message.seq)}
                />
              ))}
            </Body>
          )}
        </DataScreen>
      )}

      {tab === 'reports' && (
        <DataScreen
          load={reports}
          isEmpty={(data) => data.reports.length === 0}
          empty={<EmptyState title="No reports" body="Reported messages appear here for admins only." />}
        >
          {(data) => (
            <Body>
              {data.reports.map((report) => (
                <Card key={report.reportId}>
                  <Text style={styles.body}>{report.message?.body ?? '(deleted)'}</Text>
                  <Text style={styles.meta}>
                    from {report.message?.senderName ?? 'unknown'} · reported by {report.reporterName}
                  </Text>
                  {report.dismissedAt !== null && <Badge label="Dismissed" tone="muted" />}
                </Card>
              ))}
            </Body>
          )}
        </DataScreen>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: color.appBackground },
  tabsWrap: { padding: space.md, paddingBottom: 0 },
  body: { ...type.body, color: color.textPrimary },
  meta: { ...type.bodySmall, color: color.textSecondary },
});
