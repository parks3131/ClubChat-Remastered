/**
 * The full-screen photo viewer, and the menu hanging off it.
 *
 * **One viewer, two ways in.** A photo tapped in chat and a photo tapped in that chat's gallery
 * are the same photograph and get the same screen - a face, a name and a date over a dark field,
 * with everything else behind three dots. The only difference is the first item in that menu:
 * from chat it is **Reply**, and from the gallery it is **Show in chat**, because the gallery is
 * the one place where "take me back to where this was said" is a thing somebody needs.
 *
 * ---
 *
 * **It shows a LIST and an index into it, not one photograph, and that is the whole shape of the
 * component.** Asked for from the phone on 2026-08-29: "we should be able to swipe and slide those
 * pictures, we don't wanna go back and click the other one to see it." Every caller already had a
 * list in its hand - the gallery its grid, chat its loaded conversation - and was throwing all but
 * one entry away at the moment of opening.
 *
 * Two consequences the callers have to honour, and both are ways this goes subtly wrong:
 *
 *  - **Everything in the chrome belongs to the photo you are ON, not the one you opened.** The
 *    face, the name and the date are read from the current entry, and `contextAction` and `report`
 *    are FUNCTIONS OF IT rather than fixed objects. A "Show in chat" that still pointed at the
 *    photo you opened three swipes ago would be the exact bug this shape exists to prevent, and it
 *    is the kind that looks fine until somebody swipes.
 *  - **A one-entry list is the old behaviour**, with nothing to swipe to. That is what Highlights
 *    passes: its strip is a mix of photographs, documents and text, so paging within it would
 *    either skip the non-photos or stop dead at them.
 *
 * **A `FlatList` rather than the `ScrollView` the news carousel uses**, which is the one place this
 * deliberately does not mirror the closest existing feature. That carousel holds three photos at a
 * post's width; a gallery holds sixty at `display` size, and a `ScrollView` mounts every child at
 * once. Windowed to the neighbours, so swiping is instant in both directions and the other
 * fifty-seven are never decoded.
 *
 * ---
 *
 * **Saving downloads the `original`, never the `display` variant, and that is not a quality
 * preference.** `derive.ts` writes the derived variants as WebP, and iOS decides what it is being
 * handed from the file extension alone: `createAsset` throws `EmptyFileExtensionException` for a
 * name with no extension and rejects a type it does not recognise. Photos does not take WebP. So
 * the bytes have to be the ones the sender uploaded, and the name has to carry the real type -
 * which is why the resolve hop returns a `mime` at all. The object key has no extension to read
 * one from.
 *
 * **The temp file is cached per media id**, so Share Image followed by Download is one download
 * rather than two, and a second look at the same photo re-uses what is already on disk.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { resolveMedia } from './api.ts';
import { RemoteImage } from './media-bubble.tsx';
import { color, radius, space, type } from './theme.ts';
import { Avatar, ConfirmDialog } from './ui.tsx';
import { useNotice } from './use-notice.ts';

type MaterialIconName = React.ComponentProps<typeof MaterialIcons>['name'];

/**
 * One photograph in the viewer's list.
 *
 * Deliberately the intersection of what a `GalleryEntry` and a `MessageEnvelope` both already
 * carry, so neither caller has to invent a field or reshape a read. `seq` is here because both
 * `contextAction` and `report` are about the MESSAGE the photo arrived in rather than the media.
 */
export type PhotoViewerPhoto = {
  mediaId: string;
  seq: number;
  senderId: string;
  /** Null for a deleted account, which the header says rather than inventing a name. */
  senderName: string | null;
  senderImage: string | null;
  /** ISO. Drawn as a date, not a time: a photo is remembered by the day it was taken. */
  createdAt: string;
};

/** The one action that differs by where the viewer was opened from. */
export type PhotoViewerContextAction = {
  label: string;
  icon: MaterialIconName;
  onPress: () => void;
};

/**
 * Reporting, when the viewer may offer it.
 *
 * **The confirmation lives here rather than in either caller**, so a photo reported from chat and
 * the same photo reported from the gallery ask the same question and get the same answer. `body`
 * still comes from the caller, because where a report actually goes differs: a DM's goes to
 * ClubChat moderators and a space's goes to that space's admins, and saying the wrong one is
 * worse than saying nothing.
 */
export type PhotoViewerReport = {
  body: string;
  /** Returns what to tell the reporter afterwards. */
  run: () => Promise<string>;
};

/**
 * `image/jpeg` to `.jpg`.
 *
 * Falls back to `.jpg` rather than to no extension: a wrong-but-plausible extension gets a
 * readable failure out of iOS, and an empty one gets `EmptyFileExtensionException`, which is a
 * worse thing to show somebody who tapped Download.
 */
