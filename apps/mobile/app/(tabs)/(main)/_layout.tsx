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
 *
 * ---
 *
 * > **It is an ARROW on every screen here, never a word.** The leaf screens - poll, meeting,
 * > event, post, profile, DMs - used to render their parent's NAME instead, on the theory that a
 * > worded control was the standard nested header and the bare arrow was reserved for headers
 * > wearing a space's identity. Reported on the event screen the moment it shipped, in the
 * > plainest possible terms: *the back button is missing*.
 * >
 * > It was not missing. "CALENDAR" was sitting immediately left of the title "Event", in the same
 * > uppercase label style, and read as an eyebrow rather than as a control - two labels where
 * > there should have been a control and a heading. v1 draws `arrow-back` on every nested screen
 * > and never a word, which `parented()` below has said all along; the leaf screens were simply
 * > the ones that had never been held to it. The destination is not lost - it is still what the
 * > control announces to a screen reader, as "Back to Calendar".
 */

import { Stack } from 'expo-router';
import { BackTo, BackToClub, SpaceHeaderTitle } from '../../../src/nav.tsx';
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
      /*
        An arrow, not the parent's name. v1 draws `arrow-back` on every nested screen and never a
        word - a worded control competes with the title beside it, and "RACES" next to "New race
        channel" reads as two labels rather than a control and a heading. The destination still
        reaches a screen reader through `accessibilityLabel`, which says "Back to Races".
      */
      headerLeft: () => <BackTo href={href} label={label} variant="icon" />,
    };
  };
}

/**
 * The same, for a screen that wears its SPACE's identity instead of its own name.
 *
 * v1 gives every screen inside a club, a race or Eboard & Council that space's own avatar and
 * name as its title, with a bare arrow as the control - so the header says where you are from any
 * depth, and a worded back label would compete with it. The screen's own name is carried by the
 * body.
 *
 * > **`idOf` is what keeps the header honest, and it must come from the ROUTE.** The title reads
 * > the name and picture from context, which the incoming screen sets in a focus effect - i.e.
 * > after the first paint. Without the route saying which space this screen is for, walking from
 * > a club into one of its races drew the club's name for a frame and then swapped it. See
 * > `SpaceHeaderTitle`.
 */
function inSpace(
  kind: 'club' | 'race' | 'eboard',
  idOf: (params: Record<string, string>) => string | undefined,
) {
  return (
    title: string,
    parent: (params: Record<string, string>) => { href: string; label: string },
  ) =>
    ({ route }: { route: { params?: object } }) => {
      const params = (route.params ?? {}) as Record<string, string>;
      const { href, label } = parent(params);
      return {
        title,
        headerTitle: () => (
          <SpaceHeaderTitle expect={{ kind, id: idOf(params) }} fallback={title} />
        ),
        headerLeft: () => <BackTo href={href} label={label} variant="icon" />,
      };
    };
}

