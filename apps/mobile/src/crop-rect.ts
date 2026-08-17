/**
 * The crop rectangle: the three conversions between the spaces it lives in, and where a drag
 * moves it.
 *
 * Its own module rather than sitting inside the gesture component, following `photo-size.ts` and
 * `mentions.ts`: pure functions in a `.ts` are testable without a renderer, and this is the one
 * part of cropping whose being wrong is invisible - a frame drawn perfectly can still cut the
 * wrong pixels out of the file, and nothing on screen would say so.
 *
 * **The drag arithmetic moved here on 2026-08-15**, from the component, for the same reason the
 * conversions did. The first crop was reported as working but nearly unusable, and both causes
 * turned out to be geometry rather than gestures: a resize that refused the whole drag when
 * either side hit its minimum, and touch targets hung outside the view that owned them. Neither
 * could be caught by looking at the picture, and both are now properties something asserts - see
 * `dragRect` and `grabZone`.
 *
 * Three spaces, and keeping them straight is the whole job:
 *
 *  - **points** - where the frame is drawn and dragged, in whatever size the picture happens to
 *    be on screen right now.
 *  - **fractions** - what is STORED, 0 to 1 of the picture.
 *  - **source pixels** - what the server is asked to extract.
 *
 * > **Storing points was a real defect, found on the device on 2026-08-15.** The picture's drawn
 * > size changes whenever the surrounding layout does, and the layout changes on the very tap that
 * > confirms the crop, because the crop footer is a different height from the caption bar. So the
 * > stored rectangle silently came to mean something else: the frame drew outside the photo, the
 * > shading around it vanished, and the crop was discarded by the tap meant to apply it - the full
 * > picture posted. Fractions mean the same thing at every size, so the class is gone rather than
 * > handled, and no code watches the layout to correct anything.
 */

/** A rectangle in display points, relative to the drawn image's top-left. */
export type CropRect = { x: number; y: number; width: number; height: number };

/** How large the image is drawn right now. */
export type DisplayBox = { width: number; height: number };

/** The same rectangle as fractions of the image, 0 to 1. The only form that is stored. */
export type NormRect = { x: number; y: number; width: number; height: number };

/** What the server is asked to extract, in the source image's own pixels. */
export type SourceRect = { originX: number; originY: number; width: number; height: number };

/**
 * The whole picture, which is what a crop opens on.
 *
 * Opening on everything rather than an inset rectangle is what makes cropping a choice rather
 * than a chore: a frame that starts smaller has already cropped it, and somebody who only wanted
 * to trim one edge would have to undo that first.
 */
export const WHOLE: NormRect = { x: 0, y: 0, width: 1, height: 1 };

/** Fractions to the points the frame is drawn and dragged in. */
export function toPoints(norm: NormRect, display: DisplayBox): CropRect {
  return {
    x: norm.x * display.width,
    y: norm.y * display.height,
    width: norm.width * display.width,
    height: norm.height * display.height,
  };
}

/** Points back to fractions, which is the only form that is stored. */
export function toNorm(rect: CropRect, display: DisplayBox): NormRect {
  return {
    x: rect.x / display.width,
    y: rect.y / display.height,
    width: rect.width / display.width,
    height: rect.height / display.height,
  };
}

/**
 * Fractions to the source image's own pixels.
 *
 * The on-screen size is deliberately not a parameter. It used to be, and that put the display's
 * rounding between the finger and the file - so a frame drawn correctly could still cut a pixel
 * or two off, and the mapping had one more thing that could be stale.
 *
 * Clamped to the source's bounds, because a rectangle that rounds a fraction of a pixel past the
 * edge is refused by the extractor rather than trimmed by it.
 */
export function toSourceRect(norm: NormRect, source: DisplayBox): SourceRect {
  const originX = Math.max(0, Math.min(Math.round(norm.x * source.width), source.width - 1));
  const originY = Math.max(0, Math.min(Math.round(norm.y * source.height), source.height - 1));

  return {
    originX,
    originY,
    width: Math.max(1, Math.min(Math.round(norm.width * source.width), source.width - originX)),
    height: Math.max(
      1,
      Math.min(Math.round(norm.height * source.height), source.height - originY),
    ),
  };
}

/**
 * The largest centred rectangle of a given shape that fits inside a picture, in fractions.
 *
 * **This is what makes "one ratio for the whole post" real** (ADR-0038). A news carousel draws
 * every slide in one box, so every photo has to arrive in that box's shape - and the author picks
 * the shape once rather than cropping six pictures by hand. Centred is the honest default: it
 * keeps the middle of what somebody chose, and it is the same guess a `cover` resize makes, only
 * applied where the crop frame and the display frame can be proved identical.
 *
 * `ratio` is width over height, so `1` is a square, `0.8` is `4:5` and `16 / 9` is landscape.
 *
 * A photo that already has the target shape returns the whole image, which `isWholeImage` then
 * reads as "nothing to cut" - so the common case of a square photo in a square post costs the
 * server no decode at all.
 */
