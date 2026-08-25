/**
 * Getting somebody to where the club is meeting.
 *
 * One button. It appears when a meetup carries a pasted map link, and it opens that link in Maps -
 * which is exact, because a human chose that place on a map and the link is the record of it.
 *
 * > **There was a real embedded map here for about an hour on 2026-08-15, and it was taken out
 * > deliberately.** `react-native-maps` is installed and in the binary, and the founder's decision
 * > was "I don't want the map feature for now, just keep it - instead we can have the direction".
 * > The reason it stopped being worth it is in `ADR-0037`: a Google **"share a place"** link,
 * > which is the one anybody actually taps, carries no coordinates at any hop of its redirect. So
 * > drawing a pin meant either asking the admin to place one by hand, or paying for a Places key,
 * > to produce a picture of a place the Directions button already opens perfectly.
 *
 * **The dependency is left installed on purpose**, so the map can come back without another
 * rebuild-and-reinstall on every device. If it is ever removed, remove it knowing that: it is not
 * an oversight, and the pod is the expensive half to restore.
 *
 * **The stored coordinates are gone as of 2026-08-25**, and this comment used to say they were
 * kept so the decision stayed reversible. ADR-0049 found the pair empty on every meetup a phone
 * had ever created - the Google share sheet emits a short link that resolves to a place name, not
 * a point - so what was being kept reversible was a column pair that never held anything. The
 * pasted link is now the whole of "where", and `map-link.ts` survives only as the gate that
 * refuses a link to somewhere that is not a map.
 */

import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { color, radius, space, type } from './theme.ts';

/**
 * Whatever the platform's own maps app will accept.
 *
 * **The pasted link, or nothing.** It is the exact place somebody chose - a Google Maps URL opens
 * the Google Maps app when it is installed and the browser when it is not, and either lands on the
 * right spot, including the ones no geocoder can find.
 *
 * There was a coordinate fallback here until ADR-0049, for a meetup that somehow had a point and
 * no link. No surface could produce that state, and the coordinates it read are gone.
 */
export function directionsUrl(mapUrl: string | null): string | null {
  if (mapUrl !== null && mapUrl.trim().length > 0) return mapUrl.trim();
  /*
   * Nothing to open. Deliberately NOT a text search on the location: "Bimini" or "the wooden
   * archway entrance" sends somebody to whatever Maps guesses that means, which is worse than the
   * button not being there. No link, no button.
   */
  return null;
}

export function MeetupDirections({
  mapUrl,
  place,
}: {
  mapUrl: string | null;
  /** Only for the screen reader - the button says "Directions" and the place is above it. */
  place: string;
}) {
  const target = directionsUrl(mapUrl);
  if (target === null) return null;

  return (
    <View style={styles.frame}>
      <Pressable
        style={styles.directions}
        onPress={() => {
          void Linking.openURL(target).catch(() => {
            // A device with nothing registered for maps. Nothing to say here that is not noise.
          });
        }}
        accessibilityRole="button"
        accessibilityLabel={`Directions to ${place}`}
      >
        <MaterialIcons name="directions" size={18} color={color.onAccent} />
        <Text style={styles.directionsLabel}>Directions</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { borderRadius: radius.lg, overflow: 'hidden' },
  directions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    paddingVertical: space.sm + 2,
    backgroundColor: color.accent,
  },
  directionsLabel: { ...type.bodySmallStrong, color: color.onAccent },
});
