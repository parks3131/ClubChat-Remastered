/**
 * The crop frame: a rectangle you drag over the picture.
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
 * which owns the conversions, the drag arithmetic, and the reason storing points was a defect.
 *
 * ### Why this is a rewrite, and what the first one got wrong
 *
 * The first frame worked and was reported as "so hard... it just runs or adjusts weird". Three
 * causes, none of them the gesture code:
 *
 *  1. **Most of every handle was not grabbable.** The four corners were children of the frame,
 *     hung half outside it on negative offsets, and a view outside its parent's bounds is not
 *     reliably hit-tested. See `grabZone`, which is why the grips are now siblings of the frame.
 *  2. **A resize refused the entire drag** the moment either side fell under the minimum, so the
 *     frame stopped dead under a moving finger; and a corner dragged past its opposite flipped the
 *     rectangle and threw it across the picture. Both are gone in `dragRect`.
 *  3. **Every frame of every drag re-rendered the whole compose screen**, because the live
 *     rectangle was the parent's state. The image, the caption bar, the mention list and the
 *     keyboard avoider were all reconciled sixty times a second to move a border. The drag now
 *     lives here and the parent hears about it once, when the finger lifts.
 *
 * ### Three layers, and the order matters
 *
 * The shades cannot be touched, the chrome cannot be touched, and only the invisible grips can -
 * which means what somebody grabs is decided by one layer with nine rectangles in it, rather than
 * by which of a dozen decorated views happened to be on top.
 *
 * **Cropping is not reachable with VoiceOver**, here or in the version before it: a frame is
 * dragged, and a drag is not a gesture assistive technology can perform. Reset and Done are
 * labelled, so the mode can always be entered and left without cutting anything. Making the frame
 * itself adjustable is real work and is not pretended at with a label.
 */

import { useEffect, useRef, useState } from 'react';
import { PanResponder, StyleSheet, View, type PanResponderInstance } from 'react-native';
import {
  dragRect,
  grabZone,
  GRIPS,
  isWholeImage,
  previewLayout,
  toNorm,
  toPoints,
  toSourceRect,
  WHOLE,
  type CropRect,
  type DisplayBox,
  type Grip,
  type NormRect,
  type SourceRect,
} from './crop-rect.ts';
import { color } from './theme.ts';

export { isWholeImage, previewLayout, toNorm, toPoints, toSourceRect, WHOLE };
export type { CropRect, DisplayBox, NormRect, SourceRect };

/** The drawn corner: shorter than its touch target, which is the whole idea. */
const CHEVRON = 22;

/** How thick the drawn corner and edge marks are. */
const STROKE = 3;

/** The shortest side that still gets an edge pip drawn on it. Below this it would touch the corners. */
const PIP_ROOM = 96;