export function centredRectForRatio(source: DisplayBox, ratio: number): NormRect {
  if (source.width <= 0 || source.height <= 0 || ratio <= 0) return WHOLE;

  const sourceRatio = source.width / source.height;

  // Wider than the target: keep the full height and trim the sides.
  if (sourceRatio > ratio) {
    const width = ratio / sourceRatio;
    return { x: (1 - width) / 2, y: 0, width, height: 1 };
  }

  // Taller than the target (or identical): keep the full width and trim top and bottom.
  const height = sourceRatio / ratio;
  return { x: 0, y: (1 - height) / 2, width: 1, height };
}

/**
 * Whether the frame still covers the whole picture, in which case there is nothing to cut.
 *
 * A thousandth of tolerance, because the fractions are floating point and "reset to the whole
 * image" must reliably read as untouched rather than as a crop of 99.98% - which would cost a
 * decode, a re-encode and a write on the server to produce a copy of the same picture.
 */
export function isWholeImage(norm: NormRect): boolean {
  return norm.x <= 0.001 && norm.y <= 0.001 && norm.width >= 0.999 && norm.height >= 0.999;
}

/**
 * How to SHOW a crop that has been chosen but not yet cut.
 *
 * > **Until this existed, finishing a crop changed nothing on screen.** The picture went back to
 * > its full self and a one word label under it changed from "Crop" to "Cropped", so the only
 * > account of what was about to be sent was that word. The founder asked for the obvious thing on
 * > 2026-08-15, an hour after the frame itself became usable: show me the cropped picture before I
 * > send it.
 *
 * The cut happens on the server, so there is no cropped file to draw. What there is instead is a
 * window: a box the shape of the chosen region, with the whole picture behind it, scaled so the
 * region exactly fills the box and offset so the region's top-left sits in its corner. Everything
 * outside is clipped by the box. No pixels are copied and nothing native is involved - it is the
 * same `Image` at a different size under `overflow: hidden`.
 *
 * `box` is the room available; the window is fitted inside it the same way the whole picture is,
 * so a crop of any shape gets as much of the screen as it can have.
 *
 * **`WHOLE` returns exactly the fitted picture**, image at the origin and no offset, which is what
 * lets one code path draw both states - see the test.
 */
export function previewLayout(
  norm: NormRect,
  source: DisplayBox,
  box: DisplayBox,
): { frame: DisplayBox; image: { width: number; height: number; left: number; top: number } } {
  // Never zero: a region with no area would put an infinite scale into a style.
  const region = {
    width: Math.max(1, source.width * norm.width),
    height: Math.max(1, source.height * norm.height),
  };
  const scale = Math.min(box.width / region.width, box.height / region.height);
  const width = source.width * scale;
  const height = source.height * scale;

  return {
    frame: { width: region.width * scale, height: region.height * scale },
    /* Written as a subtraction from zero rather than a negation: negating zero gives `-0`, which
       is a real value in JavaScript and would reach a layout prop as one. */
    image: { width, height, left: 0 - norm.x * width, top: 0 - norm.y * height },
  };
}

/**
 * What a drag is holding: the frame's body, one of its corners, or one of its edges.
 *
 * **The four edges are half of why the first crop was hard to use.** Corners only means every
 * adjustment is a diagonal one, so trimming a strip off the bottom of a picture also asks you to
 * hold its width steady with the same finger. An edge grip moves one side and nothing else.
 */
export type Grip = 'move' | 'tl' | 'tr' | 'bl' | 'br' | 'top' | 'right' | 'bottom' | 'left';

/** Every grip, in the order they are stacked: the body first, then edges, then corners on top. */
export const GRIPS: readonly Grip[] = [
  'move',
  'top',
  'right',
  'bottom',
  'left',
  'tl',
  'tr',
  'bl',
  'br',
];

/**
 * The smallest frame a drag may produce, in points.
 *
 * Below this the grips have no room left to sit apart from each other and the frame becomes
 * impossible to grow again with a finger, which is a dead end rather than a small crop.
 */
export const MIN_SIZE = 48;

/** How large a grip's touch target wants to be. Larger than what is drawn, which is the point. */
export const GRAB = 44;

const clamp = (value: number, low: number, high: number) =>
  Math.max(low, Math.min(value, Math.max(low, high)));

/**
 * A drag, resolved against the picture's bounds. The one function that decides where the frame
 * goes, for all nine grips.
 *
 * `from` is the frame as it was when the finger went down and `dx`/`dy` are the gesture's
 * CUMULATIVE offsets. Applying a per-frame delta to a frame that already contains it is the
 * classic drag bug - the frame accelerates away from the finger - which is why `PanResponder`
 * reports cumulative offsets and why nothing here reads the live rectangle.
 *
 * ### The two rules that make it feel right, both learned from the version this replaces
 *
 * **Each axis is clamped on its own.** The first crop refused the whole gesture the moment either
 * side fell under the minimum, so dragging a corner in too far froze the frame outright - it
 * stopped following the finger and looked broken. Here a side that has run out pins at the
 * minimum while the other keeps tracking, which is what every crop tool on a phone does.
 *
 * **A corner never crosses its opposite.** The first version normalised with `Math.abs`, so
 * dragging past the far side flipped the rectangle inside out and it leapt across the picture.
 * The edges are held apart by `MIN_SIZE` instead, so the frame can be small but never inverted.
 */
