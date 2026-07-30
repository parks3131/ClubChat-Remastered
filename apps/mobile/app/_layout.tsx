import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SessionProvider } from '../src/chat-provider.tsx';
import { color, type } from '../src/theme.ts';

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
