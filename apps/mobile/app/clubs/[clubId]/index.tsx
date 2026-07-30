/**
 * The club hub.
 *
 * `PRD/15` fixes the order, and the first row is the point: **News and Highlights is the club's
 * front page**, above chat. Chat is the centre of gravity but the hub is what somebody opens a club
 * to see, and putting the feed second would make the hub a menu.
 *
 * The Eboard row is absent for an ordinary member rather than disabled. Rule 4 of `PRD/10` gives
 * them no visibility that the space exists at all, and a greyed-out row is visibility.
 */

import { StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { unreadCount } from '@clubchat/shared';
import { clubApi, raceApi } from '../../../src/api.ts';
import { useSession } from '../../../src/chat-provider.tsx';
import { color, space, type } from '../../../src/theme.ts';
import { Badge, Body, DataScreen, Row, SectionHeader } from '../../../src/ui.tsx';
import { useLoad } from '../../../src/use-load.ts';

/** How many races the hub previews before "See all". */
const RACE_PREVIEW = 5;

export default function ClubHubScreen() {
  const { clubId } = useLocalSearchParams<{ clubId: string }>();
  const { channels, revision } = useSession();

  const club = useLoad(() => clubApi.detail(clubId), [clubId, revision]);
  const races = useLoad(() => raceApi.list(clubId), [clubId, revision]);

  const unreadFor = (channelId: string | null): number => {
    if (channelId === null) return 0;
    const channel = channels.find((entry) => entry.id === channelId);
    return channel ? unreadCount(channel) : 0;
  };

  return (
    <DataScreen load={club}>
      {(data) => {
        const previewed = (races.data?.races ?? []).slice(0, RACE_PREVIEW);
        const total = races.data?.races.length ?? 0;

        return (
          <Body>
            {/*
              The header carries the club's own name rather than the word "Club". Set from the
              screen because only the screen has the data - the layout knows the route, not the row.
            */}
            <Stack.Screen options={{ title: data.club.name }} />
            <Text style={styles.sport}>{data.club.sport}</Text>
            {data.club.description !== null && data.club.description.length > 0 && (
              <Text style={styles.description}>{data.club.description}</Text>
            )}

            {/* First row: the club's front page. */}
            <Row
              title="News & Highlights"
              subtitle="Results, recaps and photo drops"
              href={`/clubs/${clubId}/news`}
            />

            <Row
              title="Club chat"
              subtitle="The centre of gravity"
              href={data.club.channelId !== null ? `/chat/${data.club.channelId}` : undefined}
              right={
                unreadFor(data.club.channelId) > 0 ? (
                  <Badge label={String(unreadFor(data.club.channelId))} tone="alert" />
                ) : undefined
              }
            />

            {/*
              Present only for somebody actually in the space. The server returns a null id to
              everybody else, so this row cannot be rendered for them by mistake.
            */}
            {data.club.eboardId !== null && (
              <Row
                title="Eboard & Council"
                subtitle="Admins only"
                href={`/eboard/${data.club.eboardId}`}
              />
            )}

            <SectionHeader
              title="Races & Meets"
              action={
                total > RACE_PREVIEW ? (
                  <Text style={styles.seeAll} accessibilityRole="link">
                    {`${total} total`}
                  </Text>
                ) : undefined
              }
            />
            {previewed.length === 0 ? (
              <Text style={styles.meta}>No upcoming races yet.</Text>
            ) : (
              previewed.map((race) => (
                <Row
                  key={race.id}
                  title={race.name}
                  subtitle={race.raceDate}
                  href={`/races/${race.id}`}
                  right={
                    <>
                      {race.pinned && <Badge label="Pinned" tone="accent" />}
                      {!race.hasAccess && <Badge label="No access" tone="muted" />}
                    </>
                  }
                />
              ))
            )}
            <Row title="See all races" href={`/clubs/${clubId}/races`} />

            <SectionHeader title="This club" />
            <Row title="Members" subtitle={`${data.club.memberCount}`} href={`/clubs/${clubId}/members`} />
            <Row title="Calendar" href={`/clubs/${clubId}/calendar`} />
            <Row title="Events" href={`/clubs/${clubId}/events`} />
            <Row title="Routines" href={`/clubs/${clubId}/routines`} />
            <Row title="Polls" href={`/clubs/${clubId}/polls`} />
            <Row title="Club profile" href={`/clubs/${clubId}/profile`} />
          </Body>
        );
      }}
    </DataScreen>
  );
}

const styles = StyleSheet.create({
  sport: { ...type.label, color: color.textSecondary, textTransform: 'uppercase' },
  description: { ...type.body, color: color.textPrimary, paddingBottom: space.sm },
  meta: { ...type.bodySmall, color: color.textSecondary },
  seeAll: { ...type.label, color: color.accent, textTransform: 'uppercase' },
});
