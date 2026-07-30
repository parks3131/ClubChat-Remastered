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
import { Tabs } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { useSession } from '../../src/chat-provider.tsx';
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

/** The notification count, as a badge on its own destination. */
function BadgedLabel({ label, focused }: { label: string; focused: boolean }) {
  const count = useBadge();
  return (
    <View style={styles.badgedWrap}>
      <TabLabel label={label} focused={focused} />
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
      <Tabs.Screen
        name="clubs"
        options={{
          title: 'Clubs',
          tabBarIcon: ({ focused }) => <TabIcon name="clubs" focused={focused} />,
          tabBarLabel: ({ focused }) => <TabLabel label="Clubs" focused={focused} />,
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
          tabBarIcon: ({ focused }) => <TabIcon name="notifications" focused={focused} />,
          tabBarLabel: ({ focused }) => <BadgedLabel label="Alerts" focused={focused} />,
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
  badgedWrap: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  badge: {
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
