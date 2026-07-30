/**
 * The Profile destination's stack.
 *
 * A route GROUP for the same reason `(main)` is one: it contributes nothing to the URL, so
 * `/profile` and `/profile/edit` are exactly those paths, and the tab keeps its own stack rather
 * than pushing onto the Clubs tab's.
 *
 * **Profile itself has no back control and Edit does**, which is the rule for every destination:
 * a tab root is somewhere you arrive, not somewhere you came from.
 */

import { Stack } from 'expo-router';
import { BackTo } from '../../../src/nav.tsx';
import { color, type } from '../../../src/theme.ts';

export default function ProfileStackLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: color.chrome },
        headerTitleStyle: { ...type.headerTitle, color: color.accent },
        headerTintColor: color.accent,
        contentStyle: { backgroundColor: color.appBackground },
      }}
    >
      <Stack.Screen
        name="profile/index"
        options={{ title: 'Profile', headerTitleAlign: 'left', headerShadowVisible: false }}
      />
      <Stack.Screen
        name="profile/edit"
        options={{
          title: 'Edit profile',
          // Plain, not the accent masthead: this screen is a form, and its title is a label
          // rather than a brand.
          headerTitleStyle: { ...type.headerTitle, fontSize: 19, color: color.textPrimary },
          headerLeft: () => <BackTo href="/profile" label="Profile" variant="icon" />,
        }}
      />
    </Stack>
  );
}
