/**
 * Root layout.
 *
 * > **Every screen declares an explicit parent.** The navigator renders its own back button only
 * > when history exists, so a screen reached by deep link, notification tap or page refresh has no
 * > way out of it at all - `SPEC/PRD/15` rule 3, and a bug that has now shipped three times in this
 * > project. It was caught again on 2026-07-30 by entering `/clubs/:id/members` directly and finding
 * > a header with nothing in it.
 *
 * So `headerLeft` is set for every screen below, and for the parametrised ones it is built from the
 * route's own params - a screen inside a club goes back to that club, not to the clubs list. That is
 * what `parented()` does. A screen added without one is a screen somebody can get stranded on.
 *
 * The four top-level destinations live in the `(tabs)` group. Everything else is a sibling of it on
 * this stack, which is what makes a club, a race or a chat cover the tab bar rather than nest inside
 * one tab's history.
 */

import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { SessionProvider } from "../src/chat-provider.tsx";
import { FontGate } from "../src/fonts.tsx";
import { BackTo } from "../src/nav.tsx";
import { color, type } from "../src/theme.ts";

/**
 * Screen options with a back control built from the route's own params.
 *
 * `parent` receives the params so a nested screen can name its real parent: `/clubs/:id/members`
 * goes back to `/clubs/:id`, not to the clubs list. Returning a function from `options` is what
 * makes the params available at all - a static object cannot see them.
 */
