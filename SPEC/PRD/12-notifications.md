# Notifications

One cross-club inbox answering "what did I miss, and what needs me".

**How a row is stored.** A notification records its **type and the structured parameters
its text and destination are rendered from** - not a finished sentence and not a route. The
wording and the target are produced when the row is read. That keeps the text localisable
without rewriting history, and it means changing where a notification points is one mapping
function rather than a migration over every row ever sent. See
[ADR-0013](../decisions/0013-notifications-store-type-and-params.md). The "Links to" column
below therefore describes a destination, not a stored string.

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
| **Race join request** | A club member requests to join a race | Every Owner and Admin **on that race's roster** | That race's roster | The roster is opened |
| **Eboard join request** | An admin requests to join the Eboard space | Current Eboard members only | The Eboard roster | The roster is opened |
| **Request approved** | An admin approves any of the above (or a club switches to open) | The requester | The club/race/Eboard | Inbox is opened |
| **Request denied** | An admin denies any of the above | The requester | The club | Inbox is opened |
| **Member added** | An admin adds someone directly | The person added | That space | Inbox is opened |
| **Member removed** | An admin removes someone from a club, a race roster or the Eboard | The person removed | The club | Inbox is opened |
| **Role changed** | A member is promoted or demoted | The affected member | The club | Inbox is opened |
| **Poll created** | A poll is created in any scope | Everyone who can access it, except the creator | The poll | Inbox is opened |
| **Poll closing soon** | A poll is 10 minutes from its deadline | Everyone who can access it, **including the creator** | The poll | Inbox is opened |
| **Event created** | An admin creates a calendar event | Every other club member | The event | Inbox is opened |
| **Race created** | An admin creates a race | Every other club member | The race | Inbox is opened |
| **Meeting created** | An Eboard member creates a meeting | Other Eboard members | The meeting | Inbox is opened |
| **News post created** | An admin publishes a news post | Every other club member | The feed | Inbox is opened |
| **Announcement** | An admin posts an announcement in any chat | Everyone with access to that chat | That chat | Inbox is opened |
| **Mentioned** | Someone @mentions a member | The mentioned member, **only if they can access that chat** | That chat | Inbox is opened |
| **Message reported** | A member reports a message | **Whoever reviews reports in that channel**: club admins; race admins **on that roster**; platform moderators for a DM. Never the reporter. **Eboard has no reporting**, so it never produces one | The Reports tab for that channel, or the platform queue | Inbox is opened |
| **Car-group Incharge left** | A group's Incharge leaves or is removed | Every Owner and Admin **on that race's roster** | That race's car groups | Inbox is opened |
| **Chat caught up** | A member opens a chat that had unread messages | That member only | That chat | Recorded already-read, as history |
| *(push only)* **Direct message** | Somebody sends a direct message | The other participant | That conversation | **Never a row.** Its inbox representation is the chat-unread row below |
| *(live)* **Chat unread** | Unread messages exist in an accessible chat | That member | That chat | **Only by opening that chat** |

**The direct-message row is the one exception to the two-kinds table above**, and it is worth
being precise about. In club, race and Eboard chat an ordinary message notifies nobody: it is
addressed to a room, and the room's unread count is the right granularity. A DM is the one scope
where an ordinary message is inherently addressed to **one person**, so it buzzes - and muting a
conversation would otherwise be a control over nothing. It still writes no row, because a row per
message would flood the feed with exactly the per-message noise rule 8 rejects. See
[ADR-0015](../decisions/0015-a-direct-message-pushes-without-an-inbox-row.md).

**Behaviour rules**

1. The feed merges discrete notifications and live chat-unread rows into one
   reverse-chronological list, paginated as the user scrolls (~20 per page).
2. Opening the inbox marks the visible discrete notifications read and clears the badge -
   with two exceptions below.

   2a. **The marking happens on LEAVING the screen, not on arriving at it.** Rows stay in their
   unread state for the whole visit and are read the *next* time the inbox is opened. Marking on
   arrival flips every row before the reader can perceive that any of them were new, which
   defeats the entire purpose of having an unread state - the inbox would always look uniformly
   read, no matter what had just happened.

   2b. **Unread is a whole-row treatment, not a corner badge.** An unread row is tinted, with an
   accent-filled icon well, full-strength body text and a dot; a read row is a plain card with a
   neutral well and secondary text. It has to be legible at a glance down a long list, which a
   small badge on the right is not.

3. **Chat-unread rows are never cleared by opening the inbox.** Only by opening that chat.

   3a. **So a chat-unread row is always drawn unread**, and its count never comes down by
   looking at this list. It exists in the feed only while the count is above zero. Glancing at
   an inbox is not reading 48 messages, and a row that dimmed itself on sight would be claiming
   it was.
4. **The three pending join-request types are never cleared by opening the inbox either.**
   They clear only when the relevant roster screen is opened. **This is the "only clears once
   you actually look" rule**: a row representing work waiting on you must not be dismissed by
   a glance. (The founder lost real join requests this way.)
5. **A decided join request stays in the feed, tagged "Approved" or "Denied"**, rather than
   disappearing - the admin keeps a record of what they decided.

   5a. **Deciding settles the row in EVERY admin's inbox, not only the decider's.** A request
   is sent to everyone who could act on it and exactly one of them acts; the other copies are
   then describing work that no longer exists. Each one is restated to name the outcome and
   who reached it ("Sarah approved Mike's request to join Fall Classic") and marked read, so
   it stops counting against the badge. Without this, rule 4 keeps every other admin's row
   unread until they each open that roster themselves, and an admin who was away meets a job
   that was done hours ago.

   5b. **Restated, not deleted.** The record is the point: an admin who remembers seeing
   requests and finds an empty inbox cannot tell "handled" from "lost", which is the same
   ambiguity rule 4 exists to prevent. Naming the decider answers the question they actually
   have, which is not "was this dealt with" but "who dealt with it".
6. **Every row deep-links to its target.** Tapping is always safe: a row pointing at something
   the user has since lost access to fails gracefully rather than crashing.

   6a. **A membership row names the space it is about, not the club around it.** "Sarah removed
   you from Fall Classic", never "from Hillside Running Club" - being taken off one race roster
   leaves the club membership, the club chat and every other race in it untouched, and naming
   the club instead reads as though all of it was lost. It is a false alarm about the one thing
   the reader would most want to be told accurately. The row still points at the **club**,
   because the space it names is precisely what the reader can no longer open.
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
12. **Muting a conversation silences its push and nothing else.** The unread count still accrues
    and the badge still counts the conversation. Mute is not "mark as read" - conflating the two
    would silently mark things read that nobody looked at. Muting applies to **every** scope, not
    only to DMs.

**Built since:** push notifications (Phase 1) and per-conversation muting (Phase 3.5).

**Not built:** email/SMS, per-type or per-club preferences, grouping/collapsing. See
[Roadmap and open questions](17-roadmap-and-open-questions.md).