function extensionFor(mime: string): string {
  switch (mime) {
    case 'image/png':
      return '.png';
    case 'image/heic':
      return '.heic';
    case 'image/heif':
      return '.heif';
    case 'image/webp':
      return '.webp';
    case 'image/gif':
      return '.gif';
    default:
      return '.jpg';
  }
}

export function PhotoViewer({
  photos,
  initialIndex,
  contextAction,
  report,
  onEndReached,
  onClose,
}: {
  /** Newest first, in whatever order the caller draws them. Never empty. */
  photos: readonly PhotoViewerPhoto[];
  /** Which one was tapped. Clamped, because a caller can hand a stale index across a reload. */
  initialIndex: number;
  /** Read for the photo currently on screen, never for the one that was opened. */
  contextAction: (photo: PhotoViewerPhoto) => PhotoViewerContextAction;
  /**
   * Absent on your own photo, and in Eboard chat, where reporting does not exist at all.
   *
   * A function returning null rather than an optional object, because reportability is per photo:
   * swiping from somebody else's picture onto your own has to take the item away.
   */
  report?: ((photo: PhotoViewerPhoto) => PhotoViewerReport | null) | undefined;
  /**
   * Reached the last photo in the list, so the caller may append more.
   *
   * Optional, and a caller with everything already loaded simply omits it. Chat does: its list is
   * the conversation it has loaded, which grows by scrolling the conversation rather than here.
   */
  onEndReached?: (() => void) | undefined;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [menuOpen, setMenuOpen] = useState(false);
  /** What the last action did, said back to the person who asked for it. */
  // Clears itself; see `useNotice`.
  const [notice, setNotice] = useNotice();
  const [busy, setBusy] = useState(false);
  /** Set once Report is tapped, so it takes a second deliberate step - as it does in chat. */
  const [confirmingReport, setConfirmingReport] = useState(false);

  const clamp = (i: number) => Math.max(0, Math.min(i, photos.length - 1));
  const [index, setIndex] = useState(() => clamp(initialIndex));

  /*
   * The viewer's OWN box, measured, rather than the window's.
   *
   * > **A page sized to the window hangs off the bottom of the screen, and the photograph inside it
   * > is centred on the part you cannot see.** This viewer is drawn inside a navigator screen, so
   * > it starts below the navigation bar and has that much less height than the window - and a
   * > `contain` fit centred in a box an inch taller than its container sits an inch too low, with a
   * > dead band above it. Reported from the phone on 2026-08-29 as "lift it a bit up".
   *
   * Measured rather than derived from `useSafeAreaInsets` plus a guess at the header: the box knows
   * its own size, and a screen that later gets a taller header or none at all keeps working.
   */
  const [frame, setFrame] = useState<{ width: number; height: number } | null>(null);
  const pageWidth = frame?.width ?? width;
  const pageHeight = frame?.height ?? height;

  /*
   * The photo the chrome is about.
   *
   * Falls back to the first entry rather than going undefined: `photos` can shrink under this
   * component - the gallery reloads after a report - and a header that renders nothing for a
   * frame is worse than one showing a neighbour.
   */
  const photo = photos[clamp(index)] ?? photos[0];

  /*
   * Swiping is a change of subject, so the chrome that belonged to the last photo goes.
   *
   * The menu, because it lists actions for a photo that is no longer on screen; the notice,
   * because "Saved to your photos." floating over the NEXT picture is a claim about the wrong
   * one. Keyed on the index rather than done in the scroll handler so it also covers a caller
   * that moves the index itself.
   */
  useEffect(() => {
    setMenuOpen(false);
    setNotice(null);
    // `setNotice` is stable; see `useNotice`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  const onMomentumEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (pageWidth <= 0) return;
      const next = Math.round(event.nativeEvent.contentOffset.x / pageWidth);
      setIndex((current) => (current === next ? current : clamp(next)));
      // `clamp` closes over `photos.length`, which is why this is not a bare setState.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [pageWidth, photos.length],
  );

  /*
   * The type-level floor under "never empty", placed after the last hook so the early return
   * cannot change the hook order.
   *
   * Every caller guards this already - the gallery on `entries.length`, chat and Highlights by
   * only rendering the viewer when they hold a photo. Drawing nothing is the right answer to a
   * list that should not exist: the alternative under `noUncheckedIndexedAccess` is a non-null
   * assertion, which is the same promise made where nothing can check it.
   */
  if (photo === undefined) return null;

  /**
   * The photo on disk, downloaded once.
   *
   * The `original`, for the reason at the top of this file. Returns the local file plus its type,
   * because both callers need to tell iOS what they are handing it.
   */
  const localCopy = async (): Promise<{ file: File; mime: string }> => {
    const resolved = await resolveMedia(photo.mediaId, 'original');
    const target = new File(Paths.cache, `clubchat-${photo.mediaId}${extensionFor(resolved.mime)}`);
    if (target.exists) return { file: target, mime: resolved.mime };
    const downloaded = await File.downloadFileAsync(resolved.url, target);
    return { file: downloaded, mime: resolved.mime };
  };

  const run = async (label: string, action: () => Promise<string>) => {
    setMenuOpen(false);
    setBusy(true);
    setNotice(null);
    try {
      setNotice(await action());
    } catch {
      // Never silent. Whoever tapped it is standing there waiting for something to happen.
      setNotice(`Couldn't ${label.toLowerCase()}. Try again.`);
    } finally {
      setBusy(false);
    }
  };

  const share = () =>
    run('share this photo', async () => {
      const { file, mime } = await localCopy();
      if (!(await Sharing.isAvailableAsync())) return 'Sharing is not available on this device.';
      await Sharing.shareAsync(file.uri, { mimeType: mime, dialogTitle: 'Share photo' });
      // The sheet reports itself; saying "Shared" after it closes would be a second, wrong claim
      // about something the person may well have cancelled.
      return '';
    });

  const download = () =>
    run('save this photo', async () => {
      /*
       * **`expo-media-library` is imported here rather than at the top of the file, and that is
       * load-bearing rather than tidy.** It has no web implementation, so evaluating the module
       * throws `Cannot find native module 'ExpoMediaLibraryNext'` - and a static import is
       * evaluated when the BUNDLE loads, which took the whole web app down with it: a blank
       * screen on every route, not a broken Download button. That is AGENTS.md failure mode 8
       * exactly, one package over from the `expo-sqlite` wasm case, and it shipped on
       * 2026-08-01 because the photo viewer was verified on a device and never in a browser.
       *
       * Deferring it means the module is only evaluated when somebody actually taps Download,
       * by which point the guard below has already sent web callers home.
       */
      if (Platform.OS === 'web') {
        return 'Saving to Photos is not available on the web. Use Share Image instead.';
      }
      const { file } = await localCopy();
      const MediaLibrary = await import('expo-media-library');
      // Write-only: this asks for "add to your photos" rather than for the run of the library,
      // which is the whole permission this needs and the smaller thing to ask a member for.
      const permission = await MediaLibrary.requestPermissionsAsync(true);
      if (!permission.granted) return 'Allow photo access in Settings to save photos.';
      await MediaLibrary.Asset.create(file.uri);
      return 'Saved to your photos.';
    });

  // Read for THIS photo, every render, which is what keeps the menu honest across a swipe.
  const action = contextAction(photo);
  const reportable = report?.(photo) ?? null;

  const items: Array<{ label: string; icon: MaterialIconName; onPress: () => void }> = [
    { label: action.label, icon: action.icon, onPress: action.onPress },
    { label: 'Share Image', icon: 'ios-share', onPress: () => void share() },
    { label: 'Download', icon: 'file-download', onPress: () => void download() },
  ];
  if (reportable !== null) {
    items.push({
      label: 'Report',
      icon: 'flag',
      onPress: () => {
        setMenuOpen(false);
        setConfirmingReport(true);
      },
    });
  }

  return (
    <View
      style={styles.viewer}
      onLayout={(event) => {
        const { width: w, height: h } = event.nativeEvent.layout;
        // Compared before setting, or every layout pass is a re-render and the pager resets.
        setFrame((current) =>
          current !== null && current.width === w && current.height === h
            ? current
            : { width: w, height: h },
        );
      }}
    >
      {/*
        One page per photograph, each page its own zoom surface.

        `pagingEnabled` rather than a gesture library: the swipe wanted here is a page turn, which
        is what a paging scroll view already is on both platforms. The zoom below is the same
        `ScrollView` trick it has always been, now one per page - which also means the zoom on a
        photo you have swiped away from is discarded with its page rather than following you.

        `getItemLayout` is not an optimisation here, it is what makes `initialScrollIndex` work:
        without it the list cannot know where page seventeen starts, and opening the seventeenth
        photo lands on the first.
      */}
      <FlatList
        data={photos}
        keyExtractor={(item) => item.mediaId}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        initialScrollIndex={clamp(initialIndex)}
        getItemLayout={(_, i) => ({ length: pageWidth, offset: pageWidth * i, index: i })}
        onMomentumScrollEnd={onMomentumEnd}
        // The neighbours, so a swipe in either direction is instant and nothing else is decoded.
        windowSize={3}
        initialNumToRender={1}
        maxToRenderPerBatch={2}
        {...(onEndReached ? { onEndReached, onEndReachedThreshold: 0.5 } : {})}
        renderItem={({ item }) => (
          <ScrollView
            style={{ width: pageWidth, height: pageHeight }}
            contentContainerStyle={{ width: pageWidth, height: pageHeight }}
            maximumZoomScale={4}
            minimumZoomScale={1}
            centerContent
            showsHorizontalScrollIndicator={false}
            showsVerticalScrollIndicator={false}
          >
            {/*
              `RemoteImage` rather than a bare `Image`: it owns the resolve, the spinner and the
              honest "Photo unavailable", and it is the same component the bubble and the grid use -
              so a member who loses access sees the same truthful thing in all three places.
            */}
            <RemoteImage
              mediaId={item.mediaId}
              variant="display"
              style={styles.photo}
              // Never crop: the viewer exists to show the whole photograph.
              resizeMode="contain"
              accessibilityLabel={
                item.senderName === null
                  ? 'Photo, full screen'
                  : `Photo from ${item.senderName}, full screen`
              }
            />
          </ScrollView>
        )}
      />

      {/*
        The header floats over the photograph rather than sitting in a bar above it, so nothing
        is cropped to make room for chrome - v1's own viewer arrangement, and GroupMe's.
      */}
      <View style={[styles.header, { paddingTop: insets.top + space.sm }]}>
        <Pressable
          style={styles.circle}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close the photo"
        >
          <MaterialIcons name="close" size={22} color={color.onInverseSurface} />
        </Pressable>

        <Avatar name={photo.senderName ?? '?'} image={photo.senderImage} size={36} />
        <View style={styles.who}>
          <Text style={styles.name} numberOfLines={1}>
            {photo.senderName ?? 'Deleted member'}
          </Text>
          <Text style={styles.date}>
            {new Date(photo.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}
          </Text>
        </View>

        {/*
          **No "3 / 24" counter.** One was built and taken straight back out on 2026-08-29: "i
          dont want the numbers the 1/6". The reference the founder sent is GroupMe's viewer,
          which carries a face, a name and a date and nothing else - a running total is a fact
          about the list rather than about the photograph you are looking at, and this header is
          about the photograph.
        */}
        <Pressable
          style={styles.circle}
          onPress={() => setMenuOpen((open) => !open)}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Photo options"
        >
          {busy ? (
            <ActivityIndicator color={color.onInverseSurface} />
          ) : (
            <MaterialIcons name="more-vert" size={22} color={color.onInverseSurface} />
          )}
        </Pressable>
      </View>

      {menuOpen && (
        <>
          <Pressable
            style={styles.scrim}
            onPress={() => setMenuOpen(false)}
            accessibilityRole="button"
            accessibilityLabel="Close"
          />
          <View style={[styles.menu, { top: insets.top + 60 }]}>
            {items.map((item) => (
              <Pressable
                key={item.label}
                style={styles.menuRow}
                onPress={item.onPress}
                accessibilityRole="button"
                accessibilityLabel={item.label}
              >
                <MaterialIcons name={item.icon} size={20} color={color.textPrimary} />
                <Text style={styles.menuLabel}>{item.label}</Text>
              </Pressable>
            ))}
          </View>
        </>
      )}

      {confirmingReport && reportable !== null && (
        <ConfirmDialog
          title="Report a concern"
          body={reportable.body}
          confirmLabel="Report"
          onCancel={() => setConfirmingReport(false)}
          onConfirm={() => {
            setConfirmingReport(false);
            void run('report this photo', reportable.run);
          }}
        />
      )}

      {/* An empty notice is a real outcome - the share sheet already spoke for itself. */}
      {notice !== null && notice.length > 0 && (
        <View style={[styles.notice, { paddingBottom: insets.bottom + space.md }]}>
          <Text style={styles.noticeText}>{notice}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  viewer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: color.inverseSurface,
    zIndex: 200,
  },
  photo: { width: '100%', height: '100%' },

  header: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingBottom: space.sm,
  },
  circle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  who: { flex: 1, minWidth: 0 },
  name: { ...type.headline, color: color.onInverseSurface },
  date: { ...type.bodySmall, color: color.onInverseSurface, opacity: 0.7 },

  scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 210 },
  menu: {
    position: 'absolute',
    right: space.md,
    zIndex: 211,
    minWidth: 220,
    backgroundColor: color.card,
    borderRadius: radius.lg,
    paddingVertical: space.sm,
  },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
  },
  menuLabel: { ...type.body, color: color.textPrimary },

  notice: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    paddingHorizontal: space.md,
    paddingTop: space.md,
  },
  noticeText: {
    ...type.bodySmall,
    color: color.onInverseSurface,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    overflow: 'hidden',
  },
});
