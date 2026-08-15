/**
 * Turning a pasted map link into a point, including the ones that will not say where they go.
 *
 * The parsing lives in `@clubchat/shared`'s `map-link.ts` and is pure. This is the half that
 * cannot be: **the Google Maps app shares a short link**, `https://maps.app.goo.gl/aB3xY`, which
 * contains no coordinate, no place name and nothing else to work with. Only following it finds
 * out. That is the common case rather than an edge one, because the share sheet is how anybody
 * actually copies a place.
 *
 * **The server does this, not the phone**, for the reason every rule in this codebase sits on the
 * server: the client sends a link and the server decides what it means, so a phone cannot put a
 * pin wherever it likes. It also means the answer is the same whichever client saved it.
 *
 * ### Following a redirect is an outbound request, so it is fenced
 *
 * Three fences, and each is doing a job:
 *
 *  - **A host allowlist, re-checked at every hop.** `redirect: 'manual'` rather than `follow`,
 *    because following automatically means the FIRST url is checked and the destination is not -
 *    and a shortener's whole purpose is to point somewhere else. A hop off the list ends the walk.
 *  - **A hop limit**, so a redirect loop is a null rather than a hang.
 *  - **A short timeout**, because this happens while somebody is waiting for a Save to return.
 *
 * A link that will not resolve is not an error anywhere. It is stored as pasted and still opens in
 * Maps; the meetup simply has no map picture. See `PRD/08`.
 */

import { ALLOWED_MAP_HOSTS, isMapLink, isShortMapLink, parseMapLink, type MapPoint } from '@clubchat/shared';

/** How long the whole walk may take. Somebody is watching a Save button. */
const TIMEOUT_MS = 3_000;

/** Shorteners chain, but not far. Five is generous and a loop cannot outlast it. */
const MAX_HOPS = 5;

function allowed(url: string): boolean {
  try {
    return ALLOWED_MAP_HOSTS.includes(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * The point a link names, following it first if that is the only way to find out.
 *
 * Returns null for anything it cannot answer, which includes a link to a place that has no
 * coordinates, a shortener that will not resolve, and a host that is not a map. Null means "no map
 * picture" and never means "reject the meetup".
 */
export async function resolveMapPoint(
  raw: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MapPoint | null> {
  const link = raw.trim();
  if (link.length === 0) return null;

  // A bare "lat,lng" is not a URL at all and never needs the network.
  if (!/^https?:\/\//i.test(link)) return parseMapLink(link);

  /*
   * The host is checked BEFORE the point is read, and the order is the whole point.
   *
   * `maps.google.com.evil.test/?q=1,1` parses perfectly well - `parseMapLink` is a parser, not a
   * gatekeeper, and it will happily read a pair out of any query string. Reading first and
   * checking after meant that link produced a point, and the caller would then have stored the URL
   * beside it and put it behind a Directions button. Caught by the allowlist test, which is
   * exactly the sort of thing that would never have shown up on a screen.
   */
  if (!isMapLink(link)) return null;

  const direct = parseMapLink(link);
  if (direct !== null) return direct;

  // A long map link that had no point in it will not grow one by being fetched.
  if (!isShortMapLink(link)) return null;

  let current = link;
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    if (!allowed(current)) return null;

    let response: Response;
    try {
      response = await fetchImpl(current, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        // Google serves a coordinate-bearing URL to a browser and a bare interstitial to
        // anything that looks automated.
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; ClubChat)' },
      });
    } catch {
      // A timeout, a DNS failure, a refused connection. The meetup saves without a map.
      return null;
    }

    const next = response.headers.get('location');
    if (next === null) {
      // The end of the chain. Whatever it settled on is the best thing to read.
      return parseMapLink(response.url === '' ? current : response.url);
    }

    // Relative redirects are legal, so resolve against where we are rather than assuming absolute.
    try {
      current = new URL(next, current).toString();
    } catch {
      return null;
    }

    const found = parseMapLink(current);
    if (found !== null) return found;
  }

  return null;
}
