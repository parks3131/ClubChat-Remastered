/**
 * The four top-level destinations: Clubs, Calendar, Notifications, Profile.
 *
 * `SPEC/PRD/15` opens with these four and puts the unread badge on Notifications. Until the tab
 * group existed there was no tab bar at all - Messages hung off the bottom of the club list as a
 * button, and Calendar, Notifications and Profile had nowhere to be.
 *
 * > **The bar is drawn on five screens: the four destinations and a club's front door.** Everything
 * > below a destination still *lives* inside this tab group - that is what keeps `/polls/:id` and
 * > `/races/:id` at their own URLs - but the bar is not drawn over it. Where and why is
 * > `showsTabBar` in `src/tab-bar-routes.ts`, which owns that decision alone and is tested on its
 * > own. Changed 2026-08-12, from "every signed-in screen except chat".
 *
 * Messages is deliberately NOT a fifth tab. It is a sibling of Clubs reached from the Clubs
 * destination: group chat is the product and DMs are additive, so a peer tab would misrepresent
 * their weight - and `PRD/15` lists four primary destinations, not five.
 */

import { MaterialIcons } from '@expo/vector-icons';
import { Tabs, useSegments, usePathname, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSession } from '../../src/chat-provider.tsx';
import { useCurrentSpace } from '../../src/current-space.tsx';
import { showsTabBar } from '../../src/tab-bar-routes.ts';
import { color, radius, space, tabBar, type } from '../../src/theme.ts';
import { useBadge } from '../../src/use-badge.ts';

/**
 * The bar's own height, before the home-indicator inset is added to it.
 *
 * Enough for a 24pt icon and the pill's padding around it. The inset is added at the call site
 * rather than baked in here, because this number is about the design and that one is about the
 * hardware.
 */
// Shared, because screens need it to keep their last row clear of a bar that floats over them.
const TAB_BAR_CONTENT_HEIGHT = tabBar.height;

/**
 * The four destination icons.
 *
 * `forum` rather than v1's `groups` for the first one, because that destination stopped being a
 * roster of clubs on 2026-08-02 and became the conversation list - clubs and DMs together. The
 * icon vocabulary already assigns `forum` to chat, so this is the existing meaning applied to the
 * destination rather than a new one invented for it. The other three are v1's, unchanged.
 */
const TAB_ICON = {
  clubs: 'forum',
  calendar: 'calendar-month',
  notifications: 'notifications',
  profile: 'person',
} as const;

function TabIcon({ name, focused }: { name: keyof typeof TAB_ICON; focused: boolean }) {
  return (
    <MaterialIcons
      name={TAB_ICON[name]}
      size={24}
      color={focused ? color.accent : color.textSecondary}
    />
  );
}

/**
 * The four destinations in bar order, by the route segment that identifies each.
 *
 * The segment rather than the pathname, because the first destination is a whole STACK - a club,
 * a race, a chat and every roster live inside `(main)` - so matching on the path would need a rule
 * per screen and would miss the next one somebody adds. The group name cannot drift.
 */
const TAB_ORDER = ['(main)', 'calendar', 'notifications', '(profile)'] as const;

/**
 * The active pill, as ONE element that slides between slots.
 *
 * > **A pill per tab cannot slide, however it is animated.** Four separate backgrounds can only
 * > fade one out and the next in, which is the "click and jump" the founder kept reporting: the
 * > indicator teleports because there is no single thing to move. There is exactly one pill here
 * > and it changes position, which is the only arrangement that can travel.
 *
 * It lives in `tabBarBackground`, which fills the bar behind the items, so the pill is behind the
 * icons without any of them knowing it exists.
 *
 * `useNativeDriver` because this is a transform: the animation runs on the UI thread and keeps
 * moving even while JS is busy mounting the screen being navigated to - which is precisely when a
 * tab indicator is asked to move.
 */
