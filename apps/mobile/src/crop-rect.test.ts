/**
 * The crop rectangle's three spaces, and the property that made the whole feature work.
 *
 * > **These exist because of a defect that only a device could show.** The crop was stored in
 * > display points, so it silently meant something different after every layout change - and the
 * > layout changes on the very tap that confirms the crop, because the crop footer is a different
 * > height from the caption bar. The founder recorded it on 2026-08-15: the frame drew outside the
 * > photo, the shading around it vanished, and the full uncropped picture posted.
 * >
 * > The fix was to store fractions, and the test that matters is the one asserting a frame means
 * > the same region after the picture is redrawn at a different size. That is the property; the
 * > rest of this file guards the arithmetic around it.
 */

import { describe, expect, it } from 'vitest';
import {
  isWholeImage,
  toNorm,
  toPoints,
  toSourceRect,
  WHOLE,
  type CropRect,
} from './crop-rect.ts';

describe('a stored crop survives the picture being redrawn at another size', () => {
  it('names the same region before and after a relayout', () => {
    const before = { width: 300, height: 200 };
    // What the stage becomes when the crop footer replaces the caption bar and the keyboard goes.
    const after = { width: 360, height: 240 };
    const source = { width: 3000, height: 2000 };

    // A frame drawn on the small layout: the middle-right quarter, roughly.
    const drawn: CropRect = { x: 150, y: 50, width: 120, height: 100 };
    const stored = toNorm(drawn, before);

    /*
     * The whole point. The stored crop is asked what it means at the NEW size, and it has to be
     * the same pixels - this is the assertion that would have failed before the fix, because the
     * frame was the points themselves and 150 points meant a different place afterwards.
     */
    expect(toSourceRect(stored, source)).toEqual({
      originX: 1500,
      originY: 500,
      width: 1200,
      height: 1000,
    });

    // And it draws in the right place at the new size, rather than hanging off the picture.
    const redrawn = toPoints(stored, after);
    expect(redrawn).toEqual({ x: 180, y: 60, width: 144, height: 120 });
    // Still inside the image, which is what "the frame drew outside the photo" was.
    expect(redrawn.x + redrawn.width).toBeLessThanOrEqual(after.width);
    expect(redrawn.y + redrawn.height).toBeLessThanOrEqual(after.height);
  });

  it('round-trips points through fractions unchanged', () => {
    const display = { width: 320, height: 240 };
    const drawn: CropRect = { x: 32, y: 60, width: 160, height: 120 };
    expect(toPoints(toNorm(drawn, display), display)).toEqual(drawn);
  });
});

describe('fractions to source pixels', () => {
  it('scales to the source rather than to what was on screen', () => {
    // A phone photo is far larger than the few hundred points it is drawn in, so the display
    // being nowhere in this conversion is the difference between cutting 12 megapixels and 300.
    expect(toSourceRect({ x: 0.25, y: 0.5, width: 0.5, height: 0.25 }, { width: 4000, height: 3000 }))
      .toEqual({ originX: 1000, originY: 1500, width: 2000, height: 750 });
  });

  it('never runs past the edge, however the fractions round', () => {
    // A frame dragged hard into the bottom-right, where rounding is most likely to overshoot.
    const rect = toSourceRect({ x: 0.999, y: 0.999, width: 0.9, height: 0.9 }, { width: 101, height: 101 });
    expect(rect.originX + rect.width).toBeLessThanOrEqual(101);
    expect(rect.originY + rect.height).toBeLessThanOrEqual(101);
    // And is never a zero-area rectangle, which the extractor refuses outright.
    expect(rect.width).toBeGreaterThan(0);
    expect(rect.height).toBeGreaterThan(0);
  });

  it('keeps the whole picture when the frame was never moved', () => {
    expect(toSourceRect(WHOLE, { width: 800, height: 600 })).toEqual({
      originX: 0,
      originY: 0,
      width: 800,
      height: 600,
    });
  });
});

describe('whether there is anything to cut', () => {
  it('treats the untouched frame as whole', () => {
    expect(isWholeImage(WHOLE)).toBe(true);
  });

  it('treats a frame that merely round-tripped as whole', () => {
    // The reason for the tolerance: a full frame converted to points and back is not exactly 1,
    // and calling that a crop would cost a decode and a re-encode to reproduce the same picture.
    const display = { width: 393, height: 524 };
    expect(isWholeImage(toNorm(toPoints(WHOLE, display), display))).toBe(true);
  });

  it('treats a real crop as not whole', () => {
    expect(isWholeImage({ x: 0, y: 0, width: 0.9, height: 1 })).toBe(false);
    expect(isWholeImage({ x: 0.05, y: 0, width: 0.95, height: 1 })).toBe(false);
  });
});
