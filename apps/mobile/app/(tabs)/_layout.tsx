/**
 * The four top-level destinations: Clubs, Calendar, Notifications, Profile.
 *
 * `SPEC/PRD/15` opens with these four and puts the unread badge on Notifications. Until now there
 * was no tab bar at all - Messages hung off the bottom of the club list as a button, and Calendar,
 * Notifications and Profile had nowhere to be. Everything below a destination pushes on the parent
 * stack rather than living here, so a club, a race or a chat covers the tab bar instead of nesting
 * inside one tab's history.
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
import { color, radius, space, tabBar, type } from '../../src/theme.ts';
import { useBadge } from '../../src/use-badge.ts';

/**
 * The bar's own height, before the home-indicator inset is added to it.
 *
 * Enough for a 24pt icon, a 10pt label and the pill's padding around both. The inset is added at
 * the call site rather than baked in here, because this number is about the design and that one is
 * about the hardware.
 */
// Shared, because screens need it to keep their last row clear of a bar that floats over them.
const TAB_BAR_CONTENT_HEIGHT = tabBar.height;

/**
 * The tab bar label.
 *
 * Icon **and** label, which is what v1 shipped - `groups`, `calendar-month`, `notifications`,
 * `person` for exactly these four destinations. The icon carries the recognition and the label
 * carries the meaning; an icon on its own is the accessibility failure PRD/16 names, and a label on
 * its own loses the design.
 */
function TabLabel({ label, focused }: { label: string; focused: boolean }) {
  return (
    <Text
      style={[styles.tabLabel, focused && styles.tabLabelActive]}
      /*
       * One line, always. "NOTIFICATIONS" is long enough to wrap into "NOTIFICATIO / NS" at a
       * quarter of a phone's width, and a tab bar with one two-line label is visibly crooked.
       *
       * The fit comes from the STYLE rather than from `adjustsFontSizeToFit`, which is iOS-only
       * - on web it does nothing and `numberOfLines` then truncates instead, trading a wrap for
       * an ellipsis. A smaller size and tighter tracking fit the word on both.
       */
      numberOfLines={1}
    >
      {label}
    </Text>
  );
}

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
 * One destination: the icon, its label, and the pill behind both when it is the active one.
 *
 * > **Drawn here rather than with `tabBarActiveBackgroundColor`, after that was tried and did not
 * > fit.** The navigator paints that colour on a box of its own choosing, and the box turned out to
 * > be the icon's - so the pill sat behind the icon with the label stranded underneath it, which is
 * > not what the design shows and is not something a style prop can move. Owning the container is
 * > the only way the pill can wrap both.
 *
 * It goes in the `tabBarIcon` slot with the navigator's own label switched off, so there is exactly
 * one thing being positioned per destination instead of two that have to agree.
 *
 * The pill is a second channel for the selected state, which `PRD/16` wants: orange-versus-grey
 * alone is invisible to a red-green colourblind reader and marginal on a phone in sunlight.
 */
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
 * icons and labels without any of them knowing it exists.
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
       * Tuned to be SEEN, which is the whole requirement.
       *
       * A stiffer spring settles in around 250ms, and over a quarter of a phone's width that is
       * fast enough to read as the indicator simply appearing somewhere else - which is the
       * "click and jump" this exists to remove. Slower and softer, so the eye can follow the
       * pill from the tab it left to the tab it arrived at.
       *
       * Damped rather than bouncy: it should arrive and stop, not wobble past the tab somebody
       * just chose.
       */
      damping: 18,
      stiffness: 130,
      mass: 0.9,
    }).start();
  }, [index, slot, travel]);

  return (
    <View style={styles.pillLayer} onLayout={(event) => setBarWidth(event.nativeEvent.layout.width)}>
      {slot > 0 && (
        <Animated.View
          style={[
            styles.pill,
            // Inset by the same margin `tabItem` uses, so the pill lands exactly where the icon
            // and label sit rather than a couple of points off.
            { width: slot - PILL_INSET * 2, left: PILL_INSET, transform: [{ translateX: travel }] },
          ]}
        />
      )}
    </View>
  );
}

/** Matches `tabItem`'s horizontal margin, so the sliding pill lines up with its contents. */
const PILL_INSET = 2;

