/**
 * The bottom of a screen, kept above the keyboard.
 *
 * A replacement for React Native's `KeyboardAvoidingView`, which this screen used until
 * 2026-08-14 and which is nearly right. Two things it does not allow, both of which the founder
 * asked for from the device:
 *
 * 1. **A duration of our own.** RN animates the padding for exactly as long as the keyboard says
 *    it will take, in both directions. The keyboard's rise reads as sluggish behind a screenful
 *    of messages that all have to re-lay out with it, and there is no prop for it.
 * 2. **No `await` between the event and the state.** RN's version resolves the height in an
 *    `async` method, so the change is scheduled a microtask after the keyboard has already begun
 *    to move. Small, and it is on the one path where being a frame late is visible.
 *
 * Everything else is deliberately the same, including the mechanism: `LayoutAnimation` with the
 * keyboard's own curve, which is what makes the bar and the conversation above it move as one
 * piece rather than on two clocks.
 *
 * **The state lives here rather than in the screen**, and that is the point of it being a
 * component. A keyboard event must not re-render a chat screen: its children are the same element
 * objects each time, so React re-renders this view and diffs nothing else.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { Keyboard, LayoutAnimation, Platform, View, type StyleProp, type ViewStyle } from 'react-native';

/**
 * How much of the keyboard's own duration the rise gets.
 *
 * Founder-set from the device on 2026-08-14: at the keyboard's full duration the bar read as
 * sluggish. Shortening it is safe in the direction that matters - the bar arrives before the keys
 * settle rather than after them, and being early reads as responsive where being late reads as
 * broken. Not a spring, and not zero: "it's not like it comes in a blink, it is smooth and fast".
 */
const RISE = 0.7;

/** Below this the animation reads as a jump. RCTLayoutAnimation's own floor is 10ms. */
const MIN_DURATION = 120;

export function KeyboardAvoider({
  children,
  style,
  offset = 0,
  enabled = true,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  /**
   * Points of the keyboard this view does NOT need to avoid.
   *
   * For a bar that already carries the home indicator's space, that is the bottom safe-area
   * inset: the padding needed is the keyboard minus what the bar is already holding, or the two
   * stack and the bar floats above the keys.
   */
  offset?: number;
  enabled?: boolean;
}) {
  const [bottom, setBottom] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setBottom(0);
      return;
    }

    /*
     * `will` on iOS, `did` on Android. iOS announces the change before it animates, which is what
     * makes moving *with* the keyboard possible at all; Android has no equivalent event, so it
     * gets the late one and no animation of ours.
     */
    const ios = Platform.OS === 'ios';

    const animate = (duration: number | undefined, factor: number) => {
      if (!ios || !duration) return;
      const ms = Math.max(Math.round(duration * factor), MIN_DURATION);
      LayoutAnimation.configureNext({
        duration: ms,
        update: { duration: ms, type: LayoutAnimation.Types.keyboard },
      });
    };

    const showing = Keyboard.addListener(ios ? 'keyboardWillShow' : 'keyboardDidShow', (event) => {
      animate(event.duration, RISE);
      setBottom(Math.max(event.endCoordinates.height - offset, 0));
    });

    /*
     * **The fall is not animated, and that is not laziness.**
     *
     * The keyboard is sliding down over its own quarter of a second, and it is *on top of* this
     * app - so the space it is vacating is hidden behind it for the whole descent. Dropping the
     * padding immediately puts the conversation where it belongs while the keys are still
     * covering the change, and the reader sees the keyboard leave to reveal a finished screen.
     *
     * Animate it instead and the opposite happens: the content crawls down BEHIND the departing
     * keyboard and arrives after it, which is exactly what was reported twice as "the message is
     * dropping so slow". React Native's own `KeyboardAvoidingView` gets this right by omission -
     * its hide path returns before it configures an animation - and copying the mechanism without
     * copying that asymmetry is how it came back.
     */
    const hiding = Keyboard.addListener(ios ? 'keyboardWillHide' : 'keyboardDidHide', () => {
      setBottom(0);
    });

    return () => {
      showing.remove();
      hiding.remove();
    };
  }, [offset, enabled]);

  return <View style={[style, { paddingBottom: bottom }]}>{children}</View>;
}
