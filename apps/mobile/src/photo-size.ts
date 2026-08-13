/**
 * How large a photo is drawn in a conversation.
 *
 * **A module of its own, with no `react-native` import, so it can be tested.** Vitest cannot parse
 * React Native's own sources - they carry Flow syntax - so anything imported from a file that
 * reaches `react-native` is untestable, which is why this project's tested logic (`dates`,
 * `mentions`, `chat-rows`) is always a plain module beside the component that uses it. Putting
 * this arithmetic in `media-bubble.tsx` made its test fail to import at all.
 */

/**
 * **Width-driven, with height as the backstop.**
 *
 * Capping the long edge instead - which this did first - makes a portrait narrow, because its long
 * edge is its height: a 3:4 photo came out 150 wide where a landscape got the full 200. GroupMe
 * gives a portrait the same width as anything else and lets it be tall, which is what the founder
 * compared against, so width leads and the height cap exists only to stop a genuinely tall
 * panorama running down the screen.
 *
 * At 240 a photo is about 60% of a phone's width, which is the proportion in the reference.
 */
export const PHOTO_MAX_WIDTH = 240;
export const PHOTO_MAX_HEIGHT = 320;

/**
 * Aspect ratios already measured, by the id of the thing measured.
 *
 * **A photo must change height at most once, ever.** The dimensions are not on the wire - the
 * media row stores a mime type, a byte count and its variant keys, and nothing about shape - so
 * the first render of a photo nobody has seen is necessarily a guess that then corrects itself.
 * What must not happen is that guess repeating: a chat list unmounts the cells that scroll out of
 * view, so without this every photo re-measured and re-jumped each time it came back, and a reader
 * moving up and down through a conversation with pictures in it saw the list lurch continually.
 *
 * Module-level rather than React state for exactly that reason - it has to outlive the component.
 * Unbounded, deliberately: an entry is two numbers keyed by a uuid, and a session would need tens
 * of thousands of distinct photos before it was worth the eviction logic.
 */
const measured = new Map<string, number>();

/** What was learned last time this photo was on screen, if it has been. */
export function rememberedRatio(key: string | null): number | null {
  if (key === null) return null;
  return measured.get(key) ?? null;
}

/** Remember a measurement, so this photo never has to resize on screen again. */
export function rememberRatio(key: string | null, ratio: number): void {
  if (key !== null && Number.isFinite(ratio) && ratio > 0) measured.set(key, ratio);
}

/**
 * The box a photo of a given aspect is drawn in.
 *
 * `ratio` is width over height, or null when the image has not been measured yet - in which case
 * the caller pairs the square this returns with `contain`, so an unmeasured photo is letterboxed
 * against a transparent background rather than cropped.
 */
export function photoSize(ratio: number | null): { width: number; height: number } {
  if (ratio === null || !Number.isFinite(ratio) || ratio <= 0) {
    return { width: PHOTO_MAX_WIDTH, height: PHOTO_MAX_WIDTH };
  }

  const height = PHOTO_MAX_WIDTH / ratio;
  if (height <= PHOTO_MAX_HEIGHT) {
    return { width: PHOTO_MAX_WIDTH, height: Math.round(height) };
  }

  /*
    Too tall: the height cap wins and the width comes back down with it.

    Leaving the width at its maximum here is the mistake worth guarding - the photo would be the
    right height in the wrong shape, which reads as "a bit narrow" rather than as a bug.
  */
  return { width: Math.round(PHOTO_MAX_HEIGHT * ratio), height: PHOTO_MAX_HEIGHT };
}
