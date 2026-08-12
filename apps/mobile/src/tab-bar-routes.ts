/**
 * Which screens the tab bar appears on.
 *
 * > **It used to be "everywhere except chat", and that was the wrong rule.** Everything below a
 * > destination lives inside the Clubs tab's stack, so the floating bar followed a member all the
 * > way down: over the roster, over car groups, over Meet Information, over every create form. A
 * > persistent bar is worth having between the four destinations and on the way into a club. Over
 * > a form somebody is filling in it is chrome in the thumb's way, and it costs a row.
 *
 * The rule now, decided 2026-08-12:
 *
 * | Level | Screens | Bar |
 * |---|---|---|
 * | The four destinations | `/clubs`, `/calendar`, `/notifications`, `/profile` | **yes** |
 * | A club's front door | `/clubs/:clubId` | **yes** |
 * | Everything else | rosters, races, polls, news, events, car groups, every create form, chat | no |
 *
 * **A race and the Eboard space do not keep it**, though they are the same shape as a club. They
 * are reached from inside a club, so they sit a level below the front door and follow the general
 * rule. See `SPEC/DESIGN/01-tab-bar.md`.
 *
 * ---
 *
 * > **This is what finally pays the clearance obligation.** The bar floats over the scene rather
 * > than sitting in flow, so every screen underneath it owes itself `tabBarSpace()` or its last row
 * > is visible and unreachable. `DESIGN/01` recorded that debt and it was only ever paid by six
 * > screens - every roster, poll, race and news list had a sliced final row that nobody had
 * > noticed. Removing the bar from those screens discharges the debt for all of them at once
 * > rather than by padding twenty screens by hand and hoping the twenty-first remembers.
 *
 * So the five screens that keep the bar are exactly the five that must reserve clearance, and that
 * list is short enough to hold in your head.
 */

/** The four destinations, by pathname. */
const DESTINATIONS: readonly string[] = ['/clubs', '/calendar', '/notifications', '/profile'];

/**
 * A club id, which is what separates the front door from its neighbours.
 *
 * > **`/clubs/add`, `/clubs/create` and `/clubs/join` are also two segments**, and none of them is
 * > a club hub - they are forms, and a form is precisely where the bar should not be. Matching the
 * > shape of an id rather than counting segments is what tells them apart, and it fails in the
 * > safe direction: anything added under `/clubs/` later that is not an id gets no bar, so it
 * > inherits no clearance obligation either.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether the tab bar is drawn over this pathname.
 *
 * Pure and total, so it can be exercised without mounting a navigator - which matters here because
 * every previous bug in this area was found by looking at a phone. Takes the pathname rather than
 * reading the router, so the decision is a value the test can supply.
 *
 * **Unknown routes get no bar**, deliberately. A new screen appearing with a bar over it silently
 * acquires the clearance obligation above, and nothing would fail until somebody noticed a row
 * they could not reach.
 */
export function showsTabBar(pathname: string): boolean {
  // Query strings carry `?from=clubsTab` and `?around=<seq>`; the trailing slash is a web-only
  // spelling of the same route. Neither says anything about which screen this is.
  const path = (pathname.split('?')[0] ?? '').replace(/\/+$/, '') || '/';

  if (DESTINATIONS.includes(path)) return true;

  const segments = path.split('/').filter(Boolean);
  return segments.length === 2 && segments[0] === 'clubs' && UUID.test(segments[1] ?? '');
}
