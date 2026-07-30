/**
 * Club profile: identity, the join link, and the destructive controls.
 *
 * The invite link is the **only** invite mechanism (ADR-0010 removed the typed code), which has two
 * consequences this screen has to carry. The token is shown to admins only - it is the club's front
 * door to anybody holding it. And rotation is offered plainly, because a leaked link has no
 * alternative to fall back on and invalidating every outstanding link is the remedy rather than a
 * side effect to warn about.
 *
 * The Owner has no Leave control at all, which is not an oversight: transfer is the only path out,
 * because an ownerless club cannot be recovered.
 */

import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useDeclareClub } from '../../../../../src/current-club.tsx';
import * as Linking from 'expo-linking';
import { clubApi } from '../../../../../src/api.ts';
import { color, space, type } from '../../../../../src/theme.ts';
import {
  Action,
  Badge,
  Body,
  Card,
  DataScreen,
  DetailLine,
  Row,
  SectionHeader,
} from '../../../../../src/ui.tsx';
import { useLoad } from '../../../../../src/use-load.ts';

export default function ClubProfileScreen() {
  const { clubId } = useLocalSearchParams<{ clubId: string }>();
  // Inside this club for as long as this screen is mounted, which is what the Clubs tab reads.
  useDeclareClub(clubId);
  const router = useRouter();
  const load = useLoad(() => clubApi.detail(clubId), [clubId]);
  const [busy, setBusy] = useState(false);

  return (
    <DataScreen load={load}>
      {(data) => {
        const club = data.club;
        const viewer = club.viewer;

        return (
          <Body>
            <Text style={styles.title}>{club.name}</Text>
            <View style={styles.badges}>
              <Badge label={club.sport} tone="muted" />
              <Badge label={`${club.memberCount} members`} tone="muted" />
              <Badge label={viewer.role} tone="accent" />
            </View>

            <Card>
              <DetailLine label="About" value={club.description} />
              <DetailLine label="Joining" value={club.joinPolicy === 'open' ? 'Open to anyone' : 'By request'} />
            </Card>

            <Row title="Members" href={`/clubs/${clubId}/members`} />
            <Row title="Gallery" href={club.channelId !== null ? `/channels/${club.channelId}/gallery` : undefined} />

            {/* Admin tier only. The server withholds the token from everybody else. */}
            {club.inviteToken !== null && (
              <>
                <SectionHeader title="Invite link" />
                <Card>
                  {/*
                    Built with `Linking.createURL`, which is the APP's own address - not the API's.
                    `/join/:token` is a client route: an invite pointing at the API origin sends
                    whoever taps it to a server that has no such path. On web this is the site
                    origin; on a device it is the registered `clubchat://` scheme.
                  */}
                  <Text style={styles.link} selectable>
                    {Linking.createURL(`/join/${club.inviteToken}`)}
                  </Text>
                  <Text style={styles.meta}>
                    Anybody with this link joins instantly, even on a request club. There is no code
                    to type anywhere.
                  </Text>
                  <Action
                    label={busy ? 'Rotating' : 'Rotate link'}
                    variant="secondary"
                    disabled={busy}
                    onPress={() => {
                      setBusy(true);
                      void clubApi
                        .rotateInvite(clubId)
                        .then(load.reload, load.reload)
                        .finally(() => setBusy(false));
                    }}
                  />
                  <Text style={styles.meta}>
                    Rotating invalidates every link already shared. That is the point: it is the only
                    way to take back a link that got somewhere it should not have.
                  </Text>
                </Card>
              </>
            )}

            {viewer.isAdmin && (
              <>
                <SectionHeader title="Admin" />
                <Action
                  label={club.joinPolicy === 'open' ? 'Require approval to join' : 'Let anyone join'}
                  variant="secondary"
                  onPress={() => {
                    void clubApi
                      .setJoinPolicy(clubId, club.joinPolicy === 'open' ? 'request' : 'open')
                      .then(load.reload, load.reload);
                  }}
                />
                {club.joinPolicy === 'request' && (
                  <Text style={styles.meta}>
                    Switching to open admits everybody currently waiting.
                  </Text>
                )}
              </>
            )}

            <SectionHeader title="Leaving" />
            {viewer.isOwner ? (
              <>
                {/* No Leave control for the Owner at all: transfer is the only path. */}
                <Text style={styles.meta}>
                  As the Owner you cannot leave this club - a club without an Owner cannot be
                  recovered. Transfer it to another admin from the members list first.
                </Text>
                <DeleteClub clubId={clubId} name={club.name} onDeleted={() => router.replace('/clubs')} />
              </>
            ) : (
              <LeaveClub clubId={clubId} name={club.name} onLeft={() => router.replace('/clubs')} />
            )}
          </Body>
        );
      }}
    </DataScreen>
  );
}

function LeaveClub({
  clubId,
  name,
  onLeft,
}: {
  clubId: string;
  name: string;
  onLeft: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <Action
        label="Leave club"
        variant="secondary"
        onPress={() => setConfirming(true)}
        accessibilityLabel={`Leave ${name}`}
      />
    );
  }

  return (
    <Card>
      {/* Names the club and states what is lost. */}
      <Text style={styles.meta}>
        Leave {name}? You come out of every race in it, every car group, and the board space if you
        were in it.
      </Text>
      <View style={styles.actions}>
        <Action
          label="Stay"
          variant="secondary"
          style={styles.actionButton}
          onPress={() => setConfirming(false)}
        />
        <Action
          label="Leave"
          variant="danger"
          style={styles.actionButton}
          onPress={() => {
            void clubApi.leave(clubId).then(onLeft, onLeft);
          }}
        />
      </View>
    </Card>
  );
}

function DeleteClub({
  clubId,
  name,
  onDeleted,
}: {
  clubId: string;
  name: string;
  onDeleted: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <Action
        label="Delete club"
        variant="danger"
        onPress={() => setConfirming(true)}
        accessibilityLabel={`Delete ${name}`}
      />
    );
  }

  return (
    <Card>
      <Text style={styles.meta}>
        Delete {name} for everybody? Its chat history, races, car groups, meetings, polls and news go
        with it, for every member. This cannot be undone.
      </Text>
      <View style={styles.actions}>
        <Action
          label="Keep it"
          variant="secondary"
          style={styles.actionButton}
          onPress={() => setConfirming(false)}
        />
        <Action
          label="Delete for good"
          variant="danger"
          style={styles.actionButton}
          onPress={() => {
            void clubApi.remove(clubId).then(onDeleted, onDeleted);
          }}
        />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  title: { ...type.title, color: color.textPrimary },
  badges: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' },
  link: { ...type.bodySmall, color: color.tertiary },
  meta: { ...type.bodySmall, color: color.textSecondary },
  actions: { flexDirection: 'row', gap: space.sm },
  actionButton: { flex: 1 },
});
