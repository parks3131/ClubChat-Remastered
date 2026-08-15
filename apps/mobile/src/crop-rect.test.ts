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
  dragRect,
  grabZone,
  GRIPS,
  isWholeImage,
  MIN_SIZE,
  previewLayout,
  toNorm,
  toPoints,
  toSourceRect,
  WHOLE,
  type CropRect,
  type Grip,
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

/*
 * The two groups below are the ones the founder's report on 2026-08-15 produced: the crop worked,
 * cut the right pixels, and was still "so hard... it just runs or adjusts weird". Neither cause was
 * in the conversions - one was the resize refusing a drag, the other was where the handles were -
 * so neither had anything asserting on it.
 */
describe('dragging the frame', () => {
  const box = { width: 300, height: 200 };
  const frame: CropRect = { x: 50, y: 40, width: 120, height: 100 };

  it('moves the whole frame without resizing it', () => {
    expect(dragRect(frame, 'move', 20, -10, box)).toEqual({ x: 70, y: 30, width: 120, height: 100 });
  });

  it('stops the frame at the picture rather than letting it leave', () => {
    const pushed = dragRect(frame, 'move', 999, 999, box);
    expect(pushed).toEqual({ x: 180, y: 100, width: 120, height: 100 });
    expect(dragRect(frame, 'move', -999, -999, box)).toEqual({
      x: 0,
      y: 0,
      width: 120,
      height: 100,
    });
  });

  it('moves only the edges its grip names', () => {
    // The right edge in, and nothing else changes: same origin, same height.
    expect(dragRect(frame, 'right', -20, 50, box)).toEqual({
      x: 50,
      y: 40,
      width: 100,
      height: 100,
    });
    // The top edge down: the origin moves, the BOTTOM stays where it was.
    expect(dragRect(frame, 'top', 50, 20, box)).toEqual({ x: 50, y: 60, width: 120, height: 80 });
  });

  it('takes two edges on a corner and leaves the opposite two alone', () => {
    const dragged = dragRect(frame, 'tl', 10, 10, box);
    expect(dragged).toEqual({ x: 60, y: 50, width: 110, height: 90 });
    // The fixed corner has not moved.
    expect(dragged.x + dragged.width).toBe(frame.x + frame.width);
    expect(dragged.y + dragged.height).toBe(frame.y + frame.height);
  });

  /*
   * The freeze. The first version returned the frame untouched whenever EITHER side came up short,
   * so a corner dragged hard inwards stopped following the finger on both axes at once - which is
   * what "it just runs or adjusts weird" was.
   */
  it('pins the axis that has run out and keeps tracking the other', () => {
    const dragged = dragRect(frame, 'br', -400, -20, box);
    expect(dragged.width).toBe(MIN_SIZE);
    expect(dragged.height).toBe(80);
  });

  /*
   * The flip. Normalising a corner drag with `Math.abs` let the rectangle turn inside out, so
   * dragging past the far side threw the frame across the picture rather than stopping it.
   */
  it('never lets a corner cross its opposite', () => {
    for (const grip of ['tl', 'tr', 'bl', 'br'] as const) {
      const dragged = dragRect(frame, grip, 900 * (grip === 'tl' || grip === 'bl' ? 1 : -1), 900 * (grip === 'tl' || grip === 'tr' ? 1 : -1), box);
      expect(dragged.width).toBe(MIN_SIZE);
      expect(dragged.height).toBe(MIN_SIZE);
      expect(dragged.x).toBeGreaterThanOrEqual(0);
      expect(dragged.y).toBeGreaterThanOrEqual(0);
    }
  });

  it('keeps every grip inside the picture, however far the finger goes', () => {
    for (const grip of GRIPS) {
      for (const [dx, dy] of [[900, 900], [-900, -900], [900, -900], [-900, 900]] as const) {
        const dragged = dragRect(frame, grip, dx, dy, box);
        expect(dragged.x).toBeGreaterThanOrEqual(0);
        expect(dragged.y).toBeGreaterThanOrEqual(0);
        expect(dragged.x + dragged.width).toBeLessThanOrEqual(box.width);
        expect(dragged.y + dragged.height).toBeLessThanOrEqual(box.height);
        expect(dragged.width).toBeGreaterThan(0);
        expect(dragged.height).toBeGreaterThan(0);
      }
    }
  });

  it('still produces a legal frame on a picture narrower than the minimum', () => {
    // A very wide, very short photo drawn small: the minimum cannot be honoured and must not
    // produce a negative width instead.
    const thin = { width: 300, height: 30 };
    const dragged = dragRect({ x: 0, y: 0, width: 300, height: 30 }, 'br', -900, -900, thin);
    expect(dragged.width).toBe(MIN_SIZE);
    expect(dragged.height).toBe(30);
  });
});

