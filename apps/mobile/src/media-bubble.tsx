/**
 * Photo and document bubbles.
 *
 * A photo renders through `resolveMediaUrl`, which goes via the authorized `/media/:id` hop -
 * so a member who loses access stops being able to load the image, on the next resolve, without
 * anything having to invalidate a cached URL. The bubble never holds a permanent link.
 *
 * > **Both bubbles are plain `View`s, deliberately, and not `Pressable`s.** They render INSIDE
 * > the message bubble's own Pressable, which owns the long-press that reacts and reports. A
 * > second Pressable within it produces a `<button>` nested in a `<button>` on web - invalid
 * > HTML that React reports as a hydration error - and on native it would swallow the outer
 * > gesture. Whatever tap behaviour these grow, it belongs to the enclosing bubble rather than
 * > to a nested control. Caught by the browser console during the Phase 3 smoke test.
 *
 * Both have since grown one, and both obeyed that: a photo opens the full-screen viewer and a
 * document opens the share sheet, and neither gesture is declared in this file. What a document
 * DOES declare is that it is busy - see `opening` on `DocumentBubble`, which is the tapped thing
 * answering rather than a banner somewhere else saying something happened.
 */

import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  StyleSheet,
  Text,
  View,
  type ImageStyle,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { resolveMedia, resolveMediaUrl, type MediaVariant } from './api.ts';
import { documentDetail } from './document-name.ts';
import {
  PHOTO_MAX_WIDTH,
  photoSize,
  rememberRatio,
  rememberedRatio,
} from './photo-size.ts';
import { color, radius, space, type } from './theme.ts';


/**
 * A media id, resolved and rendered.
 *
 * > **Extracted on the third caller**, which is the rule: the chat bubble, the gallery grid and the
 * > news feed all need "turn this id into an image, and say so honestly when it will not load".
 * > `PhotoBubble` is this plus the bubble frame; the gallery and news pass their own.
 *
 * Every render resolves through the authorized `/media/:id/url` hop, so access is re-decided
 * server-side rather than trusted from a URL held in a component. The memo in `api.ts` makes that
 * one request per id per hour-aligned window rather than one per mount.
 */