const inClub = inSpace('club', (p) => p['clubId']);
const inRace = inSpace('race', (p) => p['raceId']);
const inEboard = inSpace('eboard', (p) => p['eboardId']);

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
        The two ways into a club, as screens rather than as panels inside the list.

        They were `mode` state on the Clubs screen, which left them wearing the "ClubChat"
        masthead and gave them no way back except a Cancel button of their own invention. A form
        that fills the screen IS a screen, and as one it gets the stack's back arrow and a header
        that says which of the two you are looking at.
      */}
      <Stack.Screen
        name="clubs/create"
        options={{
          title: 'Create club',
          headerLeft: () => <BackTo href="/clubs" label="Clubs" variant="icon" />,
        }}
      />
      <Stack.Screen
        name="clubs/join"
        options={{
          title: 'Join club',
          headerLeft: () => <BackTo href="/clubs" label="Clubs" variant="icon" />,
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
          headerLeft: () => <BackTo href="/clubs" label="Clubs" variant="icon" />,
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
        options={({ route }) => {
          const params = (route.params ?? {}) as Record<string, string>;
          return {
            title: 'Club',
            headerTitle: () => (
              <SpaceHeaderTitle expect={{ kind: 'club', id: params['clubId'] }} fallback="Club" />
            ),
            headerLeft: () => <BackTo href="/clubs" label="Clubs" variant="icon" />,
          };
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
      {/*
        There is no races LIST screen. v1 has none: the hub previews races and "See all" opens a
        searchable sheet over them, so a race's back control returns to the club rather than to an
        intermediate page. A list that existed only to be a back target was a screen the product
        did not want, and it is gone.

        The create form names ITSELF rather than the club, because what it is doing is the thing
        that needs saying - "Binghamton Running Club" over a form that makes a race is a header
        answering a question nobody asked.
      */}
      <Stack.Screen
        name="clubs/[clubId]/races/create"
        options={parented('New race channel', (p) => ({
          href: `/clubs/${p.clubId}`,
          label: 'Club',
        }))}
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
      {/*
        The club profile and its edit form name THEMSELVES rather than the club, because the club's
        name is already the subject of the screen below the header - repeating it in the bar would
        be the same word twice.
      */}
      <Stack.Screen
        name="clubs/[clubId]/profile"
        options={parented('Club Profile', (p) => ({ href: `/clubs/${p.clubId}`, label: 'Club' }))}
      />
      <Stack.Screen
        name="clubs/[clubId]/edit"
        options={parented('Edit club', (p) => ({
          href: `/clubs/${p.clubId}/profile`,
          label: 'Club profile',
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
        options={({ route }) => {
          const params = (route.params ?? {}) as Record<string, string>;
          return {
            title: 'Race',
            // The RACE's identity, not its club's. A race is a mini-club with its own name,
            // picture and profile, and wearing its parent's face here would make the header
            // unable to answer the only question it is asked.
            headerTitle: () => (
              <SpaceHeaderTitle expect={{ kind: 'race', id: params['raceId'] }} fallback="Race" />
            ),
            headerLeft: () => <BackToClub />,
          };
        }}
      />
      {/*
        The roster's parent is the race PROFILE, not the race hub, which is where the contract
        puts it and where it is actually reached from - the Members row on the profile. It
        pointed at the hub only because the profile did not exist yet.
      */}
      <Stack.Screen
        name="races/[raceId]/roster"
        options={parented('Roster', (p) => ({
          href: `/races/${p.raceId}/profile`,
          label: 'Race profile',
        }))}
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
        options={inRace('Polls', (p) => ({ href: `/races/${p.raceId}`, label: 'Race' }))}
      />
      {/*
        The race profile and its edit form name THEMSELVES rather than the race, for the same
        reason the club's pair do: the race's name is already the subject of the screen below the
        header, and repeating it in the bar would be the same word twice.
      */}
      <Stack.Screen
        name="races/[raceId]/profile"
        options={parented('Race Profile', (p) => ({ href: `/races/${p.raceId}`, label: 'Race' }))}
      />
      <Stack.Screen
        name="races/[raceId]/edit"
        options={parented('Edit race', (p) => ({
          href: `/races/${p.raceId}/profile`,
          label: 'Race profile',
        }))}
      />

      {/* The Eboard space. */}
      <Stack.Screen
        name="eboard/[eboardId]/index"
        options={({ route }) => {
          const params = (route.params ?? {}) as Record<string, string>;
          return {
            title: 'Eboard & Council',
            headerTitle: () => (
              <SpaceHeaderTitle
                expect={{ kind: 'eboard', id: params['eboardId'] }}
                fallback="Eboard & Council"
              />
            ),
            headerLeft: () => <BackToClub />,
          };
        }}
      />
      <Stack.Screen
        name="eboard/[eboardId]/members"
        options={parented('Roster', (p) => ({
          href: `/eboard/${p.eboardId}/profile`,
          label: 'Eboard profile',
        }))}
      />
      <Stack.Screen
        name="eboard/[eboardId]/meetings"
        options={parented('Meetings', (p) => ({ href: `/eboard/${p.eboardId}`, label: 'Eboard' }))}
      />
      <Stack.Screen
        name="eboard/[eboardId]/polls"
        options={inEboard('Polls', (p) => ({ href: `/eboard/${p.eboardId}`, label: 'Eboard' }))}
      />
      <Stack.Screen
        name="eboard/[eboardId]/profile"
        options={parented('Eboard Profile', (p) => ({
          href: `/eboard/${p.eboardId}`,
          label: 'Eboard',
        }))}
      />
      <Stack.Screen
        name="eboard/[eboardId]/edit"
        options={parented('Edit Eboard & Council', (p) => ({
          href: `/eboard/${p.eboardId}/profile`,
          label: 'Eboard profile',
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
          title: 'Poll',
          /*
            A poll detail knows its own scope only after its read lands, and the back control has
            to exist before that. So the declared fallback is the Calendar, which every poll
            genuinely appears on - and with real history the arrow pops to whichever list the
            person actually came from, which is the common case.
          */
          headerLeft: () => <BackTo href="/calendar" label="Calendar" variant="icon" />,
        }}
      />
      <Stack.Screen
        name="meetings/[meetingId]"
        options={{
          title: 'Meeting',
          headerLeft: () => <BackTo href="/calendar" label="Calendar" variant="icon" />,
        }}
      />
      {/*
        An event is reached from three places - the club's events list, the calendar, and the card
        in club chat - so like a poll it falls back to the Calendar rather than guessing which. Its
        club is only known after the read lands, and the control has to exist before that.
      */}
      <Stack.Screen
        name="events/[eventId]"
        options={{
          title: 'Event',
          headerLeft: () => <BackTo href="/calendar" label="Calendar" variant="icon" />,
        }}
      />
      <Stack.Screen
        name="news/[postId]"
        options={{
          title: 'Post',
          headerLeft: () => <BackTo href="/clubs" label="Clubs" variant="icon" />,
        }}
      />
      {/*
        "Member", not "Profile", which is v1's title and is the one that distinguishes this screen
        from the Profile tab. The name is on the page itself, so the header does not repeat it.
      */}
      <Stack.Screen
        name="users/[userId]"
        options={{
          title: 'Member',
          headerLeft: () => <BackTo href="/clubs" label="Clubs" variant="icon" />,
        }}
      />

      {/* Highlights draws its own glass header, matching the chat it hangs off. */}
      <Stack.Screen name="channels/[channelId]/highlights" options={{ headerShown: false }} />
      {/*
        The gallery belongs to its scope's PROFILE - club, race or Eboard - and the contract
        names all three. It cannot work that out from its own route: it is keyed by a channel id,
        which names a conversation rather than the thing that owns it, and the declared parent has
        to exist before any read could resolve one.

        So whoever links here says where back goes, as `parent`. The three profile screens each
        pass their own, and the chat fallback is for a cold arrival - a shared link or a refresh -
        where the conversation is the honest answer and is one tap from the profile anyway.
      */}
      <Stack.Screen
        name="channels/[channelId]/gallery"
        options={parented('Gallery', (p) => ({
          href: p['parent'] ?? `/chat/${p['channelId']}`,
          label: p['parent'] === undefined ? 'Chat' : 'Profile',
        }))}
      />

      {/*
        The invite deep link, and the only invite path there is. Signed out, it routes to
        sign-in and continues here afterwards.
      */}
      <Stack.Screen
        name="join/[token]"
        options={{
          title: 'Join',
          headerLeft: () => <BackTo href="/clubs" label="Clubs" variant="icon" />,
        }}
      />
    </Stack>
  );
}