function parented(
  title: string,
  parent: (params: Record<string, string>) => { href: string; label: string },
) {
  return ({ route }: { route: { params?: object } }) => {
    const params = (route.params ?? {}) as Record<string, string>;
    const { href, label } = parent(params);
    return {
      title,
      headerLeft: () => <BackTo href={href} label={label} />,
    };
  };
}

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
          <Stack
            screenOptions={{
              headerStyle: { backgroundColor: color.chrome },
              headerTitleStyle: { ...type.headerTitle, color: color.accent },
              headerTintColor: color.accent,
              contentStyle: { backgroundColor: color.appBackground },
            }}
          >
            <Stack.Screen name="index" options={{ headerShown: false }} />
            <Stack.Screen
              name="sign-in"
              options={{ title: "ClubChat", headerShown: false }}
            />

            {/* The four destinations. Their own header comes from the tab layout. */}
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />

            {/*
            Messages sits beside Clubs rather than inside one. A DM belongs to no club - two people
            who share three clubs have one conversation - so nesting it under a club would be a lie
            about the model.
          */}
            <Stack.Screen
              name="dm/index"
              options={{
                title: "Messages",
                headerLeft: () => <BackTo href="/clubs" label="Clubs" />,
              }}
            />

            {/*
            Chat opts out of the native header and renders its own glass-blur one, per the design
            system. The consequence is that its back control is reimplemented inline - which is
            exactly why it takes an explicit back-fallback rather than relying on history.
          */}
            <Stack.Screen
              name="chat/[channelId]"
              options={{ headerShown: false }}
            />

            {/* Clubs. A club falls back to the list; everything inside it falls back to the club. */}
            <Stack.Screen
              name="clubs/[clubId]/index"
              options={{
                title: "Club",
                headerLeft: () => <BackTo href="/clubs" label="Clubs" />,
              }}
            />
            <Stack.Screen
              name="clubs/[clubId]/members"
              options={parented("Members", (p) => ({
                href: `/clubs/${p.clubId}`,
                label: "Club",
              }))}
            />
            <Stack.Screen
              name="clubs/[clubId]/news"
              options={parented("News", (p) => ({
                href: `/clubs/${p.clubId}`,
                label: "Club",
              }))}
            />
            <Stack.Screen
              name="clubs/[clubId]/races"
              options={parented("Races & Meets", (p) => ({
                href: `/clubs/${p.clubId}`,
                label: "Club",
              }))}
            />
            <Stack.Screen
              name="clubs/[clubId]/routines"
              options={parented("Routines", (p) => ({
                href: `/clubs/${p.clubId}`,
                label: "Club",
              }))}
            />
            <Stack.Screen
              name="clubs/[clubId]/polls"
              options={parented("Polls", (p) => ({
                href: `/clubs/${p.clubId}`,
                label: "Club",
              }))}
            />
            <Stack.Screen
              name="clubs/[clubId]/events"
              options={parented("Events", (p) => ({
                href: `/clubs/${p.clubId}`,
                label: "Club",
              }))}
            />
            <Stack.Screen
              name="clubs/[clubId]/calendar"
              options={parented("Calendar", (p) => ({
                href: `/clubs/${p.clubId}`,
                label: "Club",
              }))}
            />
            <Stack.Screen
              name="clubs/[clubId]/profile"
              options={parented("Club profile", (p) => ({
                href: `/clubs/${p.clubId}`,
                label: "Club",
              }))}
            />

            {/*
            Races. A race screen falls back to the RACE, and the race itself falls back to the clubs
            list rather than to its club - the race read does not carry a club id the header could
            use, and the clubs list is always reachable.

            What none of these do is fall back to a chat screen: a race member entering the race is
            redirected straight to chat, so a back control pointing at chat would bounce. PRD/15
            rule 2.
          */}
            <Stack.Screen
              name="races/[raceId]/index"
              options={{
                title: "Race",
                headerLeft: () => <BackTo href="/clubs" label="Clubs" />,
              }}
            />
            <Stack.Screen
              name="races/[raceId]/roster"
              options={parented("Roster", (p) => ({
                href: `/races/${p.raceId}`,
                label: "Race",
              }))}
            />
            <Stack.Screen
              name="races/[raceId]/meet"
              options={parented("Meet Information", (p) => ({
                href: `/races/${p.raceId}`,
                label: "Race",
              }))}
            />
            <Stack.Screen
              name="races/[raceId]/car-groups"
              options={parented("Car Groups", (p) => ({
                href: `/races/${p.raceId}`,
                label: "Race",
              }))}
            />
            <Stack.Screen
              name="races/[raceId]/polls"
              options={parented("Polls", (p) => ({
                href: `/races/${p.raceId}`,
                label: "Race",
              }))}
            />

            {/* The Eboard space. */}
            <Stack.Screen
              name="eboard/[eboardId]/index"
              options={{
                title: "Eboard & Council",
                headerLeft: () => <BackTo href="/clubs" label="Clubs" />,
              }}
            />
            <Stack.Screen
              name="eboard/[eboardId]/members"
              options={parented("Roster", (p) => ({
                href: `/eboard/${p.eboardId}`,
                label: "Eboard",
              }))}
            />
            <Stack.Screen
              name="eboard/[eboardId]/meetings"
              options={parented("Meetings", (p) => ({
                href: `/eboard/${p.eboardId}`,
                label: "Eboard",
              }))}
            />
            <Stack.Screen
              name="eboard/[eboardId]/polls"
              options={parented("Polls", (p) => ({
                href: `/eboard/${p.eboardId}`,
                label: "Eboard",
              }))}
            />

            {/*
            Leaves reached from several places. Each falls back to a destination rather than guessing
            which of its callers it came from - a poll is reachable from three scopes and from the
            calendar, so the honest fallback is the calendar it also appears on.
          */}
            <Stack.Screen
              name="polls/[pollId]"
              options={{
                title: "Poll",
                headerLeft: () => <BackTo href="/calendar" label="Calendar" />,
              }}
            />
            <Stack.Screen
              name="meetings/[meetingId]"
              options={{
                title: "Meeting",
                headerLeft: () => <BackTo href="/calendar" label="Calendar" />,
              }}
            />
            <Stack.Screen
              name="news/[postId]"
              options={{
                title: "Post",
                headerLeft: () => <BackTo href="/clubs" label="Clubs" />,
              }}
            />
            <Stack.Screen
              name="users/[userId]"
              options={{
                title: "Profile",
                headerLeft: () => <BackTo href="/clubs" label="Clubs" />,
              }}
            />
            <Stack.Screen
              name="channels/[channelId]/highlights"
              options={parented("Highlights", (p) => ({
                href: `/chat/${p.channelId}`,
                label: "Chat",
              }))}
            />
            <Stack.Screen
              name="channels/[channelId]/gallery"
              options={parented("Gallery", (p) => ({
                href: `/chat/${p.channelId}`,
                label: "Chat",
              }))}
            />

            {/*
            The invite deep link, and the only invite path there is. Signed out, it routes to
            sign-in and continues here afterwards.
          */}
            <Stack.Screen
              name="join/[token]"
              options={{
                title: "Join",
                headerLeft: () => <BackTo href="/clubs" label="Clubs" />,
              }}
            />

            {/*
            Readable signed in AND signed out, which is why they are outside every guard - and why
            their back control points at sign-in rather than at a screen behind the guard.
          */}
            <Stack.Screen
              name="legal/privacy"
              options={{
                title: "Privacy Policy",
                headerLeft: () => <BackTo href="/profile" label="Profile" />,
              }}
            />
            <Stack.Screen
              name="legal/terms"
              options={{
                title: "Terms",
                headerLeft: () => <BackTo href="/profile" label="Profile" />,
              }}
            />
          </Stack>
        </SessionProvider>
      </FontGate>
    </SafeAreaProvider>
  );
}
