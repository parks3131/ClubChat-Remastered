/**
 * Eboard & Council profile: the space's identity, and the two things that hang off it.
 *
 * The race profile's shape again, with one authority instead of two. A race separates management
 * from access - a club admin manages every race and is on none of them - and this space is the
 * opposite: **membership IS the authority** (`PRD/10` rule 5). So every control here is gated on
 * being inside, and none of them on being a club admin. An admin who left the space can still read
 * this screen, which is how they find the way back in, and can change nothing on it.
 *
 * > **There is no Delete.** v1 offers one and `PRD/10` rule 12 allows it, but the space is created
 * > with the club and there is exactly one per club - promotion auto-joins it and demotion
 * > auto-removes - so deleting it strands a club's admins with no space and no way to make
 * > another. The recreate path v1 has was never built here. Left out rather than shipped
 * > half-working; see the note in `api/routes/eboard.ts`.
 */

import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { eboardApi } from '../../../../../src/api.ts';
import { useSession } from '../../../../../src/chat-provider.tsx';
import { useDeclareEboard } from '../../../../../src/current-space.tsx';
import { RemoteImage } from '../../../../../src/media-bubble.tsx';
import { color, radius, space, type } from '../../../../../src/theme.ts';
import { pickPhoto, uploadAvatar, UploadError } from '../../../../../src/upload.ts';
import { Action, Avatar, Card, DataScreen } from '../../../../../src/ui.tsx';
import { useLoad } from '../../../../../src/use-load.ts';

export default function EboardProfileScreen() {
  const { eboardId } = useLocalSearchParams<{ eboardId: string }>();
  const router = useRouter();
  const load = useLoad(() => eboardApi.detail(eboardId), [eboardId]);
  // The roster is members-only, unlike a race's. An admin outside the space reads this screen
  // and gets no faces, which is the privacy boundary rather than a failure.
  const roster = useLoad(() => eboardApi.roster(eboardId).catch(() => null), [eboardId]);
  // Declared after the read it names, so the header picks up a changed picture immediately.
  useDeclareEboard(
    eboardId,
    load.data?.eboard.clubId,
    load.data?.eboard.name,
    load.data?.eboard.image,
  );

  const [picture, setPicture] = useState(false);
  const [pictureError, setPictureError] = useState<string | null>(null);

  const changePicture = async () => {
    setPictureError(null);
    const picked = await pickPhoto();
    if (!picked) return;
    setPicture(true);
    try {
      const mediaId = await uploadAvatar(picked);
      await eboardApi.update(eboardId, { image: mediaId });
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
    <DataScreen load={load} errorMessage="Couldn't load Eboard & Council.">
      {(data) => {
        const eboard = data.eboard;
        const viewer = eboard.viewer;
        const members = roster.data?.members ?? [];

        return (
          <ScrollView style={styles.flex} contentContainerStyle={styles.body}>
            <View style={styles.avatarWrap}>
              {eboard.image === null ? (
                <View style={styles.avatar}>
                  <Text style={styles.avatarInitial}>{eboard.name.charAt(0).toUpperCase()}</Text>
                </View>
              ) : (
                <RemoteImage
                  mediaId={eboard.image}
                  variant="display"
                  style={styles.avatar}
                  resizeMode="cover"
                />
              )}
              {/* Membership, not club-admin status. The whole point of this space. */}
              {viewer.isMember && (
                <Pressable
                  style={styles.editPic}
                  onPress={() => void changePicture()}
                  disabled={picture}
                  accessibilityRole="button"
                  accessibilityLabel="Change the Eboard picture"
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
              <Text style={styles.name}>{eboard.name}</Text>
              {viewer.isMember && (
                <Pressable
                  onPress={() => router.push(`/eboard/${eboardId}/edit`)}
                  hitSlop={space.sm}
                  accessibilityRole="button"
                  accessibilityLabel="Edit Eboard & Council"
                >
                  <MaterialIcons name="edit-note" size={22} color={color.textPrimary} />
                </Pressable>
              )}
            </View>
            {eboard.description !== null && eboard.description.length > 0 && (
              <Text style={styles.description}>{eboard.description}</Text>
            )}
            {pictureError !== null && <Text style={styles.error}>{pictureError}</Text>}

            <Pressable
              style={styles.card}
              onPress={() => router.push(`/eboard/${eboardId}/members`)}
              accessibilityRole="button"
              accessibilityLabel={`Members, ${eboard.memberCount}`}
            >
              <View style={[styles.cardIcon, { backgroundColor: color.accent }]}>
                <MaterialIcons name="group" size={22} color={color.onAccent} />
              </View>
              <View style={styles.cardText}>
                <Text style={styles.cardLabel}>Members</Text>
                <Text style={styles.cardMeta}>{eboard.memberCount}</Text>
              </View>
              <AvatarStack members={members} />
              <MaterialIcons name="chevron-right" size={22} color={color.textSecondary} />
            </Pressable>

            {/* The Eboard gallery's only entry point, and null for anybody outside the space. */}
            {eboard.channelId !== null && (
              <Pressable
                style={styles.card}
                onPress={() => router.push(
                    `/channels/${eboard.channelId}/gallery?parent=/eboard/${eboardId}/profile`,
                  )}
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

            {viewer.isMember && (
              <LeaveEboard
                eboardId={eboardId}
                name={eboard.name}
                onLeft={() => router.replace(`/clubs/${eboard.clubId}`)}
              />
            )}
          </ScrollView>
        );
      }}
    </DataScreen>
  );
}

/** The first few faces in the space, overlapped. Decoration for the row, so it is hidden. */
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
 * Leaving the space.
 *
 * **Any member may leave, and only the club Owner may remove somebody else** - the strictest
 * removal rule in the product, because this is its highest-trust space. So leaving is offered
 * here and removal lives on the roster.
 *
 * The confirmation says how to get back in, because the answer is genuinely non-obvious: staying
 * an admin will NOT re-add them. Promotion auto-joins, and they are already promoted - so the way
 * back is a request that somebody still inside approves. That is the one path in this space that
 * nobody uses in normal operation, and it exists for exactly this.
 */
function LeaveEboard({
  eboardId,
  name,
  onLeft,
}: {
  eboardId: string;
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
        <Text style={styles.leaveLabel}>Leave {name}</Text>
      </Pressable>
    );
  }

  return (
    <Card>
      <Text style={styles.meta}>
        Leave {name}? You lose its chat, its meetings and its polls. Staying an admin will not put
        you back - you would have to ask somebody still inside.
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
          disabled={userId === null}
          onPress={() => {
            if (userId === null) return;
            void eboardApi.removeMember(eboardId, userId).then(onLeft, onLeft);
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
  // A rounded square rather than a circle: a space is a thing, and the circle is for people.
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
