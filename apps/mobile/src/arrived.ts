/**
 * Finding the `arrived` marker on a route, at whatever depth the navigator put it.
 *
 * A `replace` has no direction of its own, so the screen being replaced INTO carries a query param
 * saying which way the motion should read - see `ARRIVED_FORWARD` in `nav.tsx`. Reading it back is
 * a one-liner for a leaf route and is NOT one for a navigator:
 *
 * > **A nested navigator does not receive the leaf's params; it receives the route TO the leaf.**
 * > Navigating to `/clubs?arrived=forward` gives the `(tabs)` route
 * > `{ screen: '(main)', params: { screen: 'clubs/index', params: { arrived: 'forward' } } }`.
 * > `params.arrived` is undefined there, one level up from where the answer lives, so a group
 * > route reading it directly always sees "no marker" and always takes the default.
 *
 * That is the whole bug this exists for. Backing out of a chat replaces the root stack's `(tabs)`
 * entry, and `(tabs)` had a hardcoded `push` for the one journey that IS a way in - signing in -
 * so leaving a conversation animated as though you were entering one. Both journeys arrive at the
 * same screen, and only the marker can tell them apart.
 */

/** How far to walk before giving up. Depth is bounded by the navigator nesting, not by input. */
const MAX_DEPTH = 8;

/**
 * The `arrived` value on this route, or `undefined`.
 *
 * Walks the `params.params` chain a nested navigation action builds, one link per navigator, and
 * returns the first `arrived` it finds. Takes `unknown` on purpose: this reads whatever React
 * Navigation put on the route, which is not a shape the app controls or can usefully assert.
 */
export function arrivedMarker(params: unknown): string | undefined {
  let node = params;

  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    if (node === null || typeof node !== 'object') return undefined;

    const record = node as Record<string, unknown>;
    const arrived = record['arrived'];
    if (typeof arrived === 'string') return arrived;

    node = record['params'];
  }

  return undefined;
}
