import { Link, Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SessionProvider } from '../src/chat-provider.tsx';
import { color, space, type } from '../src/theme.ts';

/**
 * An explicit back control, rendered whether or not history exists.
 *
 * The navigator's own back button appears only when there is somewhere to go back TO, so a
 * screen reached by direct URL or after a refresh has no way out of it at all. That is a bug
 * rather than a quirk - it was caught on `/dm`, where clicking through from Clubs showed a back
 * link and entering the URL directly showed nothing.
 */
function BackTo({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} accessibilityRole="button" accessibilityLabel={`Back to ${label}`}>
      {/*
        `paddingHorizontal`, matching the screen gutter and the chat screen's own header. The
        navigator renders this slot flush to x=0 on web, so without it the label touches the
        edge of the viewport.
      */}
      <Text
        style={{
          ...type.label,
          color: color.accent,
          textTransform: 'uppercase',
          paddingHorizontal: space.md,
        }}
      >
        {label}
      </Text>
    </Link>
  );
}

/**
 * Root layout.
 *
 * Consistent headers across every screen, including a working back control on screens
 * reached by deep link. `headerBackVisible` is left to the navigator, but every screen
 * below declares an explicit parent so a screen reached with no history can still be
 * navigated out of - a back control that only renders when history exists is a bug.
 */
export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <SessionProvider>
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: color.chrome },
            headerTitleStyle: { ...type.headline, color: color.accent },
            headerTintColor: color.accent,
            contentStyle: { backgroundColor: color.appBackground },
          }}
        >
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="sign-in" options={{ title: 'ClubChat', headerShown: false }} />
          <Stack.Screen name="clubs/index" options={{ title: 'Clubs' }} />
          {/*
            Messages sits beside Clubs rather than inside one. A DM belongs to no club - two
            people who share three clubs have one conversation - so nesting it under a club
            would be a lie about the model.

            `headerLeft` is explicit for the reason BackTo documents: entering /dm directly, or
            refreshing on it, leaves no history for the navigator's own back button to use.
          */}
          <Stack.Screen
            name="dm/index"
            options={{
              title: 'Messages',
              headerLeft: () => <BackTo href="/clubs" label="Clubs" />,
            }}
          />
          {/*
            Chat opts out of the native header and renders its own, per
            SPEC/TECH/13-design-system.md. The consequence is that its back control is
            reimplemented inline - which is exactly why it takes an explicit
            back-fallback rather than relying on history existing.
          */}
          <Stack.Screen name="chat/[channelId]" options={{ headerShown: false }} />
        </Stack>
      </SessionProvider>
    </SafeAreaProvider>
  );
}
