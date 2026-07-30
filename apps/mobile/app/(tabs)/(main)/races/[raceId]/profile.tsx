/**
 * Race profile: the race's identity, and the two things that hang off it.
 *
 * The same screen as the club's profile one level down, and deliberately so - a race is a
 * mini-club, so its identity screen is the club's shape with the club-only parts removed. There is
 * no invite link here, because a race is never joined by link: access is always by request or by a
 * manager adding somebody (`PRD/09`), and ADR-0010's front door is the club's.
 *
 * > **Reached by tapping the race's name in the header, from anywhere inside the race.** Which is
 * > the only reason the header carries an identity at all rather than a screen title.
 *
 * The two authorities on this screen are different things and are not interchangeable:
 *
 *  - **Manager** (a club admin) may change the picture, the name and the date, and may delete the
 *    race. Management authority, which confers no access.
 *  - **Member** (a roster row) may leave. Access, which confers no authority.
 *
 * A club admin who is not on the roster therefore sees Delete and no Leave, and a runner sees
 * Leave and no Delete. Both are correct, and conflating the two was wrong in five separate places
 * in v1.
 */

import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { raceApi } from '../../../../../src/api.ts';
import { useSession } from '../../../../../src/chat-provider.tsx';
import { useDeclareRace } from '../../../../../src/current-space.tsx';
import { formatDateLong } from '../../../../../src/dates.ts';
import { RemoteImage } from '../../../../../src/media-bubble.tsx';
import { color, radius, space, type } from '../../../../../src/theme.ts';
import { pickPhoto, uploadAvatar, UploadError } from '../../../../../src/upload.ts';
import { Action, Avatar, Card, DataScreen } from '../../../../../src/ui.tsx';
import { useLoad } from '../../../../../src/use-load.ts';