describe('where a grip is grabbed', () => {
  const box = { width: 300, height: 200 };

  /** Do two rectangles share any area at all. */
  const overlaps = (a: CropRect, b: CropRect) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

  /** Every grip that has a target on this frame, paired with it. The body is not one of them. */
  const zones = (rect: CropRect): Array<[Grip, CropRect]> => {
    const found: Array<[Grip, CropRect]> = [];
    for (const grip of GRIPS) {
      if (grip === 'move') continue;
      const zone = grabZone(rect, grip, box);
      if (zone !== null) found.push([grip, zone]);
    }
    return found;
  };

  /*
   * The reason the first crop was hard to grab. Its handles were children of the frame hung on
   * negative offsets, so at the frame's opening position - the whole picture - half of every
   * target lay outside the view that owned it and was never hit-tested.
   */
  it('keeps every zone inside the picture, including on the frame the crop opens with', () => {
    for (const rect of [
      { x: 0, y: 0, width: 300, height: 200 },
      { x: 0, y: 0, width: MIN_SIZE, height: MIN_SIZE },
      { x: 300 - MIN_SIZE, y: 200 - MIN_SIZE, width: MIN_SIZE, height: MIN_SIZE },
      { x: 90, y: 60, width: 120, height: 90 },
    ]) {
      for (const [grip, zone] of zones(rect)) {
        expect([grip, zone.x >= 0 && zone.y >= 0]).toEqual([grip, true]);
        expect([grip, zone.x + zone.width <= box.width]).toEqual([grip, true]);
        expect([grip, zone.y + zone.height <= box.height]).toEqual([grip, true]);
      }
    }
  });

  it('never lets two grips claim the same pixel', () => {
    for (const rect of [
      { x: 0, y: 0, width: 300, height: 200 },
      { x: 10, y: 10, width: 100, height: 60 },
      { x: 10, y: 10, width: MIN_SIZE, height: MIN_SIZE },
    ]) {
      const found = zones(rect);
      for (let i = 0; i < found.length; i += 1) {
        for (let j = i + 1; j < found.length; j += 1) {
          expect([found[i]![0], found[j]![0], overlaps(found[i]![1], found[j]![1])]).toEqual([
            found[i]![0],
            found[j]![0],
            false,
          ]);
        }
      }
    }
  });

  it('gives a corner a target far larger than the mark drawn on it', () => {
    const zone = grabZone({ x: 90, y: 60, width: 120, height: 90 }, 'tl', box);
    expect(zone).not.toBeNull();
    // The 22-point chevron is what is drawn; what is grabbable is the full touch target.
    expect(zone!.width).toBe(44);
    expect(zone!.height).toBe(44);
    // And it straddles the corner rather than sitting inside it, so a finger landing slightly
    // outside the frame still takes the handle.
    expect(zone!.x).toBeLessThan(90);
    expect(zone!.y).toBeLessThan(60);
  });

  /*
   * The first grab of every crop, and the one the first version made hardest: the frame opens on
   * the whole picture, so all four corners are against an edge. A target trimmed at the edge would
   * be half size exactly when nothing has been adjusted yet.
   */
  it('keeps a full size target on the frame the crop opens with', () => {
    const whole = { x: 0, y: 0, width: box.width, height: box.height };
    for (const grip of ['tl', 'tr', 'bl', 'br'] as const) {
      const zone = grabZone(whole, grip, box);
      expect([grip, zone!.width, zone!.height]).toEqual([grip, 44, 44]);
    }
  });

  /*
   * A frame at its minimum is the state the first version could not be dragged out of, so it is
   * the one that matters: all eight grips have to survive it. They do, because the zones shrink
   * with the frame instead of staying 44 points and fighting each other for the same 48.
   */
  it('keeps all eight grips on a frame shrunk to its minimum', () => {
    const small = { x: 10, y: 10, width: MIN_SIZE, height: MIN_SIZE };
    for (const grip of GRIPS) {
      const zone = grabZone(small, grip, box);
      expect([grip, zone === null]).toEqual([grip, false]);
      expect([grip, zone!.width > 0 && zone!.height > 0]).toEqual([grip, true]);
    }
  });
});

/*
 * Showing a crop that has not been cut yet. The server does the cutting, so what is on screen is
 * the whole picture behind a box the shape of the region - and if the arithmetic is out, the
 * preview lies about what is about to be sent, which is the one thing this screen exists to
 * prevent.
 */
describe('previewing the chosen region', () => {
  const source = { width: 4000, height: 3000 };
  const box = { width: 300, height: 400 };

  it('shows the whole picture, unmoved, when nothing was cropped', () => {
    const { frame, image } = previewLayout(WHOLE, source, box);
    // Fitted by its width, since the picture is wider than the room it has.
    expect(frame).toEqual({ width: 300, height: 225 });
    expect(image).toEqual({ width: 300, height: 225, left: 0, top: 0 });
  });

  it('fits the region rather than the picture, and offsets to bring it into view', () => {
    // The middle-right quarter: a square region, which the tall stage fits by its width.
    const { frame, image } = previewLayout(
      { x: 0.5, y: 0.25, width: 0.5, height: 0.6666666666666666 },
      source,
      box,
    );
    expect(frame.width).toBe(300);
    expect(Math.round(frame.height)).toBe(300);

    // The picture behind it is drawn at twice the window's width, because the region is half of
    // it, and pushed left by exactly the part being cut away.
    expect(image.width).toBe(600);
    expect(image.left).toBe(-300);
    expect(Math.round(image.top)).toBe(-112);
  });

  /*
   * The property that makes the preview honest: the window sits over exactly the pixels the
   * server is being asked to extract. Checked by walking the region's corners back through the
   * layout and landing on the frame's own corners.
   */
  it('puts the window over the same pixels the server is asked to cut', () => {
    const norm = { x: 0.1, y: 0.2, width: 0.55, height: 0.3 };
    const { frame, image } = previewLayout(norm, source, box);
    const cut = toSourceRect(norm, source);

    // Where the cut's top-left lands on the drawn picture, once the picture has been offset.
    const scale = image.width / source.width;
    expect(cut.originX * scale + image.left).toBeCloseTo(0, 6);
    expect(cut.originY * scale + image.top).toBeCloseTo(0, 6);
    // And its far corner lands on the window's far corner.
    expect(cut.width * scale).toBeCloseTo(frame.width, 6);
    expect(cut.height * scale).toBeCloseTo(frame.height, 6);
  });

  it('never asks for an infinite scale, however thin the region', () => {
    const { frame, image } = previewLayout({ x: 0, y: 0, width: 0, height: 0 }, source, box);
    for (const value of [frame.width, frame.height, image.width, image.height]) {
      expect(Number.isFinite(value)).toBe(true);
    }
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
