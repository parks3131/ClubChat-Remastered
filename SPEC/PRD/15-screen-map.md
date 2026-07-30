# Screen map and IA

Described as screens and entry points, not routes. The remaster may reshape navigation, but
every screen below has a job that must land somewhere.

### Top level

Four primary destinations: **Clubs**, **Calendar**, **Notifications**, **Profile**. The
Notifications destination carries an unread badge.

### Clubs

```
Clubs list  (empty state offers Create and Join)
├─ Create club        (name, sport, description, join policy)
├─ Join by link      (the deep-link target; no typed-code screen exists)
└─ Club hub
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
Messages list           (thread per person, most recently active first)
├─ New message          (search over people the viewer shares a club with; no global search)
└─ DM chat              ← the same chat screen, not a fork
   ├─ Gallery
   ├─ Member profile card
   └─ header options: Mute · Block / Unblock
```

**Sibling of Clubs, not nested inside one.** A DM belongs to no club - two people who share three
clubs have one conversation - so nesting it under a club would misrepresent the model.

Three things this screen group deliberately does **not** have: a Highlights **Reports** tab
(there is no admin of the conversation to read it), an announcement or poll action in the "+"
menu, and any club-scoped surface at all. A DM never appears on the calendar, in Highlights, or
in any club-scoped list.

The DM chat's **parent is the Messages list**, which matters for rule 2 below: every other chat
screen falls back to the clubs list, and this one must not.

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

> **The remaster currently differs.** Every non-destination screen is a sibling of the tabs group
> rather than nested inside it, so the tab bar disappears on the club hub, rosters and every list
> as well as on chat. Matching v1 means those screens move inside the Clubs destination's stack.

**The masthead.** The word "ClubChat" is a **one-time app masthead on the Clubs landing screen**,
not a per-screen fixture. Calendar and Notifications carry the same branded header because they
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
| Club hub | My Clubs | | Race hub | Races list |
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

### The Clubs tab is a two-stage escape hatch

Not a plain "go to the list" tab. Its meaning depends on whether the viewer is **inside a club**,
which means anywhere in that club's world - the hub, its chat, Highlights, news, calendar,
routines, polls, the races list, a race hub, a race chat, the Eboard channel, any of it. Not just
the hub.

| Where | Tapping CLUBS goes to |
|---|---|
| Not inside a club (list, Calendar, Notifications, Profile) | My Clubs |
| Inside a club, on any screen except its hub | **that club's hub**, from any depth |
| Inside a club, already on its hub | My Clubs |

So the whole gesture is: **tap once to surface at the club's front door, tap again to leave it.**
Never more than two taps to the root from anywhere. The tab carries **no extra visual state** for
any of this - same icon, same label, same active tint. The behaviour is contextual; the chrome is
not. The other destinations are plain: each goes to its own root and keeps its own stack.

The "inside a club" signal is set when a club-scoped screen mounts and cleared when it unmounts,
which is what makes it survive into race and Eboard chat. **A back arrow on the My Clubs list is a
bug, not a state** - leaving a club must unwind to the existing root entry rather than stacking a
second copy of it.

**Two cross-stack jumps override their back arrow entirely**, because popping sends the person
sideways and then bounces them back:

- A hub reached by the **Clubs tab shortcut** always goes back to My Clubs, whatever history says.
  Popping would return them to the deep screen they just escaped, which makes the shortcut useless.
- A hub reached from a **Profile club chip** goes back to Profile, *and* the jump replaces rather
  than pushes so the Clubs tab already reads as My Clubs underneath. Otherwise tapping Clubs later
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

### Icons

One vocabulary, taken from v1. An icon that means a thing in one place means it everywhere.

| Concept | Icon | Concept | Icon |
|---|---|---|---|
| Clubs (destination) | `groups` | Calendar (destination) | `calendar-month` |
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
   showed a back link when reached from Clubs and none at all when its URL was entered
   directly, because the navigator only renders its own back button when history exists. A
   screen using the shared header must therefore declare an explicit back control, not merely
   an explicit parent.*
5. **A guarded screen must render a placeholder in its denied branch**, because the redirect
   lands a frame later.
6. **Cross-destination entry passes its origin explicitly** and the destination overrides its
   own back behaviour, because jumping across sibling stacks leaves no real history.
7. **Scope access is decided once, at the scope boundary**, not re-derived per screen. Screens
   below are thin, data-free wrappers.
