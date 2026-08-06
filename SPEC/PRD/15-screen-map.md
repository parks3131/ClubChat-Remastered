# Screen map and IA

Described as screens and entry points, not routes. The remaster may reshape navigation, but
every screen below has a job that must land somewhere.

### Signed out

Four screens, and what they have in common is that **none of them may sit behind the auth gate**.

| Screen | Reached from | Job |
|---|---|---|
| **Sign in / Sign up** | The entry point, and every rejected session | One form in two modes. Carries the wordmark, because it is the one screen that has to say what the app is |
| **Forgot password** | A link under sign-in, in sign-in mode only | Takes an email, then **replaces itself with its own confirmation** rather than pushing a screen - there is nothing to go back to, and the answer is one sentence |
| **Set a new password** | The link in the reset email, **as a deep link from outside the app** | Takes the new password twice and lands on sign-in. Reachable with no session and, per PRD/03, with one |
| **Privacy Policy / Terms** | The consent line on sign-up, and Profile when signed in | Readable in both states, which is why they sit outside every guard |

> **The reset screen is the only screen in the product that is entered from outside it.** Every
> other route is reached by a tap inside the app, so "am I signed in" is answered before the
> screen is chosen. This one arrives cold, carrying a token, and any guard that redirects an
> unauthenticated visitor to sign-in would swallow it. It is on the same footing as the legal
> screens for exactly that reason.

### Top level

Four primary destinations: **Chats**, **Calendar**, **Notifications**, **Profile**. The
Notifications destination carries an unread badge.

*(The first was called **Clubs** and was a list of clubs until 2026-08-02. See below.)*

### Chats - the landing screen

**One list of every conversation, clubs and direct messages together, most recent activity
first.** This replaced the My Clubs list, because the two things a member opens the app for -
a club's chat and a direct message - were on different screens, one of them two taps down and
the other behind a button at the bottom of a list.

1. **The list carries club main chats and DMs, and nothing else.** A race and an Eboard space
   each have a real channel with a real unread count, and both are deliberately absent: the
   list is the conversations somebody thinks of as theirs, not one row per space they can
   reach. Their unread still arrives through the Notifications inbox and the badge.
2. **Each row shows** the scope's own avatar and name, the last message prefixed with who sent
   it, and when. A row with unread messages is tinted and carries a count.

   **A club's count covers every channel of that club the viewer can reach** - its main chat,
   the Eboard space, and any race they are on the roster of - because the row opens the club
   rather than one conversation inside it. The hub then badges each of those separately, so the
   total always resolves to somewhere to go. *(Corrected 2026-08-02: it counted the main chat
   alone, which made unread sitting in the Eboard invisible in the list, on the hub and
   everywhere else - reported from a phone as "it says nine and I cannot find them".)*

   A race the viewer has no roster row for contributes nothing, since they could never open it.

   **The hub badges each of those rows with its own count** - the main chat, the Eboard space and
   every race in the preview - so the total on the list always resolves to somewhere to go. A
   number that cannot be found is worse than no number, which is what it was for the Eboard and
   then again for races.
3. **Three filter chips - Unread, DMs, Clubs - and none of them is selected on arrival.**
   Landing on a filter would mean opening the app to an empty screen on every day the reader is
   caught up, which is most days, and an empty list reads as a broken app rather than as good
   news. Tapping the active chip clears it.
4. **The search field filters by conversation name.** Message content is **not** searched -
   message search remains deferred ([Roadmap](17-roadmap-and-open-questions.md)) and is a
   different and much larger feature than filtering a list already on screen.