/** The drawn edge mark: a hint that the side can be taken on its own, not a target. */
const PIP = 28;

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
   * The frame while a finger is on it.
   *
   * > **The parent owns the crop and is deliberately not told until the finger lifts.** It holds
   * > it as fractions, converts on every render, and sits under a screen's worth of other views;
   * > routing each frame of a drag through it was what made the first version feel like it was
   * > running rather than following. A drag is a local thing, and it becomes everyone's business
   * > once.
   */
  const [drag, setDrag] = useState<CropRect | null>(null);
  const shown = drag ?? rect;

  /*
   * A rectangle arriving from the parent replaces the local one - Reset, or the picture being
   * redrawn at another size. This also clears the drag after a commit, where the value is the one
   * just sent up, so nothing flickers back to where it was.
   */
  useEffect(() => {
    setDrag(null);
  }, [rect.x, rect.y, rect.width, rect.height]);

  /*
   * Everything a gesture needs, in refs, because the responders are created once: a closure over
   * a prop would capture the value from the render that built it and never see another. That was
   * a latent bug in the first version, where `display` was captured at mount and would have been
   * wrong for the whole gesture after any relayout.
   */
  const live = useRef<CropRect>(shown);
  live.current = shown;
  const box = useRef<DisplayBox>(display);
  box.current = display;
  const commit = useRef(onChange);
  commit.current = onChange;

  /** The frame as it was when the finger went down, plus the offsets that count as zero. */
  const start = useRef<CropRect>(shown);
  const origin = useRef({ dx: 0, dy: 0 });
  const fingers = useRef(1);

  /*
   * Built once, and lazily: `useRef(expression)` evaluates its argument on every render, which
   * during a drag would mean nine `PanResponder`s constructed and discarded per frame.
   */
  const held = useRef<Record<Grip, PanResponderInstance> | null>(null);
  if (held.current === null) {
    held.current = Object.fromEntries(
      GRIPS.map((grip) => [
        grip,
        PanResponder.create({
          onStartShouldSetPanResponder: () => true,
          onMoveShouldSetPanResponder: () => true,
          // The scroller below must not steal a drag that started on a grip.
          onPanResponderTerminationRequest: () => false,
          onPanResponderGrant: () => {
            start.current = live.current;
            origin.current = { dx: 0, dy: 0 };
            fingers.current = 1;
          },
          onPanResponderMove: (_event, gesture) => {
            /*
             * A second finger landing or leaving moves `PanResponder`'s centroid, and the jump is
             * half the distance between the two fingers - which is why a two-fingered grab used
             * to throw the frame across the picture. Re-baselining absorbs it: the frame as it is
             * now becomes the new starting point, and the offsets so far become the new zero.
             */
            if (gesture.numberActiveTouches !== fingers.current) {
              fingers.current = gesture.numberActiveTouches;
              start.current = live.current;
              origin.current = { dx: gesture.dx, dy: gesture.dy };
            }
            setDrag(
              dragRect(
                start.current,
                grip,
                gesture.dx - origin.current.dx,
                gesture.dy - origin.current.dy,
                box.current,
              ),
            );
          },
          onPanResponderRelease: () => commit.current(live.current),
          // A gesture taken away mid-drag keeps what it had rather than discarding it, which
          // would undo an adjustment somebody had already finished making.
          onPanResponderTerminate: () => commit.current(live.current),
        }),
      ]),
    ) as Record<Grip, PanResponderInstance>;
  }
  const responders = held.current;

  const isLeft = (grip: Grip) => grip === 'tl' || grip === 'bl';
  const isTop = (grip: Grip) => grip === 'tl' || grip === 'tr';

  return (
    // `box-none` so this layer itself is transparent to touch and only the grips inside it are not.
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {/*
        Layer one: what is being cut away, as four shades around the frame rather than one overlay
        with a hole in it. React Native has no cut-out, and the alternatives are a mask (a
        dependency) or a full-cover shade with the frame drawn brighter on top - which cannot work,
        because the picture inside the frame has to be seen at its true brightness to be cropped by
        eye.

        `none`, so a shade can never intercept a drag meant for the grip sitting over it. In the
        first version they could, and a corner hard against the picture's edge was the worst case.
      */}
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <View style={[styles.shade, { left: 0, right: 0, top: 0, height: shown.y }]} />
        <View style={[styles.shade, { left: 0, right: 0, top: shown.y + shown.height, bottom: 0 }]} />
        <View style={[styles.shade, { left: 0, width: shown.x, top: shown.y, height: shown.height }]} />
        <View
          style={[
            styles.shade,
            { left: shown.x + shown.width, right: 0, top: shown.y, height: shown.height },
          ]}
        />
      </View>

      {/*
        Layer two: everything that is drawn, and none of it touchable. Keeping the marks out of the
        touch layer is what lets them be small and precise while what you grab stays large.
      */}
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <View
          style={[
            styles.frame,
            { left: shown.x, top: shown.y, width: shown.width, height: shown.height },
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
        </View>

        {(['tl', 'tr', 'bl', 'br'] as const).map((grip) => (
          <View
            key={grip}
            style={[
              styles.chevron,
              {
                left: isLeft(grip) ? shown.x : shown.x + shown.width - CHEVRON,
                top: isTop(grip) ? shown.y : shown.y + shown.height - CHEVRON,
                borderLeftWidth: isLeft(grip) ? STROKE : 0,
                borderRightWidth: isLeft(grip) ? 0 : STROKE,
                borderTopWidth: isTop(grip) ? STROKE : 0,
                borderBottomWidth: isTop(grip) ? 0 : STROKE,
              },
            ]}
          />
        ))}

        {/*
          A pip in the middle of each long enough side, which is how an edge announces that it can
          be taken on its own. Without one the edges are a secret: the frame looks like it has four
          handles and behaves as though it has eight.
        */}
        {shown.width >= PIP_ROOM && (
          <>
            <View
              style={[
                styles.pip,
                { left: shown.x + shown.width / 2 - PIP / 2, top: shown.y - STROKE / 2, width: PIP, height: STROKE },
              ]}
            />
            <View
              style={[
                styles.pip,
                {
                  left: shown.x + shown.width / 2 - PIP / 2,
                  top: shown.y + shown.height - STROKE / 2,
                  width: PIP,
                  height: STROKE,
                },
              ]}
            />
          </>
        )}
        {shown.height >= PIP_ROOM && (
          <>
            <View
              style={[
                styles.pip,
                { left: shown.x - STROKE / 2, top: shown.y + shown.height / 2 - PIP / 2, width: STROKE, height: PIP },
              ]}
            />
            <View
              style={[
                styles.pip,
                {
                  left: shown.x + shown.width - STROKE / 2,
                  top: shown.y + shown.height / 2 - PIP / 2,
                  width: STROKE,
                  height: PIP,
                },
              ]}
            />
          </>
        )}
      </View>

      {/*
        Layer three: the nine invisible grips, in `GRIPS` order - the body first, then the edges,
        then the corners last so that where two could overlap the corner is the one on top. Each is
        a rectangle from `grabZone`, which keeps them apart from each other and inside the picture.
      */}
      {GRIPS.map((grip) => {
        const zone = grabZone(shown, grip, display);
        if (zone === null) return null;
        return (
          <View
            key={grip}
            {...responders[grip].panHandlers}
            // A drag target announces nothing useful and would put nine unlabelled stops between
            // Crop and Done for a screen reader. The mode's own controls carry the labels.
            accessible={false}
            style={[
              styles.zone,
              { left: zone.x, top: zone.y, width: zone.width, height: zone.height },
            ]}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  shade: { position: 'absolute', backgroundColor: 'rgba(0,0,0,0.55)' },
  frame: { position: 'absolute', borderWidth: 1, borderColor: color.onInverseSurface },
  guide: { position: 'absolute', backgroundColor: 'rgba(255,255,255,0.35)' },
  /* The accent, so the thing you grab is the thing the product's colour points at. */
  chevron: { position: 'absolute', width: CHEVRON, height: CHEVRON, borderColor: color.accent },
  pip: { position: 'absolute', backgroundColor: color.accent, borderRadius: STROKE / 2 },
  /* Invisible on purpose: what is grabbable is larger than what is drawn, at every frame size. */
  zone: { position: 'absolute' },
});
