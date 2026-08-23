/**
 * Does an uploaded object actually decode as an image, and is it small enough to be worth
 * trying?
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
 * The largest picture this server will attempt to decode, in pixels.
 *
 * **A byte cap does not bound a decode.** `MAX_IMAGE_BYTES` in `store.ts` is 25 MB, and it
 * bounds the compressed file; libvips allocates the *decompressed* surface, which is a function
 * of the declared dimensions and has nothing to do with the file size. Highly compressed formats
 * reach enormous dimensions in very few bytes, which is what a decompression bomb is: the test
 * beside this file refuses a 256-megapixel image in ninety-four bytes.
 *
 * Sharp's own default is 268402689 pixels (0x3FFF squared). At four bytes a pixel that is 1.00
 * GiB of raw bitmap for a single image, and the api role is pinned to 1 GB - so the default is
 * not a limit here, it is the whole machine. It fails as an OOM kill, which on Fly presents as a
 * machine restart rather than an error, on the one role that serves all traffic.
 *
 * **64 Mi pixels, so one decode is bounded to 256 MiB of bitmap** - a quarter of the machine,
 * against a default that is all of it. The number is chosen from what this product actually
 * receives, which is phone camera photographs:
 *
 * | Source | Pixels | |
 * |---|---|---|
 * | iPhone main camera | 4032 x 3024 = 12.2 M | accepted, and is the common case |
 * | iPhone 48 MP HEIF Max | 8064 x 6048 = 48.8 M | accepted |
 * | 50 MP Android sensor | 8192 x 6144 = 50.3 M | accepted |
 * | 64 MP Android sensor | 9248 x 6936 = 64.1 M | accepted, with 3 M to spare |
 * | 108 MP full-res mode | 12000 x 9000 = 108 M | refused |
 * | 200 MP full-res mode | 16320 x 12240 = 200 M | refused |
 *
 * Note it is deliberately NOT a round fifty million. A 50 MP sensor writes 50331648 pixels,
 * which is over that by two thirds of a percent - a round number would refuse a real photograph
 * from a phone on sale today, and refusing somebody's picture is the failure this ceiling must
 * not cause. The two it does refuse are opt-in full-resolution modes, and neither produces a
 * picture this product can show: the largest variant `derive.ts` writes is `display` at 1600 px
 * wide, so every pixel past a few million is decoded only to be thrown away.
 *
 * **Known rough edge, and it is a wire-contract change rather than a number here.** A refusal on
 * this ceiling reaches the client as `completeUpload`'s `undecodable`, the same code a corrupt
 * file gets - so a member whose 108 MP photo is refused is told their picture is not an image.
 * That is one cause wearing another's name, which `AGENTS.md` failure mode 21 is explicit about.
 * Separating them means a new code in the shared contract and a client that renders it.
 *
 * Kept here rather than beside `MAX_IMAGE_BYTES` in `store.ts` on purpose. That module governs
 * what the *store* will accept and re-verify by size; this governs what the *decoder* will be
 * asked to attempt, and it has to travel with `DECODE_OPTIONS` to the call sites below for the
 * same reason `failOn` does.
 */
export const MAX_IMAGE_PIXELS = 64 * 1024 * 1024;

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
 *
 * `limitInputPixels` is stated rather than left to sharp, for the reasons above the constant.
 * The same "both call sites or neither" argument applies to it with more force than to `failOn`:
 * a limit applied at one of the places that hands bytes to libvips is not a limit.
 */
export const DECODE_OPTIONS = { failOn: 'error', limitInputPixels: MAX_IMAGE_PIXELS } as const;

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
 * `MAX_IMAGE_PIXELS` is checked from the HEADER, before a scanline is allocated, so a
 * decompression bomb costs nothing here and is refused at the boundary rather than discovered
 * when the worker tries to derive from it.
 *
 * Every one of those refusals leaves by the same door: a `{ ok: false, reason }` value, never a
 * throw. `completeUpload` turns it into the typed `undecodable` code and `deriveVariants`
 * records it on the row instead of parking an outbox row, and both of those walk past a thrown
 * error. A bomb is bad input exactly as a corrupt file is, so it must not be a different shape
 * of failure.
 */
export async function probeImage(bytes: Uint8Array): Promise<ImageProbe> {
  /*
   * Lazily, exactly as `derive.ts` does - though be clear about who that actually spares.
   *
   * Sharp carries native binaries and mapping libvips is not free, but `media/pipeline.ts`
   * imports sharp at module scope and `api/routes/media.ts` imports pipeline, so **the api maps
   * libvips at boot whatever this line does.** Measured by importing `api/app.ts` under plain
   * node and counting the mapped shared objects.
   *
   * The **gateway** is the role this genuinely spares: it never reaches any media module, so it
   * never loads sharp at all. The **worker** does reach `derive.ts`, so laziness only defers its
   * cost to the first derivation rather than avoiding it - which for a process whose job is
   * deriving is the first photo anybody uploads.
   */
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
     * broken that even the header fails is refused here rather than one line later, and it is
     * where the pixel ceiling bites.
     */
    const metadata = await image.metadata();
    await image.stats();
    return { ok: true, ...displayDimensions(metadata) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
