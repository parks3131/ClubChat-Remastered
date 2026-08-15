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
 * The server still reads a point out of a link when the link carries one, and `meetups` still
 * holds it. Nothing draws it today. That is also deliberate - it costs one nullable column pair
 * and keeps the decision reversible - and it is why `map-link.ts` and its tests are still here.
 */

import { Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { color, radius, space, type } from './theme.ts';

type Point = { lat: number; lng: number };

/**
 * Whatever the platform's own maps app will accept.
 *
 * **The pasted link first, always.** It is the exact place somebody chose - a Google Maps URL opens
 * the Google Maps app when it is installed and the browser when it is not, and either lands on the
 * right spot, including the ones no geocoder can find. The point is a fallback for a meetup that
 * somehow has coordinates and no link, which is not a state the app can currently produce.
 */
export function directionsUrl(mapUrl: string | null, point: Point | null): string | null {
  if (mapUrl !== null && mapUrl.trim().length > 0) return mapUrl.trim();
  if (point !== null) {
    return Platform.OS === 'ios'
      ? `https://maps.apple.com/?daddr=${point.lat},${point.lng}`
      : `geo:${point.lat},${point.lng}?q=${point.lat},${point.lng}`;
  }
  /*
   * Nothing to open. Deliberately NOT a text search on the location: "Bimini" or "the wooden
   * archway entrance" sends somebody to whatever Maps guesses that means, which is worse than the
   * button not being there. No link, no button.
   */
  return null;
}

export function MeetupDirections({
  mapUrl,
  point,
  place,
}: {
  mapUrl: string | null;
  point: { lat: number; lng: number } | null;
  /** Only for the screen reader - the button says "Directions" and the place is above it. */
  place: string;
}) {
  const target = directionsUrl(mapUrl, point);
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
