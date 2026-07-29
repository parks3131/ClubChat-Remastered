# Notifications

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
