/**
 * Does an uploaded object actually decode as an image?
 *
 * `completeUpload` already HEADs the object and re-verifies size and type, because a presigned
 * PUT constrains where the bytes go and not what they are. This closes the last gap in that
 * same verification: the bytes can satisfy every declared fact and still not be a decodable
 * image.
 *
 * > **Found in production data.** A 97-byte PNG sat in a channel with a valid signature, a
 * > valid `IHDR` declaring a 4x4 image, and an `IDAT` chunk announcing 42 bytes of pixel data
 * > with only 40 present. Every declared fact matched. It was two bytes short of a file, and
 * > nothing on the upload path could tell.
 *
 * **Reading the header is not enough, and that is the whole reason this decodes.** `metadata()`
 * parses `IHDR` and returns 4x4 quite happily for the file above; only walking the pixel stream
 * reaches the truncation. So this pays for a full decode and is honest about it.
 */

/**
 * Decode strictness, defined once because two call sites must agree **exactly**.
 *
 * `probeImage` gates the upload and `deriveVariants` derives the thumbnails, and if the probe
 * were the more permissive of the two it would admit objects that later fail to derive - which
 * is precisely the parked-outbox hole this exists to close. One constant, both call sites.
 *
 * `'error'` rather than sharp's default `'warning'`: a photograph with a trailing garbage byte
 * or a slightly wrong marker is viewable, and refusing somebody's picture over a warning is a
 * worse failure than deriving it. Truncation and corruption raise errors, not warnings.
 */
export const DECODE_OPTIONS = { failOn: 'error' } as const;

export type ImageProbe =
  | { ok: true; width: number | null; height: number | null }
  | { ok: false; reason: string };

/**
 * The size a picture will be SEEN at, from the header's numbers and its orientation tag.
 *
 * **A camera does not rotate pixels.** It writes them in sensor order and adds an EXIF tag
 * saying which way up the result goes, so a portrait photograph from a phone is stored as
 * landscape plus "turn this 90 degrees". Orientations 5 to 8 are the quarter turns; 1 to 4 are
 * the identity and the mirrors, which do not change the shape.
 *
 * Storing the header numbers unswapped would therefore describe a picture nobody will ever see,
 * and every client sizing from them would draw a portrait photo in a landscape box.
 */
export function displayDimensions(metadata: {
  width?: number | undefined;
  height?: number | undefined;
  orientation?: number | undefined;
}): { width: number | null; height: number | null } {
  const { width, height, orientation } = metadata;
  if (width === undefined || height === undefined || width <= 0 || height <= 0) {
    return { width: null, height: null };
  }
  const quarterTurned = orientation !== undefined && orientation >= 5 && orientation <= 8;
  return quarterTurned ? { width: height, height: width } : { width, height };
}

/**
 * Decode the bytes and throw away the result.
 *
 * `stats()` rather than `.raw().toBuffer()`: both walk every pixel, but `raw` materialises the
 * decoded surface, and a 25 MB JPEG is roughly 70 MB of raw RGB. `stats()` reaches the same
 * pixels with bounded memory.
 *
 * Not `resize(1, 1)`, which looks cheaper and is wrong: libvips shrinks a JPEG **on load**, so
 * a downscale can satisfy itself from a fraction of the file and never read as far as the
 * damage.
 *
 * Sharp's `limitInputPixels` default also applies here, so a decompression bomb is refused at
 * the boundary rather than discovered when the worker tries to derive from it.
 */
export async function probeImage(bytes: Uint8Array): Promise<ImageProbe> {
  // Lazily, exactly as `derive.ts` does: sharp carries native binaries, and the gateway and
  // worker processes that never complete an upload should not pay to load it.
  const sharp = (await import('sharp')).default;
  try {
    const image = sharp(bytes, DECODE_OPTIONS);
    /*
     * The header first, then the pixels.
     *
     * `metadata()` is the cheap parse this module's header warns is not sufficient - it answers
     * 4x4 quite happily for a truncated file. It is read anyway because the dimensions are
     * wanted and this decode is already being paid for; `stats()` below is still the gate, and
     * nothing returns before it has passed. Reading the header first also means a file so
     * broken that even the header fails is refused here rather than one line later.
     */
    const metadata = await image.metadata();
    await image.stats();
    return { ok: true, ...displayDimensions(metadata) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
