/**
 * Deciding whether a pasted link is a link to a map, and therefore safe to store as one.
 *
 * A meetup's place is free text - "the wooden archway entrance", "Bimini" - and no geocoder turns
 * that into a coordinate. So the admin pastes a link from Google Maps or Apple Maps instead, and
 * the link IS the place. The founder's phrasing on 2026-08-15: *"the link will be pasted"*.
 *
 * **This module is a gate, not a parser, and that is the whole of it since 2026-08-25.** It used
 * to also read coordinates out of the link so a pin could be drawn. ADR-0049 removed the stored
 * coordinates and the drawing that never happened, which took the parsing half with it. What
 * remains is the half that was doing real work: refusing a link that is not a map.
 *
 * **The refusal is the security control, so it stays even though the parser did not.** A stored
 * `map_url` becomes a Directions button that every member of the club taps. Without this check an
 * admin could put any URL at all behind it - `maps.google.com.evil.test/?q=1,1` reads perfectly
 * plausibly and is not Google. The allowlist is by exact hostname rather than by pattern, because
 * a pattern loose enough to be convenient is loose enough to match that.
 *
 * **Pure, and in `shared` rather than on the server, because both ends need it**: the server
 * refuses a link that is not a map, and the composer wants to tell somebody their paste will not
 * work before they wait for a round trip.
 */

/**
 * Hosts a pasted link may name.
 *
 * An allowlist rather than a pattern. Google's own share sheet emits `maps.app.goo.gl`, the URL
 * bar emits `google.com/maps` or `maps.google.com`, and Apple emits `maps.apple.com`; between them
 * that is every way a person actually copies a place.
 */
const MAP_HOSTS = [
  'maps.app.goo.gl',
  'goo.gl',
  'maps.google.com',
  'www.google.com',
  'google.com',
  'maps.apple.com',
  'www.maps.apple.com',
] as const;

/**
 * Whether this is a link to a map at all, and therefore worth storing as one.
 *
 * Anything this refuses is dropped rather than rejected: the meetup still saves, it simply has no
 * Directions button. A bad paste is not a reason to refuse somebody's meetup.
 */
export function isMapLink(raw: string): boolean {
  try {
    const host = new URL(raw.trim()).hostname.toLowerCase();
    return MAP_HOSTS.some((allowed) => host === allowed);
  } catch {
    return false;
  }
}
