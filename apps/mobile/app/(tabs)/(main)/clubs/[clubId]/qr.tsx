/**
 * The club's join link as a code somebody can point a camera at.
 *
 * **What the code carries is a `clubchat://` link, and that has one consequence worth stating
 * plainly here rather than discovering with a phone in your hand: it opens the club for somebody
 * who already has ClubChat, and does nothing at all for somebody who does not.** A camera pointed
 * at a scheme it cannot resolve shows no prompt and no error. The fix is not on this screen - it
 * is an https join page that opens the app when installed and the store when not, which
 * `ADR-0010` recorded as owed from the day the typed code was removed. See
 * `SPEC/PRD/17-roadmap-and-open-questions.md`.
 *
 * So this screen is honest about its audience in the caption: it is for handing the club to
 * somebody standing in front of you, which is the case a link in a message does not cover.
 *
 * The drawing, the quiet zone and the error-correction level are `src/qr-code.tsx`'s business.
 * This screen owns the frame around it, and getting the image out to Photos or a file.
 */

import { useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { File, Paths } from 'expo-file-system';
import { LinearGradient } from 'expo-linear-gradient';
import * as Linking from 'expo-linking';
import { MaterialIcons } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';
import type Svg from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { clubApi } from '../../../../../src/api.ts';
import { useDeclareClub } from '../../../../../src/current-space.tsx';
import { QrCode } from '../../../../../src/qr-code.tsx';
import { color, radius, space, tabBarSpace, type } from '../../../../../src/theme.ts';
import { DataScreen } from '../../../../../src/ui.tsx';
import { useLoad } from '../../../../../src/use-load.ts';

/** The code's drawn size. Big enough to scan across a table, small enough to sit under a title. */
const CODE_SIZE = 260;

export default function ClubQrScreen() {
  const { clubId } = useLocalSearchParams<{ clubId: string }>();
  const load = useLoad(() => clubApi.detail(clubId), [clubId]);
  useDeclareClub(clubId, load.data?.club.name, load.data?.club.image);
  const insets = useSafeAreaInsets();

  const svgRef = useRef<Svg | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * The code as PNG bytes, rendered from the view that is on screen.
   *
   * Through `react-native-svg`'s own `toDataURL` rather than a second drawing path, so what gets
   * saved cannot drift from what was scanned in the app. Returns bare base64 - no `data:` prefix.
   */
  const exportPng = () =>
    new Promise<string>((resolve, reject) => {
      const svg = svgRef.current;
      if (svg === null) {
        reject(new Error('The code is not drawn yet.'));
        return;
      }
      /*
       * **Bounded, because `toDataURL` takes a callback and has silent failure paths.** Its web
       * implementation returns without calling back when its own ref is missing, and waits on an
       * `img.onload` that never fires if the SVG will not rasterise. A promise that never settles
       * leaves the button disabled and saying "Saving" for as long as the screen is open, which
       * is exactly what happened here before the picture was inlined.
       */
      const bail = setTimeout(() => reject(new Error('Rendering the code timed out.')), 5000);
      svg.toDataURL((base64) => {
        clearTimeout(bail);
        resolve(base64);
      });
    });

  const save = async (clubName: string) => {
    setBusy(true);
    setNotice(null);
    try {
      const base64 = await exportPng();
      const filename = `clubchat-${clubName.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-qr.png`;

      if (Platform.OS === 'web') {
        // A browser has no photo library. It has a downloads folder, which is where somebody
        // making a flyer on a laptop actually wants this.
        const anchor = document.createElement('a');
        anchor.href = `data:image/png;base64,${base64}`;
        anchor.download = filename;
        anchor.click();
        setNotice('Saved to your downloads.');
        return;
      }

      const file = new File(Paths.cache, filename);
      file.create({ overwrite: true });
      file.write(base64, { encoding: 'base64' });

      /*
       * **Imported here rather than at the top of the file, and that is load-bearing.**
       * `expo-media-library` has no web implementation, so evaluating the module throws - and a
       * static import is evaluated when the BUNDLE loads, which takes down every route rather
       * than one button. AGENTS.md failure mode 8, which shipped exactly this way once.
       */
      const MediaLibrary = await import('expo-media-library');
      // Write-only: "add to your photos" is the whole permission this needs.
      const permission = await MediaLibrary.requestPermissionsAsync(true);
      if (!permission.granted) {
        setNotice('Allow photo access in Settings to save the code.');
        return;
      }
      await MediaLibrary.Asset.create(file.uri);
      setNotice('Saved to your photos.');
    } catch {
      // Never silent: somebody is standing there waiting for something to happen.
      setNotice("Couldn't save the code. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <DataScreen load={load} errorMessage="Couldn't load this club.">
      {(data) => {
        const club = data.club;
        const inviteUrl = Linking.createURL(`/join/${club.inviteToken}`);

        return (
          <ScrollView
            style={styles.flex}
            contentContainerStyle={[
              styles.body,
              { paddingBottom: tabBarSpace(insets.bottom) + space.lg },
            ]}
          >
            <Text style={styles.name}>{club.name}</Text>

            {/*
              The accent tile is the club's own colour around a code that stays black on white.
              The gradient is the app's one branded fill - the same pair the sent bubble uses -
              and it deliberately stops at the code's edge: modules in the accent would read as
              ours to a person and as a maybe to a camera. See `src/qr-code.tsx`.
            */}
            <LinearGradient
              colors={[color.accent, color.accentPressed]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.tile}
            >
              <View style={styles.codeCard}>
                <QrCode value={inviteUrl} image={club.image} size={CODE_SIZE} svgRef={svgRef} />
              </View>
            </LinearGradient>

            <Text style={styles.caption}>Scan this to join {club.name} on ClubChat</Text>

            <View style={styles.actions}>
              <Pressable
                style={styles.action}
                onPress={() => {
                  void Share.share({ message: inviteUrl }).catch(() => undefined);
                }}
                accessibilityRole="button"
                accessibilityLabel="Share the join link"
              >
                <View style={styles.actionWell}>
                  <MaterialIcons name="ios-share" size={20} color={color.textPrimary} />
                </View>
                <Text style={styles.actionLabel}>Share Link</Text>
              </Pressable>

              <Pressable
                style={styles.action}
                onPress={() => void save(club.name)}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel="Save the code as an image"
                accessibilityState={{ disabled: busy }}
              >
                <View style={styles.actionWell}>
                  <MaterialIcons name="file-download" size={22} color={color.textPrimary} />
                </View>
                <Text style={styles.actionLabel}>{busy ? 'Saving' : 'Save Image'}</Text>
              </Pressable>
            </View>

            {notice !== null && (
              <Text style={styles.notice} accessibilityLiveRegion="polite">
                {notice}
              </Text>
            )}

            {/*
              Said here rather than left to be discovered: a code that carries an app-scheme link
              does nothing on a phone without the app, and a member handing it to a stranger at a
              club fair is exactly who would find that out the hard way.
            */}
            <Text style={styles.note}>
              Scanning works for people who already have ClubChat. Send the link to anybody else.
            </Text>
          </ScrollView>
        );
      }}
    </DataScreen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: color.appBackground },
  body: { padding: space.md, gap: space.md, alignItems: 'center' },

  name: { ...type.title, color: color.textPrimary, textAlign: 'center', marginTop: space.sm },

  tile: { borderRadius: radius.xl, padding: space.md },
  codeCard: {
    borderRadius: radius.lg,
    backgroundColor: color.card,
    overflow: 'hidden',
    width: CODE_SIZE,
    height: CODE_SIZE,
  },

  caption: { ...type.body, color: color.textSecondary, textAlign: 'center', maxWidth: 320 },

  actions: { flexDirection: 'row', gap: space.xl, paddingTop: space.sm },
  action: { alignItems: 'center', gap: space.xs },
  actionWell: {
    width: 48,
    height: 48,
    borderRadius: radius.md,
    backgroundColor: color.cardSunken,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionLabel: { ...type.label, color: color.textSecondary, textTransform: 'uppercase' },

  notice: { ...type.bodySmall, color: color.textPrimary, textAlign: 'center' },
  note: {
    ...type.bodySmall,
    color: color.textSecondary,
    textAlign: 'center',
    maxWidth: 340,
    paddingTop: space.sm,
  },
});
