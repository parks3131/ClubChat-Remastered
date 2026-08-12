/**
 * Sharing a club: the link, the code, and everywhere else the link can go.
 *
 * **Every member sees this screen, and only an admin can rotate what it hands out** (ADR-0024).
 * A club grows by its members bringing people, and an invite only an admin could send is one a
 * member routes around by asking an admin to paste a link - the same access, with a person in
 * the middle and a day's delay.
 *
 * > **The link is the only invite mechanism** (ADR-0010 removed the typed code), so this screen is
 * > the club's front door. It is reachable only from inside the club, and a non-member cannot read
 * > the club at all - which is what withholds the token, rather than anything this screen does.
 *
 * Copy Link carries no chevron. Every other row here goes somewhere; that one acts and stays put,
 * and a chevron on it would promise a screen that never arrives.
 */

import { useState } from 'react';
import { Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as Linking from 'expo-linking';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialIcons } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { clubApi } from '../../../../../src/api.ts';
import { useDeclareClub } from '../../../../../src/current-space.tsx';
import { RemoteImage } from '../../../../../src/media-bubble.tsx';
import { avatarTint, color, radius, space, tabBarSpace, type } from '../../../../../src/theme.ts';
import { ConfirmDialog, DataScreen, Row } from '../../../../../src/ui.tsx';
import { useLoad } from '../../../../../src/use-load.ts';

