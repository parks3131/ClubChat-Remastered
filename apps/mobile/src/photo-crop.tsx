/**
 * The crop frame: a rectangle you drag over the picture, and the arithmetic that turns it into
 * source pixels.
 *
 * > **Hand-built on `PanResponder`, and it imports nothing native.** That is the point rather than
 * > a limitation. Cropping was first built against `expo-image-manipulator`, which took the app
 * > down twice - a native module is resolved at bundle load, so JS importing one reaches every
 * > phone the instant Metro serves it while the binaries carrying it are hours behind, and the
 * > prebuilt framework turned out to target a newer `ExpoModulesCore` than this app ships. See
 * > `AGENTS.md` failure modes 8 and 32.
 * >
 * > So this file decides WHERE to cut and never cuts. The rectangle travels to the server, which
 * > already decodes every uploaded photo with `sharp` and now extracts from it. No native
 * > dependency, no rebuild, and nothing here can stop the app from launching.
 *
 * **Free-form, with no fixed aspect.** `upload.ts` records why: a chat photo is shown at its own
 * proportions, so cropping it to a square would throw away most of what somebody chose to send.
 *
 * The frame is DRAWN and dragged in display points and STORED as fractions - see `crop-rect.ts`,
 * which owns the three conversions and the reason storing points was a defect. This file is the
 * gesture and nothing else.
 */

import { useRef } from 'react';
import { PanResponder, StyleSheet, View } from 'react-native';
import {
  isWholeImage,
  toNorm,
  toPoints,
  toSourceRect,
  WHOLE,
  type CropRect,
  type DisplayBox,
  type NormRect,
  type SourceRect,
} from './crop-rect.ts';
import { color } from './theme.ts';

export { isWholeImage, toNorm, toPoints, toSourceRect, WHOLE };
export type { CropRect, DisplayBox, NormRect, SourceRect };

/**
 * The smallest frame a drag may produce, in points.
 *
 * Below this the handles overlap each other and the frame becomes impossible to grow again with
 * a finger, which is a dead end rather than a small crop.
 */
const MIN_SIZE = 48;

/** The touch target around each corner. Larger than the drawn handle, which is the point. */
const HANDLE_TOUCH = 44;

type Corner = 'tl' | 'tr' | 'bl' | 'br';

/** Keep a rectangle inside its box by MOVING it. Used by the whole-frame drag, where size is fixed. */
function clampInside(rect: CropRect, box: DisplayBox): CropRect {
  return {
    ...rect,
    x: Math.max(0, Math.min(rect.x, box.width - rect.width)),
    y: Math.max(0, Math.min(rect.y, box.height - rect.height)),
  };
}

