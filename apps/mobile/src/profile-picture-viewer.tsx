/**
 * Somebody's profile picture, full screen, and nothing else.
 *
 * > **Deliberately NOT `PhotoViewer`, and the difference is a product decision rather than a
 * > styling one.** That component is for a photograph somebody posted into a conversation: it
 * > carries the sender, the day, a way back to the message, Share, Download and Report, because
 * > all of those are true of content. **A profile picture is not content, it is identity.** You
 * > cannot save one, share one, or report one from here - "you should not download somebody's
 * > profile picture" was the founder's phrasing on 2026-08-12, and removing the menu is the
 * > enforcement rather than a preference.
 *
 * So there is no chrome at all: black, the picture centred in it, and a gesture out. No close
 * button, because a control drawn over somebody's face is the thing this screen exists to avoid.
 *
 * ### Dismissing
 *
 * **Drag in any direction.** The picture follows the finger and the black fades as it goes, so
 * the gesture reports its own progress - past a threshold it leaves, short of it it springs back.
 * That is the same physics every photo viewer on a phone uses, and it is the reason a close
 * button is not missed.
 *
 * **A tap also dismisses**, and that is not decoration. A drag cannot be performed with a switch,
 * a keyboard, or VoiceOver's gestures, so gesture-only would make this screen a trap for exactly
 * the people least able to escape it. The whole surface is one labelled button as far as
 * assistive technology is concerned; it just does not draw itself as one.
 */

import { useRef } from 'react';
import { Animated, Modal, PanResponder, Pressable, StyleSheet, View } from 'react-native';
import { RemoteImage } from './media-bubble.tsx';

/** How far the picture travels before letting go dismisses rather than springing back. */
const ESCAPE_DISTANCE = 110;

/**
 * How far a finger moves before this claims the gesture.
 *
 * Small, but not zero: claiming at zero would swallow the tap, which is the other way out.
 */
const CLAIM_DISTANCE = 6;

/**
 * The frame the picture is shown in: the full width of the screen, square.
 *
 * > **Square because that is what a profile picture already IS.** `pickSquarePicture` crops every
 * > one to `aspect: [1, 1]` on both platforms, and every avatar in the product draws that square
 * > - as a circle for a person, a rounded square for a club. Opening it should show the same
 * > picture larger, not a differently-shaped one.
 *
 * Full width with a square frame is also exactly the arrangement asked for: **black above and
 * below, and none at the sides**. A frame narrower than the screen would put bands on all four
 * edges, and letting a photograph's own aspect decide the height is what made one member's
 * picture bleed edge to edge while another's sat in generous black.
 */
const PICTURE_ASPECT = 1;

export function ProfilePictureViewer({
  mediaId,
  name,
  onClose,
}: {
  mediaId: string;
  /** Whose picture it is, for the screen reader. Never drawn - the picture is the whole screen. */
  name: string;
  onClose: () => void;
}) {
  const pan = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  /** Distance travelled, driving the backdrop's fade. Tracked separately so it stays a number. */
  const travelled = useRef(new Animated.Value(0)).current;

  const responder = useRef(
    PanResponder.create({
      // Never on touch-down: the tap has to survive, and claiming the start would eat it.
      onMoveShouldSetPanResponder: (_event, gesture) =>
        Math.abs(gesture.dx) > CLAIM_DISTANCE || Math.abs(gesture.dy) > CLAIM_DISTANCE,
      onPanResponderMove: (_event, gesture) => {
        pan.setValue({ x: gesture.dx, y: gesture.dy });
        travelled.setValue(Math.hypot(gesture.dx, gesture.dy));
      },
      onPanResponderRelease: (_event, gesture) => {
        const distance = Math.hypot(gesture.dx, gesture.dy);
        if (distance > ESCAPE_DISTANCE) {
          onClose();
          return;
        }
        // Short of the threshold: back where it started, so a half-gesture reads as refused
        // rather than as nothing having happened.
        Animated.parallel([
          Animated.spring(pan, { toValue: { x: 0, y: 0 }, useNativeDriver: true, damping: 22 }),
          Animated.spring(travelled, { toValue: 0, useNativeDriver: true, damping: 22 }),
        ]).start();
      },
      // A gesture taken away mid-drag settles the same way rather than leaving the picture
      // stranded off-centre.
      onPanResponderTerminate: () => {
        pan.setValue({ x: 0, y: 0 });
        travelled.setValue(0);
      },
    }),
  ).current;

  /*
   * The black fades as the picture travels, so the screen behind starts showing through before
   * the gesture completes. `useNativeDriver` because both are transforms and an opacity - this
   * runs on the UI thread and keeps up with the finger.
   */
  const backdropOpacity = travelled.interpolate({
    inputRange: [0, ESCAPE_DISTANCE * 2],
    outputRange: [1, 0.25],
    extrapolate: 'clamp',
  });

  return (
    /*
     * A `Modal`, not an absolutely-positioned view inside the screen.
     *
     * > **The navigator's header sits ABOVE a screen's content**, so an overlay inside the screen
     * > covers everything except the one strip carrying somebody else's name and a back arrow -
     * > which is exactly the chrome this screen exists to remove. A modal renders above the
     * > navigator, so "the whole screen is black with the picture on it" is true rather than
     * > nearly true.
     *
     * `onRequestClose` is Android's hardware back button, which must dismiss this the same way a
     * swipe does or the only way out is a gesture the OS has just overridden.
     */
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.viewer} {...responder.panHandlers}>
        <Animated.View style={[styles.backdrop, { opacity: backdropOpacity }]} />

        {/*
          The whole surface is the way out for anybody not using a finger. It is a button with a
          label and no appearance, which is the opposite of the usual mistake - drawing a control
          that announces nothing.
        */}
        <Pressable
          style={styles.tapTarget}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={`${name}'s picture. Close`}
          accessibilityHint="Swipe in any direction, or tap, to go back"
        >
          <Animated.View
            style={[styles.stage, { transform: [{ translateX: pan.x }, { translateY: pan.y }] }]}
          >
            {/*
              `RemoteImage` rather than a bare `Image`: it owns the resolve, the spinner and the
              honest "Photo unavailable", so somebody whose access has lapsed sees the same
              truthful thing here as everywhere else.

              `cover` against a square frame, which for a profile picture crops nothing - the
              stored image is already square. It matters only for a picture uploaded before the
              crop step existed, and there it fills the frame rather than leaving bands down the
              sides. That is the same square every avatar in the product already draws.
            */}
            <RemoteImage
              mediaId={mediaId}
              variant="display"
              style={styles.picture}
              resizeMode="cover"
              accessibilityLabel={`${name}'s profile picture`}
            />
          </Animated.View>
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  /** Fills the modal, which is itself the whole screen including the navigator's header. */
  viewer: { flex: 1 },
  // Its own layer rather than a background on the container, so it can fade while the picture
  // moves independently of it.
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#000' },
  tapTarget: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  stage: { width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' },
  /*
   * Full width, square, centred - so the black is above and below and nowhere else.
   *
   * > **The black has to be a property of the SCREEN, not of the photograph.** Letting a
   * > picture's own aspect decide meant one member's opened into generous bands and another's
   * > bled edge to edge, because a phone photo held upright is very nearly the screen's own
   * > ratio. Two people's faces should not open into two differently-shaped screens.
   */
  picture: { width: '100%', aspectRatio: PICTURE_ASPECT },
});
