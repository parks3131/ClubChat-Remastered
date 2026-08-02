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
import { useLocalSearchParams, useRouter } from 'expo-router';
import { channelApi } from '../../../../../src/api.ts';
import type { GalleryEntry } from '../../../../../src/api-types.ts';
import { useSession } from '../../../../../src/chat-provider.tsx';
import { RemoteImage } from '../../../../../src/media-bubble.tsx';
import { PhotoViewer } from '../../../../../src/photo-viewer.tsx';
import { color, space, type } from '../../../../../src/theme.ts';
import { DataScreen, EmptyState } from '../../../../../src/ui.tsx';
import { useLoad } from '../../../../../src/use-load.ts';

/** Three across, which is the grid the design implies at phone width. */
const COLUMNS = 3;
/** A hairline between tiles rather than a gutter: the photographs should touch. */
const GUTTER = 2;

export default function GalleryScreen() {
  const { channelId } = useLocalSearchParams<{ channelId: string }>();
  const router = useRouter();
  const { userId } = useSession();
  const [viewing, setViewing] = useState<GalleryEntry | null>(null);
  const load = useLoad(() => channelApi.gallery(channelId), [channelId]);
  // Only for `canReport`, which is the server's answer about this conversation and not something
  // a gallery can derive: reporting does not exist at all in the Eboard scope.
  const meta = useLoad(() => channelApi.meta(channelId), [channelId]);
  const { width } = useWindowDimensions();

  // The gutter appears between each pair and at each edge, so N columns need N+1 of them.
  const tile = Math.floor((width - GUTTER * (COLUMNS + 1)) / COLUMNS);

  if (viewing !== null) {
    const entry = viewing;
    const reportable = meta.data?.canReport === true && entry.senderId !== userId;
    return (
      <PhotoViewer
        mediaId={entry.mediaId}
        senderName={entry.senderName}
        senderImage={entry.senderImage}
        takenAt={entry.createdAt}
        /*
          "Show in chat" rather than "Reply", which is the one thing the gallery needs that chat
          does not: a photograph here has been lifted out of the conversation it was said in, and
          getting back to what was being talked about is the question somebody actually has.
        */
        contextAction={{
          label: 'Show in chat',
          icon: 'chat-bubble-outline',
          onPress: () => router.push(`/chat/${channelId}?around=${entry.seq}`),
        }}
        {...(reportable
          ? {
              report: {
                body: 'This photo goes to the admins of this space, who can read the messages around it. The sender is not told.',
                run: async () => {
                  const result = await channelApi.report(channelId, entry.seq);
                  return result.alreadyReported
                    ? 'You already reported this photo.'
                    : 'Reported. The sender is not told.';
                },
              },
            }
          : {})}
        onClose={() => setViewing(null)}
      />
    );
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
              onPress={() => setViewing(entry)}
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
});
