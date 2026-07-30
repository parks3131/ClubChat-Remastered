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
import { StyleSheet, Text, View } from 'react-native';
import { useSession } from '../../src/chat-provider.tsx';
import { useCurrentClub } from '../../src/current-club.tsx';
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
  return <Text style={[styles.tabLabel, focused && styles.tabLabelActive]}>{label}</Text>;
}

/** The four icons v1 used for these destinations, kept identical. */
const TAB_ICON = {
  clubs: 'groups',
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
  const { currentClub } = useCurrentClub();
  const pathname = usePathname();
  const router = useRouter();

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
          title: 'Clubs',
          /*
            This tab supplies its OWN headers, from the stack inside it. Without this the tab
            navigator draws a second one above them - a "Clubs" bar stacked on top of every
            screen's real header, which is exactly what appeared the first time this was wired up.
            The other three destinations are single screens and keep the tab navigator's header.
          */
          headerShown: false,
          tabBarIcon: ({ focused }) => <TabIcon name="clubs" focused={focused} />,
          tabBarLabel: ({ focused }) => <TabLabel label="Clubs" focused={focused} />,
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

            if (currentClub === null) {
              router.replace('/clubs');
              return;
            }

            const hub = `/clubs/${currentClub.clubId}`;
            if (pathname === hub) {
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
        name="profile"
        options={{
          title: 'Profile',
          tabBarIcon: ({ focused }) => <TabIcon name="profile" focused={focused} />,
          tabBarLabel: ({ focused }) => <TabLabel label="Profile" focused={focused} />,
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  tabLabel: { ...type.label, color: color.textSecondary, textTransform: 'uppercase' },
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
