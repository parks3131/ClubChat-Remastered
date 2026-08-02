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
import { Tabs, usePathname, useRouter } from 'expo-router';
import { useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSession } from '../../src/chat-provider.tsx';
import { useCurrentSpace } from '../../src/current-space.tsx';
import { color, radius, space, type } from '../../src/theme.ts';
import { useBadge } from '../../src/use-badge.ts';

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
        tabBarStyle: {
          backgroundColor: color.chrome,
          borderTopColor: color.divider,
          // Hidden entirely while the session is unresolved, so the shell does not flash
          // chrome over the sign-in redirect.
          display: authState === 'signed-in' ? 'flex' : 'none',
        },
        tabBarActiveTintColor: color.accent,
        tabBarInactiveTintColor: color.textSecondary,
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
          tabBarIcon: ({ focused }) => <TabIcon name="clubs" focused={focused} />,
          tabBarLabel: ({ focused }) => <TabLabel label="Chats" focused={focused} />,
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
            event.preventDefault();
            const club = clubRef.current;

            if (club === null) {
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
          tabBarIcon: ({ focused }) => <TabIcon name="calendar" focused={focused} />,
          tabBarLabel: ({ focused }) => <TabLabel label="Calendar" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="notifications"
        options={{
          title: 'Notifications',
          tabBarIcon: ({ focused }) => <BadgedIcon focused={focused} />,
          tabBarLabel: ({ focused }) => <TabLabel label="Notifications" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="(profile)"
        options={{
          title: 'Profile',
          // Supplies its own headers from the stack inside it, like (main).
          headerShown: false,
          tabBarIcon: ({ focused }) => <TabIcon name="profile" focused={focused} />,
          tabBarLabel: ({ focused }) => <TabLabel label="Profile" focused={focused} />,
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  tabLabel: {
    ...type.label,
    // Below the label token's 12/0.6, which is tuned for a badge rather than for a quarter of a
    // phone's width. The longest destination name is what sets this.
    fontSize: 10,
    letterSpacing: 0.2,
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
