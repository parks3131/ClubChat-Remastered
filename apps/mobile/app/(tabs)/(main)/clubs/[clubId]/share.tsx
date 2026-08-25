/**
 * Handing the club to somebody: the code, the link, and the two ways out.
 *
 * **One screen since 2026-08-12, where it used to be two.** Share club listed rows - Copy Link,
 * Share QR code, Share to - and the code lived a tap further in. The code IS the share surface for
 * the case this exists to serve, somebody standing in front of you, so it is now what the screen
 * opens on and the rows became two buttons under it.
 *
 * **Every member of the club sees this, and only an admin can rotate what it hands out**
 * (ADR-0024). Each tier is handed its own link and the screen never chooses: the server returns
 * exactly one token, picked by tier, so there is no branch here to get wrong and no way for a
 * member to be shown the admin string (ADR-0025).
 *
 * > **The screen does not narrate what the link does, and that is a decision rather than an
 * > omission.** It briefly did: "anyone who scans this joins straight away, even if it normally
 * > asks people to request". Accurate for an admin, and it read as a warning about something the
 * > reader had not asked about, on a surface whose whole job is to be held out to another person.
 * > Removed 2026-08-12. The behaviour is untouched - an admin's link admits outright, a member's
 * > obeys the join policy (ADR-0025) - it is simply not explained here.
 *
 * The drawing, the quiet zone and the error-correction level are `src/qr-code.tsx`'s business.
 * This screen owns the frame around it, the actions, and getting the image out.
 */