5. **A club row opens that club's hub; a DM row opens the conversation.** The asymmetry follows
   from what the two things are: a DM *is* a conversation and has nowhere else to go, while a
   club is a place with a chat in it, alongside News, races, the Eboard space and the calendar.
   Opening a club straight into its chat puts all of that a back-press behind the reader.

   The cost, stated because it is real: a club row previews a message and then opens something
   that is not that conversation. What keeps it honest is that the hub's own chat row carries the
   same unread count, so the number on the list row is repeated rather than swallowed.

   *(Shipped opening chat on 2026-08-02 and changed the same day, on seeing it: the hub is the
   club's front door and the chat list should not bypass it.)*
6. **Two actions in the header.** A person+ opens the people search that starts a direct
   message; a plain + opens join-or-create-a-club. Both are additive and neither is styled as
   the primary.
7. **The empty state says which of three things happened** - no chats at all, nothing matching
   the search, or nothing unread - because "No chats yet" under an active Unread filter is a
   lie.
8. **A long press on any row opens Pin/Unpin, Mute/Unmute, Delete chat and Leave club.**
   Pinned rows sort above every unpinned one and carry a pin glyph, so the ordering explains
   itself rather than looking arbitrary. The first three are per-person facts about a
   conversation and apply in every scope; Leave club is absent on a DM, which has nothing to
   leave, and absent for an Owner, who must transfer ownership first (`PRD/04`). See
   [Direct messages](14-direct-messages.md) rules 11 and 12.

   8a. **Delete chat is personal in every scope, and the dialog says so in the scope's own
   words.** It hides everything said so far from you alone: on a DM the other person keeps every
   message and is not told, and on a club or race chat so does everybody else. It was a DM-only
   action until 2026-08-06. Nothing is destroyed, which is what separates it from deleting a
   message - that is authority over a shared room, and this is a view of your own.

   8b. **Leaving is confirmed with the cascade named, not with "are you sure".** Leaving a club
   takes its chat, every race in the club and any Eboard access, in one transaction; leaving a
   race takes its chat and your car group place and leaves the club membership alone. The part
   nobody expects from a menu opened on a chat row is the part the dialog has to state.

   8c. **Every long press in the product buzzes, with one feel.** A medium impact fires the
   moment the press registers, before the menu is drawn. A long press shows no progress, so
   without it the only signal that it worked is the menu appearing, and the only signal that you
   have not held long enough is nothing at all - which reads as a dead control. One shared
   helper, not a call per screen, because the same gesture feeling different in two places is
   the defect this fixes.

9. **The row lifts, the screen blurs behind it, and the menu springs out of it.** Not a bottom
   sheet: a sheet opens where the tab bar is, and on the club hub it opened *underneath* it, so
   the first item was visible and Cancel was not.

   9a. **The pressed row is redrawn floating at the exact rectangle it occupies**, and grows
   slightly. It is the subject of the menu, so it stays sharp and in place while everything
   around it recedes - which is what makes the menu read as belonging to that row rather than to
   the app.

   9b. **The background blurs rather than dimming to grey.** A dim says "something is in front of
   your list"; a blur says "this is still your list, and it is waiting". The blur covers the
   header and the tab bar too, so nothing is left looking still-usable.

   9c. **Icons on the left, destructive item last and red, no Cancel row** - tapping anywhere
   outside dismisses, and in a menu this short a Cancel would be a fifth of its height spent on
   "never mind". The menu hangs below the row, flipping above it when the row sits too low, and
   is clamped inside the safe area on all four sides.

10. **A long press on a race row in the club hub opens the same menu**, in both the preview list
    and the searchable "See all" sheet, with the menu opening over the sheet rather than closing
    it. Leave group there leaves the race, not the club.

    10a. **A race with no roster row gets Pin and nothing else.** The other three all act on the
    race's chat, and a race you are not on has none. Pinning is the one act that was never gated
    on access.

    10b. **The race pin is personal, and it is not access-gated.** Any member can pin any race
    they can see, which is every race in their club - a locked race is pinnable, and somebody
    waiting on a roster request is exactly who wants it at the top of their hub. An admin pinning
    a race pins it for themselves and for nobody else; club-wide admin pins were built in v1 and
    deliberately removed. See [Races and meets](09-races-and-meets.md) rules 21 to 23.

    10c. **No visible pin control on the row.** A toggle on every row is five controls in a
    five-row list for something most people set once. The pin glyph at the end of the row is the
    state the gesture sets, and it appears in both lists so pinning from the sheet is visibly not
    a no-op.

```
Chats  (every club chat and DM, newest first; chips: Unread | DMs | Clubs)
├─ New message        (person+: search people you share a club with → their profile)
├─ Add a club         (+: chooser)
│  ├─ Create club     (name, sport, description, join policy)
│  └─ Join club       (search by name)
├─ Join by link       (the deep-link target; no typed-code screen exists)
├─ DM chat            ← a DM row opens HERE
└─ Club hub           ← a club row opens HERE, not its chat
   ├─ News and Highlights        ← first row; the club's front page
   │  └─ Create / edit post      (admin)
   ├─ Club main chat             ← the centre of gravity
   │  ├─ Highlights   (Pinned | Announcements | Reports)
   │  └─ header quick-nav: Members · Poll · Routines · Events
   ├─ Eboard and Council         (admins only)
   ├─ Races and Meets            (preview of ~5 + searchable "See all")
   ├─ Club profile               (identity, join-link actions)
   │  ├─ Edit club               (admin)
   │  ├─ Members                 (roster, pending requests, add-member search)
   │  └─ Gallery
   ├─ Member profile card        (read-only, from chat or any roster)
   ├─ Calendar (club-scoped) → Event detail → Create/edit event (admin)
   ├─ Events list (Upcoming | Past)
   ├─ Routines (week view) → Activity type → Workout create/detail
   └─ Polls (ALL POLLS | MY VOTES) → Create → Poll detail
```

### Race

```
Race preview            (club member without access: name, date, Meet Info, Request to join)
Race hub                (manager without a roster row: request + Manage roster)
Race chat               ← a real race member is redirected straight here
├─ Highlights
├─ Gallery
├─ Race profile → Edit race (manager)
├─ Roster               (approve/deny/add/remove; manager)
├─ Meet Information     (five fields, one form; edit = manager)
├─ Car Assignments and Groups
└─ Polls
```

Race chat's header quick-nav: **Members · Meet Information · Polls · Car Assignments and
Groups**.

### Eboard

```
Eboard landing          (club admin who is not a member: request to join)
Eboard chat             ← a member is redirected straight here
├─ Highlights
├─ Gallery
├─ Eboard profile → Edit
├─ Roster
├─ Meetings (Upcoming | Past) → Meeting detail → Create/edit (creator only)
└─ Polls
```

Eboard chat's header quick-nav: **Members · Meetings · Polls**.

### Messages

```
New message             (search over people the viewer shares a club with; no global search)
└─ Member profile       ← a result opens the PROFILE
   └─ Send message      ← which is where a conversation actually starts
      └─ DM chat        ← the same chat screen, not a fork
         ├─ Chat info   ← the header NAME opens this
         │  ├─ Shared clubs      (listed, each opening that club)
         │  ├─ Gallery           (this conversation's photos)
         │  └─ ⋯ menu: Pin · Block / Unblock · Delete chat
         ├─ Member profile card
         └─ header options: Mute · Block / Unblock
```

**Chat info is the conversation's profile, not the person's.** A member profile is reachable
from any roster, where there may be no conversation at all - so the things that act on a
*thread* live here instead, and this screen exists only where a thread does.

**DMs are listed in the Chats destination, alongside club chats**, and are reached by the DMs
chip rather than by a screen of their own. A DM belongs to no club - two people who share three
clubs have one conversation - so nesting it under a club would misrepresent the model.

**Starting one goes through the person's profile, and that is deliberate.** A search result
opens who they are rather than jumping straight into a thread with them, which also means
"message this person" lives in exactly one place: reaching a profile from a roster, from a chat
avatar or from the search all offer the same action rather than three different ones.

*(There is no standalone Messages list. One existed until the Chats destination absorbed every
conversation; after that the only thing still navigating to it was a DM chat's back-fallback, so
it was a screen kept alive solely by the back control pointing at it. Removing it meant giving DM
chat a new declared parent, which is the Chats list.)*

Three things this screen group deliberately does **not** have: a Highlights **Reports** tab
(there is no admin of the conversation to read it), an announcement or poll action in the "+"
menu, and any club-scoped surface at all. A DM never appears on the calendar, in Highlights, or
in any club-scoped list.

The DM chat's **parent is the Chats list**, which is where its conversation is listed. It reaches
that list under the DMs chip rather than under a list of its own, so the back control lands on the
destination the conversation actually lives in.

### Profile

Own profile (with "Your clubs"), Edit profile, Privacy Policy, Terms, Sign out, Delete
account. Privacy Policy and Terms must **also** be reachable while signed out, from sign-up.

### Chrome: where the tab bar, the masthead and the back control appear

Read off v1 directly on 2026-07-30, because none of it is derivable from the screen list and all
of it is load-bearing. **This is what shipped**, and where the remaster currently differs the
difference is recorded as such rather than quietly kept.

**The tab bar.** Present on every signed-in screen **except chat**, in all three chat scopes.
Chat hides it on mount and restores it on unmount, because chat owns both edges of the screen: a
translucent header at the top and the composer pinned to the bottom, and a tab bar under the
composer would put two competing bars in the thumb's way. Everywhere else - club hub, roster,
polls, races, highlights, gallery, calendar - the tab bar stays, so a member is never more than
one tap from the four destinations. Signed-out screens have no tab bar at all.

*(The remaster differed here until 2026-07-30, when every non-destination screen moved inside the
first destination's stack. The tab bar is now present everywhere v1 puts it, and absent only in
chat.)*

**The masthead.** ~~The word "ClubChat" is a one-time app masthead on the Clubs landing screen.~~
**Gone as of 2026-08-02**: that screen became the Chats list, which draws its own "Chats" title
alongside its two header actions, and a branded bar above it would be a second header saying
something else. The word survives on sign-in, which is the one screen that has to say what the
app is. Calendar and Notifications carry the branded header because they
have no nested stack of their own to host one. Inside a club, the header title is instead the
club's own avatar and name, **tappable through to the club profile from every screen in the
club**. Chat and Highlights replace the header entirely with the glass-blur one.

**The back control.** Present on every screen below a destination, and never on a destination
itself. It **tries history first and falls back to a declared parent** - `back()` when there is
something to pop, so returning preserves the scroll position and state of the screen behind, and
an explicit parent when there is not, which is every screen reached by deep link, notification
tap or page refresh. Falling back without trying history first is not equivalent: it discards the
state of the screen being returned to, and it grows the stack instead of unwinding it.

> **It is permanent furniture, never conditional on history.** A native back button renders only
> when history exists, and refresh, deep link and notification tap all produce none. Designing it
> as conditional is the single most repeated bug in this project.

The parent is a **fixed property of the screen**, not a guess: always one meaningful level up,
never "the tab root" and never nothing.

| Screen | Back goes to | | Screen | Back goes to |
|---|---|---|---|---|
| Club hub | Chats | | Race hub | Races list |
| Club chat | Club hub | | **Race chat** | **Races list** |
| Club Highlights | Club chat | | Race Highlights | Race chat |
| Club calendar | Club hub | | Race roster | Race hub |
| Events list | Club hub | | Meet Information | Race hub |
| News feed | Club hub | | Car groups | Race hub |
| Routines | Club hub | | Race polls | Race hub |
| Polls list | Club hub | | Eboard hub | Club hub |
| Races list | Club hub | | **Eboard chat** | **Club hub** |
| Club profile | Club hub | | Eboard Highlights | Eboard chat |
| Members | Club profile | | Eboard roster | Eboard hub |
| Gallery | its chat | | Meetings list | Eboard hub |
| Poll detail | Calendar | | Eboard polls | Eboard hub |

**The two bold rows are a hard rule, not a preference.** A race hub and an Eboard hub each send a
real member straight into chat, so if either chat pointed back at its own hub, somebody arriving
with no history would bounce hub to chat to hub forever.

**Highlights is a view over a conversation, not a destination**, so its back always returns to the
chat it belongs to, and a row inside it jumps into that chat at that message rather than opening a
sub-page - there is nothing deeper to come back from.

### The Chats tab is a two-stage escape hatch

Not a plain "go to the list" tab. Its meaning depends on whether the viewer is **inside a club**,
which means anywhere in that club's world - the hub, its chat, Highlights, news, calendar,
routines, polls, the races list, a race hub, a race chat, the Eboard channel, any of it. Not just
the hub.

| Where | Tapping CHATS goes to |
|---|---|
| Not inside a club (the list, Calendar, Notifications, Profile) | the Chats list |
| Inside a club, on any screen except its hub | **that club's hub**, from any depth |
| Inside a club, already on its hub | the Chats list |

So the whole gesture is: **tap once to surface at the club's front door, tap again to leave it.**
Never more than two taps to the root from anywhere. The tab carries **no extra visual state** for
any of this - same icon, same label, same active tint. The behaviour is contextual; the chrome is
not. The other destinations are plain: each goes to its own root and keeps its own stack.

The "inside a club" signal is set when a club-scoped screen mounts and cleared when it unmounts,
which is what makes it survive into race and Eboard chat. **A back arrow on the Chats list is a
bug, not a state** - leaving a club must unwind to the existing root entry rather than stacking a
second copy of it.

**Two cross-stack jumps override their back arrow entirely**, because popping sends the person
sideways and then bounces them back:

- A hub reached by the **Chats tab shortcut** always goes back to the Chats list, whatever history says.
  Popping would return them to the deep screen they just escaped, which makes the shortcut useless.
- A hub reached from a **Profile club chip** goes back to Profile, *and* the jump replaces rather
  than pushes so the Chats tab already reads as the Chats list underneath. Otherwise tapping Chats later
  lands back on that hub whose back bounces to Profile - a live, reproducible loop.

**A screen the viewer may not see redirects to that scope's safe parent** rather than rendering an
error - a non-admin at the Eboard space lands on the club hub, a non-roster member at race chat on
the races list - and renders a centred spinner for the frame before the redirect, never a flash of
the protected content.

**The Calendar destination is club-scoped when a club is active.** Entering a club sets it as
current, and the Calendar tab then shows that club's feed with the club's name in its header
(`Ridgeway Calendar`); leaving the club clears it and the tab shows the merged cross-club feed
again. The **tab bar label stays "Calendar"** either way - only the header title changes. This is
why the club-scoped and cross-club calendars are one component: they are one screen with a
parameter, reached two ways.

### Motion

One rule, everywhere: **going deeper slides right to left, coming back slides left to right.**
That is what a stack push and pop already do; declaring it rather than inheriting it is what makes
it true on Android as well. The edge-swipe gesture is the same motion under a thumb and is on
throughout.

**Switching between the four destinations does not slide.** They are siblings rather than depth,
and a motion that means both "you went in" and "you moved across" means neither.

**A replace carries no direction of its own**, so the screen being replaced into says which way it
reads. Most replaces here are a way out - a back control with no history to pop, a saved edit, a
deleted club, a sign-out - and a few are a way in: creating a club or a race and landing on it,
signing in, opening a conversation from a member's profile.

> **A conversation is opened directly, never through a landing screen.** The club hub links
> straight to its main chat, to the Eboard's chat for a member of the space, and to a race's chat
> for somebody on its roster. Routing those through the landing screen meant one tap cost a push
> plus a redirect - two transitions for one act, which cannot be made to feel like one and was
> reported as exactly that. The landings remain for the arrivals that genuinely need a decision: a
> notification, a direct URL, and anybody without access.

### Icons

One vocabulary, taken from v1. An icon that means a thing in one place means it everywhere.

| Concept | Icon | Concept | Icon |
|---|---|---|---|
| Chats (destination) | `forum` | Calendar (destination) | `calendar-month` |
| Notifications (destination) | `notifications` | Profile (destination) | `person` |
| News and Highlights | `auto-awesome` | Club main chat | `forum` |
| Eboard and Council | `shield` | Race or meet | `flag` |
| Highlights (from chat) | `bolt` | Members or roster | `group` |
| Polls | `how-to-vote` | Routines | `fitness-center` |
| Events | `event` | Meetings | `groups` |
| Meet Information | `info` | Car groups | `directions-car` |
| Pinned | `push-pin` | Announcement | `campaign` |
| Report | `flag` | Delete | `delete-outline` |
| Gallery or grid | `grid-view` | Document | `insert-drive-file` |

The three club-hub rows carry **filled circular icon wells in three different tints** - chat on
the accent, News on the secondary, Eboard on the tertiary - which is what stops the hub reading
as an undifferentiated list.

### Navigation rules that must survive

1. **Chat is the home screen of a race and of an Eboard space.** A member entering either is
   taken straight to chat; the hub only renders for the not-yet-a-member states.
2. **Consequence:** a chat screen's back-fallback must **never** point at its own hub, or an
   entry with no history bounces hub → chat → hub forever.
3. **Every screen must be navigable back out when reached with no history** (deep link, page
   refresh, notification tap). A back control that only renders when history exists is a bug.
   Every screen declares an explicit parent to fall back to.
4. **Test direct URL entry and refresh, not just clicking through.** Click-through alone will
   never surface a missing back control. *Demonstrated again in Phase 3.5: the Messages list
   (since removed) showed a back link when reached from Clubs and none at all when its URL was entered
   directly, because the navigator only renders its own back button when history exists. A
   screen using the shared header must therefore declare an explicit back control, not merely
   an explicit parent.*
5. **A guarded screen must render a placeholder in its denied branch**, because the redirect
   lands a frame later.
6. **Cross-destination entry passes its origin explicitly** and the destination overrides its
   own back behaviour, because jumping across sibling stacks leaves no real history.
7. **Scope access is decided once, at the scope boundary**, not re-derived per screen. Screens
   below are thin, data-free wrappers.