export function dragRect(
  from: CropRect,
  grip: Grip,
  dx: number,
  dy: number,
  box: DisplayBox,
): CropRect {
  /*
   * Moving the whole frame changes its origin and never its size, so it is clamped by being
   * pushed back inside the picture rather than by being resized against the edge.
   */
  if (grip === 'move') {
    return {
      ...from,
      x: clamp(from.x + dx, 0, box.width - from.width),
      y: clamp(from.y + dy, 0, box.height - from.height),
    };
  }

  /*
   * Expressed as four independent edges rather than as x/y/width/height. A resize moves one or
   * two of them and leaves the rest exactly where they were, which is the definition of the
   * gesture; deriving the same thing from an origin and a size is where the sign errors live.
   *
   * The minimum is capped by the picture itself, so a photograph drawn smaller than 48 points on
   * some axis still has a legal frame instead of an impossible one.
   */
  const minWidth = Math.min(MIN_SIZE, box.width);
  const minHeight = Math.min(MIN_SIZE, box.height);

  let left = from.x;
  let top = from.y;
  let right = from.x + from.width;
  let bottom = from.y + from.height;

  if (grip === 'tl' || grip === 'bl' || grip === 'left') {
    left = clamp(from.x + dx, 0, right - minWidth);
  }
  if (grip === 'tr' || grip === 'br' || grip === 'right') {
    right = clamp(right + dx, left + minWidth, box.width);
  }
  if (grip === 'tl' || grip === 'tr' || grip === 'top') {
    top = clamp(from.y + dy, 0, bottom - minHeight);
  }
  if (grip === 'bl' || grip === 'br' || grip === 'bottom') {
    bottom = clamp(bottom + dy, top + minHeight, box.height);
  }

  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Where a grip is actually grabbed - which is deliberately not where it is drawn.
 *
 * > **This is the other half of why the first crop was hard to use.** Its handles were children of
 * > the frame, hung half outside it on negative offsets. A view that sits outside its parent's
 * > bounds is not reliably hit-tested on either platform, so half of every touch target was dead,
 * > and what was left was a 22-point square exactly on the corner. The frame was not hard to drag
 * > because the arithmetic was wrong; it was hard to drag because most of what looked grabbable
 * > was not.
 *
 * So the zones are returned as rectangles in the picture's own coordinates and drawn as siblings
 * of the frame rather than as its children - which is what keeps them inside the bounds of the
 * view that hosts them at every position, including hard against an edge.
 *
 * **A zone that would hang over an edge is pushed inside rather than trimmed**, so it keeps its
 * full size. That matters more than it sounds: the frame OPENS on the whole picture, so all four
 * corners start against an edge, and trimming would make the very first grab of every crop the
 * smallest target in the whole interaction.
 *
 * Zones also shrink with the frame, never past half a side, so four corners and four edges always
 * tile without overlapping. The corners are placed first and each edge takes only what is left
 * between two of them, because a zone pushed inwards must not come to rest under its neighbour.
 *
 * Returns null when an edge has no room left between its corners. The corners always exist, since
 * they are the only way back out of a frame at its minimum.
 */
export function grabZone(rect: CropRect, grip: Grip, box: DisplayBox): CropRect | null {
  if (grip === 'move') return intersect(rect, box);

  const reach = Math.max(1, Math.min(GRAB, rect.width / 2, rect.height / 2));
  const half = reach / 2;

  /* Where each corner zone actually sits: centred on its corner, then pushed inside the picture. */
  const left = clamp(rect.x - half, 0, box.width - reach);
  const right = clamp(rect.x + rect.width - half, 0, box.width - reach);
  const top = clamp(rect.y - half, 0, box.height - reach);
  const bottom = clamp(rect.y + rect.height - half, 0, box.height - reach);

  if (grip === 'tl') return { x: left, y: top, width: reach, height: reach };
  if (grip === 'tr') return { x: right, y: top, width: reach, height: reach };
  if (grip === 'bl') return { x: left, y: bottom, width: reach, height: reach };
  if (grip === 'br') return { x: right, y: bottom, width: reach, height: reach };

  if (grip === 'top' || grip === 'bottom') {
    const x = left + reach;
    const width = right - x;
    return width <= 0 ? null : { x, y: grip === 'top' ? top : bottom, width, height: reach };
  }

  const y = top + reach;
  const height = bottom - y;
  return height <= 0 ? null : { x: grip === 'left' ? left : right, y, width: reach, height };
}

/** A rectangle trimmed to the picture, or null if nothing of it is left. */
function intersect(rect: CropRect, box: DisplayBox): CropRect | null {
  const x = clamp(rect.x, 0, box.width);
  const y = clamp(rect.y, 0, box.height);
  const width = Math.min(rect.x + rect.width, box.width) - x;
  const height = Math.min(rect.y + rect.height, box.height) - y;
  return width <= 0 || height <= 0 ? null : { x, y, width, height };
}
