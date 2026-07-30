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
 * > gesture. Whatever tap behaviour these grow (a full-screen viewer), it belongs to the
 * > enclosing bubble rather than to a nested control. Caught by the browser console during the
 * > Phase 3 smoke test.
 */

import { useEffect, useState } from 'react';
import { ActivityIndicator, Image, StyleSheet, Text, View } from 'react-native';
import { formatBytes } from '@clubchat/shared';
import { resolveMediaUrl, type MediaVariant } from './api.ts';
import { color, radius, space, type } from './theme.ts';

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

  useEffect(() => {
    if (localUri || !mediaId) return;
    let cancelled = false;
    void resolveMediaUrl(mediaId, variant)
      .then((resolved) => {
        if (!cancelled) setUri(resolved);
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

  if (failed) {
    return (
      <View style={[styles.photoFrame, styles.photoUnavailable]}>
        <Text style={styles.unavailableText}>Photo unavailable</Text>
      </View>
    );
  }

  if (!uri) {
    return (
      <View style={[styles.photoFrame, styles.photoLoading]}>
        <ActivityIndicator color={color.accent} />
      </View>
    );
  }

  return (
    <View style={styles.photoFrame}>
      <Image
        source={{ uri }}
        style={styles.photo}
        // `contain` rather than `cover`: cropping somebody's photo to fit a bubble hides the
        // part they were pointing at.
        resizeMode="contain"
        onError={() => setFailed(true)}
        accessibilityLabel={mine ? 'Photo you sent' : 'Photo'}
        accessibilityIgnoresInvertColors
      />
    </View>
  );
}

type DocumentProps = {
  name: string | null;
  size: number | null;
  mine: boolean;
};

/** A document bubble: filename and size, per PRD/05's in-scope table. */
export function DocumentBubble({ name, size, mine }: DocumentProps) {
  return (
    <View
      accessibilityLabel={`Document ${name ?? 'attachment'}${
        size === null ? '' : `, ${formatBytes(size)}`
      }`}
      style={[styles.document, mine ? styles.documentMine : styles.documentTheirs]}
    >
      <View style={styles.documentIcon}>
        <Text style={styles.documentIconText}>FILE</Text>
      </View>
      <View style={styles.documentMeta}>
        <Text
          style={[styles.documentName, mine && styles.onAccent]}
          numberOfLines={2}
          // Break in the middle of a long name rather than truncating the extension away - the
          // extension is the most informative part of a filename.
          ellipsizeMode="middle"
        >
          {name ?? 'Attachment'}
        </Text>
        {size !== null && (
          <Text style={[styles.documentSize, mine && styles.onAccentDim]}>
            {formatBytes(size)}
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  photoFrame: {
    width: 220,
    height: 220,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: color.fallback,
  },
  photo: { width: '100%', height: '100%' },
  photoLoading: { alignItems: 'center', justifyContent: 'center' },
  photoUnavailable: { alignItems: 'center', justifyContent: 'center', padding: space.md },
  unavailableText: { ...type.bodySmall, color: color.textSecondary, textAlign: 'center' },
  document: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    maxWidth: 260,
    padding: space.sm,
    borderRadius: radius.md,
  },
  documentMine: { backgroundColor: color.accent },
  documentTheirs: {
    backgroundColor: color.card,
    borderWidth: 1,
    borderColor: color.divider,
  },
  documentIcon: {
    width: 40,
    height: 40,
    borderRadius: radius.sm,
    backgroundColor: color.appBackground,
    alignItems: 'center',
    justifyContent: 'center',
  },
  documentIconText: { ...type.label, color: color.secondary },
  documentMeta: { flex: 1, gap: space.xs },
  documentName: { ...type.body, color: color.textPrimary },
  documentSize: { ...type.label, color: color.textSecondary },
  onAccent: { color: color.onAccent },
  onAccentDim: { color: color.onAccent, opacity: 0.8 },
});
