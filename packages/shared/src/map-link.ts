/**
 * Reading a point out of a map link somebody pasted.
 *
 * A meetup's place is free text - "the wooden archway entrance", "Bimini" - and no geocoder turns
 * that into a coordinate. So the admin pastes a link from Google Maps or Apple Maps instead, and
 * this is the module that decides what it means. The founder's phrasing on 2026-08-15: *"the link
 * will be pasted... from that you can take the coordinates"*.
 *
 * **Its own module with tests, following `crop-rect.ts`, for the same reason.** This is the part
 * of the feature whose being wrong is invisible. A frame drawn perfectly can still cut the wrong
 * pixels; a link parsed wrongly puts a pin in the wrong hemisphere, and the screen shows a
 * perfectly convincing map of it. Nothing on the surface says otherwise, so the assertions have to
 * live here.
 *
 * **Pure, and in `shared` rather than on the server, because both ends need it**: the server
 * resolves the link when a meetup is saved, and the client wants to know whether what somebody
 * just pasted is going to work before they wait for a round trip.
 *
 * ### What a share sheet actually produces
 *
 * Not one format. The Google Maps app emits a SHORT link with no coordinates in it at all
 * (`maps.app.goo.gl/XYZ`), which only a redirect can resolve - see `isResolvableMapLink`, and the
 * server for the fetch that follows it. Copying the URL bar emits a long one with the point in the
 * path. Apple Maps puts it in a query parameter. All three are common and all three are handled.
 */

/** A point on the earth, as far as this app is concerned. */
export type MapPoint = { lat: number; lng: number };

/**
 * Hosts a pasted link may name.
 *
 * An allowlist rather than a pattern, because this list is also what the server is willing to send
 * an outbound request to when it resolves a short link. A link to anywhere else is stored and
 * opened but never fetched, so a pasted URL cannot make the server call an arbitrary address.
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

/** Hosts whose links carry no point and have to be followed to find one. */
const SHORT_HOSTS = ['maps.app.goo.gl', 'goo.gl'] as const;

/**
 * A latitude and longitude that are actually on the earth.
 *
 * The range check is not paranoia about the parse: `@40.7,-74.0,17z` and `?q=40.7,-74.0` are
 * matched by shapes loose enough to also match a zoom level or a place id if the string is odd, so
 * something has to refuse `200,-999`. A refused parse means "no map", which is a state the screen
 * already draws. A wrong point means a confident map of the wrong place.
 */
function point(lat: number, lng: number): MapPoint | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  // 0,0 is in the Gulf of Guinea and is what a failed substitution produces far more often than it
  // is what somebody meant, so it is refused rather than drawn.
  if (lat === 0 && lng === 0) return null;
  return { lat, lng };
}

/** `40.7128,-74.0060` and the spellings around it, wherever one is embedded. */
const PAIR = /(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)/;

function pairIn(text: string | null | undefined): MapPoint | null {
  if (typeof text !== 'string') return null;
  const found = PAIR.exec(text);
  if (found === null) return null;
  return point(Number(found[1]), Number(found[2]));
}

/**
 * The point a link carries, or null when it carries none.
 *
 * Null is not a failure worth reporting to anybody: a short link legitimately has no point until
 * it is followed, and a link to a named place with no coordinates is still a perfectly good thing
 * to hand to Maps. It means "no map picture", not "bad link".
 */
export function parseMapLink(raw: string): MapPoint | null {
  const text = raw.trim();
  if (text.length === 0) return null;

  // A bare pair, pasted on its own. Not a link at all, and the thing somebody does when they have
  // already copied coordinates from somewhere else.
  if (/^-?\d{1,3}(?:\.\d+)?\s*,\s*-?\d{1,3}(?:\.\d+)?$/.test(text)) return pairIn(text);

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }

  /*
   * The path form first, and Google's `@lat,lng,zoom` before any query parameter.
   *
   * Order matters here rather than being arbitrary. A Google place URL carries BOTH `/@40.7,-74.0`
   * (where the camera is) and often a `?q=` naming the place, and the `@` is the one that is
   * actually a coordinate. Reading the query first would find a place name and give up.
   */
  const at = /@(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/.exec(url.pathname);
  if (at !== null) {
    const found = point(Number(at[1]), Number(at[2]));
    if (found !== null) return found;
  }

  // Apple's `ll`, Google's `q` and `query`, and `sll`/`center` which older links still use.
  for (const key of ['ll', 'q', 'query', 'sll', 'center', 'daddr']) {
    const found = pairIn(url.searchParams.get(key));
    if (found !== null) return found;
  }

  // Some Apple links put the point in the fragment rather than the query.
  return pairIn(url.hash);
}

/** Whether this is a link to a map at all, and therefore worth storing as one. */
export function isMapLink(raw: string): boolean {
  try {
    const host = new URL(raw.trim()).hostname.toLowerCase();
    return MAP_HOSTS.some((allowed) => host === allowed);
  } catch {
    return false;
  }
}

/**
 * Whether this link has to be FOLLOWED before it can say where it points.
 *
 * The Google Maps app's share sheet produces one of these every time, so this is the common case
 * rather than an edge one: `https://maps.app.goo.gl/aB3xY` contains no coordinate, no place name
 * and nothing else to work with. Only the server follows it - see `resolveMapLink` there - and
 * only to a host on the allowlist above.
 */
export function isShortMapLink(raw: string): boolean {
  try {
    const host = new URL(raw.trim()).hostname.toLowerCase();
    return SHORT_HOSTS.some((short) => host === short);
  } catch {
    return false;
  }
}

/** Every host the server may follow a link to. Exported so the fetch and the parser cannot drift. */
export const ALLOWED_MAP_HOSTS: readonly string[] = MAP_HOSTS;