function ActivePill() {
  // Read as a plain array: the hook's type is a one-element tuple, which cannot express "the
  // segment after `(tabs)`" even though that is exactly what it contains here.
  const segments = useSegments() as readonly string[];
  const [barWidth, setBarWidth] = useState(0);

  // `indexOf` returns -1 for a route outside the four, which `Math.max` pins to the first rather
  // than translating the pill off the left edge.
  const index = Math.max(0, TAB_ORDER.indexOf(segments[1] as (typeof TAB_ORDER)[number]));
  const slot = barWidth / TAB_ORDER.length;

  const travel = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (slot === 0) return;
    Animated.spring(travel, {
      toValue: index * slot,
      useNativeDriver: true,
      /*
       * About twice as quick as it first shipped: it settles in a little over 200ms rather than
       * around 400.
       *
       * The original was tuned deliberately SLOW, on the reasoning that a fast indicator reads as
       * teleporting and the eye needs to follow it. That over-corrected. The thing that removes
       * the "click and jump" is the pill having a continuous path at all, not the time it takes -
       * once it genuinely travels, a slow trip stops reading as motion and starts reading as lag
       * behind a screen that has already changed.
       *
       * Still damped just short of critical, so it arrives and stops rather than wobbling past
       * the tab somebody just chose. Values are a matched set - stiffness sets the speed, and
       * damping has to move with it or the same numbers that make it quick also make it bounce.
       */
      damping: 26,
      stiffness: 280,
      mass: 0.7,
    }).start();
  }, [index, slot, travel]);

  return (
    <View style={styles.pillLayer} onLayout={(event) => setBarWidth(event.nativeEvent.layout.width)}>
      {slot > 0 && (
        <Animated.View
          style={[
            styles.pill,
            // Inset by the same margin `tabItem` uses, so the pill lands exactly where the icon
            // sits rather than a couple of points off.
            { width: slot - PILL_INSET * 2, left: PILL_INSET, transform: [{ translateX: travel }] },
          ]}
        />
      )}
    </View>
  );
}

/** Matches `tabItem`'s horizontal margin, so the sliding pill lines up with its contents. */
const PILL_INSET = 2;

/**
 * One destination: its icon, and the pill behind it when it is the active one.
 *
 * > **Drawn here rather than with `tabBarActiveBackgroundColor`, after that was tried and did not
 * > fit.** The navigator paints that colour on a box of its own choosing, and the box turned out to
 * > be the icon's rather than the destination's, which is not something a style prop can move.
 * > Owning the container is the only way the pill can be positioned against the item.
 *
 * It goes in the `tabBarIcon` slot with the navigator's own label switched off, so there is exactly
 * one thing being positioned per destination instead of two that have to agree.
 *
 * > **Icon only, from 2026-08-09**, at the founder's request, to see how the bar reads without the
 * > names under it. Two things about that are worth knowing before it is judged. `TECH/13` gives
 * > the pill as a second channel for the selected state precisely because accent-versus-grey alone
 * > fails `PRD/16`'s contrast bar, so the pill is now carrying that on its own and must not also be
 * > removed. And the name each icon lost is not gone: it moves to `tabBarAccessibilityLabel` on
 * > every screen below, because a tab with no text in it gives a screen reader nothing to announce.
 */
function TabItem({
  name,
  focused,
  badge = false,
}: {
  name: keyof typeof TAB_ICON;
  focused: boolean;
  /** Notifications carries the unread count on its icon; nothing else does. */
  badge?: boolean;
}) {
  /*
    No background here any more. `ActivePill` draws the one pill for the whole bar and moves it,
    which is what a static per-item background could never do - see its note.
  */
  return (
    <View style={styles.tabItem}>
      {badge ? <BadgedIcon focused={focused} /> : <TabIcon name={name} focused={focused} />}
    </View>
  );
}

/**
 * The notification count, as a badge on the tab's ICON.
 *
 * **A count of things, not of messages.** Each unread notification counts one, and each chat with
 * any unread counts one however many messages are in it - so a chat with 48 unread adds 1 here and
 * its row says 48. A badge of 200 because somebody sent 200 messages is noise; a badge of 1 because
 * one conversation needs attention is information. The server computes it that way; this only
 * draws it.
 *
 * Absent at zero rather than showing "0", and capped at 99+.
 */
function BadgedIcon({ focused }: { focused: boolean }) {
  const count = useBadge();
  return (
    <View>
      <TabIcon name="notifications" focused={focused} />
      {count > 0 && (
        <View style={styles.badge} accessibilityLabel={`${count} unread notifications`}>
          <Text style={styles.badgeLabel}>{count > 99 ? '99+' : count}</Text>
        </View>
      )}
    </View>
  );
}

