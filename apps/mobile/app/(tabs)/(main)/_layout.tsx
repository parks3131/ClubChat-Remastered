/**
 * The Clubs destination's stack: everything that keeps the tab bar.
 *
 * > **Why this is a route GROUP and not a folder.** `(main)` is parenthesised, so it contributes
 * > nothing to the URL - `/clubs/:id/members`, `/polls/:id` and `/races/:id` are the same paths
 * > they were before these files moved under it. A plain folder named `main` would have prefixed
 * > every one of them, and a folder named `clubs` would have turned `/polls/:id` into
 * > `/clubs/polls/:id`. The group is what lets the whole product nest inside one tab without a
 * > single href changing.
 *
 * **What this buys: the tab bar stays.** `SPEC/PRD/15` records v1's rule - the tab bar is present
 * on every signed-in screen except chat, so a member reading a roster or a poll is always one tap
 * from the four destinations. Reaching that in Expo Router means those screens live *inside* a
 * tab rather than beside the tab group, which is what this file makes possible. Chat stays a
 * sibling of `(tabs)` on the root stack precisely so that it is the one screen that covers the
 * bar, because chat owns both edges: a glass header at the top and the composer at the bottom.
 *
 * ---
 *
 * > **Every screen declares an explicit parent.** The navigator renders its own back button only
 * > when history exists, so a screen reached by deep link, notification tap or page refresh has no
 * > way out of it at all - `PRD/15` rule 3, and a bug that has now shipped three times here.
 *
 * So `headerLeft` is set for every screen below, and for the parametrised ones it is built from
 * the route's own params - a screen inside a club goes back to that club, not to the clubs list.
 * That is what `parented()` does. A screen added without one is a screen somebody can get
 * stranded on.
 */

import { Stack } from 'expo-router';
import { BackTo, ClubHeaderTitle } from '../../../src/nav.tsx';
import { color, type } from '../../../src/theme.ts';

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

/**
 * The same, for a screen inside a club.
 *
 * v1 gives every club screen the club's own avatar and name as its title rather than the screen's,
 * with a bare arrow as the control - so the header says which club you are in from any depth, and
 * a worded back label would compete with it. The screen's own name is carried by the body.
 */
function inClub(
  title: string,
  parent: (params: Record<string, string>) => { href: string; label: string },
) {
  return ({ route }: { route: { params?: object } }) => {
    const params = (route.params ?? {}) as Record<string, string>;
    const { href, label } = parent(params);
    return {
      title,
      headerTitle: () => <ClubHeaderTitle fallback={title} />,
      headerLeft: () => <BackTo href={href} label={label} variant="icon" />,
    };
  };
}