function TabItem({
  name,
  label,
  focused,
  badge = false,
}: {
  name: keyof typeof TAB_ICON;
  label: string;
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
      <TabLabel label={label} focused={focused} />
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
   * it - the icons sat on the bottom edge with the labels clipped off the screen. So the height is
   * stated, and it has to carry `insets.bottom` with it or it is right on the phone it was
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

          > **In normal flow, NOT `position: absolute`.** Floating a tab bar absolutely is the usual
          > recipe and it makes the bar overlap the screen behind it, so every list in every tab has
          > to grow a bottom padding equal to the bar's height - and the one nobody remembers is the
          > one whose last row sits permanently under it. Keeping it in flow means the screens end
          > where the bar begins, which is the same look with none of that.

          `marginBottom` carries the home-indicator inset, so the bar floats above it rather than
          being tucked under it. Zero in a browser, 34pt on this phone.
        */
        tabBarStyle: {
          backgroundColor: color.chrome,
          // No hairline: a rule across the full width under a rounded floating bar is two designs.
          borderTopWidth: 0,
          height: TAB_BAR_CONTENT_HEIGHT,
          marginHorizontal: space.sm,
          marginBottom: insets.bottom > 0 ? insets.bottom : space.md,
          marginTop: tabBar.gap,
          // Fully round. A 24pt radius on a 60pt bar reads as a rounded rectangle; half the
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
          // Hidden entirely while the session is unresolved, so the shell does not flash
          // chrome over the sign-in redirect.
          display: authState === 'signed-in' ? 'flex' : 'none',
        },
        tabBarActiveTintColor: color.accent,
        tabBarInactiveTintColor: color.textSecondary,
        // `TabItem` draws the label inside its own pill, so the navigator must not draw a second
        // one underneath it.
        tabBarShowLabel: false,
        /*
          The item is only a press target now - `TabItem` fills it and draws its own pill. No
          margins here, so the pill gets the full quarter-width to sit in and the longest label
          ("NOTIFICATIONS") has room rather than truncating to "NOTIFICATI...".
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
          /*
            This tab supplies its OWN headers, from the stack inside it. Without this the tab
            navigator draws a second one above them - a "Clubs" bar stacked on top of every
            screen's real header, which is exactly what appeared the first time this was wired up.
            The other three destinations are single screens and keep the tab navigator's header.
          */
          headerShown: false,
          tabBarIcon: ({ focused }) => <TabItem name="clubs" label="Chats" focused={focused} />,
        }}
        /*
          The two-stage escape hatch. `PRD/15`:

            - not inside a club        -> the My Clubs list
            - inside one, off its hub  -> that club's hub, from arbitrary depth
            - inside one, ON its hub   -> the My Clubs list

          So the whole gesture is: tap once to surface at the club's front door, tap again to leave
          the club. Never more than two taps to the root from anywhere.

          The tab carries no extra visual state for any of this - same icon, same label, same
          active tint. The behaviour is contextual; the chrome is not.
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
          tabBarIcon: ({ focused }) => (
            <TabItem name="calendar" label="Calendar" focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="notifications"
        options={{
          title: 'Notifications',
          tabBarIcon: ({ focused }) => (
            <TabItem name="notifications" label="Notifications" focused={focused} badge />
          ),
        }}
      />
      <Tabs.Screen
        name="(profile)"
        options={{
          title: 'Profile',
          // Supplies its own headers from the stack inside it, like (main).
          headerShown: false,
          tabBarIcon: ({ focused }) => <TabItem name="profile" label="Profile" focused={focused} />,
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  /*
   * The whole destination, icon and label together, filling the press target.
   *
   * `justifyContent: 'center'` rather than a top padding, so the pair sits centred in the bar
   * whatever the label's line height turns out to be on a given platform.
   */
  tabItem: {
    flex: 1,
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
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

  tabLabel: {
    ...type.label,
    // Below the label token's 12/0.6, which is tuned for a badge rather than for a quarter of a
    // phone's width. The longest destination name is what sets this.
    fontSize: 9.5,
    letterSpacing: 0.1,
    color: color.textSecondary,
    textTransform: 'uppercase',
  },
  tabLabelActive: { color: color.accent },
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