import { useRef, useState } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { File, Paths } from 'expo-file-system';
import * as Clipboard from 'expo-clipboard';
import { MaterialIcons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import type Svg from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { clubApi } from '../../../../../src/api.ts';
import { useDeclareClub } from '../../../../../src/current-space.tsx';
import { inviteLink } from '../../../../../src/invite-link.ts';
import { QrCode } from '../../../../../src/qr-code.tsx';
import { color, radius, space, type } from '../../../../../src/theme.ts';
import { Avatar, ConfirmDialog, DataScreen } from '../../../../../src/ui.tsx';
import { useLoad } from '../../../../../src/use-load.ts';
import { useNotice } from '../../../../../src/use-notice.ts';

/**
 * The code's drawn size.
 *
 * Big enough to scan across a table, and small enough that the whole screen - crest, card, both
 * pills and the caption - lands inside one phone screen without scrolling. That last part is the
 * constraint: this surface is used by somebody holding a phone out to another person, and content
 * they have to scroll to is content the other person is waiting through.
 */
const CODE_SIZE = 220;

/** The club's face, overlapping the card's top edge by half of itself. */
const CREST = 96;

export default function ClubShareScreen() {
  const { clubId } = useLocalSearchParams<{ clubId: string }>();
  const load = useLoad(() => clubApi.detail(clubId), [clubId]);
  useDeclareClub(clubId, load.data?.club.name, load.data?.club.image);
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const svgRef = useRef<Svg | null>(null);
  // Clears itself; see `useNotice`.
  const [notice, setNotice] = useNotice();
  const [busy, setBusy] = useState(false);
  const [confirmingRotate, setConfirmingRotate] = useState(false);
  const [rotating, setRotating] = useState(false);

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

  /*
   * The club, if it has arrived. Read here rather than inside `DataScreen` so the header can be
   * declared from the first frame - see the note on the share control below.
   */
  const loadedClub = load.data?.club ?? null;

  return (
    <>
      {/*
        The system share sheet, in the header rather than as a third pill.

        It belongs there because it is a different KIND of act from the two below it: Scan and Copy
        keep you on this screen, and this hands off to another app.

        > **Declared OUTSIDE `DataScreen`, and that is the whole point of this block.** It lived
        > inside the data branch, so it could not exist until the club fetch returned - the icon
        > popped into the header about a second after the screen opened, which reads as the app
        > still deciding what this page is. Chrome should be drawn on the first frame; only its
        > ACTION needs the data. So the control renders immediately and does nothing until there
        > is a link to share, which is a far smaller lie than appearing late.
        >
        > The title colour had the same fault and went further, onto the route in `_layout`,
        > because it depends on nothing at all.
      */}
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable
              onPress={() => {
                if (loadedClub === null) return;
                const url = inviteLink(loadedClub.inviteToken);
                void Share.share({ message: url }).catch(() => undefined);
              }}
              accessibilityRole="button"
              accessibilityLabel="Share the join link"
              // Announced as unavailable while the club is still loading, rather than looking
              // identical to a control that works and silently doing nothing.
              accessibilityState={{ disabled: loadedClub === null }}
              hitSlop={space.sm}
            >
              <MaterialIcons
                name="ios-share"
                size={22}
                // Dimmed until there is something to share. The control keeps its place either
                // way, so nothing moves when the club arrives.
                color={loadedClub === null ? color.border : color.textPrimary}
              />
            </Pressable>
          ),
        }}
      />
      <DataScreen load={load} errorMessage="Couldn't load this club.">
        {(data) => {
          const club = data.club;
          const inviteUrl = inviteLink(club.inviteToken);

          return (
            <>
            <ScrollView
              style={styles.flex}
              /*
                No tab-bar clearance: the bar is not drawn on this screen. Reserving it left a
                bar's worth of dead space under the buttons once the bar stopped appearing.
              */
              contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + space.lg }]}
            >
              {/*
                The card, with the club's face straddling its top edge. The crest is drawn AFTER
                the card in source order so it lands on top; a negative margin on the card pulls
                it up under the face rather than the face being absolutely positioned, so the
                whole block still grows with its contents.
              */}
              {/*
                Lifted above the card, and this needs saying because it looked like a layout bug
                and was a paint-order one: later siblings paint on top in React Native, so the card
                - which comes next and is pulled up under this by a negative margin - was covering
                the crest's lower half. The face has to be the thing in front.
              */}
              <View style={styles.crest}>
                <Avatar
                  name={club.name}
                  image={club.image}
                  size={CREST}
                  kind="group"
                  shape="circle"
                  tintId={clubId}
                />
              </View>

              <View style={styles.card}>
                {/*
                  Black on white with its quiet zone intact, whatever the frame around it is. The
                  accent belongs to the screen: modules in the brand colour read as ours to a
                  person and as a maybe to a camera. See `src/qr-code.tsx`.
                */}
                {/*
                  **No picture in the middle of the code**, deliberately, since the club's face is
                  already the largest thing on the screen directly above it. Two copies of one
                  photograph a centimetre apart is not identification, it is repetition.

                  It also makes the code easier to scan rather than only tidier: the logo is what
                  forced correction level `H`, and `H` spends modules on redundancy. With nothing
                  over the middle the same link is drawn in fewer, larger modules - which is what
                  matters when somebody is reading it off a phone across a table.

                  That headroom is what absorbed the move from `clubchat://join/<token>` to the
                  https link: 59 characters became 72, so at level `M` the grid went from 33
                  modules to 37, and at `CODE_SIZE` each module went from about 6.7pt to about
                  5.9pt. The same 72 characters at level `H` would need 49 modules and about
                  4.5pt each, which is the version of this screen that would have had a scanning
                  problem.
                */}
                <QrCode value={inviteUrl} size={CODE_SIZE} svgRef={svgRef} />

                {/*
                  The club's name is drawn by the SCREEN and never inside the code. One apostrophe
                  in an SVG attribute makes the whole export fail silently, and a club name is the
                  most likely place to find one. AGENTS.md failure mode 23.
                */}
                <Text style={styles.name}>{club.name}</Text>
                <Text style={styles.joinOn}>Join on ClubChat</Text>
              </View>

              <View style={styles.actions}>
                <Pressable
                  style={({ pressed }) => [styles.pill, pressed && styles.pillPressed]}
                  onPress={() => router.push('/clubs/scan')}
                  accessibilityRole="button"
                  accessibilityLabel="Scan somebody else's club code with the camera"
                >
                  <Text style={styles.pillLabel}>Scan</Text>
                </Pressable>

                <Pressable
                  style={({ pressed }) => [styles.pill, pressed && styles.pillPressed]}
                  onPress={() => {
                    /*
                      A copy that fails says so. The confirmation is the only evidence there is,
                      because a clipboard cannot be read back from inside the app - without it
                      somebody walks away believing they hold the link.
                    */
                    void Clipboard.setStringAsync(inviteUrl)
                      .then(() => setNotice('Link copied.'))
                      .catch(() => setNotice("Couldn't copy the link."));
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="Copy the join link"
                >
                  <Text style={styles.pillLabel}>Copy</Text>
                </Pressable>
              </View>

              {notice !== null && (
                <Text style={styles.notice} accessibilityLiveRegion="polite">
                  {notice}
                </Text>
              )}

              {/*
                **No sentence describing what the link does.** Removed 2026-08-12, at the founder's
                request, and the reasoning is worth keeping because the copy was accurate.

                It said "anyone who scans this joins straight away, even if it normally asks people
                to request" - true for an admin, and it read as a warning about a thing the reader
                had not asked about. Naming an exception ("even if it normally...") makes somebody
                wonder whether they are doing something they should not, on a screen whose whole
                job is to be handed to another person. The behaviour is unchanged: an admin's code
                still admits outright, a member's still obeys the policy (ADR-0025). It is simply
                not narrated here.

                What the screen still says is the LIMITATION below, which is a different kind of
                statement: not a promise about the club's rules, but the one fact that makes the
                code fail silently in somebody's hand.
              */}

              {/*
                **This line used to state a limitation, and now states that there is not one.**

                The code carried `clubchat://join/<token>`, which does nothing at all on a phone
                without ClubChat - no prompt, no error, no page - and a member handing the code to
                a stranger at a club fair was exactly who found that out the hard way. So the
                screen said so: "Scanning works for people who already have ClubChat. Send the link
                to anybody else."

                ADR-0010 named an https join page as the mitigation on 2026-07-28 and it went
                unbuilt until 2026-08-25. It exists now (`packages/site-worker`, ADR-0045), the
                code carries the https link, and the app claims that path as a universal link - so
                one string opens the app for somebody who has it and a page with the club's name
                for somebody who does not. That closes `PRD/04`'s "join link opened without the app
                installed" edge case.

                It is still one short sentence rather than a description of the mechanism, for the
                reason the removed paragraph above records: this screen is held out to another
                person, and narrating what a link does reads as a warning.
              */}
              <Text style={styles.note}>
                Anybody can scan this. Without ClubChat installed, it opens a page for the club.
              </Text>

              {/*
                Rotation, below everything and admin only.

                It is the one destructive control here and it destroys OTHER people's outstanding
                invitations, so it sits away from the share actions rather than beside them, and
                the confirmation says so in those terms. DESIGN/04 rule 5.
              */}
              {club.viewer.isAdmin && (
                <Pressable
                  onPress={() => setConfirmingRotate(true)}
                  disabled={rotating}
                  accessibilityRole="button"
                  accessibilityLabel="Rotate the join link, invalidating every link already shared"
                  accessibilityState={{ disabled: rotating }}
                  style={styles.rotateRow}
                >
                  <MaterialIcons name="autorenew" size={16} color={color.error} />
                  <Text style={styles.rotate}>
                    {rotating ? 'Rotating' : 'Rotate link - invalidates every link already shared'}
                  </Text>
                </Pressable>
              )}
            </ScrollView>

            {confirmingRotate && (
              <ConfirmDialog
                title="Rotate the join link?"
                body={`Every link and code already shared for ${club.name} stops working, including ones other members have sent. A new one is created in its place.`}
                confirmLabel="Rotate link"
                onCancel={() => setConfirmingRotate(false)}
                onConfirm={() => {
                  setConfirmingRotate(false);
                  setRotating(true);
                  setNotice(null);
                  void clubApi
                    .rotateInvite(clubId)
                    .then(() => {
                      setNotice('Link rotated. Every old link and code is now dead.');
                      load.reload();
                    })
                    .catch(() => setNotice("Couldn't rotate the link. Try again."))
                    .finally(() => setRotating(false));
                }}
              />
            )}
            </>
          );
        }}
      </DataScreen>
    </>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: color.appBackground },
  /*
   * `md` rather than `xl` at the top. The crest is the first thing and it is already a large
   * round object; a section-sized gap above it pushed the caption off the bottom of the phone,
   * which is the one thing this screen must not do.
   */
  body: { alignItems: 'center', paddingHorizontal: space.lg, paddingTop: space.md },

  /*
   * `zIndex` AND `elevation`, because they are two different platforms' answers to the same
   * question and neither covers the other: iOS and web order by `zIndex`, Android by `elevation`.
   * Setting only the first is the version that looks right on the phone in your hand and wrong on
   * the one you have never run.
   */
  crest: { zIndex: 1, elevation: 1 },

  card: {
    backgroundColor: color.card,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: color.hairline,
    paddingHorizontal: space.lg,
    paddingBottom: space.lg,
    // Room for the code, plus the half of the crest that overlaps this edge.
    paddingTop: CREST / 2 + space.lg,
    // Pulls the card up under the crest rather than positioning the crest absolutely, so the
    // block keeps growing with its contents.
    marginTop: -(CREST / 2),
    alignItems: 'center',
    alignSelf: 'stretch',
  },

  // Anton, because this is the subject of the screen rather than a label on it.
  name: { ...type.title, color: color.textPrimary, textAlign: 'center', marginTop: space.md },
  joinOn: { ...type.body, color: color.textSecondary, marginTop: space.xs },

  actions: { flexDirection: 'row', gap: space.md, marginTop: space.lg, alignSelf: 'stretch' },
  /*
   * A stadium rather than a rounded rectangle, matching the tab bar's pill and the app's other
   * primary actions. Both are the accent: neither is secondary to the other - showing a code and
   * sending a link are the same act by different means.
   */
  pill: {
    flex: 1,
    backgroundColor: color.accent,
    borderRadius: radius.pill,
    paddingVertical: space.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillPressed: { backgroundColor: color.accentPressed },
  pillLabel: { ...type.headline, color: color.onAccent },

  notice: { ...type.bodySmall, color: color.textSecondary, marginTop: space.md, textAlign: 'center' },
  note: {
    ...type.bodySmall,
    color: color.textSecondary,
    textAlign: 'center',
    marginTop: space.md,
    maxWidth: 340,
  },

  rotateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    marginTop: space.xl,
    paddingVertical: space.sm,
  },
  rotate: { ...type.bodySmall, color: color.error, textAlign: 'center' },
});
