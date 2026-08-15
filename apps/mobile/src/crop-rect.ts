/**
 * The crop rectangle, and the three conversions between the spaces it lives in.
 *
 * Its own module rather than sitting inside the gesture component, following `photo-size.ts` and
 * `mentions.ts`: pure functions in a `.ts` are testable without a renderer, and this is the one
 * part of cropping whose being wrong is invisible - a frame drawn perfectly can still cut the
 * wrong pixels out of the file, and nothing on screen would say so.
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
 * Whether the frame still covers the whole picture, in which case there is nothing to cut.
 *
 * A thousandth of tolerance, because the fractions are floating point and "reset to the whole
 * image" must reliably read as untouched rather than as a crop of 99.98% - which would cost a
 * decode, a re-encode and a write on the server to produce a copy of the same picture.
 */
export function isWholeImage(norm: NormRect): boolean {
  return norm.x <= 0.001 && norm.y <= 0.001 && norm.width >= 0.999 && norm.height >= 0.999;
}
