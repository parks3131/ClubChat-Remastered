/**
 * How large a photo is drawn in a conversation.
 *
 * The two clamps interact, and the interesting case is a photo tall enough to hit the height cap:
 * it has to give width back, or it renders at the right height and the wrong shape. That failure
 * looks like "a bit narrow" rather than like a bug, which is why it is asserted rather than
 * eyeballed.
 */

import { describe, expect, it } from 'vitest';
import { photoSize, rememberRatio, rememberedRatio } from './photo-size.ts';

/** What the caller actually cares about: does the box still have the picture's proportions. */
const aspectOf = ({ width, height }: { width: number; height: number }) => width / height;

describe('a photo in a conversation', () => {
  it('gives a landscape the full width and lets the height follow', () => {
    const size = photoSize(16 / 9);
    expect(size.width).toBe(240);
    expect(size.height).toBe(135);
  });

  it('gives a portrait the SAME width as a landscape, not the same long edge', () => {
    // The bug this replaced: capping the long edge made a 3:4 portrait 150 wide against a
    // landscape's 240, so the founder's photos came out visibly smaller than anyone expects.
    expect(photoSize(3 / 4).width).toBe(240);
    expect(photoSize(3 / 4).height).toBe(320);
  });

  it('clamps a very tall photo by height, and narrows it to keep its shape', () => {
    const ratio = 9 / 21;
    const size = photoSize(ratio);
    expect(size.height).toBe(320);
    // The half that is easy to leave out. Without it the box is 240 wide at 320 tall, which is
    // a 3:4 frame around a 9:21 picture.
    expect(size.width).toBeLessThan(240);
    expect(aspectOf(size)).toBeCloseTo(ratio, 2);
  });

  it('keeps the aspect ratio for anything inside both caps', () => {
    for (const ratio of [0.8, 1, 1.5, 2]) {
      expect(aspectOf(photoSize(ratio))).toBeCloseTo(ratio, 1);
    }
  });

  it('falls back to a square when the image has not been measured', () => {
    // Null is "not measured yet", and the caller pairs this with `contain` so nothing is cropped.
    expect(photoSize(null)).toEqual({ width: 240, height: 240 });
  });

  it('does not divide by a ratio it cannot use', () => {
    // A zero-dimension image would otherwise produce Infinity and a box of NaN.
    expect(photoSize(0)).toEqual({ width: 240, height: 240 });
    expect(photoSize(Number.NaN)).toEqual({ width: 240, height: 240 });
  });
});

/**
 * What a photo remembers about its own shape.
 *
 * The point of this is what happens on the SECOND mount: a chat list unmounts the cells that
 * scroll out of view, so without a memory every photo re-measures and re-resizes each time it
 * comes back, and the list lurches every time somebody scrolls up through pictures.
 */
describe('remembering a photo shape', () => {
  it('gives a photo its final size on the mount after the first', () => {
    expect(rememberedRatio('media-1')).toBeNull();
    rememberRatio('media-1', 0.75);
    // The second mount opens at the true shape rather than at the square guess.
    expect(photoSize(rememberedRatio('media-1'))).toEqual({ width: 240, height: 320 });
  });

  it('knows nothing about a photo it has not seen', () => {
    expect(rememberedRatio('never-seen')).toBeNull();
    expect(rememberedRatio(null)).toBeNull();
  });

  it('refuses a measurement it could not use', () => {
    // A zero-dimension image must not be remembered as a shape, or the photo is wrong forever
    // rather than for one frame.
    rememberRatio('media-bad', 0);
    rememberRatio('media-bad', Number.NaN);
    rememberRatio('media-bad', Number.POSITIVE_INFINITY);
    expect(rememberedRatio('media-bad')).toBeNull();
  });
});
