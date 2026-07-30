/**
 * Root layout.
 *
 * Only four things live at this level, and what they have in common is that **none of them shows
 * the tab bar**:
 *
 *  - `index` and `sign-in`, which run before there is a session to have destinations for.
 *  - `legal/*`, readable signed in AND signed out, which is why they sit outside every guard.
 *  - `chat/[channelId]`, which is the one signed-in screen that covers the bar.
 *
 * **Everything else moved inside `(tabs)/(main)`** on 2026-07-30, so the tab bar stays put on the
 * club hub, every roster, every list and every leaf - which is v1's rule, recorded in
 * `SPEC/PRD/15`. The earlier arrangement had all of them as siblings of the tab group, so a club,
 * a race and a poll each hid the four destinations; only chat should do that. Because `(tabs)` and
 * `(main)` are both route groups, and groups contribute nothing to a URL, that move changed no
 * path and no href anywhere in the app.
 *
 * Chat is the deliberate exception rather than an oversight. It owns both edges of the screen -
 * a translucent header at the top, the composer pinned to the bottom - and a tab bar underneath
 * the composer would put two competing bars in the same thumb's reach.
 */

import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SessionProvider } from '../src/chat-provider.tsx';
import { CurrentSpaceProvider } from '../src/current-space.tsx';
import { FontGate } from '../src/fonts.tsx';
import { BackTo } from '../src/nav.tsx';
import { color, type } from '../src/theme.ts';

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      {/*
        The whole app waits on the typefaces, which is TECH/13 rule 4 - outside the session
        provider so the gate covers sign-in too, since that screen has the largest display type in
        the product and is the most obvious place to flash a system face.
      */}
      <FontGate>
        <SessionProvider>
          {/*
            Outside the Stack, because the Clubs tab and the Calendar destination both read
            "which club am I inside" from OTHER tabs - they sit outside the club's own stack
            entirely and cannot see its params.
          */}
          <CurrentSpaceProvider>
          <Stack
            screenOptions={{
              headerStyle: { backgroundColor: color.chrome },
              headerTitleStyle: { ...type.headerTitle, color: color.accent },
              headerTintColor: color.accent,
              contentStyle: { backgroundColor: color.appBackground },
            }}
          >
            <Stack.Screen name="index" options={{ headerShown: false }} />
            <Stack.Screen name="sign-in" options={{ title: 'ClubChat', headerShown: false }} />

            {/* The four destinations, and everything that keeps the tab bar beneath them. */}
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />

            {/*
              Chat opts out of the native header and renders its own glass-blur one, per the
              design system. The consequence is that its back control is reimplemented inline -
              which is exactly why it takes an explicit back-fallback rather than relying on
              history.
            */}
            <Stack.Screen name="chat/[channelId]" options={{ headerShown: false }} />

            {/*
              Readable signed in AND signed out, which is why they are outside every guard - and
              why their back control points at Profile rather than at a screen behind the guard.
            */}
            <Stack.Screen
              name="legal/privacy"
              options={{
                title: 'Privacy Policy',
                headerLeft: () => <BackTo href="/profile" label="Profile" />,
              }}
            />
            <Stack.Screen
              name="legal/terms"
              options={{
                title: 'Terms',
                headerLeft: () => <BackTo href="/profile" label="Profile" />,
              }}
            />
          </Stack>
          </CurrentSpaceProvider>
        </SessionProvider>
      </FontGate>
    </SafeAreaProvider>
  );
}
