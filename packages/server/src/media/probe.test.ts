/**
 * The size a picture will be seen at.
 *
 * Pure, so it needs no database and no sharp - the arithmetic is one swap, and the swap is the
 * whole thing that is easy to get wrong and impossible to notice from the server side. A wrong
 * answer here does not fail anything: it lays a portrait photograph out in a landscape box on
 * every client, for the life of the row.
 */

import { describe, expect, it } from 'vitest';
import { displayDimensions } from './probe.ts';

describe('the displayed size of an image', () => {
  it('takes the header numbers when there is no rotation to apply', () => {
    // 1 is "as stored". 2 to 4 are mirrors and half turns, which do not change the shape.
    for (const orientation of [undefined, 1, 2, 3, 4]) {
      expect(displayDimensions({ width: 400, height: 300, orientation })).toEqual({
        width: 400,
        height: 300,
      });
    }
  });

  it('swaps them for the quarter turns, which is every portrait photo from a phone', () => {
    /*
     * A camera does not rotate pixels. It writes them in sensor order - landscape - and adds a
     * tag saying which way up the result goes. Orientation 6 is the common one: hold a phone
     * upright, and the file says 400x300 while the picture is 300x400.
     */
    for (const orientation of [5, 6, 7, 8]) {
      expect(displayDimensions({ width: 400, height: 300, orientation })).toEqual({
        width: 300,
        height: 400,
      });
    }
  });

  it('answers null rather than guessing, when the header will not say', () => {
    // A client reads null as "measure it yourself", which is what every client did before these
    // columns existed. A zero would be a shape, and a wrong one.
    expect(displayDimensions({})).toEqual({ width: null, height: null });
    expect(displayDimensions({ width: 400 })).toEqual({ width: null, height: null });
    expect(displayDimensions({ width: 0, height: 300 })).toEqual({ width: null, height: null });
  });
});
