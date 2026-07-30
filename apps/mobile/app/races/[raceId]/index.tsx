/**
 * The race hub - which is really three screens sharing one read.
 *
 * | Who | Sees |
 * |---|---|
 * | A club member with no access | The **preview**: name, date, Meet Information, and a request action |
 * | A manager with no roster row | The preview plus **a way into the roster to manage others** |
 * | A real race member | Redirected straight into **race chat** |
 *
 * The last one is `PRD/09` rule 7 and `PRD/15` rule 1: chat is the race's home screen, and
 * everything else hangs off its header. Which makes rule 2 the trap - **a chat screen's
 * back-fallback must never point at this hub**, or an entry with no history bounces hub → chat →
 * hub forever. Chat falls back to the races list instead.
 *
 * Meet Information is readable by every club member, including the preview state, because it is
 * exactly what somebody needs in order to decide whether to ask to go.
 */

import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Redirect, Stack, useLocalSearchParams } from 'expo-router';
import { raceApi } from '../../../src/api.ts';
import { color, space, type } from '../../../src/theme.ts';
import {
  Action,
  Badge,
  Body,
  Card,
  DataScreen,
  DetailLine,
  Row,
  SectionHeader,
} from '../../../src/ui.tsx';
import { useLoad } from '../../../src/use-load.ts';

export default function RaceHubScreen() {
  const { raceId } = useLocalSearchParams<{ raceId: string }>();
  const [requested, setRequested] = useState(false);
  const load = useLoad(() => raceApi.detail(raceId), [raceId]);

  return (
    <DataScreen load={load}>
      {(data) => {
        const race = data.race;
        const viewer = race.viewer;

        // A real race member is taken straight to chat. `replace` rather than `push`, so the
        // history does not contain a hub that back would return them to.
        if (viewer.hasAccess && viewer.channelId !== null) {
          return <Redirect href={`/chat/${viewer.channelId}`} />;
        }

        return (
          <Body>
            <Stack.Screen options={{ title: race.name }} />
            <Text style={styles.title}>{race.name}</Text>
            <Text style={styles.date}>{race.raceDate}</Text>
            <View style={styles.badges}>
              <Badge label={`${race.memberCount} going`} tone="muted" />
              {viewer.isManager && <Badge label="You manage this" tone="accent" />}
            </View>

            <SectionHeader title="Meet Information" />
            <Card>
              {/*
                Empty-state behaviour differs per field, deliberately. Description, location and
                hotel are hidden entirely when empty; photos and results always show a placeholder,
                because those are expected later and a missing hotel usually means there is no hotel.
              */}
              <DetailLine label="Details" value={race.meetDescription} />
              <DetailLine label="Location" value={race.meetLocationUrl} />
              <DetailLine label="Hotel" value={race.meetHotelUrl} />
              <DetailLine label="Photos" value={race.meetPhotosUrl} placeholder="Stay tuned" />
              <DetailLine label="Results" value={race.meetResultsUrl} placeholder="Stay tuned" />
            </Card>

            {/* Any member can pin any race they can see. Personal: nobody else's hub changes. */}
            <Action
              label={viewer.pinned ? 'Unpin from your hub' : 'Pin to your hub'}
              variant="secondary"
              onPress={() => {
                void raceApi.setPin(raceId, !viewer.pinned).then(load.reload, load.reload);
              }}
            />

            {viewer.requestPending || requested ? (
              <Card>
                <Text style={styles.meta}>Requested - waiting on an admin to approve.</Text>
              </Card>
            ) : (
              <Action
                label="Request to join"
                onPress={() => {
                  void raceApi
                    .requestAccess(raceId)
                    .then(() => setRequested(true))
                    .catch(load.reload);
                }}
                accessibilityLabel={`Request to join ${race.name}`}
              />
            )}

            {/*
              A manager with no roster row gets exactly one thing: a way into the roster to manage
              others. Not the race itself - rule 5.
            */}
            {viewer.isManager && (
              <>
                <SectionHeader title="Manage" />
                <Row title="Roster" subtitle="Approve, add and remove" href={`/races/${raceId}/roster`} />
                <Row title="Meet Information" subtitle="Edit all five fields" href={`/races/${raceId}/meet`} />
              </>
            )}
          </Body>
        );
      }}
    </DataScreen>
  );
}

const styles = StyleSheet.create({
  title: { ...type.title, color: color.textPrimary },
  date: { ...type.label, color: color.textSecondary, textTransform: 'uppercase' },
  badges: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap', paddingBottom: space.sm },
  meta: { ...type.bodySmall, color: color.textSecondary },
});