export function RemoteImage({
  mediaId,
  variant = 'display',
  style,
  resizeMode = 'cover',
  accessibilityLabel = 'Photo',
}: {
  mediaId: string;
  variant?: MediaVariant;
  style?: StyleProp<ImageStyle>;
  resizeMode?: 'cover' | 'contain';
  accessibilityLabel?: string;
}) {
  const [uri, setUri] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void resolveMediaUrl(mediaId, variant)
      .then((resolved) => {
        if (!cancelled) setUri(resolved);
      })
      .catch(() => {
        // Losing access is a legitimate reason to fail. Never a silent blank.
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [mediaId, variant]);

  if (failed) {
    return (
      <View style={[styles.remoteFallback, style as StyleProp<ViewStyle>]}>
        <Text style={styles.unavailableText}>Photo unavailable</Text>
      </View>
    );
  }

  if (uri === null) {
    return (
      <View style={[styles.remoteFallback, style as StyleProp<ViewStyle>]}>
        <ActivityIndicator color={color.accent} />
      </View>
    );
  }

  return (
    <Image
      source={{ uri }}
      style={style}
      resizeMode={resizeMode}
      onError={() => setFailed(true)}
      accessibilityLabel={accessibilityLabel}
      accessibilityIgnoresInvertColors
    />
  );
}

type PhotoProps = {
  mediaId: string | null;
  /** A local uri, for the optimistic bubble before the send is acked. */
  localUri?: string | undefined;
  variant?: MediaVariant;
  mine: boolean;
};

/**
 * A photo bubble.
 *
 * Three states, and the failure one is visible rather than a blank square: an image that will
 * never load looks identical to one still loading, and the difference matters to whoever is
 * waiting.
 */
export function PhotoBubble({ mediaId, localUri, variant = 'display', mine }: PhotoProps) {
  // A local uri renders immediately - the optimistic bubble should not wait on a round trip to
  // show a photo the sender just picked off their own device.
  const [uri, setUri] = useState<string | null>(localUri ?? null);
  const [failed, setFailed] = useState(false);
  /*
   * What this photo is shaped like, remembered across mounts.
   *
   * Keyed by media id rather than by url: the signed url rotates every hour, so a url key would
   * miss on the very reappearances this exists to cover. A lazy initialiser, so a photo that has
   * been on screen before opens at its final size and never resizes at all.
   */
  const ratioKey = mediaId ?? localUri ?? null;
  const [ratio, setRatio] = useState<number | null>(() => rememberedRatio(ratioKey));

  useEffect(() => {
    if (localUri || !mediaId) return;
    let cancelled = false;
    /*
     * `resolveMedia`, not `resolveMediaUrl`: the same authorized hop, keeping the shape it also
     * returns.
     *
     * **This is what makes a photo render at its final size on the first frame.** The server
     * measured it once, at upload, during a decode it was already paying for - so a client that
     * asks for the URL is told the aspect in the same breath and never has to download the bytes
     * to find out. The measure-and-remember path below is now the FALLBACK, for photos uploaded
     * before the server recorded this.
     */
    void resolveMedia(mediaId, variant)
      .then((resolved) => {
        if (cancelled) return;
        if (resolved.width !== null && resolved.height !== null && resolved.height > 0) {
          const known = resolved.width / resolved.height;
          rememberRatio(ratioKey, known);
          setRatio(known);
        }
        setUri(resolved.url);
      })
      .catch(() => {
        // Losing access is a legitimate reason to fail, so this is not necessarily an error -
        // but it is never a silent blank.
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [mediaId, localUri, variant]);

  /*
   * Ask the image how tall it is.
   *
   * > **`onLoad` was tried first and silently did nothing on web.** Its `nativeEvent.source` is a
   * > native-only shape, so the handler ran, found no dimensions and left every photo square - the
   * > exact class this repo already knows as "a check against a field the library does not return
   * > reads undefined forever", and it presents as the feature simply not working.
   *
   * `Image.getSize` is the documented cross-platform call. Its failure path leaves `ratio` null,
   * which is not a hang: the photo falls back to a square box with `contain`, so an unmeasured
   * picture is letterboxed against a transparent background rather than cropped.
   */
  useEffect(() => {
    if (uri === null || ratio !== null) return;
    let cancelled = false;
    Image.getSize(
      uri,
      (width, height) => {
        if (width <= 0 || height <= 0) return;
        rememberRatio(ratioKey, width / height);
        if (!cancelled) setRatio(width / height);
      },
      () => {
        // Not `setFailed`: the bytes may still render perfectly. Only the measurement is lost.
      },
    );
    return () => {
      cancelled = true;
    };
    // `ratio` is read as a guard, not as an input: re-running when it lands would measure a photo
    // twice. `ratioKey` is derived from props that are already in this list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uri]);

  if (failed) {
    return (
      <View style={[styles.photoPlaceholder, styles.photoUnavailable]}>
        <Text style={styles.unavailableText}>Photo unavailable</Text>
      </View>
    );
  }

  if (!uri) {
    return (
      <View style={[styles.photoPlaceholder, styles.photoLoading]}>
        <ActivityIndicator color={color.accent} />
      </View>
    );
  }

  /*
   * The photo is the shape of the photo.
   *
   * > **It used to be a fixed 220 square with `contain` over a grey fill**, so any picture that
   * > was not square arrived matted in two grey bands - which read as part of the message rather
   * > than as an absence, and stacked with the bubble's own fill behind it into three nested
   * > rectangles around one image. The founder's word for it was "boundary shades".
   *
   * Sizing the LONG edge rather than the width keeps a portrait from towering over the
   * conversation while a landscape stays comfortably wide, and means no photo is ever cropped or
   * padded to fit a frame it does not have.
   */
  const size = photoSize(ratio);

  return (
    <Image
      source={{ uri }}
      style={[styles.photo, size]}
      /*
        `cover` once the box IS the image's own ratio - there is nothing left to crop. Until then
        `contain`, so an unmeasured photo is letterboxed against a transparent background rather
        than having its edges taken off to fill a square it never matched.
      */
      resizeMode={ratio === null ? 'contain' : 'cover'}
      onError={() => setFailed(true)}
      accessibilityLabel={mine ? 'Photo you sent' : 'Photo'}
      accessibilityIgnoresInvertColors
    />
  );
}

type DocumentProps = {
  name: string | null;
  size: number | null;
  mine: boolean;
  /**
   * True while the bytes are being fetched for the share sheet.
   *
   * The spinner takes the icon's place rather than sitting beside it, so nothing in the
   * conversation moves while a file is on its way - and it is drawn on the thing that was
   * tapped, which is the only place somebody is looking after tapping it.
   */
  opening?: boolean;
};

/**
 * A document bubble: filename and size, per PRD/05's in-scope table.
 *
 * > **The tile is the bubble, and carries the bubble's own fill.** It was a white card with a
 * > hairline, rendered inside the tinted bubble, so every document in the conversation was two
 * > nested rectangles around one filename - the same "boundary shades" the photo bubble lost its
 * > grey matte for. The message bubble goes `bare` for a document exactly as it does for a
 * > caption-less photo, and this draws the one rectangle that is left.
 */
export function DocumentBubble({ name, size, mine, opening = false }: DocumentProps) {
  const detail = documentDetail(name, size);
  return (
    <View
      accessibilityLabel={`Document ${name ?? 'attachment'}${
        detail === null ? '' : `, ${detail}`
      }`}
      style={[styles.document, mine ? styles.documentMine : styles.documentTheirs]}
    >
      <View style={styles.documentIcon}>
        {opening ? (
          <ActivityIndicator color={color.onAccent} />
        ) : (
          <MaterialIcons name="description" size={26} color={color.onAccent} />
        )}
      </View>
      <View style={styles.documentMeta}>
        <Text
          style={styles.documentName}
          numberOfLines={2}
          // Break in the middle of a long name rather than truncating the extension away - the
          // extension is the most informative part of a filename.
          ellipsizeMode="middle"
        >
          {name ?? 'Attachment'}
        </Text>
        {detail !== null && <Text style={styles.documentDetail}>{detail}</Text>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  remoteFallback: {
    backgroundColor: color.fallback,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /*
    The square stand-in, for the moments a photo is not there to be measured: still resolving, or
    gone. It keeps its grey, because THAT grey is honest - it is the absence of an image rather
    than a frame around one.
  */
  photoPlaceholder: {
    width: PHOTO_MAX_WIDTH,
    height: PHOTO_MAX_WIDTH,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: color.fallback,
  },
  /* No fill and no border. The rounded image is the whole object. */
  photo: { borderRadius: radius.md },
  photoLoading: { alignItems: 'center', justifyContent: 'center' },
  photoUnavailable: { alignItems: 'center', justifyContent: 'center', padding: space.md },
  unavailableText: { ...type.bodySmall, color: color.textSecondary, textAlign: 'center' },
  /*
    The tile IS the bubble. No `maxWidth` of its own: the message row already caps a bubble at 82%
    of the screen, and a second cap here was the tile disagreeing with the conversation about how
    wide a message may be.

    `space.sm + 4` twice, which is the padding-to-icon relationship the founder's mockup holds: the
    frame around the icon is a quarter of the icon, and the gap to the words matches it, so the
    tile reads as one object rather than as an icon with a caption next to it.
  */
  document: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm + 4,
    padding: space.sm + 4,
    borderRadius: radius.lg,
  },
  /*
    The bubble's own two fills, because this tile stands in for the bubble.

    > **It was a white card with a hairline, inside the tinted bubble**, which put two rectangles
    > around every document in the conversation. Before that it was a solid accent slab, back when
    > the sent bubble was an orange gradient carrying white text.

    The two keys stay separate although both are just the bubble's fill: the sent bubble is
    expected to get its own treatment again, and the call site already branches.
  */
  documentMine: { backgroundColor: color.bubbleSent },
  documentTheirs: { backgroundColor: color.bubbleReceived },
  /*
    The accent square, which is the only saturated thing in the tile and is doing the whole job of
    saying "this is a file" at a glance down a scrolling conversation.
  */
  documentIcon: {
    width: 48,
    height: 48,
    borderRadius: radius.md,
    backgroundColor: color.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /*
    `flexShrink`, never `flex: 1`. A flexible basis makes the tile claim the full 82% for a
    six-character filename; shrinking only when it must keeps the bubble close to the size of what
    it contains, which is the relationship the rest of the conversation is built on.
  */
  documentMeta: { flexShrink: 1 },
  documentName: { ...type.headline, color: color.textPrimary },
  documentDetail: { ...type.bodySmall, color: color.textSecondary },
});
