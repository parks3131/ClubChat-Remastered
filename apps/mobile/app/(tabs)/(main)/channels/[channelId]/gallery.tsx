/**
 * The Gallery grid, and the full-screen viewer.
 *
 * Every photo posted in that chat, and nothing else: the gallery inherits the chat's access rules
 * exactly, so a private Eboard photo is unreachable here for the same reason it is unreachable in
 * the conversation.
 *
 * **The grid is edge to edge with a hairline gutter, not a page of cards.** v1 makes this the one
 * screen with no page margin, because photographs are the content rather than something sitting
 * inside content - a 16px margin and a rounded card around each tile turns a gallery into a list.
 */

import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';
import { channelApi } from '../../../../../src/api.ts';
import { RemoteImage } from '../../../../../src/media-bubble.tsx';
import { color, space, type } from '../../../../../src/theme.ts';
import { DataScreen, EmptyState } from '../../../../../src/ui.tsx';
import { useLoad } from '../../../../../src/use-load.ts';

/** Three across, which is the grid the design implies at phone width. */
const COLUMNS = 3;
/** A hairline between tiles rather than a gutter: the photographs should touch. */
const GUTTER = 2;

export default function GalleryScreen() {
  const { channelId } = useLocalSearchParams<{ channelId: string }>();
  const [viewing, setViewing] = useState<string | null>(null);
  const load = useLoad(() => channelApi.gallery(channelId), [channelId]);
  const { width } = useWindowDimensions();

  // The gutter appears between each pair and at each edge, so N columns need N+1 of them.
  const tile = Math.floor((width - GUTTER * (COLUMNS + 1)) / COLUMNS);

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
        <ScrollView style={styles.scroll} contentContainerStyle={styles.grid}>
          {data.entries.map((entry) => (
            <Pressable
              key={entry.mediaId}
              onPress={() => setViewing(entry.mediaId)}
              style={[styles.tile, { width: tile, height: tile }]}
              accessibilityRole="imagebutton"
              accessibilityLabel="Open photo"
            >
              {/*
                `RemoteImage` does the resolve, shared with the chat bubble and the news feed, so
                every render goes through the authorized hop - and the memo in `api.ts` makes a
                grid of thirty photos thirty resolves once rather than per mount.
              */}
              <RemoteImage
                mediaId={entry.mediaId}
                variant="thumb"
                style={styles.image}
                resizeMode="cover"
              />
            </Pressable>
          ))}
          {data.nextCursor !== null && (
            <Text style={styles.more}>Older photos load as you scroll.</Text>
          )}
        </ScrollView>
      )}
    </DataScreen>
  );
}

/**
 * The full-screen viewer.
 *
 * The `display` variant rather than the original: a full-screen view does not need the raw file,
 * and the derived one is what the pipeline made for exactly this. The surface inverts, which is
 * the one place `inverseSurface` is the right token - a photograph is judged against dark.
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
      {/* Floating over the photograph rather than sitting in a bar under it, so nothing crops. */}
      <Pressable
        style={styles.close}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close the photo"
      >
        <MaterialIcons name="close" size={22} color={color.onInverseSurface} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: color.appBackground },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: GUTTER,
    padding: GUTTER,
    paddingBottom: space.xl,
  },
  tile: { backgroundColor: color.cardSunken, overflow: 'hidden' },
  image: { width: '100%', height: '100%' },
  more: { ...type.bodySmall, color: color.textSecondary, padding: space.md },

  viewer: { flex: 1, backgroundColor: color.inverseSurface, justifyContent: 'center' },
  full: { flex: 1, width: '100%' },
  close: {
    position: 'absolute',
    top: space.lg,
    right: space.md,
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
});
