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
import { ActivityIndicator, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { MaterialIcons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useDeclareClub } from '../../../../../src/current-club.tsx';
import * as Linking from 'expo-linking';
import { clubApi } from '../../../../../src/api.ts';
import { color, radius, space, type } from '../../../../../src/theme.ts';
import { RemoteImage } from '../../../../../src/media-bubble.tsx';
import { pickPhoto, uploadAvatar, UploadError } from '../../../../../src/upload.ts';
import { Action, Card, DataScreen } from '../../../../../src/ui.tsx';
import { useLoad } from '../../../../../src/use-load.ts';

export default function ClubProfileScreen() {
  const { clubId } = useLocalSearchParams<{ clubId: string }>();
  // Inside this club for as long as this screen is mounted, which is what the Clubs tab reads.
  const router = useRouter();
  const load = useLoad(() => clubApi.detail(clubId), [clubId]);
  // Declared after the read it names, so the header picks up a changed picture immediately.
  useDeclareClub(clubId, load.data?.club.name, load.data?.club.image);
  const [busy, setBusy] = useState(false);

  const [picture, setPicture] = useState(false);
  const [pictureError, setPictureError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  /** The club's picture, admin only. Identity media, exactly like a person's avatar. */
  const changePicture = async () => {
    setPictureError(null);
    const picked = await pickPhoto();
    if (!picked) return;
    setPicture(true);
    try {
      const mediaId = await uploadAvatar(picked);
      await clubApi.update(clubId, { image: mediaId });
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
    <DataScreen load={load}>
      {(data) => {
        const club = data.club;
        const viewer = club.viewer;
        const inviteUrl =
          club.inviteToken === null ? null : Linking.createURL(`/join/${club.inviteToken}`);

        return (
          <ScrollView style={styles.flex} contentContainerStyle={styles.body}>
            <View style={styles.avatarWrap}>
              {club.image === null ? (
                <View style={styles.avatar}>
                  <Text style={styles.avatarInitial}>{club.name.charAt(0).toUpperCase()}</Text>
                </View>
              ) : (
                <RemoteImage mediaId={club.image} variant="display" style={styles.avatar} resizeMode="cover" />
              )}
              {/* Admin tier only: a member cannot change the club's face. */}
              {viewer.isAdmin && (
                <Pressable
                  style={styles.editPic}
                  onPress={() => void changePicture()}
                  disabled={picture}
                  accessibilityRole="button"
                  accessibilityLabel="Change the club picture"
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
              <Text style={styles.name}>{club.name}</Text>
              {viewer.isAdmin && (
                <Pressable
                  onPress={() => router.push(`/clubs/${clubId}/edit`)}
                  hitSlop={space.sm}
                  accessibilityRole="button"
                  accessibilityLabel="Edit the club"
                >
                  <MaterialIcons name="edit-note" size={22} color={color.textPrimary} />
                </Pressable>
              )}
            </View>
            {club.description !== null && club.description.length > 0 && (
              <Text style={styles.description}>{club.description}</Text>
            )}
            {pictureError !== null && <Text style={styles.error}>{pictureError}</Text>}

            {/*
              The invite link is the ONLY invite mechanism (ADR-0010 removed the typed code), and
              the token is admin-only because it is the club's front door to anybody holding it.
            */}
            {inviteUrl !== null && (
              <View style={styles.shareRow}>
                <Pressable
                  style={styles.shareButton}
                  onPress={() => {
                    void Share.share({ message: inviteUrl }).catch(() => undefined);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="Share the join link"
                >
                  <MaterialIcons name="ios-share" size={18} color={color.onAccent} />
                  <Text style={styles.shareLabel}>Share join link</Text>
                </Pressable>
                <Pressable
                  style={styles.copyButton}
                  onPress={() => {
                    void Clipboard.setStringAsync(inviteUrl).then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    });
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="Copy the join link"
                >
                  <MaterialIcons
                    name={copied ? 'check' : 'content-copy'}
                    size={18}
                    color={color.accent}
                  />
                </Pressable>
              </View>
            )}

            <Pressable
              style={styles.card}
              onPress={() => router.push(`/clubs/${clubId}/members`)}
              accessibilityRole="button"
              accessibilityLabel={`Members, ${club.memberCount}`}
            >
              <View style={[styles.cardIcon, { backgroundColor: color.accent }]}>
                <MaterialIcons name="group" size={22} color={color.onAccent} />
              </View>
              <View style={styles.cardText}>
                <Text style={styles.cardLabel}>Members</Text>
                <Text style={styles.cardMeta}>{club.memberCount}</Text>
              </View>
              <MaterialIcons name="chevron-right" size={22} color={color.textSecondary} />
            </Pressable>

            {/*
              The gallery's home. It is reached from here rather than from chat's grid, which is
              where v1 puts it - and until this screen existed it was the one built surface with
              no entry point at all.
            */}
            {club.channelId !== null && (
              <Pressable
                style={styles.card}
                onPress={() => router.push(`/channels/${club.channelId}/gallery`)}
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

            {/* Rotation stays available: a leaked link has no alternative to fall back on. */}
            {inviteUrl !== null && (
              <Pressable
                onPress={() => {
                  setBusy(true);
                  void clubApi
                    .rotateInvite(clubId)
                    .then(load.reload, load.reload)
                    .finally(() => setBusy(false));
                }}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel="Rotate the join link, invalidating every link already shared"
              >
                <Text style={styles.rotate}>
                  {busy ? 'Rotating' : 'Rotate link - invalidates every link already shared'}
                </Text>
              </Pressable>
            )}

            {/*
              The Owner deletes; everybody else leaves. The Owner has no Leave control at all,
              which is not an oversight: an ownerless club cannot be recovered, so transfer is the
              only path out.
            */}
            {viewer.isOwner ? (
              <>
                <Text style={styles.note}>Transfer ownership from Members to leave this club.</Text>
                <DeleteClub
                  clubId={clubId}
                  name={club.name}
                  onDeleted={() => router.replace('/clubs')}
                />
              </>
            ) : (
              <LeaveClub clubId={clubId} name={club.name} onLeft={() => router.replace('/clubs')} />
            )}
          </ScrollView>
        );
      }}
    </DataScreen>
  );
}

/**
 * Leaving, for anybody who is not the Owner.
 *
 * The Owner never sees this: an ownerless club cannot be recovered, so transfer is the only path
 * out for them. The confirmation names what is lost, because leaving a club also removes the
 * member from every race roster, car group and the Eboard space in that club - which is one
 * action with a much wider effect than its label suggests.
 */
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
      <Pressable
        style={styles.leaveButton}
        onPress={() => setConfirming(true)}
        accessibilityRole="button"
        accessibilityLabel={`Leave ${name}`}
      >
        <Text style={styles.leaveLabel}>Leave club</Text>
      </Pressable>
    );
  }

  return (
    <Card>
      <Text style={styles.meta}>
        Leave {name}? You lose access to its chat, every race in it, and the Eboard space. You can
        rejoin only the way you joined the first time.
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
      <Pressable
        style={styles.deleteButton}
        onPress={() => setConfirming(true)}
        accessibilityRole="button"
        accessibilityLabel={`Delete ${name}`}
      >
        <Text style={styles.deleteLabel}>Delete Club</Text>
      </Pressable>
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
  flex: { flex: 1, backgroundColor: color.appBackground },
  body: { alignItems: 'center', padding: space.md, paddingBottom: space.xl, gap: space.sm },
  meta: { ...type.bodySmall, color: color.textSecondary },
  error: { ...type.bodySmall, color: color.error },

  avatarWrap: { width: 140, height: 140, marginTop: space.sm },
  // A rounded square rather than a circle: a club is a thing, and the circle is for people.
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
  description: { ...type.body, color: color.textSecondary, textAlign: 'center' },

  shareRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginVertical: space.sm },
  shareButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: color.accent,
    borderRadius: radius.pill,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm + 4,
  },
  shareLabel: { ...type.label, color: color.onAccent, textTransform: 'uppercase' },
  copyButton: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },

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

  rotate: { ...type.bodySmall, color: color.textSecondary, textAlign: 'center', paddingTop: space.sm },
  note: {
    ...type.bodySmall,
    color: color.textSecondary,
    textAlign: 'center',
    marginTop: space.lg,
  },

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
