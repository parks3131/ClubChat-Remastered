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
import { useDeclareRace } from '../../../../../src/current-space.tsx';
import { raceApi } from '../../../../../src/api.ts';
import { color, space, type } from '../../../../../src/theme.ts';
import { ARRIVED_REDIRECT } from '../../../../../src/nav.tsx';
import {
  Action,
  Badge,
  Body,
  Card,
  DataScreen,
  Row,
  SectionHeader,
} from '../../../../../src/ui.tsx';
import { MeetInformationCard } from '../../../../../src/screens/meet-information.tsx';
import { useLoad } from '../../../../../src/use-load.ts';

export default function RaceHubScreen() {
  const { raceId } = useLocalSearchParams<{ raceId: string }>();
  const [requested, setRequested] = useState(false);
  const load = useLoad(() => raceApi.detail(raceId), [raceId]);
  /*
   * Which space this screen is in, for the header and for the Clubs tab's shortcut.
   *
   * The id comes from the ROUTE, so the header knows which space it is drawing before the name
   * arrives - that is what stops it showing the previous screen's name for a frame. Everything
   * else comes from the read, because a race and an Eboard space each know their own club and the
   * route does not carry it.
   */
  useDeclareRace(
    raceId,
    load.data?.race.clubId,
    load.data?.race.name,
    load.data?.race.image,
  );

  return (
    <DataScreen load={load}>
      {(data) => {
        const race = data.race;
        const viewer = race.viewer;

        // A real race member is taken straight to chat. `replace` rather than `push`, so the
        // history does not contain a hub that back would return them to.
        if (viewer.hasAccess && viewer.channelId !== null) {
          return <Redirect href={`/chat/${viewer.channelId}?${ARRIVED_REDIRECT}`} />;
        }

        return (
          <Body>
            <Stack.Screen options={{ title: race.name }} />
            <Text style={styles.title}>{race.name}</Text>
            {/* Absent for an ordinary group. Not drawn rather than drawn blank. */}
            {race.raceDate !== null && <Text style={styles.date}>{race.raceDate}</Text>}
            {/*
              No "You manage this" badge any more, and its absence is a consequence rather than a
              tidy-up: this hub renders only for somebody OFF the roster, and since ADR-0027
              managing requires being on it. The badge could no longer be true here, and a control
              that cannot fire is a claim about a state the product no longer has.
            */}
            <View style={styles.badges}>
              <Badge label={`${race.memberCount} going`} tone="muted" />
            </View>

            <SectionHeader title="Meet Information" />
            {/*
              Shared with the Meet Information screen, which a member reaches from quick-nav. The
              per-field empty-state rule lives in that module rather than being written out here
              and again there - see its note.
            */}
            <MeetInformationCard race={race} />

            {/* Any member can pin any race they can see. Personal: nobody else's hub changes. */}
            <Action
              label={viewer.pinned ? 'Unpin from your hub' : 'Pin to your hub'}
              variant="secondary"
              onPress={() => {
                void raceApi.setPin(raceId, !viewer.pinned).then(load.reload, load.reload);
              }}
            />

            {/*
              The Owner joins outright; everybody else asks. Checked before the pending state,
              because an Owner who asked and then gave up waiting should still be offered the
              door rather than being left staring at their own request - which is the situation
              this exists for, a roster whose last admin has gone.
            */}
            {viewer.canJoinDirectly ? (
              <Action
                label="Join this race"
                onPress={() => {
                  void raceApi.joinDirectly(raceId).then(load.reload, load.reload);
                }}
                accessibilityLabel={`Join ${race.name}`}
              />
            ) : viewer.requestPending || requested ? (
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
              Two different questions, and they were one block until 2026-08-12.

              `isManager` now means an admin who is ALSO on this roster (ADR-0027), and this hub
              only renders for somebody who is NOT - a member is redirected into chat above. So
              the manage block is unreachable here by construction, and what remains is the one
              capability an admin keeps from outside the race: reading the roster.

              > **Splitting them is the whole fix.** The roster link used to live inside the
              > manage block, so roster-gating management hid it too - the server went on granting
              > the read and nothing in the app could reach it. A control gated on "can act" when
              > the rule is "can look" fails silently in the direction nobody checks.
            */}
            {viewer.canReadRoster && (
              <>
                <SectionHeader title="Roster" />
                <Row
                  title="Who is going"
                  subtitle={`${race.memberCount} on the roster`}
                  href={`/races/${raceId}/roster`}
                />
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