export default function TabsLayout() {
  const { authState } = useSession();
  const { currentClub } = useCurrentSpace();
  /*
   * The bar's height is computed from the real inset, never guessed.
   *
   * The pills need more room than the navigator's default bar gives, and padding alone overflows
   * it - the icons sat on the bottom edge with their contents clipped off the screen. So the height
   * is stated, and it has to carry `insets.bottom` with it or it is right on the phone it was
   * measured on and wrong on every other one. 34pt on a notched iPhone, 0 in a browser.
   */
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const router = useRouter();

  /*
   * The two values the Clubs tab decides on, held in refs and read at PRESS time.
   *
   * > **`listeners` is a prop, so its closure is frozen at whatever the last render saw.** React
   * > Navigation keeps the handler it was given; if this component does not re-render between the
   * > club changing and the tap, the tap decides on a stale club and a stale path - sending
   * > somebody to the My Clubs list when they are standing inside a club, or to a hub they have
   * > already left.
   *
   * It used to re-render often enough to hide this: the club context stored a fresh object on
   * every focus, so any navigation anywhere re-rendered this layout. That was accidental, and it
   * stopped being true when the context started skipping updates that change nothing - which is
   * the right thing for it to do, and turned a latent staleness into a visible one. Refs make the
   * handler read the present rather than the last render.
   */
  const clubRef = useRef(currentClub);
  clubRef.current = currentClub;
  const pathRef = useRef(pathname);
  pathRef.current = pathname;

  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: color.chrome },
        headerTitleStyle: { ...type.headerTitle, color: color.accent },
        headerTintColor: color.accent,
        sceneStyle: { backgroundColor: color.appBackground },
        /*
          A floating bar: inset from the edges, fully rounded, lifted off the bottom.

          > **It DOES overlap the screen behind it, and this comment used to claim it did not.**
          > The claim was that keeping the bar in normal flow made the screens end where the bar
          > begins, so no list would ever need bottom padding. That is not what happens: content
          > runs underneath, which is why the Chats list had its last row sliced in half on
          > 2026-08-09 and had to reserve `tabBarSpace()`. The correction is recorded rather than
          > quietly deleted because the false version is what left every OTHER screen unpadded -
          > if the bar cannot cover anything, there is nothing to pad for, and nobody looked.

          So every scrolling screen the bar is drawn over owes itself `tabBarSpace(insets.bottom)`.

          > **That debt is now paid, by shrinking the set rather than by padding it.** It used to
          > be owed by every screen in the product and honoured by six, so every roster, poll,
          > race and news list had a final row that was visible and unreachable. Since 2026-08-12
          > the bar appears on five screens, and those five are exactly the five that reserve
          > clearance - see `showsTabBar`. Twenty screens stopped owing anything at all.

          `marginBottom` carries the home-indicator inset, so the bar floats above it rather than
          being tucked under it. Zero in a browser, 34pt on this phone.
        */
        tabBarStyle: {
          /*
            Lifted OUT of the layout, so the scene runs the full height of the screen and the bar
            floats over it.

            > **This is what makes every other property here mean anything.** In flow, the
            > navigator ends the scene at the bar's top edge, so the strips either side of an inset
            > bar and the band below it contain nothing at all - and a translucent bar over nothing
            > is indistinguishable from an opaque one. The tint was added first and appeared to do
            > nothing for exactly this reason: there was no content behind it to come through.

            The cost is the one the old comment here was trying to avoid, and it is real: a
            scrolling screen that does not reserve `tabBarSpace()` has a last row it can never
            bring out from under the bar. That is why the bar is now drawn on five screens rather
            than on all of them - the five reserve it, and nothing else has to.
          */
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          /*
            Translucent, so the page is visible through the bar.

            Opaque chrome read as a lid: the list simply stopped at the bar's top edge with no
            sign that anything continued. A tint lets the content through and the bar starts
            reading as glass hovering over a page that carries on underneath - which is only true
            now that the scene actually extends under it.
          */
          backgroundColor: color.chromeTranslucent,
          // No hairline: a rule across the full width under a rounded floating bar is two designs.
          borderTopWidth: 0,
          height: TAB_BAR_CONTENT_HEIGHT,
          /*
           * Inset past the screen gutter, at `lg`.
           *
           * A floating bar has to read as sitting ON the page rather than as being fitted to the
           * bottom of it, and 8pt a side was close enough to the edge to look like the second.
           * The gutter at 16 was the obvious next stop and still read as flush; going one step
           * further deliberately breaks alignment with the content padding, which is what makes
           * the bar look like a separate object floating over the page rather than another block
           * of it.
           */
          marginHorizontal: space.lg,
          /*
            Lifts the bar off the bottom edge, leaving the home-indicator band clear - and now
            that the scene runs underneath, that band is a strip the list is visible in rather
            than dead space. It is half of what makes the bar read as floating; the side insets
            are the other half.
          */
          marginBottom: insets.bottom > 0 ? insets.bottom : space.md,
          // Fully round. A 24pt radius on a 64pt bar reads as a rounded rectangle; half the
          // height reads as one continuous shape, which is what the reference design does.
          borderRadius: radius.pill,
          // The bar is a surface sitting ON the page now, so it needs the hairline every other
          // raised surface in this product carries. See the note on `hairline` in theme.ts.
          borderWidth: 1,
          borderColor: color.divider,
          /*
           * Zero, and it has to be stated.
           *
           * The navigator pads the bar's BOTTOM by the home-indicator inset so a normal
           * full-width bar clears it. This bar floats above the indicator on `marginBottom`
           * instead, so leaving that padding in place counts the inset twice: 34pt of empty
           * band inside the bar, with the icons pushed into its top half. That band read as
           * "the bar is too tall" and survived being made taller AND shorter, because it was
           * never the height that was wrong.
           */
          paddingBottom: 0,
          /*
            Drawn on five screens, and nowhere else.

            > **This used to be "every signed-in screen except chat", and the exception list was
            > the wrong shape.** Everything below a destination lives inside `(main)`, so the bar
            > followed a member down into the roster, car groups, Meet Information and every
            > create form - chrome in the thumb's way on a screen they were filling in, and a row
            > of content lost underneath it. It now appears on the four destinations and a club's
            > front door: the places somebody is choosing where to go rather than doing something.

            `showsTabBar` is a pure function over the pathname, in its own module with its own
            tests, because every previous bug in this area was found by looking at a phone.

            Still hidden while the session is unresolved, so the shell cannot flash chrome over
            the sign-in redirect - and that check comes first, since a signed-out member has no
            destinations to show whatever screen they are on.
          */
          display: authState === 'signed-in' && showsTabBar(pathname) ? 'flex' : 'none',
        },
        tabBarActiveTintColor: color.accent,
        tabBarInactiveTintColor: color.textSecondary,
        // The destinations are icon-only, so there is no label for the navigator to draw. Left
        // explicit rather than removed: turning it back on would put a second label under an icon
        // that is already centred for one.
        tabBarShowLabel: false,
        /*
          The item is only a press target now - `TabItem` fills it and the pill slides behind it.
          No margins here, so the pill gets the full quarter-width to sit in.
        */
        tabBarBackground: () => <ActivePill />,
        tabBarItemStyle: { paddingHorizontal: 0, paddingVertical: 0 },
        tabBarIconStyle: { flex: 1, width: '100%' },
        /*
          No motion between destinations, declared rather than left to a default.

          The four tabs are SIBLINGS, not depth - Calendar is not deeper than Chats - so sliding
          between them would say something untrue about where you are. It also keeps the slide
          meaning exactly one thing everywhere else: right-to-left is going in, left-to-right is
          coming out. A gesture that means two things means neither.
        */
        animation: 'none',
      }}
    >
      {/*
        The Clubs destination is a route GROUP, not a single screen: `(main)` holds its own stack
        with the club hub, every roster, every list and every leaf inside it. That is what keeps
        the tab bar on all of them - see `PRD/15` and the note in `(main)/_layout.tsx`. The group
        is invisible in the URL, so this tab's root is still plain `/clubs`.
      */}
      <Tabs.Screen
        name="(main)"
        options={{
          title: 'Chats',
          // The name a screen reader announces, now that the icon has no text under it.
          tabBarAccessibilityLabel: 'Chats',
          /*
            This tab supplies its OWN headers, from the stack inside it. Without this the tab
            navigator draws a second one above them - a "Clubs" bar stacked on top of every
            screen's real header, which is exactly what appeared the first time this was wired up.
            The other three destinations are single screens and keep the tab navigator's header.
          */
          headerShown: false,
          tabBarIcon: ({ focused }) => <TabItem name="clubs" focused={focused} />,
        }}
        /*
          The two-stage escape hatch. `PRD/15`:

            - not inside a club        -> the My Clubs list
            - inside one, off its hub  -> that club's hub, from arbitrary depth
            - inside one, ON its hub   -> the My Clubs list

          So the whole gesture is: tap once to surface at the club's front door, tap again to leave
          the club. Never more than two taps to the root from anywhere.

          The tab carries no extra visual state for any of this - same icon, same active tint. The
          behaviour is contextual; the chrome is not.
        */
        listeners={{
          tabPress: (event) => {
            const club = clubRef.current;

            if (club === null) {
              /*
                Already ON the list, so this tap is not a journey - it is the "take me back to the
                top" every tab bar answers. Let it through UNTOUCHED and the list scrolls itself.

                > **`preventDefault` used to be the first line of this handler, and it is exactly
                > what stopped both halves of that.** Falling through to the `replace` below
                > swapped the screen for an identical copy of itself and animated the swap, so
                > tapping CHATS from the chats list played a pop per tap over a page that never
                > changed. And `useScrollToTop` - which the list uses to answer this tap - checks
                > `defaultPrevented` and declines to run when anything claimed the event, so
                > intercepting here is precisely what would have swallowed the scroll.

                The navigator's own default for a tab you are already on is a no-op, which is why
                nothing has to be prevented here.
              */
              if (pathRef.current === '/clubs') return;

              event.preventDefault();

              /*
                Not in a club, so this is a plain "go to the list" - and it must UNWIND to the
                list rather than stack a second copy on top of whatever the Clubs stack was left
                showing. `replace` on a stack of [list, hub] gives [list, list]: still two deep,
                and the navigator draws a back arrow on what looks like the root. A back arrow on
                My Clubs is a bug, not a state (PRD/15).
              */
              if (router.canDismiss()) router.dismissTo('/clubs');
              else router.replace('/clubs');
              return;
            }

            // Everything below is a real move, so the navigator's own action must not also run.
            event.preventDefault();

            const hub = `/clubs/${club.clubId}`;
            if (pathRef.current === hub) {
              /*
                Already at the front door, so this tap means "leave the club".

                `dismissTo` rather than `replace`: replace swaps the top of the stack in place, so
                a stack of [list, hub] becomes [list, list] - still two deep, leaving a back arrow
                on what looks like the plain root list. A back arrow on the root is a bug, not a
                state. `dismissTo` unwinds to the existing entry instead of adding one.
              */
              router.dismissTo('/clubs');
              return;
            }

            // `from=clubsTab` tells the hub to override its back arrow to the My Clubs list,
            // regardless of the history this jump leaves behind - see the hub's own note.
            router.replace(`${hub}?from=clubsTab`);
          },
        }}
      />
      <Tabs.Screen
        name="calendar"
        options={{
          title: 'Calendar',
          tabBarAccessibilityLabel: 'Calendar',
          tabBarIcon: ({ focused }) => <TabItem name="calendar" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="notifications"
        options={{
          title: 'Notifications',
          tabBarAccessibilityLabel: 'Notifications',
          tabBarIcon: ({ focused }) => <TabItem name="notifications" focused={focused} badge />,
        }}
      />
      <Tabs.Screen
        name="(profile)"
        options={{
          title: 'Profile',
          tabBarAccessibilityLabel: 'Profile',
          // Supplies its own headers from the stack inside it, like (main).
          headerShown: false,
          tabBarIcon: ({ focused }) => <TabItem name="profile" focused={focused} />,
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  /*
   * The whole destination - just the icon now - filling the press target.
   *
   * `justifyContent: 'center'` rather than a top padding, so the icon sits centred in the bar
   * however tall the bar turns out to be on a given platform.
   */
  tabItem: {
    flex: 1,
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
    /*
     * A stadium, not a rounded rectangle.
     *
     * This was `radius.lg`, and side by side with the app it is modelled on the difference is the
     * whole character of the control: 16pt on a ~40pt pill leaves four visible straight edges and
     * reads as a box, where half the height reads as a lozenge. The founder's note was about the
     * SHAPE rather than the colour, and this is the shape.
     */
    borderRadius: radius.pill,
    /*
     * Symmetric margins, and the bar is sized to fit rather than the pill nudged to compensate.
     *
     * A `marginTop` nudge was tried first, to centre the pill against the band the navigator
     * reserves under the icon slot for the label it has been told not to draw. It moved the pill
     * into a box too short to hold it and **clipped the top off every icon** on a real phone.
     * Giving the bar the height its contents actually need is the fix; moving content around
     * inside a box that is too small is not.
     */
    marginVertical: space.xs,
    marginHorizontal: 2,
    paddingHorizontal: 0,
    paddingVertical: space.xs,
  },
  /*
   * The layer the sliding pill lives on: the whole bar, behind every item.
   *
   * Vertical margins match `tabItem`'s so the pill is the same height as the content it sits
   * behind, and it is not interactive - the items above it own every touch.
   */
  pillLayer: { flex: 1, justifyContent: 'center' },
  pill: {
    position: 'absolute',
    top: space.sm,
    bottom: space.sm,
    borderRadius: radius.pill,
    backgroundColor: color.accentSoft,
  },

  // Top-right of the icon, overlapping it slightly, which is where a badge is read for.
  badge: {
    position: 'absolute',
    top: -4,
    left: 14,
    minWidth: 18,
    height: 18,
    borderRadius: radius.pill,
    backgroundColor: color.error,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.xs,
  },
  badgeLabel: { ...type.label, fontSize: 10, color: color.onAccent },
});
