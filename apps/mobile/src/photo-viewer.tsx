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

import { useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
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
  mediaId,
  senderName,
  senderImage,
  takenAt,
  contextAction,
  report,
  onClose,
}: {
  mediaId: string;
  /** Null for a deleted account, which the header says rather than inventing a name. */
  senderName: string | null;
  senderImage: string | null;
  /** ISO. Drawn as a date, not a time: a photo is remembered by the day it was taken. */
  takenAt: string;
  contextAction: PhotoViewerContextAction;
  /** Absent on your own photo, and in Eboard chat, where reporting does not exist at all. */
  report?: PhotoViewerReport | undefined;
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

  /**
   * The photo on disk, downloaded once.
   *
   * The `original`, for the reason at the top of this file. Returns the local file plus its type,
   * because both callers need to tell iOS what they are handing it.
   */
  const localCopy = async (): Promise<{ file: File; mime: string }> => {
    const resolved = await resolveMedia(mediaId, 'original');
    const target = new File(Paths.cache, `clubchat-${mediaId}${extensionFor(resolved.mime)}`);
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

  const items: Array<{ label: string; icon: MaterialIconName; onPress: () => void }> = [
    { label: contextAction.label, icon: contextAction.icon, onPress: contextAction.onPress },
    { label: 'Share Image', icon: 'ios-share', onPress: () => void share() },
    { label: 'Download', icon: 'file-download', onPress: () => void download() },
  ];
  if (report !== undefined) {
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
    <View style={styles.viewer}>
      {/*
        Pinch to zoom, which on iOS is what a `ScrollView` with a zoom range gives for free. A
        photograph opened full screen is opened to look closely at, and the alternative is a
        gesture library for one screen.
      */}
      <ScrollView
        style={styles.zoom}
        contentContainerStyle={{ width, height }}
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
          mediaId={mediaId}
          variant="display"
          style={styles.photo}
          // Never crop: the viewer exists to show the whole photograph.
          resizeMode="contain"
          accessibilityLabel={
            senderName === null ? 'Photo, full screen' : `Photo from ${senderName}, full screen`
          }
        />
      </ScrollView>

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

        <Avatar name={senderName ?? '?'} image={senderImage} size={36} />
        <View style={styles.who}>
          <Text style={styles.name} numberOfLines={1}>
            {senderName ?? 'Deleted member'}
          </Text>
          <Text style={styles.date}>
            {new Date(takenAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}
          </Text>
        </View>

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

      {confirmingReport && report !== undefined && (
        <ConfirmDialog
          title="Report a concern"
          body={report.body}
          confirmLabel="Report"
          onCancel={() => setConfirmingReport(false)}
          onConfirm={() => {
            setConfirmingReport(false);
            void run('report this photo', report.run);
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
  zoom: { flex: 1 },
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