export default function RaceProfileScreen() {
  const { raceId } = useLocalSearchParams<{ raceId: string }>();
  const router = useRouter();
  const load = useLoad(() => raceApi.detail(raceId), [raceId]);
  const roster = useLoad(() => raceApi.roster(raceId).catch(() => null), [raceId]);
  // Declared after the read it names, so the header picks up a changed picture immediately.
  useDeclareRace(raceId, load.data?.race.clubId, load.data?.race.name, load.data?.race.image);

  const [picture, setPicture] = useState(false);
  const [pictureError, setPictureError] = useState<string | null>(null);

  /** The race's picture, manager only. Identity media, exactly like a club's or a person's. */
  const changePicture = async () => {
    setPictureError(null);
    const picked = await pickPhoto();
    if (!picked) return;
    setPicture(true);
    try {
      const mediaId = await uploadAvatar(picked);
      await raceApi.update(raceId, { image: mediaId });
      load.reload();
    } catch (error) {
      setPictureError(
        error instanceof UploadError ? error.message : 'Could not update the picture.',
      );
    } finally {
      setPicture(false);
    }
  };

  return (
    <DataScreen load={load} errorMessage="Couldn't load this race.">
      {(data) => {
        const race = data.race;
        const viewer = race.viewer;
        /*
         * The roster read is allowed to fail without taking the screen with it - a club member
         * previewing a race they have no access to cannot read its roster, and that is a correct
         * refusal rather than an error. They still see the race's identity, which is the point of
         * the preview.
         */
        const members = roster.data?.members ?? [];

        return (
          <ScrollView style={styles.flex} contentContainerStyle={styles.body}>
            <View style={styles.avatarWrap}>
              {race.image === null ? (
                <View style={styles.avatar}>
                  <Text style={styles.avatarInitial}>{race.name.charAt(0).toUpperCase()}</Text>
                </View>
              ) : (
                <RemoteImage
                  mediaId={race.image}
                  variant="display"
                  style={styles.avatar}
                  resizeMode="cover"
                />
              )}
              {viewer.isManager && (
                <Pressable
                  style={styles.editPic}
                  onPress={() => void changePicture()}
                  disabled={picture}
                  accessibilityRole="button"
                  accessibilityLabel="Change the race picture"
                >
                  {picture ? (
                    <ActivityIndicator size="small" color={color.onAccent} />
                  ) : (
                    <MaterialIcons name="edit" size={18} color={color.onAccent} />
                  )}
                </Pressable>
              )}
            </View>

            <View style={styles.nameRow}>
              <Text style={styles.name}>{race.name}</Text>
              {viewer.isManager && (
                <Pressable
                  onPress={() => router.push(`/races/${raceId}/edit`)}
                  hitSlop={space.sm}
                  accessibilityRole="button"
                  accessibilityLabel="Edit the race"
                >
                  <MaterialIcons name="edit-note" size={22} color={color.textPrimary} />
                </Pressable>
              )}
            </View>
            {/*
              The date, spelled out. `raceDate` is a plain calendar day rather than a timestamp -
              a race has a day, not a time - so it is formatted without ever becoming a Date in
              UTC, which is the bug that rendered every race a day early west of Greenwich.
            */}
            <Text style={styles.date}>{formatDateLong(race.raceDate)}</Text>
            {pictureError !== null && <Text style={styles.error}>{pictureError}</Text>}

            <Pressable
              style={styles.card}
              onPress={() => router.push(`/races/${raceId}/roster`)}
              accessibilityRole="button"
              accessibilityLabel={`Members, ${race.memberCount}`}
            >
              <View style={[styles.cardIcon, { backgroundColor: color.accent }]}>
                <MaterialIcons name="group" size={22} color={color.onAccent} />
              </View>
              <View style={styles.cardText}>
                <Text style={styles.cardLabel}>Members</Text>
                <Text style={styles.cardMeta}>{race.memberCount}</Text>
              </View>
              <AvatarStack members={members} />
              <MaterialIcons name="chevron-right" size={22} color={color.textSecondary} />
            </Pressable>

            {/*
              The race gallery's only entry point. It was built in Phase 3 and reachable from
              nowhere until this screen existed - the same gap the club's gallery had.
            */}
            {viewer.channelId !== null && (
              <Pressable
                style={styles.card}
                onPress={() => router.push(`/channels/${viewer.channelId}/gallery`)}
                accessibilityRole="button"
                accessibilityLabel="Gallery"
              >
                <View style={[styles.cardIcon, { backgroundColor: color.tertiary }]}>
                  <MaterialIcons name="photo-library" size={22} color={color.onAccent} />
                </View>
                <View style={styles.cardText}>
                  <Text style={styles.cardLabel}>Gallery</Text>
                </View>
                <MaterialIcons name="chevron-right" size={22} color={color.textSecondary} />
              </Pressable>
            )}

            {/*
              Access and authority, drawn separately because they ARE separate. A runner leaves; a
              club admin deletes; somebody who is both sees both.
            */}
            {viewer.hasAccess && (
              <LeaveRace
                raceId={raceId}
                name={race.name}
                onLeft={() => router.replace(`/clubs/${race.clubId}`)}
              />
            )}
            {viewer.isManager && (
              <DeleteRace
                raceId={raceId}
                name={race.name}
                onDeleted={() => router.replace(`/clubs/${race.clubId}`)}
              />
            )}
          </ScrollView>
        );
      }}
    </DataScreen>
  );
}

/** The first few faces on the roster, overlapped. Decoration for the row, so it is hidden. */
function AvatarStack({
  members,
}: {
  members: ReadonlyArray<{ userId: string; name: string; image: string | null }>;
}) {
  return (
    <View style={styles.stack} accessibilityElementsHidden importantForAccessibility="no">
      {members.slice(0, 4).map((member, index) => (
        <View
          key={member.userId}
          style={[styles.stackItem, index === 0 ? null : styles.stackItemOverlap]}
        >
          <Avatar name={member.name} image={member.image} size={28} />
        </View>
      ))}
    </View>
  );
}

/**
 * Leaving a race, for anybody on its roster.
 *
 * The confirmation names the car group, because leaving silently vacates it - and if they were
 * its Incharge, that group is left without one until a manager assigns another. One action, an
 * effect on other people's travel arrangements.
 */
