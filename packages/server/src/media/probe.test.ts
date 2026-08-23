/**
 * The probe: the size a picture will be seen at, and the ceiling on what is decoded at all.
 *
 * `displayDimensions` is pure, so it needs no database and no sharp - the arithmetic is one swap,
 * and the swap is the whole thing that is easy to get wrong and impossible to notice from the
 * server side. A wrong answer there does not fail anything: it lays a portrait photograph out in
 * a landscape box on every client, for the life of the row.
 *
 * The pixel ceiling is not pure. It is a fact about what `probeImage` tells sharp, and the only
 * honest way to assert it is to run a real decode - so the second half of this file does. It
 * still needs no database.
 */

import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { DECODE_OPTIONS, displayDimensions, MAX_IMAGE_PIXELS, probeImage } from './probe.ts';

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

// ===========================================================================
// The pixel ceiling
// ===========================================================================

/** PNG's own CRC-32, which libpng checks before it will look at a chunk. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    let c = (crc ^ byte) & 0xff;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/**
 * A PNG that DECLARES a size, carrying almost none of the pixels it promises.
 *
 * **The construction is the whole test.** Producing a genuine 256-megapixel image to prove the
 * ceiling refuses one would allocate the three quarters of a gigabyte the ceiling exists to
 * refuse - the test would BE the bug it is written against, and on a machine pinned to 1 GB it
 * would take the run down rather than fail.
 *
 * It does not need to, because `limitInputPixels` is a **header** check: libvips reads `IHDR`,
 * multiplies the two numbers, and refuses before it allocates a single scanline. Ninety-four
 * bytes declaring 16000 by 16000 therefore reach exactly the code path a real decompression bomb
 * reaches, at exactly the moment a real one is stopped. That is also what makes a bomb a bomb -
 * enormous declared dimensions in very few bytes is the attack, not an accident of this fixture.
 */
function pngDeclaring(width: number, height: number): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  // One scanline, deflated, where the header promises `height` of them. Whatever gets past the
  // pixel ceiling then dies on the truncation, which is what distinguishes the two refusals.
  const idat = zlib.deflateSync(Buffer.alloc(width + 1));
  return new Uint8Array(
    Buffer.concat([
      Buffer.from('89504e470d0a1a0a', 'hex'),
      pngChunk('IHDR', ihdr),
      pngChunk('IDAT', idat),
      pngChunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

/** libvips' wording when `limitInputPixels` refuses a header. Nothing else says this. */
const PIXEL_LIMIT = /exceeds pixel limit/i;

describe('the pixel ceiling on a decode', () => {
  it('refuses a file whose header declares more pixels than any camera produces', async () => {
    /*
     * 16000 x 16000 is 256 megapixels: comfortably INSIDE sharp's own default of 268402689, and
     * therefore admitted by the decoder until this ceiling existed. At four bytes a pixel that is
     * a gigabyte of raw bitmap asked for by a 94-byte file, on a machine pinned to one gigabyte.
     *
     * The byte cap cannot see it - `MAX_IMAGE_BYTES` is 25 MB and this is under a hundred bytes -
     * and the memory pin does not save you from it. It presents as an OOM kill, which on Fly is a
     * machine restart rather than an error, on the single role that serves all traffic.
     */
    const probe = await probeImage(pngDeclaring(16000, 16000));

    expect(probe.ok, 'a 256-megapixel header was handed to the decoder').toBe(false);
    // Refused ON ITS DIMENSIONS, at the header, rather than incidentally on the truncated pixel
    // data further in. Only the first of those bounds the allocation.
    if (!probe.ok) expect(probe.reason).toMatch(PIXEL_LIMIT);
  });

  it('accepts a 50-megapixel photograph, which is a current Android flagship at full size', async () => {
    /*
     * The other half, and the reason the ceiling is not simply as low as it will go. A real
     * encoded image, decoded for real: 8192 x 6144 is 50331648 pixels, which is what a 50 MP
     * phone sensor writes and what a member will actually send.
     *
     * Note it is over a round "50 megapixels" by two thirds of a percent. A ceiling of 50000000
     * would refuse this photograph, which is why the constant is not that number.
     */
    const sharp = (await import('sharp')).default;
    const photograph = await sharp({
      create: { width: 8192, height: 6144, channels: 3, background: '#8899aa' },
    })
      .jpeg({ quality: 80 })
      .toBuffer();

    const probe = await probeImage(new Uint8Array(photograph));

    expect(probe.ok, 'a 50-megapixel photograph was refused').toBe(true);
    if (probe.ok) expect(probe).toEqual({ ok: true, width: 8192, height: 6144 });
  });

  it('leaves an ordinary phone photo well clear of the ceiling', async () => {
    // 4032 x 3024 is 12 megapixels - the iPhone main camera's default, and the overwhelming
    // majority of what this product receives. Nowhere near the ceiling, and it must stay so.
    const sharp = (await import('sharp')).default;
    const photograph = await sharp({
      create: { width: 4032, height: 3024, channels: 3, background: '#334455' },
    })
      .jpeg({ quality: 80 })
      .toBuffer();

    const probe = await probeImage(new Uint8Array(photograph));
    expect(probe).toEqual({ ok: true, width: 4032, height: 3024 });
  });

  it('refuses a bomb the same way it refuses a corrupt file, rather than throwing', async () => {
    /*
     * The refusal has to arrive as a value. `completeUpload` turns `{ ok: false }` into the typed
     * `undecodable` code a caller already handles, and `deriveVariants` records it on the row
     * instead of parking its outbox row - both of which a thrown error walks straight past.
     *
     * An image bomb is bad input, exactly as a corrupt file is, so it takes the same exit.
     */
    const bomb = probeImage(pngDeclaring(16000, 16000));
    await expect(bomb).resolves.toMatchObject({ ok: false });
  });

  it('hands the worker the same ceiling, because it is one constant and not two', () => {
    /*
     * `derive.ts` imports `DECODE_OPTIONS` rather than restating it, so the resize the worker
     * runs is given exactly what the probe above was given. That is asserted here rather than
     * trusted, because the failure it guards against is silent: **a limit applied at one of the
     * places that hands bytes to libvips is not a limit**, and a second call site added later
     * with its own options object would look perfectly correct.
     */
    expect(DECODE_OPTIONS.limitInputPixels).toBe(MAX_IMAGE_PIXELS);
    // And the ceiling actually is one. Sharp's default, 0x3FFF squared, is 1.00 GiB of raw
    // bitmap on a machine pinned to 1 GB, which is a limit only in the sense that a cliff is.
    expect(MAX_IMAGE_PIXELS).toBeLessThan(268402689);
  });
});
