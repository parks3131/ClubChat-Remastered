/**
 * Scanning somebody else's club code.
 *
 * The other half of the QR screen: one person holds up their code, the other points a phone at
 * it. Until now the code could only be *shown*, which made it useful in a message and useless in
 * the room it was designed for.
 *
 * > **It joins by handing the token to `/join/[token]`, and does not redeem anything itself.**
 * > That screen is "the only invite path there is" and already answers all five states a redeem
 * > can produce - joined, requested, banned, revoked, and signed-out-then-back. A scanner that
 * > called `redeemInvite` directly would be a second join path that starts out missing four of
 * > them, and would drift from the first the next time one of those rules changed. Scanning is a
 * > new way to *acquire* a link, not a new way to redeem one.
 *
 * So everything below is about turning a camera frame into a token, and refusing anything else.
 */

import { useCallback, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useFocusEffect, useRouter } from 'expo-router';
import { tokenFromScan } from '../../../../src/invite-link.ts';
import { Action, Body, Card } from '../../../../src/ui.tsx';
import { color, radius, space, type } from '../../../../src/theme.ts';

export default function ScanScreen() {
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const [rejected, setRejected] = useState(false);

  /*
   * A scanner fires continuously while a code is in frame, so without this the first successful
   * read navigates several times and stacks several join screens behind each other. Latched in a
   * ref rather than state because the callback must see the new value on its very next frame,
   * which is sooner than a re-render.
   */
  const handled = useRef(false);

  // Re-arm on every visit, so coming back from a join and scanning again works.
  useFocusEffect(
    useCallback(() => {
      handled.current = false;
      setRejected(false);
    }, []),
  );

  const onScanned = ({ data }: { data: string }) => {
    if (handled.current) return;
    const token = tokenFromScan(data);
    if (token === null) {
      // Not one of ours. Say so and keep scanning rather than navigating somewhere wrong.
      setRejected(true);
      return;
    }
    handled.current = true;
    /*
     * `replace`, not `push`. The scanner is a step on the way in and should not sit behind the
     * result - backing out of a club you just joined into a live camera is not a way out.
     */
    router.replace(`/join/${token}`);
  };

  if (permission === null) return <Body />;

  if (!permission.granted) {
    /*
     * Asked here rather than on mount, because a permission prompt that appears before the person
     * has seen what the screen is for gets denied - and on iOS a denial is permanent until they go
     * to Settings. The screen says what it wants the camera for first.
     */
    return (
      <Body>
        <Card>
          <Text style={styles.title}>Scan a club code</Text>
          <Text style={styles.body}>
            ClubChat needs the camera to read a club QR code. It is used for nothing else, and no
            photo is taken or stored.
          </Text>
        </Card>
        <Action
          label={permission.canAskAgain ? 'Allow camera' : 'Open Settings to allow camera'}
          onPress={() => void requestPermission()}
          accessibilityLabel="Allow ClubChat to use the camera to scan a club code"
        />
      </Body>
    );
  }

  return (
    <View style={styles.flex}>
      <CameraView
        style={styles.flex}
        // Only QR. A scanner that also reads barcodes finds a cereal box across the room.
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={onScanned}
      />
      {/*
        Over the camera rather than beside it, because the camera fills the screen and a person
        pointing a phone at a code is not reading a layout.
      */}
      <View style={styles.overlay} pointerEvents="none">
        <View style={styles.reticle} />
        <Text style={styles.hint} accessibilityLiveRegion="polite">
          {rejected
            ? 'That is not a ClubChat code. Point at a club QR code.'
            : 'Point at a club QR code'}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: color.inverseSurface },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /*
   * A frame to aim with. Square, because the thing being aimed at is - and generous, because the
   * scanner reads the whole frame anyway: this is an aiming aid, not a crop, and a tight box
   * would suggest the code has to be inside it.
   */
  reticle: {
    width: 240,
    height: 240,
    borderRadius: radius.lg,
    borderWidth: 3,
    borderColor: color.onAccent,
  },
  hint: {
    ...type.body,
    color: color.onAccent,
    textAlign: 'center',
    marginTop: space.lg,
    paddingHorizontal: space.lg,
  },
  title: { ...type.headline, color: color.textPrimary, marginBottom: space.sm },
  body: { ...type.bodySmall, color: color.textSecondary },
});
