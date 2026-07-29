# ClubChat - Remaster Brief

**A complete, self-contained description of what ClubChat is, everything it does, who is
allowed to do what, and every behaviour rule that must survive a rebuild.**

This file exists to be handed to an AI (or a person) building ClubChat again on a
**different architecture**, with the same product idea. It is deliberately
implementation-neutral: it describes behaviour, permissions, and invariants, not tables,
frameworks, or file paths. Where the current build made a decision that is worth carrying
over regardless of stack, it is called out as a **Rule**. Where a lesson is specific to the
current stack (React Native + Expo Router + Supabase/Postgres RLS), it is marked
*(current-stack detail)* so the remaster can translate rather than copy.

Nothing here is aspirational. Every behaviour described is shipped and working today,
unless a section explicitly says "not built".

> **Terminology.** "Admin" always means **Admin or Owner** unless a rule names Owner
> specifically. "Space" means a club, a race, or an Eboard channel - the three things that
> have their own membership and their own chat.

---

## Table of contents

1. [The product in one page](#1-the-product-in-one-page)
2. [Domain model](#2-domain-model)
3. [Roles, authority, and where authority stops](#3-roles-authority-and-where-authority-stops)
4. [Feature specifications](#4-feature-specifications)
   - [4.1 Accounts, auth, profile](#41-accounts-auth-profile)
   - [4.2 Clubs and membership](#42-clubs-and-membership)
   - [4.3 Chat](#43-chat)
   - [4.4 News and Highlights](#44-news-and-highlights)
   - [4.5 Calendar and events](#45-calendar-and-events)
   - [4.6 Weekly routines](#46-weekly-routines)
   - [4.7 Races and Meets](#47-races-and-meets)
   - [4.8 Eboard and Council](#48-eboard-and-council)
   - [4.9 Polls](#49-polls)
   - [4.10 Notifications](#410-notifications)
   - [4.11 Media, galleries, attachments](#411-media-galleries-attachments)
5. [Screen map and information architecture](#5-screen-map-and-information-architecture)
6. [Server-side event catalogue](#6-server-side-event-catalogue)
7. [Authorization requirements](#7-authorization-requirements)
8. [Cross-cutting UX rules](#8-cross-cutting-ux-rules)
9. [Design system](#9-design-system)
10. [Hard-won lessons to carry into the remaster](#10-hard-won-lessons-to-carry-into-the-remaster)
11. [Known gaps and what the remaster should fix](#11-known-gaps-and-what-the-remaster-should-fix)
12. [Parity acceptance checklist](#12-parity-acceptance-checklist)

---

## 1. The product in one page

### The problem

A sports club (the founding case is a university running club) coordinates itself entirely
through GroupMe plus ad-hoc tools:

| What they need | What they do today | Why it breaks |
|---|---|---|
| A weekly workout plan | Written in Excel, screenshotted, pasted into chat, manually pinned | Not searchable, not dated, buried by chat volume |
| Race logistics (carpools, meeting times, results) | A brand new GroupMe group per race | Group sprawl, no roster continuity, dies after the race |
| Announcements | A normal message someone remembers to pin | Indistinguishable from chatter |
| A private admin/captain space | A second GroupMe group | Manually maintained, drifts out of sync with who is actually an admin |
| Club calendar | Messages | Nothing is a date |

None of it is structured. It only works because members manually replicate structure the
chat app does not provide.

### The product bet

**Give clubs the structure they are already faking by hand.** Every artifact they improvise
- the pinned workout screenshot, the per-race group chat, the admin side-group, the "who's
driving" thread - becomes a first-class object with its own membership, permissions, and
history.

### Product principles

1. **A Race is a Club nested one level down.** Same shape: membership, roster, chat, its own
   sub-features. Not a special-purpose "event" screen. The admin-only Eboard space is the
   same shape again.
2. **Structure, not features.** Every addition must replace something members currently do
   by hand, not add a new thing to maintain.
3. **Deliberately simple where the founder said simple.** Routines carry a title and a
   description, not a structured exercise builder. Races carry a name and a date, not a full
   event schema.
4. **Chat is the centre of gravity.** Chat is where a club actually lives. Every other
   feature is reachable from chat, and things created elsewhere post themselves back into
   chat.
5. **Access is earned per space, not inherited.** Being a club admin grants authority over a
   race, but not automatic membership of its chat.

### Goals

- Replace the group-chat app as the club's primary coordination surface.
- Make a race's logistics survive as durable, revisitable structure instead of a disposable
  group chat.
- Make weekly training plans first-class, dated, and per-sport rather than a screenshot.
- Work as a **template**: a swim club, a running club, and a climbing club should all fit
  with no customisation work.

### Non-goals (deliberate, do not build)

| Not building | Why |
|---|---|
| Activity/training tracking | Strava exists. ClubChat plans workouts, it does not record them |
| Workout completion tracking | Explicit scoping call - routines are a plan, not a checklist |
| Structured exercise builders (sets/reps/splits) | Explicit "keep it very simple" call |
| RSVP or attendance, anywhere | No attendance concept exists in the product |
| Cross-club discovery or a social graph | Clubs are found by name or invite link, nothing more |
| Direct messages between members | Every conversation is scoped to a club, race, or Eboard |
| An "invite-only" club tier | Covered by the `request` policy plus a private share link |
| Threaded replies, message editing, message search | Out of scope by decision |
| Comments on news posts | Discussion belongs in chat |
| Recurring events | Weekly training is Routines' job |

### Platforms

iOS, Android, and web from one codebase. Phone-first, portrait only. Web is primarily a
development and testing surface but is fully functional. **Any behaviour must work
identically on all three**; confirmation dialogs, file pickers, camera capture, clipboard,
and sharing each behave differently per platform and each has caused a shipped bug.

---

## 2. Domain model

Conceptual entities and their relationships. No storage decisions implied.

```
User ──< ClubMembership >── Club
                             ├──< JoinRequest
                             ├──< CalendarEvent
                             ├──< RoutineWorkout
                             ├──< NewsPost ──< NewsPostReaction
                             ├──< Poll ──< PollOption ──< PollVote
                             ├──< Race
                             │     ├──< RaceMembership
                             │     ├──< RaceJoinRequest
                             │     ├──< RacePin (per user)
                             │     ├──< CarGroup ──< CarGroupMembership
                             │     └──  MeetInformation (5 fields on the race itself)
                             ├──  EboardChannel (exactly one)
                             │     ├──< EboardMembership
                             │     ├──< EboardJoinRequest
                             │     └──< Meeting
                             └──< Channel (chat)
                                   ├──< Message ──< Reaction / Mention / Report
                                   └──< ReadCursor (per user)
```

### The channel abstraction

**This is the single most important structural idea in the product.** There is **one** chat
channel concept with three scopes:

| Scope | Owned by | Who can read/post |
|---|---|---|
| Club main chat | A club | Every club member |
| Race chat | A race | Every race roster member |
| Eboard chat | An Eboard channel | Every Eboard member |

Everything that hangs off a channel - messages, reactions, mentions, reports, read cursors,
pins, announcements, highlights, galleries - works **identically in all three scopes with
zero duplication**. A feature added to club chat is added to all three, or it is a
parameter. Polls repeat the same trick: one poll concept with a club/race/Eboard scope.

**Rule:** adding a fourth scope must cost one membership predicate, one admin predicate, one
poll-access predicate, one branch per notification audience rule, and a set of thin screen
wrappers. Nothing shared should change. If a fourth scope would require forking chat, the
abstraction has been broken.

### Entity notes

| Entity | Key facts |
|---|---|
| **User / profile** | Full name, avatar, bio, city, date of birth, school. Self-editable only. Created automatically on signup. |
| **Club** | Name, sport, description, avatar, join policy (`open` \| `request`), invite code. Exactly one Owner at all times. |
| **ClubMembership** | Role: `owner` \| `admin` \| `member`. Per club. **Exactly one owner per club, enforced at the data layer, not in the UI.** |
| **Channel** | Belongs to a club always; optionally scoped to a race or an Eboard channel. Exactly one main channel per club, one per race, one per Eboard. |
| **Message** | Type: `text` \| `photo` \| `document` \| `announcement` \| `system` \| `poll` \| `event` \| `meeting`. Carries body, media reference, pinned flag, soft-delete timestamp, optional document name/size, optional linked poll/event/meeting. |
| **Race** | Name, date (date only, no time), avatar, plus five Meet Information fields: description, location link, hotel link, photos link, results link. |
| **RaceMembership** | The **only** source of truth for race access. Club-admin status is not a substitute, ever. |
| **CarGroup** | Auto-numbered ("Group 1", "Group 2"), one optional Incharge who must be a current member of that group. A person is in at most one group per race. |
| **EboardChannel** | Exactly one per club, created automatically with the club. Name, description, avatar. |
| **Meeting** | Title, description, datetime, optional link. Creator-only edit/delete. |
| **Poll** | Question, 2-10 options, `allow_multiple`, `is_private`, `is_closed`, optional `closes_at`. Scope: club, race, or Eboard. |
| **CalendarEvent** | Type (`race` \| `practice` \| `team_bonding` \| `volunteer` \| `other`), title, start datetime, optional end, optional location, optional description. Club-scoped only. The `race` type is a **label only** and has no relationship to a real Race. |
| **RoutineWorkout** | Date (a real calendar date), activity type (10 values), title, optional description. Club-scoped only. |
| **NewsPost** | Body text and/or one photo (at least one required), author, timestamp, emoji reactions. |
| **Notification** | Recipient, actor, club, type (18 values), a fully rendered human-readable body, and a target route. |

### Invariants that must hold in any architecture

1. **Exactly one Owner per club, always.** Enforced by the data layer. An ownerless club has
   no recovery path.
2. **Exactly one main channel per club, one per race, one per Eboard.** Any lookup for "the
   club's main channel" must exclude race- and Eboard-scoped channels. *(current-stack
   detail: forgetting this predicate caused "more than one row returned by a subquery"
   twice.)*
3. **Race membership is the sole source of truth for race access.** Substituting "is a club
   admin" has been wrong in five separate places.
4. **Eboard membership is always a subset of the club's admin tier.**
5. **A person is in at most one car group per race.**
6. **Poll vote counts are public; voter identity is gated.** Counts must be readable without
   exposing who voted, so a count cannot simply be derived from rows the viewer is forbidden
   to read.
7. **Message deletion is a soft delete with a tombstone**, never a removal.
8. **Notifications are written server-side only.** No client path may create one.
9. **Deleting a club, race, or Eboard cascades** to all its children, including chat history,
   rosters, polls, and notifications.
10. **Deleting an account anonymises, it does not remove content.** Messages stay in their
    conversations, unattributed, so history stays readable.

---

## 3. Roles, authority, and where authority stops

### Personas

| Persona | Who they are | What they need |
|---|---|---|
| **Club Owner / founder** | Created the club, or had it handed to them | Full control: identity, join policy, who is an admin, delete or hand over |
| **Captain / Admin** | Team captains, board members, coaches | Author workouts, run the calendar, create races, approve joiners, post announcements and news |
| **Member** | A runner/swimmer/climber | Read everything the club shares, chat, react, vote, join races, see who is driving |
| **Prospective member** | Has the link, or found the club by name | Get in: instantly if the club is open, by request otherwise |

### Hierarchy

**Owner > Admin > Member.** Owner is a strict superset of Admin: every admin-gated capability
is automatically available to the Owner.

1. Every club has exactly one Owner at all times.
2. Ownership is transferable to any current member; the outgoing Owner becomes an Admin.
3. The Owner cannot leave their own club and cannot be removed. Transfer first.
4. Roles are per club. Owner of one club, plain member of another, no interaction.

> **Rule (this bug shipped four separate times):** every audience query or authority check
> that filters on the admin tier must match **both** `admin` and `owner`. A check for
> "admin" alone silently excludes a club whose only admin-tier member is the Owner - which
> is every brand-new club.

### Where authority does NOT propagate

This is the most-misunderstood part of the model, and it is deliberate.

| Boundary | Rule |
|---|---|
| **Club admin → race chat** | Club admin status grants **management authority** over every race in the club (approve/add/remove members, edit Meet Information, manage car groups, delete the race) but **not** access to the race's chat, polls, or car-group membership. Those require a real roster row: the admin must request to join or be added like anyone else. |
| **Club admin → race car group** | An admin not on the race roster cannot be assigned to a car group, even though they can manage the groups. |
| **Club admin → race polls** | Creating or even seeing a race poll requires being on the race roster **and** being an admin. |
| **Club admin → Eboard membership** | Admin-tier membership **does** grant Eboard membership - automatically, and it is revoked automatically on demotion. But an admin who chooses to leave the Eboard space must request or be re-added; admin status alone does not re-admit them. |
| **Race roster → parent club** | Race membership is always a subset of club membership. Leaving the club removes every race and Eboard row for that club. |

### Consolidated permission matrix

#### Club

| Action | Owner | Admin | Member | Non-member |
|---|---|---|---|---|
| Read club chat / calendar / routines / news / races list | ✅ | ✅ | ✅ | ❌ |
| Send messages, react, report a message | ✅ | ✅ | ✅ | ❌ |
| Pin / unpin, post an announcement | ✅ | ✅ | ❌ | ❌ |
| Delete any message | ✅ | ✅ | own only | ❌ |
| Edit club name / description / avatar / join policy | ✅ | ✅ | ❌ | ❌ |
| Share or copy the join link | ✅ | ✅ | ❌ | ❌ |
| Add a member directly; approve/deny join requests | ✅ | ✅ | ❌ | ❌ |
| Promote Member → Admin, demote Admin → Member | ✅ | ✅ | ❌ | ❌ |
| Remove a Member | ✅ | ✅ | ❌ | ❌ |
| **Remove an Admin** | ✅ | ❌ | ❌ | ❌ |
| **Transfer ownership** | ✅ | ❌ | ❌ | ❌ |
| Leave the club | ❌ | ✅ | ✅ | - |
| **Delete the club** | ✅ | ❌ | ❌ | ❌ |

#### Club content

| Action | Owner | Admin | Member |
|---|---|---|---|
| Create/edit/delete a calendar event | ✅ | ✅ | ❌ |
| Create/edit/delete a routine workout | ✅ | ✅ | ❌ |
| Create/edit/delete a news post (any admin, any post) | ✅ | ✅ | ❌ |
| React to a news post | ✅ | ✅ | ✅ |
| Create a club poll | ✅ | ✅ | ❌ |
| Vote in a club poll | ✅ | ✅ | ✅ |
| Close / reopen / delete a poll | creator only | creator only | creator only |

#### Race

| Action | Club Owner/Admin (manager) | Race member | Club member, not on roster |
|---|---|---|---|
| Create a race | ✅ | ❌ | ❌ |
| See the race in lists; preview name, date, Meet Information | ✅ | ✅ | ✅ |
| Request to join | ✅ | - | ✅ |
| Approve/deny requests, add or remove roster members | ✅ | ❌ | ❌ |
| Read/post in race chat | only if also on the roster | ✅ | ❌ |
| Pin / announce in race chat | only if also on the roster | ❌ | ❌ |
| Edit Meet Information | ✅ | ❌ | ❌ |
| Create/delete car groups, assign members, set Incharge | ✅ | ❌ (view only) | ❌ |
| Be assigned to a car group | only if also on the roster | ✅ | ❌ |
| Create a race poll | only if also on the roster | ❌ | ❌ |
| See/vote in a race poll | only if also on the roster | ✅ | ❌ |
| Pin the race to their own hub | ✅ | ✅ | ✅ |
| Leave the race | ✅ (own row) | ✅ | - |
| Edit race identity / delete the race | ✅ | ❌ | ❌ |

#### Eboard and Council

| Action | Eboard member | Club admin, not a member | Club member |
|---|---|---|---|
| See that the space exists | ✅ | ✅ | ❌ |
| Read/post in Eboard chat | ✅ | ❌ | ❌ |
| Request to join / be added | - | ✅ | ❌ |
| Approve requests, add members | ✅ | ❌ | ❌ |
| Create a meeting or a poll | ✅ | ❌ | ❌ |
| Edit/delete a meeting | creator only | ❌ | ❌ |
| Remove another Eboard member | **Club Owner only** | ❌ | ❌ |
| Leave the Eboard space | ✅ | - | - |
| Delete the space | ✅ | ❌ | ❌ |

### Behaviour rules for roles

1. **Promotion to admin-tier auto-joins the Eboard space; demotion auto-removes.** An
   ownership transfer is a no-op for Eboard membership, since both sides stay admin-tier.
2. **Removing someone from a club cascades**: their race rosters, car-group assignments, and
   Eboard membership for that club are cleaned up in the same action.
3. **A role change is announced in club chat** as a system message and notifies the affected
   member.
4. **Role badges are visible** on the club list and the member roster, so authority is never
   guessed.

### Rejected alternatives (do not re-litigate)

| Decision | Rejected | Why |
|---|---|---|
| Three tiers (Owner/Admin/Member) | Two tiers with an implicit non-transferable "creator" | A creator concept cannot be handed over; a founder leaving left the club undeletable |
| Owner cannot self-remove | Auto-pick a successor | An ownerless club has no recovery path |
| Remove-an-Admin is Owner-only, demote-an-Admin is any-admin | Symmetric permissions | Admins policing each other's role is normal; ejecting each other is not |
| No separate "race admin" role | Per-race admin role | Club admins already have full authority; a second role adds UI for no new capability |
| No separate "Eboard admin" role | Mirror club tiers inside Eboard | Every Eboard member is already a club admin, so the role would be constant |
| Club admin gets authority over a race but not its chat | Auto-join every admin to every race (this was built, then reversed) | An admin auto-added to 30 races drowns in chat for races they are not running |

---

## 4. Feature specifications

Each subsection gives purpose, behaviour rules, permissions, edge cases, and acceptance
criteria. Behaviour rules are numbered so they can be cited.

### 4.1 Accounts, auth, profile

**Purpose.** Lightweight identity that makes a member recognisable across a club's chats and
rosters, plus full self-service control of the account.

**Fields.** Avatar, full name, bio, city, date of birth, school. Email is auth-only and is
never shown to other members.

**Behaviour rules**

1. Sign-up takes an email and a password. A consent line below the password field links to
   the Privacy Policy and the Terms.
2. Sign-up handles the "email confirmation required" case explicitly - the user is told to
   confirm, never left on a silent failure.
3. **The session persists across app restarts.** A returning user lands in the app, not on
   sign-in.
4. An unauthenticated user is always routed to sign-in; an authenticated one is always
   routed into the app, **including from the bare entry point** (`/`).
5. A profile is **self-editable only**. Nobody can edit another member's profile, including
   an Owner.
6. The avatar is uploaded from the profile screen, via an overlay control on the avatar
   itself.
7. "Your clubs" lists the user's clubs on their own profile, capped with a searchable
   "+N more" popup when there are many; each entry opens that club.
8. Another member's profile is **read-only**, reached by tapping their avatar in chat or
   their row on any roster.
9. Privacy Policy and Terms are readable **both signed out and signed in**.
10. Signing out returns to sign-in and clears the session.
11. **Account deletion is permanent, self-service, and confirmation-gated on every
    platform.** It anonymises the profile and permanently blocks future sign-in.
12. Deleting an account **does not delete the content they posted**. Their messages remain in
    their conversations, unattributed.

**Edge cases**

| State | Behaviour |
|---|---|
| Signed out, deep link into the app | Routed to sign-in first, then on to the target |
| Sign-in fails | Inline error; the form retains its input |
| Profile with no avatar | Letter-initial placeholder, used consistently in chat and rosters |
| Profile with no bio/city/school | Those rows are simply absent |
| Avatar upload fails | Surfaced; the old avatar is retained |
| User belongs to no clubs | "Your clubs" empty state |
| Deleted account's past messages | Remain in history, unattributed |
| Deleted account tries to sign in | Permanently blocked |
| **Auth check hangs on a slow network** | **The app falls back to signed-out rather than hanging on a spinner.** A hung check previously presented as an app that never loaded. Race the session check against a timeout. |

**Rejected alternatives.** Hard-deleting a user and their content (tears holes in every
conversation). Admin-mediated deletion (app-store requirement plus the right default).
Public profiles (clubs are small and often include minors). Usernames separate from full
names (clubs use real names). Aggressive session expiry (this is a club chat, not a bank).

---

### 4.2 Clubs and membership

**Purpose.** One durable home per team with a known roster, known admins, and a controlled
way in.

**Behaviour rules**

1. A club is created with a **name, a sport, an optional description, and a join policy**.
   The creator becomes its Owner.
2. **A new club is provisioned with its main chat and its Eboard space automatically** - no
   separate setup step - and the Owner is a member of both immediately.
3. **`open` policy:** finding the club by name and tapping Join adds the user immediately.
4. **`request` policy:** finding the club by name files a pending request; an admin approves
   or denies.
5. **The join link and manual invite code always join instantly, regardless of join
   policy.** It is a private side channel, deliberately independent of the public search
   path.
6. **Switching a club from `request` to `open` auto-approves every currently pending
   request**, rather than stranding them with no approval step left in the product.
7. Join policy is editable after creation.
8. **Approving a request, adding a member, removing a member, and changing a role each post a
   system message into club chat** and notify the people affected.
9. A member can leave any club they are not the Owner of. **Leaving removes them from every
   race roster, car group, and the Eboard space for that club in the same action.**
10. **Deleting a club is permanent and Owner-only.** Chat history, members, races, the Eboard
    space, polls, and posts all go with it. The confirmation names the club and states this.
11. The roster shows every member with their role badge; tapping a member opens their
    read-only profile card.
12. **Adding a member directly is a search over users**, not an invitation the recipient must
    accept.
13. **The club name is tappable from any club screen's header**, leading to the club profile:
    identity (avatar, name, description), join-link actions, and links onward to Members and
    Gallery.
14. **Identity and roster are separate screens.** The club profile carries identity and
    settings; Members is its own screen holding the roster, pending requests, and the
    add-member search. Races and the Eboard space follow the same split.

**Edge cases**

| State | Behaviour |
|---|---|
| No clubs yet | Empty state with Create and Join actions |
| Search returns nothing | "No clubs found" - no suggestion to create one with that name |
| Already a member of a searched club | The result shows membership rather than a Join button |
| Request already pending | Shows "Requested"; the action is disabled |
| Invite code typed in the wrong case | Accepted - codes match case-insensitively even though the UI styles them uppercase |
| Invalid or expired code | Inline "Invalid invite code"; the form stays filled |
| Join link opened while signed out | Routed to sign-in first, then the join completes |
| Join link opened twice | The second attempt is a no-op, not an error |
| Owner tries to leave | The Leave action is not shown at all - transfer is the only path |
| Deleted club still open on another device | Reads fail and the user is returned to the clubs list |

**Search.** Club search is by name, returns a safe projection (name, sport, member count, and
the caller's own request status) for clubs the caller is **not** a member of, limited to a
handful of results. Non-members must be able to find and join a club without being able to
read anything inside it.

**Acceptance criteria**

- [ ] Creating a club lands the creator on the club hub as Owner, with a working main chat.
- [ ] A newly created club already has an Eboard space with the Owner as a member.
- [ ] An open club can be found by name and joined in one tap, with no admin action.
- [ ] A request club files a pending request and shows "Requested" until decided.
- [ ] An admin can approve and deny; the requester is notified of the outcome either way.
- [ ] Switching a request club to open immediately admits everyone pending.
- [ ] The join link joins a second account instantly, even on a request club.
- [ ] Copying the invite code works on iOS, Android, and web.
- [ ] Promote and demote both work and are both announced in chat.
- [ ] An Owner can remove an Admin; a non-Owner Admin cannot.
- [ ] Transferring ownership leaves exactly one Owner, with the previous Owner an Admin.
- [ ] A non-Owner who leaves appears in no race roster, car group, or Eboard roster after.
- [ ] Deleting a club removes it from every member's clubs list.

---

### 4.3 Chat

**The centre of gravity.** One chat implementation serves club, race, and Eboard scopes with
**total feature parity**; only the menus differ.

**In scope**

| Capability | Notes |
|---|---|
| Text messages | With @mention tagging and autocomplete |
| Photo attachments | Library or camera |
| Document attachments | Any file type, shown with filename and size |
| Emoji reactions | Fixed set: 👍 ❤️ 😂 🔥 🎉 😮 |
| Announcements | Admin-only, visually distinct |
| Pinning | Admin-only, with a floating dismissible pinned strip |
| Highlights | Pinned / Announcements / Reports tabs over the same conversation |
| Jump-to-message | Tapping a pinned notice lands on that exact message, highlighted |
| Unread-aware entry | Chat opens on the first unread message |
| Jump-to-latest | A floating control once scrolled away from the live tail |
| System messages | Joins, leaves, adds, removes, promotions, demotions |
| Auto-posted cards | A created poll, event, or meeting posts itself into the relevant chat |
| Inline poll voting | A poll card in chat is fully votable without opening the poll screen |
| Moderation | Soft delete with a tombstone; report a message |
| Gallery | Every photo ever posted in that chat, as a grid |
| Quick-nav | A header menu into that space's other features |

**Out of scope:** threaded/quote replies, editing a sent message, typing indicators, read
receipts, presence, voice notes, video calls, DMs, message search, and paging *newer* beyond
a jump window (chat only pages upward from the live tail).

**Behaviour rules**

1. **One chat implementation serves all three scopes.** Feature parity is total.
2. **Chat loads the most recent ~40 messages** and pages further backward as the user scrolls
   up.
3. **Chat opens positioned on the first unread message, with no visible scroll motion.** If
   fully caught up, it opens at the bottom.
4. **Opening a chat marks it read**, which clears its unread count everywhere. Nothing else
   clears it.
5. **Only an admin of that space can post an announcement or pin a message.** In race chat
   that means a club admin who is **also on the roster**; in Eboard chat every member
   qualifies.
6. **A pin is separate from an announcement.** Pinning an ordinary message notifies nobody;
   posting an announcement notifies everyone in that space.
7. **The pinned strip floats over the conversation and can be dismissed locally.** Dismissing
   does not unpin for anyone. Tapping a pinned notice jumps the conversation to that message
   and briefly highlights it.
8. **@mentioning a member notifies them individually**, and the mention renders highlighted.
   A mention only notifies someone who can actually access that chat.
9. **A message can be deleted by its sender or by an admin of that space.** Deletion leaves a
   "This message was deleted" tombstone rather than removing it from history. Reactions and
   pin state are cleared with it.
10. **Anyone can report a message they did not send.** Reporting twice is a no-op. Reports
    surface only to admins, in a Reports tab in Highlights, where they can delete the message
    or dismiss the report.
11. **The composer's "+" opens an attach menu** with Photos, Camera, and Document always
    available, plus admin-gated create actions for whatever the scope supports (club: Poll,
    Event; race: Poll; Eboard: Poll, Meeting).
12. **Creating a poll, event, or meeting posts a card into the corresponding chat**,
    regardless of whether it was created from chat or from its own screen.
13. **Deleting the underlying poll, event, or meeting removes its chat card**, rather than
    leaving a dead link.
14. **Chat is full-screen** - the bottom tab bar is hidden while in a conversation.
15. **The chat header carries the space's name and avatar, tappable to that space's
    profile**, plus Highlights and a quick-nav menu.
16. **Every chat has a Gallery**: every photo ever posted in that conversation, as a grid,
    tap-to-view full screen. Read-only; photos enter it only by being posted in chat.
17. **@mention autocomplete offers only people who can access that chat** - club members in
    club chat, roster members in race chat, Eboard members in Eboard chat.

**Highlights**

A view of chat, not a feed of its own. Tabs: **Pinned**, **Announcements**, and (admins only)
**Reports**. The list is view-only; jumping to a message in context is the pinned strip's
job in chat.

**Edge cases**

| State | Behaviour |
|---|---|
| Empty conversation | Empty state, composer available |
| Loading | Spinner; the composer is not shown until the channel resolves |
| Offline / send failure | The send fails **visibly** rather than silently dropping the message |
| Photo or document upload fails | The message is not posted and the failure is surfaced |
| Deleted message | Tombstone; reactions and pin state cleared |
| Deleted poll/event/meeting | Its chat card disappears |
| Jump target far back in history | A window of history around that message is loaded; scroll-up paging continues from there |
| Realtime message arrives while reading old history | It merges in, but the view is **not** yanked to the bottom |
| No back history (deep link, refresh) | The back control falls back to that space's parent, **never** to a screen that would bounce back into chat |
| Non-member opens a race/Eboard chat URL directly | Redirected out |

**Acceptance criteria**

- [ ] A message sent on one device appears on another in realtime without a refresh.
- [ ] Photos and documents round-trip: upload, appear, and open when tapped.
- [ ] A document bubble shows its filename and size.
- [ ] Reactions toggle on and off and are visible to everyone.
- [ ] An @mention notifies the mentioned member and renders highlighted.
- [ ] The mention autocomplete lists only people who can access that chat.
- [ ] Every photo posted appears in that chat's Gallery and opens full screen from it.
- [ ] A member cannot post an announcement or pin; an admin can do both.
- [ ] The pinned strip appears when a message is pinned and can be dismissed without unpinning.
- [ ] Highlights lists pinned and announcement messages.
- [ ] Reopening a chat with unread messages lands on the first unread one with no visible scrolling.
- [ ] The jump-to-latest control appears after scrolling up and disappears at the bottom.
- [ ] Scrolling to the top loads older messages without losing scroll position, and **does not fire spuriously on open**.
- [ ] Deleting a message leaves a tombstone for every other member.
- [ ] Reporting surfaces the message in the admin Reports tab; a second report by the same person changes nothing.
- [ ] Creating a poll from "+" posts a votable card, and voting on the card matches the full poll screen.
- [ ] Race and Eboard chat behave identically to club chat for everything above.

**Rejected alternatives.** Reusing pinning to mean "important" (the club already faked
announcements by pinning; making them distinct is the whole point). Notifying on every pin
(pins are reference, not interruption). Hard delete (a message vanishing mid-conversation
makes the replies unreadable). Auto-hiding reported messages (abusable by a single reporter
in a small trusted group). Always opening at the bottom (explicit founder request: landing at
the bottom means hunting upward for what you missed). A full emoji picker (fast tap targets
beat completeness). Link-only poll cards (voting should be one tap from the conversation).

---

### 4.4 News and Highlights

**Purpose.** A durable, scrollable record of club news - results, recaps, photo drops - that
is not competing with chat's message flow. **A pinned chat message is a reference; a news
post is a publication.** The two surfaces coexist deliberately.

| | News feed | Chat Highlights |
|---|---|---|
| Content | Standalone posts authored for the feed | Messages already sent in chat |
| Author | Any club admin | Whoever sent the message |
| Reached from | The club hub (it is the **first row**) | The chat header |
| Tapping a row | Opens the post | Nothing - view-only |
| Scope | Club only | Club, race, and Eboard each have their own |

**Behaviour rules**

1. A post must have **body text, a photo, or both**; an entirely empty post cannot be created.
2. The feed is reverse-chronological, newest first, with no pinning or ordering controls.
3. **Any club admin can create, edit, or delete any post**, not only its author.
4. Every club member can read the feed and react. Reactions use the same emoji set as chat.
5. A member can add and remove their own reaction, one of each emoji per post.
6. **Creating a post notifies every other club member. Editing or deleting does not notify.**
7. Editing reuses the create form, pre-filled: leaving the photo untouched keeps it, choosing
   a new one replaces it, clearing it removes it.
8. **Deleting a post is permanent, with no tombstone** - unlike a chat message, there is no
   surrounding conversation that a gap would make unreadable.
9. Every post shows its creator's name, avatar, and post time.

**Acceptance criteria**

- [ ] Text-only, photo-only, and both all create successfully; neither is rejected.
- [ ] An admin who did not author a post can still edit and delete it.
- [ ] Editing without touching the photo keeps it; replacing swaps it; clearing removes it.
- [ ] Creating notifies every other club member; editing and deleting notify nobody.
- [ ] A member sees no create/edit/delete controls and is redirected off those routes.
- [ ] Deleting asks for confirmation on web as well as native.

---

### 4.5 Calendar and events

Two views over **one merged feed**: a month grid for "what is happening when", and a list for
"what is coming up".

**Behaviour rules**

1. **The month grid marks any day carrying a calendar event, a race, or an Eboard meeting.**
   Tapping a marked day opens a popup listing that day's items; tapping an item opens it.
2. **Polls are excluded from the month grid** but included in the Upcoming/Past list - a poll
   has a closing deadline, not a day it happens on.
3. **Filler days from adjacent months are never marked or tappable**, so a marker always
   belongs to the month on screen.
4. The Upcoming/Past list is one merged, sorted feed across events, races, meetings, and
   polls. Past items are faded, most-recent-first.
5. **A poll is "upcoming" while it is still open**, not by comparing its date - an open-ended
   poll must never fall into Past.
6. **The Calendar shows the active club's feed if the user is inside a club, and a merged
   cross-club feed otherwise.** In merged mode every row is tagged with its club and no
   create action is offered.
7. **Every read respects the viewer's own access.** An Eboard meeting only appears for Eboard
   members; a race poll only for race members.
8. **Every race is visible on the calendar to every club member**, whether or not they have
   race access. Tapping through without access leads to the race preview, not the race.
9. Only an admin can create, edit, or delete an event. Creating one notifies every other club
   member.
10. **A created event posts a card into club chat** with its title, date, and location.
11. An event carries a type, a title, a date and time, an optional location, and an optional
    description.
12. **Creating an event from chat's "+" returns to chat afterwards**, not to the new event's
    detail screen - the chat card already confirms it.

**Edge cases.** A month with nothing renders with no markers and no error. Loading keeps the
grid at a **fixed height** so paging months does not make the page jump. An event deleted
while its detail screen is open returns the user to the list. Direct route access to
create/edit as a non-admin redirects.

**Rejected alternatives.** One screen with grid above list (explicit founder request: the
calendar should be just the grid). Polls on the grid by closing date (cluttered it). A
separate calendar table everything writes into (a second copy would drift; a merged read
cannot go stale). Hiding races the viewer cannot access (members need to know a race exists
in order to ask to join it). A club picker on the global calendar (creation is club-scoped;
a picker adds a step for a rare case).

---

### 4.6 Weekly routines

Admin-authored, dated training plans. **The feature that replaces the screenshotted Excel
sheet.**

**Behaviour rules**

1. The screen shows **one real calendar week, Monday through Sunday** - not a repeating
   template.
2. **On the current week, only today and future days are shown.** The week is a plan, not a
   record. Paging back shows all seven days.
3. **A day with no workout renders as "Rest day"**, explicitly - never omitted or blank. An
   empty day is otherwise ambiguous between "rest" and "not posted yet".
4. Creating a workout **starts with picking its activity type**, then the title and
   description form.
5. A workout carries an **activity type, a title, and an optional description**. Nothing else.
6. **Any club admin can create, edit, or delete any workout**, not only its author.
7. Each activity type has its own icon and label, used consistently in the week view and the
   detail view.
8. Members see the week view and detail read-only - no create, edit, or delete controls
   anywhere.
9. **Creating a workout does not notify anyone and does not post to chat.** It is reference
   material, not an event. A week of workouts would otherwise fire seven notifications.

**Activity types (10).** Run, Trail Run, Bike, Swim, Strength, Hybrid Fitness, Indoor Climb,
Bouldering, XC Ski, Other.

**Out of scope.** A structured exercise builder (sets, reps, distances, splits), completion
tracking, recurring/template weeks, per-member personalisation, attachments.

---

### 4.7 Races and Meets

**A race is a mini-club nested inside a club** - its own roster, its own chat, its own
logistics - replacing the throwaway group chat spun up per race.

#### Creation and access

1. **A race is created with a name and a date only**, by a club admin, from the club's Races
   & Meets list.
2. **Every club member can see every race exists** - in the races list, on the calendar, and
   in the club hub preview.
3. **Access is always by request.** There is no "open" race policy. A club member requests;
   any club admin approves, denies, or adds them directly.
4. **A club admin is a "manager" of every race in their club** - full management authority -
   but **management authority is not access**. Chat, polls, and car-group assignment all
   require a real roster row, for admins too.
5. **A manager not on the roster** sees a request-to-join screen plus a way into the roster to
   manage others, not the race itself.
6. **A club member with no access who taps a race gets a preview**: name, date, Meet
   Information, and the request action. Nothing member-only is exposed.
7. **A race member is redirected straight into race chat** on entering the race. Chat is the
   race's home screen; everything else is reached from its header menu.
8. Any race member can leave the race, which also removes them from their car group.
9. Leaving the parent club removes the user from every race in it.

#### Meet Information

10. **Five fields, edited together as one form**: description, race/event location link,
    hotel link, photos link, results link.
11. **Any manager can edit all five** - not restricted to whoever created the race.
12. **Empty-state behaviour differs per field, deliberately:** description, location, and
    hotel are **hidden entirely** when empty; photos and results **always show a "stay tuned"
    placeholder**. (Photos and results are expected later; a missing hotel link usually means
    there is no hotel.)
13. **Meet Information is readable by any club member**, including those without race access -
    it is exactly the information they need to decide whether to go.

#### Car Assignments and Groups

14. **Groups are auto-numbered on creation** - "Group 1", "Group 2" - with no naming prompt.
15. **A person can be in at most one car group per race.**
16. **Only people with real race access can be added to a group**, and the add-member search
    excludes anyone already in any group for that race.
17. **Each group can have one designated Incharge**, who must be a current member of that
    group.
18. **If the Incharge leaves or is removed, the group's Incharge is cleared automatically and
    every club admin is notified that the group needs a new one.** The rest of the group is
    untouched.
19. **A plain member leaving a group is a non-event** - no notification. Any member can leave
    their own car group without leaving the race.
20. Every race member can view the groups, including Incharge tags, read-only. Only managers
    can create, delete, assign, or remove.

#### Pins

21. **Pinning a race is personal.** Each member pins for themselves; it affects only their own
    club-hub preview, never anyone else's.
22. **Any member can pin any race they can see** - pinning is not admin-gated.

**Edge cases.** A pending request shows "Requested - waiting on an admin to approve" on both
the row and the preview. A denied request can be re-filed. A group whose Incharge just left
persists with no Incharge. Deleting a race takes its chat history, roster, car groups, Meet
Information, and polls with it, and the confirmation says so. Back from race chat lands on
the races list, **never** on a screen that bounces back into chat.

**Rejected alternatives.** Spawning races from a "race"-type calendar event (matched an
earlier sketch, but the detailed scoping produced standalone races; the calendar link was
designed and never built). A bespoke "event with attendees" screen (reusing membership + chat
gave race chat full feature parity for free). An open join policy (race rosters are travel
logistics). A race admin role. Auto-joining every admin to every race (**built, then
reversed**). Two separate Meet Info sections (**shipped, then merged** on founder follow-up).
Prompting for car group names (naming eight cars is friction). Club-wide admin race pins
(**built, then corrected**: anyone pins for themselves). Structured results (results already
live in a timing provider's site).

**Open questions.** Should a race carry a start/end time? Should car groups have capacity?
Should a finished race be archivable? Should a race be delegable to a non-admin race captain?

---

### 4.8 Eboard and Council

One private space per club for its admins - the board/captains' side group, made official.

**How this deliberately differs from a Race.** Both are mini-clubs nested under a club, but
their membership models are opposites:

| | Race | Eboard and Council |
|---|---|---|
| Who may be a member | Any club member | Club admins only |
| How a member gets in | Requests, or is added by any club admin | **Automatically, on becoming admin-tier** |
| Does admin status grant membership? | **No** | **Yes** - promotion auto-joins, demotion auto-removes |
| Who approves requests / adds members | Any club admin, from outside | **Existing members only** |
| Who can remove a member | Any club manager | **The club Owner only** |
| How many per club | Many | Exactly one |
| Who can create one | Any club admin | Nobody - created with the club |
| Who can create content inside | Admins only (polls) | **Any member** (meetings and polls) |

The consequence worth stating plainly: **the request-to-join path exists, but in normal
operation nobody uses it.** It matters only for an admin who deliberately left and wants back
in.

**Behaviour rules**

1. Every club has exactly one Eboard space, **created automatically at club creation**, with
   the Owner as its first member.
2. **Promotion to Admin or Owner auto-joins; demotion to Member auto-removes.**
3. **An ownership transfer changes nothing** about Eboard membership - both parties stay
   admin-tier.
4. **Only club admins can see the space exists.** Ordinary members have no visibility of it,
   its chat, its meetings, or its polls.
5. Only current members can read or post in Eboard chat, approve requests, or add other
   admins.
6. **Any Eboard member can create a meeting or a poll** - there is no further role
   distinction inside.
7. **Only the meeting's creator can edit or delete it.** Everyone else is view-only, and the
   detail view shows "Added by <name>".
8. **Creating a meeting notifies the other Eboard members and posts a card into Eboard chat.**
9. A meeting carries a title, a description, a date and time, and an optional link (video
   call, agenda doc, anything).
10. Meetings are listed as Upcoming and Past, and appear on the calendar of **Eboard members
    only**.
11. Any member can leave. **Removing someone else is Owner-only.**
12. Deleting the space is restricted to existing members and takes its chat history,
    meetings, and polls with it.
13. **A member entering the space is taken straight to Eboard chat**, with Meetings and Polls
    reached from the chat header menu.

**Rejected alternatives.** Manual "+ Create" the first time (pure friction; every club wants
one). Keeping the original request-only model (leadership churn meant the space drifted out
of sync with who was actually an admin). Reusing Race's model wholesale (race separates
authority from access; for Eboard the two are the same thing). Letting "any club admin"
approve (an admin outside the space could add themselves in, defeating the privacy boundary).
Mutual removal (highest-trust space in the product). Any-member meeting editing (**two
explicit founder follow-ups** after meetings first shipped).

---

### 4.9 Polls

Structured voting, scoped to a club, a race, or the Eboard. Replaces "react with 👍 if you're
coming".

**Behaviour rules**

1. A poll has a question and **between 2 and 10 options**.
2. **Vote counts are always public**, on every poll, including private ones.
3. **Voter identity is gated by the poll's privacy setting**: on a public poll everyone
   eligible can see who voted for what; on a private poll **only the creator** can. **A voter
   always sees their own vote either way.**
4. **Tapping an option votes for it. Tapping it again withdraws the vote.** On a single-choice
   poll, tapping a different option **moves** the vote rather than adding a second.
5. A per-option control reveals that option's voters, shown once the option has at least one
   vote and the viewer is allowed to see voters. **Opening the voter list must not cast a
   vote.**
6. **A poll closes when its creator closes it, or when its deadline passes** - whichever comes
   first. A closed poll cannot be voted in.
7. **Only the creator can close, reopen, or delete a poll** - in every scope, including a club
   poll created by another admin.
8. A deadline is optional, chosen from presets (1 day / 3 days / 1 week) or a custom amount in
   minutes, hours, or days, computed from the moment of creation.
9. **Ten minutes before a poll's deadline, everyone who can access it is reminded - including
   the creator.** This fires **once per poll, ever**.
10. **Creating a poll notifies everyone who can access it except the creator**, and posts a
    votable card into the corresponding chat.
11. **A poll card in chat is fully votable inline**, identical to the full screen for
    multi-select, privacy, deadlines, and closed state. Actions the card cannot hold (the
    voter list, and the creator's close/reopen/delete) are reached via a "View Poll" link.
12. **Scope determines both audience and creation rights:**
    - **Club poll** - any club member votes; any club admin creates.
    - **Race poll** - only race roster members see or vote; creating requires being **both** a
      club admin **and** on the roster.
    - **Eboard poll** - only Eboard members see or vote; any Eboard member creates.
13. The list has an **ALL POLLS** tab and a **MY VOTES** tab (polls the viewer has voted in).
14. An open poll is a live card with a countdown when it has a deadline; a closed poll is
    visually muted and labelled CLOSED.
15. Polls appear in the calendar's events list, bucketed by **open/closed**, never by date.

**Out of scope.** Ranked or weighted voting. Editing a question or options after creation
(would invalidate cast votes). Adding options after creation, or write-ins. Fully anonymous
polls (the creator always sees voters on a private poll - someone must be accountable for
interpreting a sensitive vote). Quorum, thresholds, or automatic outcomes. Results export.

**Edge cases.** A poll with no votes shows zero counts and offers no voter-list control. A
passed deadline is treated as closed **everywhere**, without anyone having closed it.
Reopening preserves existing votes. A member who loses access (leaves the race, is demoted out
of Eboard) loses the poll from their view entirely.

---

### 4.10 Notifications

One cross-club inbox answering "what did I miss, and what needs me".

**Two kinds of row**

| | Discrete notification | Chat unread |
|---|---|---|
| What it is | A recorded event ("X created a poll") | A live count of unread messages in one chat |
| Where it comes from | Written when the event happens | **Computed on read, never stored** |
| Can it be wrong? | No - it is a record | No - it is derived from the messages themselves |
| How it clears | Opening the inbox (most types) | **Only by opening that chat** |
| After clearing | Stays in the feed as history | Replaced by a "caught up on N messages" history row |

**Notification catalogue**

| Type | Trigger | Audience | Links to | Clears when |
|---|---|---|---|---|
| **Club join request** | Someone requests to join a request-policy club | Every club Owner and Admin | The club's member roster | The roster is opened |
| **Race join request** | A club member requests to join a race | Every club Owner and Admin | That race's roster | The roster is opened |
| **Eboard join request** | An admin requests to join the Eboard space | Current Eboard members only | The Eboard roster | The roster is opened |
| **Request approved** | An admin approves any of the above (or a club switches to open) | The requester | The club/race/Eboard | Inbox is opened |
| **Request denied** | An admin denies any of the above | The requester | The club | Inbox is opened |
| **Member added** | An admin adds someone directly | The person added | That space | Inbox is opened |
| **Member removed** | An admin removes someone | The person removed | The club | Inbox is opened |
| **Role changed** | A member is promoted or demoted | The affected member | The club | Inbox is opened |
| **Poll created** | A poll is created in any scope | Everyone who can access it, except the creator | The poll | Inbox is opened |
| **Poll closing soon** | A poll is 10 minutes from its deadline | Everyone who can access it, **including the creator** | The poll | Inbox is opened |
| **Event created** | An admin creates a calendar event | Every other club member | The event | Inbox is opened |
| **Race created** | An admin creates a race | Every other club member | The race | Inbox is opened |
| **Meeting created** | An Eboard member creates a meeting | Other Eboard members | The meeting | Inbox is opened |
| **News post created** | An admin publishes a news post | Every other club member | The feed | Inbox is opened |
| **Announcement** | An admin posts an announcement in any chat | Everyone with access to that chat | That chat | Inbox is opened |
| **Mentioned** | Someone @mentions a member | The mentioned member, **only if they can access that chat** | That chat | Inbox is opened |
| **Car-group Incharge left** | A group's Incharge leaves or is removed | Every club Owner and Admin | That race's car groups | Inbox is opened |
| **Chat caught up** | A member opens a chat that had unread messages | That member only | That chat | Recorded already-read, as history |
| *(live)* **Chat unread** | Unread messages exist in an accessible chat | That member | That chat | **Only by opening that chat** |

**Behaviour rules**

1. The feed merges discrete notifications and live chat-unread rows into one
   reverse-chronological list, paginated as the user scrolls (~20 per page).
2. Opening the inbox marks the visible discrete notifications read and clears the badge -
   with two exceptions below.
3. **Chat-unread rows are never cleared by opening the inbox.** Only by opening that chat.
4. **The three pending join-request types are never cleared by opening the inbox either.**
   They clear only when the relevant roster screen is opened. **This is the "only clears once
   you actually look" rule**: a row representing work waiting on you must not be dismissed by
   a glance. (The founder lost real join requests this way.)
5. **A decided join request stays in the feed, tagged "Approved" or "Denied"**, rather than
   disappearing - the admin keeps a record of what they decided.
6. **Every row deep-links to its target.** Tapping is always safe: a row pointing at something
   the user has since lost access to fails gracefully rather than crashing.
7. Opening a chat with unread messages records a **"caught up on N messages"** row, so the
   history of having caught up survives even though the live count is gone.
8. The badge reflects unread discrete notifications plus **one per channel** with unread
   messages (never a per-message sum), and updates in realtime from anywhere in the app.
9. **Notification audience always respects access.** A race poll notifies only roster members;
   an Eboard meeting only Eboard members; an announcement in race chat only that roster; a
   mention only if the mentioned person can open that chat.
10. **Creation notifications exclude the actor.** You are never notified about something you
    just did - **except** the poll closing-soon reminder, which deliberately includes the
    creator, because they are exactly who needs to know it is about to close.
11. **Pinning never notifies. Announcing always does.**

**Not built:** push notifications, email/SMS, per-type or per-club preferences, muting,
grouping/collapsing. See [section 11](#11-known-gaps-and-what-the-remaster-should-fix).

---

### 4.11 Media, galleries, attachments

**Two classes of media, and the split matters.**

| Class | Examples | Visibility | Serving |
|---|---|---|---|
| **Identity** | User, club, race, and Eboard avatars | Public | Served directly from a stable stored URL |
| **Content** | Chat photos, chat documents, news-post photos | **Private** | Served through short-lived signed links, scoped to people who can read that chat/club |

**Rules**

1. **Chat photos and documents are never on public URLs.** A private Eboard channel's photos
   must not be readable by anyone holding a guessable URL. The read check must be the *same*
   membership check that protects the messages themselves.
2. **Avatar paths are stable and upserted** ("one avatar per owner"), so no old-file cleanup
   is needed. The stored URL is cache-busted, since the path never changes.
3. **Every chat has a Gallery**: every photo ever posted in that conversation, newest first,
   as a grid, tap-to-view full screen. It is read-only and adds no new authorization - it
   inherits the chat's own access rules. Club, race, and Eboard each have their own, reached
   from that space's profile screen.
4. **A photo enters a gallery only by being posted in chat.** There is no separate upload.
5. **Signed display URLs must be stable per device**, not minted per fetch. A URL that changes
   on every fetch guarantees a permanent cache miss at every layer (the signature rides in the
   query string, and the query string is part of every cache key). Memoize them, refresh
   ahead of expiry, and clear the memo on sign-out so a second account on a shared device
   cannot inherit URLs for media it may not be allowed to see. Render sites should pass an
   explicit cache key derived from the URL **without** its query string.
6. **Sign in batches, never per row.** One signing call per bucket per page, not one per
   message.
7. A document message shows filename and size; a photo message may carry a caption.

**Known gaps in the current build.** No storage cleanup at all (deleting a message, post,
club, race, or account leaves the object). No file size or MIME-type limits on any bucket. No
image resizing - full-resolution originals are uploaded and displayed. The gallery signs a
channel's entire photo history in one call and is unpaginated by design. Two devices still
hold different signed URLs for the same object, so N viewers is still N origin downloads.

---

## 5. Screen map and information architecture

Described as screens and entry points, not routes. The remaster may reshape navigation, but
every screen below has a job that must land somewhere.

### Top level

Four primary destinations: **Clubs**, **Calendar**, **Notifications**, **Profile**. The
Notifications destination carries an unread badge.

### Clubs

```
Clubs list  (empty state offers Create and Join)
├─ Create club        (name, sport, description, join policy)
├─ Join by code/link  (consumes an invite code; also the deep-link target)
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
   never surface a missing back control.
5. **A guarded screen must render a placeholder in its denied branch**, because the redirect
   lands a frame later.
6. **Cross-destination entry passes its origin explicitly** and the destination overrides its
   own back behaviour, because jumping across sibling stacks leaves no real history.
7. **Scope access is decided once, at the scope boundary**, not re-derived per screen. Screens
   below are thin, data-free wrappers.

---

## 6. Server-side event catalogue

Everything here must happen **automatically, server-side, regardless of which client or
screen triggered it**. Hooking the data change rather than the call site is what makes a chat
card appear whether the poll was created from the poll screen or the chat "+" menu.

### Bootstrap and membership sync

| When | What must happen |
|---|---|
| A user signs up | Their profile is created |
| A club is created | The creator is added as **Owner**, the main chat channel is created, and an Eboard space is created - **in that order**, since the Eboard's own setup reads the membership |
| A race is created | The race's channel is created **first**, then the creator is added to the roster (the reverse order silently swallows the first system message) |
| An Eboard space is created | Every club member in the admin tier is bulk-added as a member |
| A member's role changes | Entering the admin tier auto-joins the Eboard space; leaving it auto-removes them. An admin↔owner transition is a **no-op** |
| A member is removed from a club | Their car-group assignments, race rosters, and Eboard membership for that club are deleted - **all** races, not just upcoming ones |
| A club flips `request` → `open` | Every pending join request is auto-approved |
| A car-group member is removed | If they were the Incharge, clear it and notify the club's admins |
| A vote is cast or withdrawn | The option's public vote count is updated |

### System chat messages

Posted into the **club's main channel** (or the race's / Eboard's own channel where noted):

- "X joined the club" / "X was added by Y"
- "X left the club" / "X was removed by Y"
- Promotion / demotion / ownership transfer. **An ownership transfer posts one message, not
  two** - the outgoing owner→admin half is suppressed.
- Race member added → that race's channel
- Eboard member added → that Eboard's channel

### Chat cards for created objects

| Created | Card posted into |
|---|---|
| Poll | That poll's own scope channel (race → that race's; Eboard → that Eboard's; else club main) |
| Calendar event | Club main channel |
| Eboard meeting | That Eboard's channel |

Deleting the underlying object removes its card.

### Notification fan-out

Every notification in [4.10](#410-notifications) is written server-side, on the data change,
with its audience computed per the scope rules. Two audience rules have each been fixed
multiple times and are restated as invariants:

1. **Club-role audience filters must match both `admin` and `owner`.** A bare "admin" filter
   means a club whose only admin-tier member is the Owner gets nothing at all.
2. **Race audiences are roster members only, never roster ∪ club admins.** Since chat access
   itself requires a roster row, unioning in admins notifies people about a channel they
   cannot open.

Also: **an approval must not produce both "your request was approved" and "you were added".**
The approval path suppresses the membership-added notification for that transaction.

### The one scheduled job

**Poll closing-soon** is the only notification with no data change to hang on - nothing
changes when a deadline gets within 10 minutes. A job runs every minute, selects polls that
are open, have a deadline within the next 10 minutes, and have not been flagged yet, fans out
to the poll's full audience **including the creator**, and stamps them as notified so it fires
**at most once per poll, ever**.

Everything else about deadlines is computed live: "is this poll closed" is evaluated at read
time as `closed_manually OR deadline_passed`. **There is no job that closes polls.**

---

## 7. Authorization requirements

The current build has **no application server**: the client talks to the database directly and
row-level security is the only access control that exists. A different architecture may put
this in a service layer instead. What must not change is the guarantee.

### The guarantee

> **Every read and every write is access-checked on the server, not in the UI.** Client-side
> gates (hidden buttons, `isAdmin` props) are UX, never enforcement. A member who types a URL
> for a race chat, an Eboard poll, or another club's roster gets **nothing back**.

### Rules that must hold in any architecture

1. **Every authorization check is centralised and reused, never re-derived inline per query.**
   The current build has a catalogue of membership/admin predicates (`is_club_member`,
   `is_club_admin`, `is_club_owner`, `is_channel_member`, `is_channel_admin`,
   `is_race_member`, `is_race_admin`, `is_eboard_member`, `can_access_poll`, plus poll
   creator/private/closed helpers). Whatever the stack, that list is the vocabulary.
2. **Multi-step flows are atomic and re-check authorization themselves.** Approving a join
   request updates the request **and** creates the membership row in one transaction, and
   re-checks the approver's authority in its own body.
3. **Decision endpoints are idempotent.** Two admins hitting Approve on the same request must
   produce one membership, one notification, and one recorded decider.
4. **A write that reads its own result back must also pass the read check.** If creating a row
   returns it, the read policy has to cover "I am the one who just created this," and that
   check should be bound to the row's own columns. *(current-stack detail: this exact trap
   produced this repo's longest debugging session, and creating a club is still only possible
   because the read rule includes an explicit "or I created it" clause.)*
5. **A read rule must never route through a helper that re-queries the same table by id.**
   Write the branch inline on the row's own columns.
6. **Column-level authority needs its own enforcement.** A rule that says "the sender or an
   admin may update this message" legitimately carries body edits and soft-deletes, so it
   cannot also gate the `pinned` and `message_type` columns. A separate before-write check
   rejects any change to those columns by a non-admin. **Without it, any member could pin
   their own message and retro-flip it into an announcement.** (This was a real, shipped
   defect, now closed.)
7. **Membership rows are the sole source of truth for access.** Never substitute an admin
   check for a roster row. This has been wrong in five separate places.
8. **The Owner role can only be written by the ownership-transfer path**, which **demotes the
   outgoing owner before promoting the new one** (the one-owner constraint is checked per
   statement, so the other order momentarily holds two owners and fails).
9. **Notifications have no client-writable path.**
10. **Cascade deletes must not be blocked by child-level permission rules.** Deleting a club
    really does remove the Owner's own membership row, even though nothing may delete it
    directly.
11. **Vote privacy is row-level; vote counts are not.** Counts must live somewhere every
    eligible viewer can read, because a rule that hides the voter rows also hides the count.
12. **Rate limiting belongs in the write path.** Message sends are throttled by a token bucket
    (burst 30, refill 1/sec per sender) enforced before the insert, returning a 429-equivalent.
    Still unthrottled: reports, reactions, join requests. Volumetric DDoS is deliberately out
    of scope for the application tier.
13. **Account deletion anonymises and blocks future sign-in.** Blocking a user does **not**
    invalidate an already-issued access token, so the client must sign out immediately after.

### New-surface checklist

For any new table/resource: enable enforcement → write the **read** rule first → write the
**create** rule so it implies the read rule → decide explicitly whether writes are
**any-admin** (news posts, races, routines, events, Meet Information) or **creator-only**
(meetings, polls) → **write the delete rule in the same change** (three tables shipped
without one) → prove the forbidden case is actually blocked by impersonating a
non-privileged user, not by reading the code.

---

## 8. Cross-cutting UX rules

These are product requirements, not polish. Several were shipped bugs first.

### Loading, errors, empties

1. **Every data-loading screen has three states**: loading, loaded, and a **standard inline
   load-error with a retry**. No screen may fail to a blank page.
2. **Every list has a designed empty state**, and it tells the truth ("No events yet", "No
   upcoming races yet", "No events across your clubs yet"), never a bare blank.
3. **A user who lands somewhere they lack permission is redirected**, never shown a broken
   screen.
4. **Realtime is an enhancement, not a requirement.** Every screen also loads its data
   directly, so a dropped connection degrades to stale-until-refresh rather than broken.

### Destructive actions

5. **Every destructive action is confirmation-gated on every platform**, and the confirmation
   **names the thing** being destroyed and states what is lost.
6. *(current-stack detail, but the lesson generalises)* The native alert API is a **total
   no-op on web**, so a delete button reported success, logged nothing, and did nothing.
   **Verify destructive actions actually changed the data, on every platform.**

### Privacy

7. Profiles are visible only to people who share a club with the viewer.
8. Personal data collected is deliberately minimal: email, name, and optional bio, city, date
   of birth, school.
9. **No analytics, tracking, or third-party data sharing.**
10. **No personal data in a shareable link.** The join link carries only an opaque club invite
    token.

### Performance expectations

| Concern | Expectation |
|---|---|
| Chat history | Never load an entire conversation. ~40 most recent, page backward |
| Notifications | Paginated, ~20 per page |
| Photos/documents | Never inlined in the payload; referenced and fetched separately |
| News feed, races list, rosters | Small enough to load whole (currently unpaginated) |
| Unread counts | **Computed, never stored** - a stored count drifts, a computed one cannot |
| Merged cross-club calendar | One read per feature per club; **the least scalable read in the product** |
| Deadline reminders | Fire within a minute of their window |

**Rule: no screen may block on an unbounded read.**

### Offline

The current build is **online-only**: no cache, no queued sends, no optimistic send. Sending
offline fails **visibly**. This is a known limitation, not a decision - a club coordinating at
a race venue with poor signal is exactly the failure case. See section 11.

### Accessibility

**No accessibility work has been done. This is the product's clearest gap.** Zero
accessibility labels exist; every icon-only control (attach button, pin and announce toggles,
per-message overflow, race pin control, jump-to-latest) is effectively invisible to a screen
reader. Contrast, dynamic type, touch-target sizes, and reduced motion are all unverified.
**The remaster should not repeat this** - see section 11.

### Verification standard

- **Pixel perfection is the standard.** Misaligned rows, inconsistent spacing, a header that
  jumps, a colour off-token, a control a few pixels from where it belongs - all defects worth
  fixing when seen.
- **Reproduce a bug end-to-end before fixing it**, through the running app, on the relevant
  platform, with realistic data. A fix never preceded by a reproduction is a guess, and this
  project's history contains several confident guesses that were wrong.
- **A failing or flaky test and a type error get fixed when seen**, whether or not the current
  change caused them.

---

## 9. Design system

The current visual language is a Material-3-shaped token set called the "Kinetic Performance
System". The remaster may restyle, but these structural rules should survive.

### Structural rules

1. **One flat token module** - colours, radii, spacing, typography - imported directly.
   **Never hardcode a colour, radius, or font size a token covers.**
2. **One accent colour app-wide.** No screen introduces its own.
3. **Typography roles are spread, not copied** - each role is a complete family/size/
   line-height triple.
4. **The whole app is gated on fonts being loaded**, so no screen ever flashes system fonts.
5. **Shared screens, not forked copies.** Chat, Highlights, Polls, Calendar, Events, Members,
   and Gallery are each **one** implementation reused by club, race, and Eboard, so a fix
   lands everywhere at once.
6. **Consistent headers** across every club-scoped screen, including a working back control
   on screens reached by deep link.

### Current tokens (for reference)

| Category | Values |
|---|---|
| Accent | `#ff4d00` "Energetic Orange" - every accent: header titles, FABs, active tab, links, back arrows, pins, primary buttons |
| Surfaces | App background `#f7f9fb`; cards `#ffffff`; **every header and the tab bar** `#f2f4f6`; dividers/fallbacks in the `#ecee…`-`#e0e3…` ramp |
| Text | Primary `#191c1e`; secondary/muted `#5c4037` |
| Semantic | Secondary/poll badges `#565e74` family; practice/tertiary `#005daa` family; error and the notification badge `#ba1a1a` family |
| Radii | 4 / 8 (default) / 12 / 16 / 24 / pill. Avatars use an explicit half-width radius |
| Spacing | 4 micro / 16 gutter and screen padding / 8 tight stack / 24 section / 48 empty-state top |
| Type | Anton for display and **every header title**; Archivo Narrow for body and numeric emphasis; Inter SemiBold, uppercase, letterspaced, for labels/badges/buttons |

### Signature treatments

- **Glass-blur headers** on chat and Highlights (they opt out of the native header and render
  their own), plus the floating pinned strip. Consequence: the list needs manual top padding
  computed from header height + safe-area inset + pinned-strip height, and the back control is
  reimplemented inline - which is exactly why every such component takes an explicit
  back-fallback.
- **Gradient fill on sent message bubbles**, isolated in a container component so the list's
  row renderer never switches element types between sent and received.
- **Chat hides the bottom tab bar** while open.

**Light mode only** today; there is no dark palette. The token module is a flat named export
specifically so a dark variant can be swapped in without touching call sites.

---

## 10. Hard-won lessons to carry into the remaster

Every entry here cost at least one long debugging session. They are ordered by how much time
they cost.

### Data and authorization

1. **A create-and-return needs a read rule that covers the row you just created.** Otherwise
   the write succeeds and the read-back fails with a misleading permission error. Bind the
   check to the row's own columns.
2. **A read rule must never call a helper that re-queries the same table by id** - it
   recurses into its own policy. Write the branch inline.
3. **"Admin" checks must include the Owner.** This exact mistake shipped **four** times after
   the Owner tier was added, and a fifth instance was found later in a helper.
4. **Row-level rules cannot do column-level authority.** Pin and announcement-type changes
   needed a separate before-write check; a policy split would have cost the sender their
   legitimate edit and delete rights.
5. **A membership row is the only proof of access.** "Can read the roster" is not "is a
   member" - the current build must check membership explicitly, because reading the Eboard
   roster is club-admin-wide while being in it is not.
6. **Enum/type literals inside a `DISTINCT`/`UNION` audience query need an explicit cast**
   *(current-stack detail)*, or the whole statement aborts. This broke race announcements
   twice.
7. **Ordering matters in bootstrap triggers.** Create the channel before adding the first
   member, or the first system message is silently swallowed. Demote before promoting on
   ownership transfer, or the one-owner constraint fires.
8. **Storing a route string on a notification means every function that matches on that route
   must be updated together.** Changing one literal left approvals permanently unresolved for
   eight migrations.

### Lists and scrolling

9. **A list's "reached the start" callback fires at mount**, and "content size changed" fires
   far more often than the content actually changes. Treat both as suspect on the first
   render, or chat pages backward the instant it opens.
10. **Landing on a specific message must not visibly scroll.** The user should open chat
    already positioned on their first unread message, not watch it fly there.
11. **A jump target that is only measured after layout lands short on the first tap.** Verify
    the second tap and the first tap behave identically.
12. **A new realtime message must not yank the view** when the user is reading history.

### Navigation

13. **A back control that only renders when history exists is a bug.** Direct URL entry and
    page refresh leave no history on *any* screen, not just stack roots. Every screen declares
    an explicit fallback parent.
14. **Never pop history unguarded** - it throws when there is nothing to pop.
15. **"Pop to a route" only works within the current stack's ancestry**; across sibling
    destinations it silently does nothing. Use a replace instead.
16. **Replacing the top entry does not reduce stack depth**, so a spurious back button remains
    on what looks like a root.
17. **A "hang" with no console errors and no network activity is navigation logic**, not a
    stuck client. That misdiagnosis has been made twice here.
18. **A redirect-on-mount pair can loop.** Chat-as-home means a chat's back-fallback must
    never be its own hub.

### Platform

19. **A brand-new cross-platform API working on one OS is not evidence it works on the
    other.** A file-upload fix confirmed on iOS reproduced the identical crash on Android.
    Prefer the older documented path on any hot path.
20. **A synthetic click is not user activation.** Library web shims that dispatch a synthetic
    click to open a file dialog silently fail under some browser configurations while the
    handler still runs, so nothing looks wrong. Build a real input and call a real click.
21. **A date-only value parsed as an ISO string is UTC midnight**, and renders a day early in
    negative-offset timezones. Build dates from split components.
22. **Confirm dialogs, file pickers, camera, clipboard, and sharing all behave differently per
    platform.** Verify each on each.

### Realtime

23. **A subscription topic derived only from stable ids will collide on remount** and throw,
    because teardown is asynchronous and a same-topic subscribe returns the still-joined
    channel. Include a fresh per-call component in every topic.
24. **Do not diff realtime payloads into local state.** Every subscription callback should
    just say "something changed" and trigger a refetch; merge-by-id refetch is far less
    error-prone than reconciling insert/update/delete events against a paginated list.
25. **Realtime delivery is not guaranteed and has no replay after a disconnect.** A phone that
    backgrounds and resumes can permanently miss messages with no error and no indication.
    **The remaster must reconcile on reconnect and on app foreground**, not just on mount.
26. **Never subscribe to everything.** Unfiltered subscriptions mean every user receives every
    row in the project, and the cost is per-subscriber authorization plus a full refetch each.
    Every subscription must carry a filter, or be replaced by a cheaper signal.

### Process

27. **Reproduce before fixing.** Read-and-reason fixes in this repo's history were repeatedly
    wrong.
28. **Verify a permission by impersonating the unprivileged user and watching the write get
    rejected**, not by reading the rule.
29. **A migration is never edited after being applied.** A correction is always a new one.

---

## 11. Known gaps and what the remaster should fix

### Blocking a real release today

| Gap | Impact | Note for the remaster |
|---|---|---|
| **Push notifications** | A member learns nothing until they open the app. The single biggest functional gap | Everything a push payload needs already exists: each notification carries a fully rendered body and a target route. What is missing is a device-token registry and a delivery path. **Build this into the notification fan-out from day one.** |
| **Legal review** of Privacy Policy and Terms | The shipped documents are an in-house first draft, explicitly not legal advice | Must happen before any public release |
| **iOS distribution** | Blocked on paid developer-program enrolment | Not a code problem |
| **Error monitoring** | A crash or failed load in real use is **invisible** | Today errors are shown to the user and dropped on the floor. Wire a reporting service in the error path from the start |

### Important, not blocking

| Gap | What "fixed" looks like |
|---|---|
| **Accessibility** | Every interactive control labelled, screen-reader navigable, contrast verified against WCAG AA, dynamic type supported, reduced motion respected. Start with the icon-only controls |
| **Offline** | At minimum read-only cached chat; ideally a send outbox with optimistic messages. A club at a race venue with poor signal is the real failure case |
| **Test coverage** | Today: date/formatting and calendar-feed logic only. **The permission matrix is verified by hand.** The remaster should have automated permission tests |
| **Muting and notification preferences** | Everything fans out to everyone eligible, with no member control |
| **Block or mute between members** | No member-level safety tool exists. Notable for a product that will include minors |
| **Over-the-air updates** | Every fix currently needs a full store release |

### Architectural debt worth designing away

These are recorded remediation items in the current build. A remaster gets them for free if
designed in.

1. **Realtime reconciliation on reconnect and foreground** (see lesson 25).
2. **Filtered subscriptions** (lesson 26). Today three subscriptions are project-wide; with
   200 concurrent users, one message insert costs ~200 authorizations, ~200 billed messages,
   and ~200 full refetches.
3. **Message sequence numbers** - a monotonic per-channel ordinal, so ordering, paging, and
   "have I seen everything up to N" do not depend on timestamps.
4. **Client-generated idempotency keys on sends**, so a retry after a flaky network cannot
   double-post.
5. **Denormalized and capped unread counts**, and a collapsed calendar feed. The cross-club
   merged calendar currently reads once per feature **per club the user belongs to**.
6. **Highlights must not silently lose pins past the loaded window.** Today the pinned and
   announcement lists are computed over a bounded slice of history.
7. **Media cost.** Signed URLs are memoized per device, which fixed the repeat-fetch
   multiplier, but two devices still hold different URLs for the same object, so N viewers is
   still N origin downloads. A CDN-friendly scheme (stable URLs plus an authorization gate, or
   a transformation layer) belongs in the design, not bolted on.
8. **Storage cleanup.** Nothing is ever deleted from object storage today.
9. **File size and MIME-type limits.** Currently unset everywhere; a member can upload an
   arbitrarily large "document", and documents are never scanned or type-restricted.
10. **Notification retention.** The table grows unbounded, with no archival path.
11. **Localisation.** Notification bodies are built server-side in English and are
    unlocalizable and untestable from the client.
12. **Rate limiting beyond messages** - reports, reactions, and join requests are still
    unthrottled.
13. **Backups and version parity** between development and production data stores.

### Deliberately deferred (do not "fix")

Race-specific workout plans (in the original vision, never built; may have been absorbed by
Meet Information - needs a product call). Bidirectional chat paging. Message search. Comments
on news posts. Recurring events. External calendar sync. RSVP or attendance, anywhere.

### Open product questions

- **Hub placement:** Routines, Polls, and the Events list are fully reachable from club chat's
  header quick-nav, and work normally there. Whether they should *also* sit on the club hub is
  unresolved. A stopgap "More" menu on the hub was explicitly rejected.
- Should a club (or a finished race) be **archivable** - read-only history preserved - rather
  than only deletable?
- Should the calendar's `race` event **type be removed**, given it has no relationship to a
  real Race and reads as if it does?
- Is **"Eboard & Council"** the right default name for every club, or should it be
  configurable?
- Should **"News & Highlights"** be renamed, given chat's own "Highlights" is easy to confuse
  with it?
- Should the **join link be revocable or rotatable** if it leaks?
- Should ownership transfer **require the recipient to accept**?
- Should an admin other than a poll's creator be able to close a poll whose creator has left?
- Do clubs including **minors** need age gating, parental consent, or restricted profile
  fields? Is a **data-retention policy** needed? Should a user be able to **export their own
  data** before deleting?

---

## 12. Parity acceptance checklist

A remaster is at parity when every line below passes on **iOS, Android, and web**.

### Accounts

- [ ] Sign up, sign in, session persists across restarts, sign out clears it.
- [ ] Signed-out access to any in-app route lands on sign-in, then continues to the target.
- [ ] Privacy Policy and Terms readable both signed out and signed in.
- [ ] Profile fields save and appear in chat and rosters; nobody can edit another's profile.
- [ ] Account deletion is confirmation-gated, blocks future sign-in, and leaves past messages
      in place, unattributed.
- [ ] A hung auth check falls back to signed-out rather than hanging on a spinner.

### Clubs

- [ ] Create → Owner, working main chat, and an Eboard space with the Owner in it.
- [ ] Open club joins in one tap; request club files a request and shows "Requested".
- [ ] Switching request → open admits everyone pending.
- [ ] The invite link joins instantly even on a request club, and is idempotent.
- [ ] Promote/demote announced in chat; Owner-only admin removal; ownership transfer leaves
      exactly one Owner.
- [ ] Leaving cascades out of every race, car group, and the Eboard space.
- [ ] Deleting a club removes it from every member's list.

### Chat (verify in all three scopes)

- [ ] Realtime delivery without refresh; **and** no message is missing after backgrounding the
      app for 60 seconds and returning.
- [ ] Photos and documents round-trip; documents show filename and size.
- [ ] Reactions toggle; mentions notify and render highlighted; autocomplete lists only people
      who can access that chat.
- [ ] Members cannot pin or announce - **verified by attempting the write directly, not by the
      button being hidden**.
- [ ] Pinned strip appears, dismisses locally, and its notice jumps to the message on the
      **first** tap.
- [ ] Chat opens on the first unread message with no visible scrolling; jump-to-latest appears
      and disappears correctly.
- [ ] Scroll-up paging works and does not fire on open.
- [ ] Soft delete leaves a tombstone; reporting twice is a no-op; reports reach only admins.
- [ ] Poll/event/meeting cards post automatically and disappear when the object is deleted.
- [ ] Gallery contains every photo posted in that chat.

### Races

- [ ] Create with name and date; visible to every club member.
- [ ] A no-access member sees the preview (name, date, Meet Information) and can request.
- [ ] **An admin who is not on the roster cannot open race chat or race polls and cannot be
      assigned to a car group**, but can manage the roster and edit Meet Information.
- [ ] A race member entering the race lands in race chat.
- [ ] Meet Information saves as one form; empty description/location/hotel hidden; empty
      photos/results show the placeholder.
- [ ] Car groups auto-number; one group per person; Incharge limited to that group's members;
      Incharge leaving clears it and notifies admins; a plain member leaving notifies nobody.
- [ ] Race pins affect only the pinner's own hub.

### Eboard

- [ ] Auto-created with the club, Owner inside.
- [ ] Promotion auto-joins; demotion auto-removes; ownership transfer changes nothing.
- [ ] Ordinary members have no visibility and are redirected off its routes.
- [ ] Only existing members approve requests or add admins; only the Owner removes a member.
- [ ] Any member creates meetings and polls; only the creator edits or deletes a meeting.
- [ ] Meetings appear on the calendar of members only.

### Polls

- [ ] 2 options and 10 options both allowed; 1 rejected; an 11th cannot be added.
- [ ] Counts visible on public and private polls; voter list gated by privacy; a voter always
      sees their own vote.
- [ ] Single-choice moves the vote; multi-select adds; tapping the current option withdraws;
      opening the voter list casts nothing.
- [ ] A passed deadline reads as CLOSED everywhere with nobody having closed it; reopening
      preserves votes.
- [ ] Close/reopen/delete offered only to the creator, including to admins who did not create
      it.
- [ ] Closing-soon reminder fires once, 10 minutes out, to everyone **including** the creator.
- [ ] A race poll is invisible to an admin without a roster row, **including by direct URL**.

### Calendar and routines

- [ ] The grid marks exactly the days with an event, race, or meeting, and no filler days.
- [ ] Paging months does not change the grid's height.
- [ ] The list merges events, races, meetings, and polls into Upcoming/Past.
- [ ] An open, deadline-less poll never falls into Past.
- [ ] Eboard meetings are absent from a non-member's calendar; races are visible to everyone.
- [ ] The merged cross-club feed tags each row with its club and offers no create action.
- [ ] The routines week shows Monday-Sunday, hides past days on the current week, and says
      "Rest day" where nothing is scheduled.
- [ ] Any admin can edit any workout; creating one notifies nobody and posts nothing.

### Notifications

- [ ] One feed across every club, merging discrete rows and live chat-unread rows.
- [ ] Opening the inbox clears the badge but **not** chat-unread rows and **not** pending
      join-request rows.
- [ ] Opening the relevant roster clears its join-request rows.
- [ ] Opening a chat clears its unread row and leaves a "caught up on N messages" row.
- [ ] A decided request stays, tagged Approved or Denied.
- [ ] Every row navigates to its target, and fails gracefully if access was lost.
- [ ] Audiences respect access in every scope; creators are excluded from their own creation
      notifications.
- [ ] Pinning notifies nobody; announcing notifies everyone in that chat.

### Cross-cutting

- [ ] No screen fails to a blank page; every load has loading, loaded, and retryable-error.
- [ ] Every destructive action is confirmation-gated on all three platforms **and the data
      actually changed**.
- [ ] Direct URL access to any unauthorized screen redirects rather than exposing data.
- [ ] Every screen reached by deep link or refresh can navigate back out.
- [ ] Private media is never reachable by a public URL.
- [ ] Chat and notifications page rather than loading everything.

---

*End of brief. If something here conflicts with a running implementation, the implementation
is the fact and this document is the bug - fix it here in the same change.*
