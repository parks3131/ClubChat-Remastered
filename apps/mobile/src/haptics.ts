/**
 * The buzz that acknowledges a long press.
 *
 * A long press has no visual progress. Without haptics the only way to learn it worked is the
 * menu arriving, and the only way to learn you have not held long enough is nothing happening -
 * which is indistinguishable from a dead control. The buzz is the acknowledgement, and it has to
 * land BEFORE anything is drawn, or it is a reaction to the menu rather than to the gesture.
 *
 * **One function rather than a call at each site**, because "the same vibration everywhere" is a
 * claim about a single constant. Chat bubbles had `ImpactFeedbackStyle.Medium` and the two list
 * screens had nothing at all, so the identical gesture felt like a different control depending on
 * where you performed it. Anything that long-presses calls this and inherits the feel.
 *
 * Fire-and-forget on purpose. On a device with system haptics turned off, on a simulator, or on
 * web where there is no Taptic Engine, this rejects - and whatever it precedes must still open.
 * A missing buzz degrades the affordance; an unhandled rejection would break the gesture.
 */

import * as Haptics from 'expo-haptics';

export function longPressFeedback(): void {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
}
