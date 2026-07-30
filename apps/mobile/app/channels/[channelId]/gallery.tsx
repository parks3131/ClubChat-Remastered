/**
 * The Gallery grid, and the full-screen viewer.
 *
 * **Phase 3's remaining client surface.** The server endpoint behind this has been complete and
 * paginated since Phase 3; until now tapping a photo did nothing, which was recorded rather than
 * left implied.
 *
 * Every photo posted in that chat, and nothing else: the gallery inherits the chat's access rules
 * exactly, so a private Eboard photo is unreachable here for the same reason it is unreachable in
 * the conversation.
 */

import { useState } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { channelApi } from '../../../src/api.ts';
import { RemoteImage } from '../../../src/media-bubble.tsx';
import { color, radius, space, type } from '../../../src/theme.ts';
import { Action, Body, DataScreen, EmptyState } from '../../../src/ui.tsx';
import { useLoad } from '../../../src/use-load.ts';

/** Three across, which is the grid the design implies at phone width. */
const COLUMNS = 3;

export default function GalleryScreen() {
  const { channelId } = useLocalSearchParams<{ channelId: string }>();
  const [viewing, setViewing] = useState<string | null>(null);
  const load = useLoad(() => channelApi.gallery(channelId), [channelId]);
  const { width } = useWindowDimensions();

  // The gutter is applied once per edge and once between each pair.
  const tile = Math.floor((width - space.md * 2 - space.xs * (COLUMNS - 1)) / COLUMNS);

  if (viewing !== null) {
    return <Viewer mediaId={viewing} onClose={() => setViewing(null)} />;
  }

  return (
    <DataScreen
      load={load}
      isEmpty={(data) => data.entries.length === 0}
      empty={<EmptyState title="No photos yet" body="Photos posted in this chat collect here." />}
    >
      {(data) => (
        <Body>
          <View style={styles.grid}>
            {data.entries.map((entry) => (
              <Thumb
                key={entry.mediaId}
                mediaId={entry.mediaId}
                size={tile}
                onPress={() => setViewing(entry.mediaId)}
              />
            ))}
          </View>
          {data.nextCursor !== null && (
            <Text style={styles.meta}>Older photos load as you scroll.</Text>
          )}
        </Body>
      )}
    </DataScreen>
  );
}

/**
 * One tile.
 *
 * `RemoteImage` does the resolve, which is shared with the chat bubble and the news feed - every
 * render goes through the authorized hop, and the memo in `api.ts` makes a grid of thirty photos
 * thirty resolves once rather than per mount.
 */
function Thumb({
  mediaId,
  size,
  onPress,
}: {
  mediaId: string;
  size: number;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.tile, { width: size, height: size }]}
      accessibilityRole="imagebutton"
      accessibilityLabel="Open photo"
    >
      <RemoteImage mediaId={mediaId} variant="thumb" style={styles.image} resizeMode="cover" />
    </Pressable>
  );
}

/**
 * The full-screen viewer.
 *
 * The `display` variant rather than the original: a full-screen view does not need the raw file, and
 * the derived one is what the pipeline made for exactly this.
 */
function Viewer({ mediaId, onClose }: { mediaId: string; onClose: () => void }) {
  return (
    <View style={styles.viewer}>
      <RemoteImage
        mediaId={mediaId}
        variant="display"
        style={styles.full}
        resizeMode="contain"
        accessibilityLabel="Photo, full screen"
      />
      <View style={styles.viewerBar}>
        <Action label="Close" variant="secondary" onPress={onClose} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  tile: {
    backgroundColor: color.fallback,
    borderRadius: radius.xs,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  image: { width: '100%', height: '100%' },
  meta: { ...type.bodySmall, color: color.textSecondary },
  viewer: { flex: 1, backgroundColor: color.textPrimary, justifyContent: 'center' },
  full: { flex: 1, width: '100%' },
  viewerBar: { padding: space.md },
});