export function CropOverlay({
  display,
  rect,
  onChange,
}: {
  display: DisplayBox;
  rect: CropRect;
  onChange: (next: CropRect) => void;
}) {
  /*
   * The rect as it was when the current gesture began, plus the live rect.
   *
   * Refs rather than state, and every handler works from `start` plus the gesture's CUMULATIVE
   * `dx`. Reading the live rect and adding a delta applies each frame's movement to a value that
   * already contains it, so the frame accelerates away from the finger - the classic drag bug,
   * and the reason `PanResponder` reports cumulative offsets rather than per-frame ones.
   *
   * `live` exists because the responders are created once: a closure over `rect` would capture
   * the value from the render that built them and never see another.
   */
  const start = useRef<CropRect>(rect);
  const live = useRef<CropRect>(rect);
  live.current = rect;

  const responderFor = (grab: (from: CropRect, dx: number, dy: number) => CropRect) =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      // The scroller below must not steal a drag that started on a handle.
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        start.current = live.current;
      },
      onPanResponderMove: (_event, gesture) => {
        onChange(grab(start.current, gesture.dx, gesture.dy));
      },
    });

  /** Drag the whole frame. Size is fixed; only the origin moves, and it stays in the picture. */
  const move = useRef(
    responderFor((from, dx, dy) =>
      clampInside({ ...from, x: from.x + dx, y: from.y + dy }, display),
    ),
  ).current;

  /*
   * A corner drag moves two edges and leaves the opposite two alone.
   *
   * Written as "where is the fixed corner, and where has the dragged one got to", then normalised
   * - rather than as four sets of min/max on x/y/width/height. The second form is what produces a
   * frame that inverts when a corner is dragged past its opposite; with this one, crossing over is
   * a rectangle whose corners have swapped roles, which `Math.min`/`abs` handle for free.
   */
  const cornerResponder = (corner: Corner) =>
    responderFor((from, dx, dy) => {
      const fixedX = corner === 'tl' || corner === 'bl' ? from.x + from.width : from.x;
      const fixedY = corner === 'tl' || corner === 'tr' ? from.y + from.height : from.y;

      const movedX = (corner === 'tl' || corner === 'bl' ? from.x : from.x + from.width) + dx;
      const movedY = (corner === 'tl' || corner === 'tr' ? from.y : from.y + from.height) + dy;

      // Inside the picture first, so a finger dragged off the edge stops at it.
      const clampedX = Math.max(0, Math.min(movedX, display.width));
      const clampedY = Math.max(0, Math.min(movedY, display.height));

      const width = Math.abs(fixedX - clampedX);
      const height = Math.abs(fixedY - clampedY);

      /*
       * Below the minimum the frame is left alone rather than pinned to the minimum.
       *
       * Pinning looks equivalent and is not: it lets the frame keep sliding along the axis that is
       * still legal, so a finger dragged into a corner walks the whole rectangle across the
       * picture at minimum size. Refusing the frame leaves it where it was.
       */
      if (width < MIN_SIZE || height < MIN_SIZE) return from;
      return { x: Math.min(fixedX, clampedX), y: Math.min(fixedY, clampedY), width, height };
    });

  const corners = useRef({
    tl: cornerResponder('tl'),
    tr: cornerResponder('tr'),
    bl: cornerResponder('bl'),
    br: cornerResponder('br'),
  }).current;

  const handle = (corner: Corner) => {
    const isLeft = corner === 'tl' || corner === 'bl';
    const isTop = corner === 'tl' || corner === 'tr';
    return (
      <View
        key={corner}
        {...corners[corner].panHandlers}
        style={[
          styles.handleTouch,
          isLeft ? { left: -HANDLE_TOUCH / 2 } : { right: -HANDLE_TOUCH / 2 },
          isTop ? { top: -HANDLE_TOUCH / 2 } : { bottom: -HANDLE_TOUCH / 2 },
        ]}
      >
        <View
          style={[
            styles.handle,
            {
              borderLeftWidth: isLeft ? 3 : 0,
              borderRightWidth: isLeft ? 0 : 3,
              borderTopWidth: isTop ? 3 : 0,
              borderBottomWidth: isTop ? 0 : 3,
            },
          ]}
        />
      </View>
    );
  };

  return (
    // `box-none` so the four shades below do not swallow a drag meant for the frame.
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {/*
        What is being cut away, as four shades around the frame rather than one overlay with a
        hole in it. React Native has no cut-out, and the alternatives are a mask (a dependency) or
        a full-cover shade with the frame drawn brighter on top - which cannot work, because the
        picture inside the frame has to be seen at its true brightness to be cropped by eye.
      */}
      <View style={[styles.shade, { left: 0, right: 0, top: 0, height: rect.y }]} />
      <View style={[styles.shade, { left: 0, right: 0, top: rect.y + rect.height, bottom: 0 }]} />
      <View style={[styles.shade, { left: 0, width: rect.x, top: rect.y, height: rect.height }]} />
      <View
        style={[
          styles.shade,
          { left: rect.x + rect.width, right: 0, top: rect.y, height: rect.height },
        ]}
      />

      <View
        {...move.panHandlers}
        style={[
          styles.frame,
          { left: rect.x, top: rect.y, width: rect.width, height: rect.height },
        ]}
      >
        {/*
          Thirds: the one piece of chrome here that is not structural. A crop with no guides is
          judged against the frame's own edges, and every camera app draws these because they are
          what people compose against.
        */}
        <View style={[styles.guide, { left: '33.33%', top: 0, bottom: 0, width: 1 }]} />
        <View style={[styles.guide, { left: '66.66%', top: 0, bottom: 0, width: 1 }]} />
        <View style={[styles.guide, { top: '33.33%', left: 0, right: 0, height: 1 }]} />
        <View style={[styles.guide, { top: '66.66%', left: 0, right: 0, height: 1 }]} />

        {(['tl', 'tr', 'bl', 'br'] as const).map(handle)}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  shade: { position: 'absolute', backgroundColor: 'rgba(0,0,0,0.55)' },
  frame: { position: 'absolute', borderWidth: 1, borderColor: color.onInverseSurface },
  guide: { position: 'absolute', backgroundColor: 'rgba(255,255,255,0.35)' },
  handleTouch: {
    position: 'absolute',
    width: HANDLE_TOUCH,
    height: HANDLE_TOUCH,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /* The accent, so the thing you grab is the thing the product's colour points at. */
  handle: { width: 22, height: 22, borderColor: color.accent },
});
