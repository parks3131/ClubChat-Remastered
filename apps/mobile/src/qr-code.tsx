/**
 * A club's join link, as a square somebody can point a camera at.
 *
 * **The encoder is `qrcode-generator` and the drawing is ours**, rather than a wrapper component,
 * for two reasons. The wrappers all drag a dependency tree behind them - the popular one pulls
 * `qrcode`, which pulls `yargs`, into a phone bundle - and every one of them would still need
 * teaching the two things this file actually has an opinion about: the quiet zone, and the hole
 * the club's picture sits in.
 *
 * Three properties here are load-bearing rather than stylistic, and each one is the difference
 * between a code that scans and a picture of a code:
 *
 * 1. **The quiet zone.** Four clear modules on every side is part of the QR specification, not
 *    padding. Cropped to the code's own edge, a scanner cannot find the symbol at all.
 * 2. **Dark on light, at full contrast.** Modules are `textPrimary` on white, never the accent -
 *    `#ff4d00` on white is around 3:1, which reads as "our colour" to a person and as a maybe to a
 *    camera. The accent belongs to the frame around the tile, where it costs nothing.
 * 3. **Error correction `H`, because the middle is covered.** The club's picture occupies about 5%
 *    of the symbol's area; level H tolerates 30%, so the code still resolves with the logo over it.
 *    Lower a level and the hole starts eating real data.
 *
 * The background is painted rather than left transparent, for the same class of reason: the
 * exported PNG lands wherever somebody shares it, and a transparent quiet zone over a dark
 * message bubble is an unscannable code that looked fine in the app.
 */

import { useEffect, useMemo, useState } from 'react';
import type { RefObject } from 'react';
import qrcode from 'qrcode-generator';
import Svg, { ClipPath, Defs, G, Image as SvgImage, Path, Rect } from 'react-native-svg';
import { resolveMediaUrl } from './api.ts';
import { color } from './theme.ts';

/** The specification's minimum, in modules. Not a design choice. */
const QUIET_ZONE = 4;

/** How much of the symbol's width the club's picture may cover. See the header. */
const LOGO_SHARE = 0.22;

export type QrCodeRef = RefObject<Svg | null>;

/**
 * The code itself.
 *
 * `svgRef` is how the screen gets a PNG out of this: `react-native-svg` renders the live view to
 * a bitmap through `toDataURL`, which is why saving and sharing the image need no second drawing
 * path and cannot drift from what is on screen.
 */
export function QrCode({
  value,
  image,
  size,
  svgRef,
}: {
  /** The link the code carries. */
  value: string;
  /** The club's picture, as a media id. Null draws the code with no hole in it. */
  image?: string | null;
  size: number;
  svgRef?: QrCodeRef;
}) {
  const [logoUri, setLogoUri] = useState<string | null>(null);

  useEffect(() => {
    if (image === null || image === undefined) {
      setLogoUri(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      /*
       * **The picture is inlined as a data URI rather than referenced by its URL, so the export
       * is a snapshot of something already here.** Saving rasterises whatever is drawn at that
       * instant; a remote `href` makes the picture's arrival a race against the button, run
       * again inside the rasteriser, and on web it is run against a *re-parsed copy* of the SVG
       * whose external fetches are the browser's business rather than ours. Inlined, the export
       * cannot come out with a hole where the club should be.
       *
       * The presigned URL is still what we start from - this only changes when the bytes are
       * fetched, never who is allowed to fetch them.
       */
      const url = await resolveMediaUrl(image, 'thumb');
      const blob = await (await fetch(url)).blob();
      const inlined = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('The picture could not be read.'));
        reader.onload = () => resolve(String(reader.result));
        reader.readAsDataURL(blob);
      });
      if (!cancelled) setLogoUri(inlined);
    })()
      // A picture that will not resolve is not a reason to withhold the code. It draws without one.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [image]);

  const symbol = useMemo(() => {
    // Type 0 is "the smallest that fits", so a rotated token that happens to be longer still
    // encodes rather than throwing.
    const code = qrcode(0, 'H');
    code.addData(value);
    code.make();

    const count = code.getModuleCount();
    const logo =
      logoUri === null
        ? null
        : (() => {
            const span = Math.round(count * LOGO_SHARE);
            const start = Math.floor((count - span) / 2);
            // One clear module all the way round, so the picture sits IN the code rather than
            // being crowded by it. Also the reason the cleared square is bigger than the drawn
            // one: a logo whose edge touches live modules reads as a printing fault.
            return { start, span, end: start + span, holeStart: start - 1, holeEnd: start + span + 1 };
          })();

    // ONE path rather than a rect per module: a symbol at this size is around 1,100 modules, and
    // half of them being their own view is a real cost on a phone and in the bitmap export.
    let d = '';
    for (let row = 0; row < count; row += 1) {
      for (let col = 0; col < count; col += 1) {
        if (!code.isDark(row, col)) continue;
        // Modules under the picture are dropped from the path rather than painted over, so the
        // exported PNG has no dark pixels hiding beneath a logo that failed to load.
        if (
          logo !== null &&
          row >= logo.holeStart &&
          row < logo.holeEnd &&
          col >= logo.holeStart &&
          col < logo.holeEnd
        ) {
          continue;
        }
        d += `M${col} ${row}h1v1h-1z`;
      }
    }

    return { count, path: d, logo };
  }, [value, logoUri]);

  const extent = symbol.count + QUIET_ZONE * 2;

  return (
    <Svg
      ref={svgRef}
      width={size}
      height={size}
      viewBox={`0 0 ${extent} ${extent}`}
      /*
        **No apostrophe in here, and nothing interpolated that could contain one.** Exporting a
        PNG goes through `data:image/svg+xml`, and `react-native-svg` builds that string by
        swapping every double quote for a single quote - so one apostrophe inside any attribute
        value closes the attribute early, the SVG fails to parse, and `img.onerror` fires where
        the only handler is `onload`. That is a save button that spins forever, from a label
        nobody would think to suspect. A club named "Roja's Runners" would do it too, which is
        why the name is drawn by the SCREEN around this code and never inside it.
      */
      accessibilityLabel="QR code for the club join link"
    >
      {/* Painted, never transparent. See the header. */}
      <Rect x={0} y={0} width={extent} height={extent} fill={color.card} />
      <G transform={`translate(${QUIET_ZONE}, ${QUIET_ZONE})`}>
        <Path d={symbol.path} fill={color.textPrimary} />
        {symbol.logo !== null && logoUri !== null && (
          <>
            <Defs>
              {/*
                A rounded square, not a circle: the product's one rule about roundness is that
                circles are people and rounded squares are things, and a club is a thing.
                `SPEC/DESIGN/02-avatar`.
              */}
              <ClipPath id="qr-code-logo">
                <Rect
                  x={symbol.logo.start}
                  y={symbol.logo.start}
                  width={symbol.logo.span}
                  height={symbol.logo.span}
                  rx={symbol.logo.span * 0.22}
                />
              </ClipPath>
            </Defs>
            <SvgImage
              href={{ uri: logoUri }}
              x={symbol.logo.start}
              y={symbol.logo.start}
              width={symbol.logo.span}
              height={symbol.logo.span}
              preserveAspectRatio="xMidYMid slice"
              clipPath="url(#qr-code-logo)"
            />
          </>
        )}
      </G>
    </Svg>
  );
}