export default function ShareClubScreen() {
  const { clubId } = useLocalSearchParams<{ clubId: string }>();
  const load = useLoad(() => clubApi.detail(clubId), [clubId]);
  useDeclareClub(clubId, load.data?.club.name, load.data?.club.image);
  const insets = useSafeAreaInsets();

  const [copied, setCopied] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);
  const [confirmingRotate, setConfirmingRotate] = useState(false);

  return (
    <DataScreen load={load} errorMessage="Couldn't load this club.">
      {(data) => {
        const club = data.club;
        const inviteUrl = Linking.createURL(`/join/${club.inviteToken}`);

        return (
          <>
            <ScrollView
              style={styles.flex}
              contentContainerStyle={[
                styles.body,
                { paddingBottom: tabBarSpace(insets.bottom) + space.lg },
              ]}
            >
              {/*
                What the link looks like when it lands: the club's own face, its name, and what
                tapping it does. The same three facts a recipient needs and the reason this is a
                preview rather than a URL on its own - a raw `clubchat://` string tells somebody
                nothing about whose club they are being asked to join.
              */}
              <View style={styles.preview}>
                {club.image === null ? (
                  /*
                    The lettered fallback, exactly as `Avatar` draws it: most clubs have no
                    picture, so this is the ordinary case rather than a missing one, and a bare
                    coloured rectangle would read as an image that failed to load.
                  */
                  <View
                    style={[styles.previewFill, styles.previewFallback, { backgroundColor: avatarTint(clubId) }]}
                    accessibilityElementsHidden
                    importantForAccessibility="no"
                  >
                    <Text style={styles.previewInitial}>{club.name.charAt(0).toUpperCase()}</Text>
                  </View>
                ) : (
                  <RemoteImage
                    mediaId={club.image}
                    variant="display"
                    style={styles.previewFill}
                    resizeMode="cover"
                    accessibilityLabel={`${club.name}'s picture`}
                  />
                )}
                {/*
                  A scrim under the text rather than a solid band, because the picture is the
                  point: it darkens where the words are and leaves the rest of the photograph
                  alone. Without it a name lands on whatever the photo happens to be.
                */}
                <LinearGradient
                  colors={['transparent', 'rgba(0,0,0,0.65)']}
                  style={styles.previewFill}
                />
                <View style={styles.previewText}>
                  <Text style={styles.previewName} numberOfLines={2}>
                    {club.name}
                  </Text>
                  <Text style={styles.previewJoin}>Join on ClubChat</Text>
                </View>
              </View>

              <View style={styles.rows}>
                <Row
                  title="Copy Link"
                  navigates={false}
                  left={
                    <View style={[styles.well, styles.wellQuiet]}>
                      <MaterialIcons name="link" size={22} color={color.textPrimary} />
                    </View>
                  }
                  onPress={() => {
                    void Clipboard.setStringAsync(inviteUrl).then(
                      () => {
                        setCopied('Link copied');
                        setTimeout(() => setCopied(null), 2000);
                      },
                      () => {
                        // A copy that fails silently is worse than one that fails: the member
                        // walks away believing they are holding the link.
                        setCopied("Couldn't copy - use Share to...");
                        setTimeout(() => setCopied(null), 3000);
                      },
                    );
                  }}
                />
                {/*
                  The featured row, and the only filled well on the screen: the code is the new
                  thing here, and it is what somebody standing in front of you can use.
                */}
                <Row
                  title="Share QR code"
                  href={`/clubs/${clubId}/qr`}
                  left={
                    <View style={[styles.well, styles.wellAccent]}>
                      <MaterialIcons name="qr-code-2" size={22} color={color.onAccent} />
                    </View>
                  }
                />
                <Row
                  title="Share to..."
                  left={
                    <View style={[styles.well, styles.wellQuiet]}>
                      <MaterialIcons name="ios-share" size={20} color={color.textPrimary} />
                    </View>
                  }
                  onPress={() => {
                    void Share.share({ message: inviteUrl }).catch(() => undefined);
                  }}
                  accessibilityLabel="Share the join link to another app"
                />
              </View>

              {/*
                What YOUR link does, which is not the same sentence for everybody (ADR-0025).
                An admin's bypasses the join policy; a member's obeys it. The screen says which
                rather than describing the club, because the person reading this is about to
                hand the link to somebody and needs to know what happens when they open it.
              */}
              <Text style={styles.note}>
                {club.viewer.isAdmin
                  ? `Anyone with this link joins ${club.name} straight away, even if the club normally asks people to request.`
                  : club.joinPolicy === 'request'
                    ? `Anyone with this link asks to join ${club.name}, and an admin approves them.`
                    : `Anyone with this link joins ${club.name} straight away.`}
              </Text>

              {/*
                Rotation is the admin tier's alone. It is the remedy for a leaked link and it
                invalidates every link every member has already handed out, which is why it
                confirms and why it sits at the bottom rather than beside the share actions.
              */}
              {club.viewer.isAdmin && (
                <Pressable
                  onPress={() => setConfirmingRotate(true)}
                  disabled={rotating}
                  accessibilityRole="button"
                  accessibilityLabel="Rotate the join link, invalidating every link already shared"
                >
                  <Text style={styles.rotate}>
                    {rotating ? 'Rotating' : 'Rotate link - invalidates every link already shared'}
                  </Text>
                </Pressable>
              )}
            </ScrollView>

            {/*
              The confirmation sits at the bottom of the screen rather than beside the row, which
              is where a hand that just tapped is, and where GroupMe puts it. It says the deed in
              the past tense because it has already happened - there is nothing to undo or wait for.
            */}
            {copied !== null && (
              <View
                style={[styles.toast, { bottom: tabBarSpace(insets.bottom) }]}
                accessibilityLiveRegion="polite"
              >
                <MaterialIcons name="check-circle" size={18} color={color.onAccentSoft} />
                <Text style={styles.toastLabel}>{copied}</Text>
              </View>
            )}

            {confirmingRotate && (
              <ConfirmDialog
                title="Rotate the join link?"
                body={`Every link already shared for ${club.name} stops working immediately, including ones members have sent to people who have not joined yet. You cannot bring the old one back.`}
                confirmLabel="Rotate link"
                dismissLabel="Keep it"
                onCancel={() => setConfirmingRotate(false)}
                onConfirm={() => {
                  setConfirmingRotate(false);
                  setRotating(true);
                  void clubApi
                    .rotateInvite(clubId)
                    .then(load.reload, load.reload)
                    .finally(() => setRotating(false));
                }}
              />
            )}
          </>
        );
      }}
    </DataScreen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: color.appBackground },
  body: { padding: space.md, gap: space.md, alignItems: 'center' },

  preview: {
    width: 220,
    height: 220,
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: color.cardSunken,
    marginTop: space.sm,
  },
  previewFill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  previewFallback: { alignItems: 'center', justifyContent: 'center' },
  previewInitial: { ...type.displayXl, color: color.onAccent, opacity: 0.9 },
  previewText: { position: 'absolute', left: space.md, right: space.md, bottom: space.md },
  previewName: { ...type.title, fontSize: 20, lineHeight: 25, color: color.onAccent },
  previewJoin: { ...type.bodySmall, color: color.onAccent, opacity: 0.85 },

  rows: { width: '100%', maxWidth: 460, gap: space.sm },
  well: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  wellQuiet: { backgroundColor: color.cardSunken },
  wellAccent: { backgroundColor: color.accent },

  note: {
    ...type.bodySmall,
    color: color.textSecondary,
    textAlign: 'center',
    maxWidth: 420,
    paddingTop: space.sm,
  },
  rotate: {
    ...type.bodySmall,
    color: color.textSecondary,
    textAlign: 'center',
    paddingTop: space.md,
  },

  toast: {
    position: 'absolute',
    alignSelf: 'center',
    // In the style rather than as a prop: the prop is deprecated, and it warns on every render.
    pointerEvents: 'none',
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: color.accentSoft,
    borderWidth: 1,
    borderColor: color.accentSoftBorder,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  toastLabel: { ...type.label, color: color.onAccentSoft, textTransform: 'uppercase' },
});
