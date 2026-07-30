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