export default function MainStackLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: color.chrome },
        headerTitleStyle: { ...type.headerTitle, color: color.accent },
        headerTintColor: color.accent,
        contentStyle: { backgroundColor: color.appBackground },
      }}
    >
      {/*
        The Clubs landing screen, and the only place the "ClubChat" masthead appears. v1 treats it
        as a one-time app masthead rather than a per-screen fixture, which is why no other screen
        in this stack repeats it.
      */}
      <Stack.Screen
        name="clubs/index"
        options={{
          title: 'ClubChat',
          headerTitleAlign: 'left',
          headerShadowVisible: false,
        }}
      />

      {/*
        Messages sits beside Clubs rather than inside one. A DM belongs to no club - two people
        who share three clubs have one conversation - so nesting it under a club would be a lie
        about the model.
      */}
      <Stack.Screen
        name="dm/index"
        options={{
          title: 'Messages',
          headerLeft: () => <BackTo href="/clubs" label="Clubs" />,
        }}
      />

      {/* Clubs. A club falls back to the list; everything inside it falls back to the club. */}
      {/*
        The hub wears the club's own identity like every other screen in the club, and a bare
        arrow rather than a worded label - a "CLUBS" next to "Binghamton Running Club" reads as
        two competing titles.
      */}
      <Stack.Screen
        name="clubs/[clubId]/index"
        options={{
          title: 'Club',
          headerTitle: () => <ClubHeaderTitle fallback="Club" />,
          headerLeft: () => <BackTo href="/clubs" label="Clubs" variant="icon" />,
        }}
      />
      <Stack.Screen
        name="clubs/[clubId]/members"
        options={inClub('Members', (p) => ({
          href: `/clubs/${p.clubId}/profile`,
          label: 'Club profile',
        }))}
      />
      <Stack.Screen
        name="clubs/[clubId]/news"
        options={inClub('News', (p) => ({ href: `/clubs/${p.clubId}`, label: 'Club' }))}
      />
      <Stack.Screen
        name="clubs/[clubId]/races"
        options={inClub('Races & Meets', (p) => ({ href: `/clubs/${p.clubId}`, label: 'Club' }))}
      />
      <Stack.Screen
        name="clubs/[clubId]/routines"
        options={inClub('Routines', (p) => ({ href: `/clubs/${p.clubId}`, label: 'Club' }))}
      />
      <Stack.Screen
        name="clubs/[clubId]/polls"
        options={inClub('Polls', (p) => ({ href: `/clubs/${p.clubId}`, label: 'Club' }))}
      />
      <Stack.Screen
        name="clubs/[clubId]/events"
        options={inClub('Events', (p) => ({ href: `/clubs/${p.clubId}`, label: 'Club' }))}
      />
      <Stack.Screen
        name="clubs/[clubId]/calendar"
        options={inClub('Calendar', (p) => ({ href: `/clubs/${p.clubId}`, label: 'Club' }))}
      />
      <Stack.Screen
        name="clubs/[clubId]/profile"
        options={parented('Club profile', (p) => ({ href: `/clubs/${p.clubId}`, label: 'Club' }))}
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
          title: 'Race',
          headerLeft: () => <BackTo href="/clubs" label="Clubs" />,
        }}
      />
      <Stack.Screen
        name="races/[raceId]/roster"
        options={parented('Roster', (p) => ({ href: `/races/${p.raceId}`, label: 'Race' }))}
      />
      <Stack.Screen
        name="races/[raceId]/meet"
        options={parented('Meet Information', (p) => ({
          href: `/races/${p.raceId}`,
          label: 'Race',
        }))}
      />
      <Stack.Screen
        name="races/[raceId]/car-groups"
        options={parented('Car Groups', (p) => ({ href: `/races/${p.raceId}`, label: 'Race' }))}
      />
      <Stack.Screen
        name="races/[raceId]/polls"
        options={inClub('Polls', (p) => ({ href: `/races/${p.raceId}`, label: 'Race' }))}
      />

      {/* The Eboard space. */}
      <Stack.Screen
        name="eboard/[eboardId]/index"
        options={{
          title: 'Eboard & Council',
          headerLeft: () => <BackTo href="/clubs" label="Clubs" />,
        }}
      />
      <Stack.Screen
        name="eboard/[eboardId]/members"
        options={parented('Roster', (p) => ({ href: `/eboard/${p.eboardId}`, label: 'Eboard' }))}
      />
      <Stack.Screen
        name="eboard/[eboardId]/meetings"
        options={parented('Meetings', (p) => ({ href: `/eboard/${p.eboardId}`, label: 'Eboard' }))}
      />
      <Stack.Screen
        name="eboard/[eboardId]/polls"
        options={inClub('Polls', (p) => ({ href: `/eboard/${p.eboardId}`, label: 'Eboard' }))}
      />

      {/*
        Leaves reached from several places. Each falls back to a destination rather than guessing
        which of its callers it came from - a poll is reachable from three scopes and from the
        calendar, so the honest fallback is the calendar it also appears on.
      */}
      <Stack.Screen
        name="polls/[pollId]"
        options={{
          title: 'Poll',
          /*
            A poll detail knows its own scope only after its read lands, and the back control has
            to exist before that. So the declared fallback is the Calendar, which every poll
            genuinely appears on - and with real history the arrow pops to whichever list the
            person actually came from, which is the common case.
          */
          headerLeft: () => <BackTo href="/calendar" label="Calendar" />,
        }}
      />
      <Stack.Screen
        name="meetings/[meetingId]"
        options={{
          title: 'Meeting',
          headerLeft: () => <BackTo href="/calendar" label="Calendar" />,
        }}
      />
      <Stack.Screen
        name="news/[postId]"
        options={{
          title: 'Post',
          headerLeft: () => <BackTo href="/clubs" label="Clubs" />,
        }}
      />
      <Stack.Screen
        name="users/[userId]"
        options={{
          title: 'Profile',
          headerLeft: () => <BackTo href="/clubs" label="Clubs" />,
        }}
      />

      {/* Highlights draws its own glass header, matching the chat it hangs off. */}
      <Stack.Screen name="channels/[channelId]/highlights" options={{ headerShown: false }} />
      <Stack.Screen
        name="channels/[channelId]/gallery"
        options={parented('Gallery', (p) => ({ href: `/chat/${p.channelId}`, label: 'Chat' }))}
      />

      {/*
        The invite deep link, and the only invite path there is. Signed out, it routes to
        sign-in and continues here afterwards.
      */}
      <Stack.Screen
        name="join/[token]"
        options={{
          title: 'Join',
          headerLeft: () => <BackTo href="/clubs" label="Clubs" />,
        }}
      />
    </Stack>
  );
}
