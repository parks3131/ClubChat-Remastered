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
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
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
  /*
    Which photo is open, as an INDEX into the list rather than the entry itself.

    The viewer pages between them now, so the thing that changes as you swipe is the position and
    not the identity - and holding the entry would mean the grid and the viewer could disagree
    about what "the current photo" is the moment a page is appended below.
  */
  const [viewingIndex, setViewingIndex] = useState<number | null>(null);
  const load = useLoad(() => channelApi.gallery(channelId), [channelId]);

  /*
   * Older pages, appended as the viewer swipes off the end of what is loaded.
   *
   * The same shape the inbox uses for the same job - see `notifications.tsx`, which this mirrors
   * rather than reinvents. Silent on failure for the same reason: the pages already loaded stay,
   * and the next swipe retries. A photo the reader has not asked for yet is not worth an error
   * state over.
   */
  const [older, setOlder] = useState<GalleryEntry[]>([]);
  const [olderCursor, setOlderCursor] = useState<number | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [exhausted, setExhausted] = useState(false);

  const entries = [...(load.data?.entries ?? []), ...older];
  const nextCursor = olderCursor ?? load.data?.nextCursor ?? null;

  const loadOlder = async () => {
    if (loadingOlder || exhausted || nextCursor === null) return;
    setLoadingOlder(true);
    try {
      const page = await channelApi.gallery(channelId, nextCursor);
      setOlder((current) => [...current, ...page.entries]);
      setOlderCursor(page.nextCursor);
      if (page.nextCursor === null) setExhausted(true);
    } catch {
      // See the note above: a failed page is not an error state.
    } finally {
      setLoadingOlder(false);
    }
  };
  // Only for `canReport`, which is the server's answer about this conversation and not something
  // a gallery can derive: reporting does not exist at all in the Eboard scope.
  const meta = useLoad(() => channelApi.meta(channelId), [channelId]);
  const { width } = useWindowDimensions();

  // The gutter appears between each pair and at each edge, so N columns need N+1 of them.
  const tile = Math.floor((width - GUTTER * (COLUMNS + 1)) / COLUMNS);

  if (viewingIndex !== null && entries.length > 0) {
    return (
      <>
      {/*
        **The navigator's header goes while a photograph is open, and that is what "lift it a bit
        up" was about.** This screen returns the viewer INSTEAD of the grid rather than drawing it
        over the top, so the "Gallery" bar stayed above it - the viewer began an inch down the
        screen, and its own header, which pads by the top inset because it expects to own the
        status bar, was pushed down again by the same amount. What the founder saw was a band of
        empty dark above the picture and the picture too low; the reference he sent alongside is
        GroupMe's viewer, whose chrome sits directly under the status bar.

        Chat and Highlights never had this: both draw the viewer as an absolutely positioned
        sibling over a screen with no header at all. Hiding it here is what makes the three the
        same surface rather than two that agree and one that does not.

        > **Both branches say what the header should be, and the OTHER branch is the bug.** Options
        > reach the navigator through `setOptions`, which MERGES and persists: unmounting the
        > element that hid the header does not put it back. Shipped that way for an hour on
        > 2026-08-29 - closing a photograph returned you to a grid with no bar, no title and no
        > back arrow, which is a screen with no way out of it. So the grid states `true` rather
        > than relying on absence to mean anything.
      */}
      <Stack.Screen options={{ headerShown: false }} />
      <PhotoViewer
        photos={entries}
        initialIndex={viewingIndex}
        /*
          "Show in chat" rather than "Reply", which is the one thing the gallery needs that chat
          does not: a photograph here has been lifted out of the conversation it was said in, and
          getting back to what was being talked about is the question somebody actually has.

          Taking the photo as an argument is what keeps it pointing at the picture ON SCREEN after
          a swipe rather than at the one that was tapped to get here.
        */
        contextAction={(photo) => ({
          label: 'Show in chat',
          icon: 'chat-bubble-outline',
          onPress: () => router.push(`/chat/${channelId}?around=${photo.seq}`),
        })}
        /*
          The server's answer about this conversation, and "not your own photo" - evaluated per
          photo, because swiping from somebody else's onto your own has to take Report away.
          `canReport` is false for the whole Eboard scope, where reporting does not exist at all.
        */
        report={(photo) =>
          meta.data?.canReport === true && photo.senderId !== userId
            ? {
                body: 'This photo goes to the admins of this space, who can read the messages around it. The sender is not told.',
                run: async () => {
                  const result = await channelApi.report(channelId, photo.seq);
                  return result.alreadyReported
                    ? 'You already reported this photo.'
                    : 'Reported. The sender is not told.';
                },
              }
            : null
        }
        onEndReached={() => void loadOlder()}
        onClose={() => setViewingIndex(null)}
      />
      </>
    );
  }

  return (
    <>
    {/* Put back explicitly. See the note in the viewer branch for why absence is not enough. */}
    <Stack.Screen options={{ headerShown: true }} />
    <DataScreen
      load={load}
      isEmpty={(data) => data.entries.length === 0}
      empty={<EmptyState title="No photos yet" body="Photos posted in this chat collect here." />}
    >
      {() => (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.grid}
          /*
            **The grid said "Older photos load as you scroll." and nothing did.** The sentence has
            been on this screen since the gallery shipped, describing a loader that did not exist:
            the read asked for the first page and no code ever asked for a second, so a
            conversation with more than sixty photographs simply ended. Found while adding the
            viewer's own paging on 2026-08-29 - the loader that swipe needed is the loader this
            line was already promising, so wiring it here is six lines and makes an existing claim
            true rather than adding a feature.
          */
          onScroll={({ nativeEvent: e }) => {
            const remaining =
              e.contentSize.height - e.layoutMeasurement.height - e.contentOffset.y;
            if (remaining < e.layoutMeasurement.height) void loadOlder();
          }}
          scrollEventThrottle={200}
        >
          {/*
            `entries`, not `data.entries`: the grid draws the first page PLUS whatever swiping
            through the viewer has pulled in behind it. Reading from `data` here would show the
            grid shrinking back to sixty every time the viewer was closed.
          */}
          {entries.map((entry, i) => (
            <Pressable
              key={entry.mediaId}
              onPress={() => setViewingIndex(i)}
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
          {nextCursor !== null && (
            <Text style={styles.more}>Older photos load as you scroll.</Text>
          )}
        </ScrollView>
      )}
    </DataScreen>
    </>
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
