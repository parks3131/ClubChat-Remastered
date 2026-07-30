/**
 * The Eboard space.
 *
 * Two states, and which one you get is the whole design:
 *
 * - **A club admin who is not a member** sees a landing screen with a request action. They are
 *   admin-tier, so no promotion will re-add them - the request is their only way back in.
 * - **A member is taken straight to Eboard chat**, exactly like a race. `PRD/15` rule 1.
 *
 * An ordinary club member reaches neither: the server answers 404, because rule 4 gives them no
 * visibility that the space exists at all. That is why this screen has no "not allowed" branch of
 * its own - the read fails and `DataScreen` says so.
 */

import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Redirect, Stack, useLocalSearchParams } from 'expo-router';
import { useDeclareEboard } from '../../../../../src/current-space.tsx';
import { eboardApi } from '../../../../../src/api.ts';
import { color, space, type } from '../../../../../src/theme.ts';
import { Action, Badge, Body, Card, DataScreen, Row, SectionHeader } from '../../../../../src/ui.tsx';
import { useLoad } from '../../../../../src/use-load.ts';

export default function EboardScreen() {
  const { eboardId } = useLocalSearchParams<{ eboardId: string }>();
  const [requested, setRequested] = useState(false);
  const load = useLoad(() => eboardApi.detail(eboardId), [eboardId]);
  /*
   * Which space this screen is in, for the header and for the Clubs tab's shortcut.
   *
   * The id comes from the ROUTE, so the header knows which space it is drawing before the name
   * arrives - that is what stops it showing the previous screen's name for a frame. Everything
   * else comes from the read, because a race and an Eboard space each know their own club and the
   * route does not carry it.
   */
  useDeclareEboard(
    eboardId,
    load.data?.eboard.clubId,
    load.data?.eboard.name,
    load.data?.eboard.image,
  );

  return (
    <DataScreen load={load}>
      {(data) => {
        const eboard = data.eboard;

        // A member goes straight to chat. `Redirect` rather than push, so back does not return
        // them to a hub that would bounce them here again.
        if (eboard.viewer.isMember && eboard.channelId !== null) {
          return <Redirect href={`/chat/${eboard.channelId}`} />;
        }

        return (
          <Body>
            {/* The space's name is per-club data, not a constant - "Eboard & Council" is only the
                default. */}
            <Stack.Screen options={{ title: eboard.name }} />
            <Text style={styles.title}>{eboard.name}</Text>
            <View style={styles.badges}>
              <Badge label={`${eboard.memberCount} members`} tone="muted" />
              <Badge label="Admins only" tone="muted" />
            </View>
            {eboard.description !== null && eboard.description.length > 0 && (
              <Text style={styles.body}>{eboard.description}</Text>
            )}

            <Card>
              <Text style={styles.meta}>
                You are an admin of this club but not in its board space. Being promoted adds you
                automatically - so if you left, the way back is to ask somebody inside.
              </Text>
            </Card>

            {eboard.viewer.requestPending || requested ? (
              <Card>
                <Text style={styles.meta}>Requested - waiting on a member to approve.</Text>
              </Card>
            ) : (
              <Action
                label="Request to rejoin"
                onPress={() => {
                  void eboardApi
                    .requestAccess(eboardId)
                    .then(() => setRequested(true))
                    .catch(load.reload);
                }}
              />
            )}

            <SectionHeader title="Meanwhile" />
            {/* Meetings and polls are members-only; the roster read refuses a non-member too. */}
            <Row title="Meetings" href={`/eboard/${eboardId}/meetings`} />
            <Row title="Polls" href={`/eboard/${eboardId}/polls`} />
          </Body>
        );
      }}
    </DataScreen>
  );
}

const styles = StyleSheet.create({
  title: { ...type.title, color: color.textPrimary },
  badges: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' },
  body: { ...type.body, color: color.textPrimary },
  meta: { ...type.bodySmall, color: color.textSecondary },
});