function LeaveRace({
  raceId,
  name,
  onLeft,
}: {
  raceId: string;
  name: string;
  onLeft: () => void;
}) {
  const { userId } = useSession();
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <Pressable
        style={styles.leaveButton}
        onPress={() => setConfirming(true)}
        accessibilityRole="button"
        accessibilityLabel={`Leave ${name}`}
      >
        <Text style={styles.leaveLabel}>Leave Race</Text>
      </Pressable>
    );
  }

  return (
    <Card>
      <Text style={styles.meta}>
        Leave {name}? You lose its chat and your place in any car group. Getting back in means
        asking again.
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
          // `userId` is null only when signed out, which cannot reach this screen - but the
          // guard is here rather than an assertion, because a Leave button that silently posts
          // `null` would remove nobody and report success.
          disabled={userId === null}
          onPress={() => {
            if (userId === null) return;
            void raceApi.removeMember(raceId, userId).then(onLeft, onLeft);
          }}
        />
      </View>
    </Card>
  );
}

function DeleteRace({
  raceId,
  name,
  onDeleted,
}: {
  raceId: string;
  name: string;
  onDeleted: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <Pressable
        style={styles.deleteButton}
        onPress={() => setConfirming(true)}
        accessibilityRole="button"
        accessibilityLabel={`Delete ${name}`}
      >
        <Text style={styles.deleteLabel}>Delete Race</Text>
      </Pressable>
    );
  }

  return (
    <Card>
      <Text style={styles.meta}>
        Delete {name} for everybody? Its chat history, roster, car groups, Meet Information and
        polls go with it. This cannot be undone.
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
            void raceApi.remove(raceId).then(onDeleted, onDeleted);
          }}
        />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: color.appBackground },
  body: { alignItems: 'center', padding: space.md, paddingBottom: space.xl, gap: space.sm },
  meta: { ...type.bodySmall, color: color.textSecondary },
  error: { ...type.bodySmall, color: color.error },

  avatarWrap: { width: 140, height: 140, marginTop: space.sm },
  // A rounded square rather than a circle: a race is a thing, and the circle is for people.
  avatar: {
    width: 140,
    height: 140,
    borderRadius: radius.xl,
    backgroundColor: color.cardRaised,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  avatarInitial: { ...type.display, fontSize: 48, lineHeight: 56, color: color.accent },
  editPic: {
    position: 'absolute',
    right: -4,
    bottom: -4,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: color.accent,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: color.appBackground,
  },

  nameRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.sm },
  name: { ...type.title, fontSize: 24, lineHeight: 30, color: color.textPrimary },
  date: { ...type.bodySmall, color: color.textSecondary, marginBottom: space.sm },

  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    width: '100%',
    maxWidth: 420,
    backgroundColor: color.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.hairline,
    padding: space.md,
  },
  cardIcon: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardText: { flex: 1 },
  cardLabel: { ...type.title, fontSize: 17, lineHeight: 22, color: color.textPrimary },
  cardMeta: { ...type.bodySmall, color: color.textSecondary },

  stack: { flexDirection: 'row', alignItems: 'center', marginRight: space.xs },
  stackItem: { borderRadius: 16, borderWidth: 2, borderColor: color.card },
  stackItemOverlap: { marginLeft: -10 },

  // Outlined rather than filled: destructive, and one tap from a confirmation rather than from
  // the deed. A solid red button here would read as the primary action of the screen.
  deleteButton: {
    width: '100%',
    maxWidth: 420,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.error,
    paddingVertical: space.md,
    alignItems: 'center',
    marginTop: space.sm,
  },
  deleteLabel: { ...type.headline, color: color.error },
  leaveButton: {
    width: '100%',
    maxWidth: 420,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.hairline,
    paddingVertical: space.md,
    alignItems: 'center',
    marginTop: space.lg,
  },
  leaveLabel: { ...type.headline, color: color.textSecondary },

  actions: { flexDirection: 'row', gap: space.sm },
  actionButton: { flex: 1 },
});
