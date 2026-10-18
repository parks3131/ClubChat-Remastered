# 3. The tools

Thirteen tools. All read-only, all marked with the MCP `readOnlyHint` annotation, and each one a
thin call into a function a REST route already uses. **If a tool needs logic the route does not
have, that logic belongs in `domain/`, shared by both, never in the tool.**

## 3.1 Rules every tool follows

- **Acts as the caller.** The `AccessContext` comes from the token's user, never from a tool
  argument. No tool takes a user id.
- **One id per call, owning scope resolved on the server.** A tool takes a `chatId` or a `clubId`,
  never both for one thing. Where an owning club is needed, resolve it with `domain/scopes.ts`
  (AGENTS.md 2.2).
- **Ids are canonicalised.** Lower-case every uuid argument before use (failure mode 36). Reject a
  malformed one as "not found", like the API's uuid hook.
- **"Not found" and "not allowed" are the same answer**, as everywhere in this API: "I couldn't find
  that, or you don't have access to it."
- **Answers are written to be spoken.** Names, not ids, in the text. Times in plain words. Every
  answer also carries `structuredContent` with the ids Claude needs for its next call.
- **Dates are handled as the calendar handles them.** A feed item's `at` is either an instant or a
  date-only `YYYY-MM-DD`, told apart by `allDay`. Never parse a date-only value with `new Date()`
  (AGENTS.md section 4: it renders a day early west of UTC).
- **Bounded.** Every list has a default and a ceiling, so an answer arrives in seconds.
- **Nothing is marked read.** No tool calls the read-cursor or notification-read paths.
- **Chat text is labelled as member content** in the output, so the model treats it as quoted data
  rather than instructions (see [`04-security-and-privacy.md`](04-security-and-privacy.md)).

Inputs are zod schemas. The descriptions below are what Claude reads to choose a tool, so keep them
in plain words.

## 3.2 The list

### `list_my_clubs`
- **Claude reads:** "The clubs the member belongs to, with their role in each. Call this first to
  turn a club name the member says into a clubId."
- **Input:** none.
- **Calls:** `listClubsForUser(db, userId)` (`domain/reads.ts`).
- **Returns:** `[{ clubId, name, role }]`.

### `list_chats`
- **Claude reads:** "The member's chats with unread counts and the last message. Optionally only
  one club's chats."
- **Input:** `{ clubId?: uuid }`.
- **Calls:** `listConversations(db, ctx)` (`domain/reads.ts`), filtered by `clubId` when given.
  **Not** `listAccessibleChannels`: that is sync state for the client and "deliberately nothing a
  person reads" (`api/routes/chat.ts`).
- **Returns:** `[{ chatId, name, kind, unread, muted, lastMessage }]`, where `kind` is the
  channel scope.

### `whats_new`
- **Claude reads:** "What the member has not read yet, across all their chats."
- **Input:** `{ perChat?: 1..10 = 5 }`.
- **Calls:** `listConversations` for chats with `unread > 0`, then `readHistory(db, ctx, chatId,
  { limit })` for each, newest chats first, at most 8 chats.
- **Returns:** per chat, its name, the unread count, and the newest few messages. Says so when there
  were more than it read.

### `read_messages`
- **Claude reads:** "Recent messages from one chat: a club chat, a race or e-board chat, or a
  direct message."
- **Input:** `{ chatId: uuid, count?: 1..30 = 10, before?: seq }`.
- **Calls:** the channel authorization (`authorizeChannels`, refactored to take a context; it
  checks `isChannelMember`), then `readHistory`. `readHistory` writes nothing.
- **Returns:** messages oldest to newest: sender name, time, text, the quoted message for a reply,
  and `[photo]` or `[file]` for media. Never a media URL.

### `list_direct_messages`
- **Claude reads:** "The member's direct-message conversations, with who they are with and unread
  counts."
- **Input:** none.
- **Calls:** `listConversations` filtered to scope `dm`. Cross-check against `listDmThreads`
  (`domain/dm.ts`) and use whichever the DM screen treats as truth for blocked conversations.
- **Returns:** `[{ chatId, withName, unread, lastMessage }]`.

### `my_calendar`
- **Claude reads:** "The member's events, meetups, meetings and races across their clubs, upcoming
  or past."
- **Input:** `{ when?: 'upcoming' | 'past' = 'upcoming', clubId?: uuid, limit?: 1..30 = 15 }`.
- **Calls:** `readCalendarFeed(db, ctx, { clubId })` (`domain/calendar.ts`), then the same filter and
  sort `GET /calendar` applies. **Extract that filter-and-sort from `api/routes/calendar.ts` into a
  shared function first**, so the route and the tool cannot drift.
- **Returns:** `[{ kind, id, clubName, title, at, allDay, timeOfDay }]`. `kind` is one of `event`,
  `race`, `meeting`, `meetup`, which `event_details` takes.

### `event_details`
- **Claude reads:** "Everything about one calendar item: when, where, what."
- **Input:** `{ kind: 'event' | 'meetup' | 'meeting' | 'race', id: uuid }`.
- **Calls:** `readEvent`, `readMeetup` (`domain/content.ts`), `readMeeting` (the function behind
  `GET /meetings/:id`), or for `race` the same reads as `race_details`.
- **Returns:** title, club, time, place name and map link if any, description.

### `my_notifications`
- **Claude reads:** "The member's notifications: mentions, join requests, decisions, and so on."
- **Input:** `{ limit?: 1..30 = 10 }`.
- **Calls:** `readInbox(db, userId, { limit })` (`domain/inbox.ts`). Turn each row into text with
  `renderNotification` from `@clubchat/shared`, which push already uses, so the wording matches.
- **Returns:** text, time, and whether it is unread. Does not mark anything read.

### `pinned`
- **Claude reads:** "Pinned messages or announcements in one chat."
- **Input:** `{ chatId: uuid, kind?: 'pinned' | 'announcements' = 'pinned' }`.
- **Calls:** channel authorization, then `readHighlights(db, ctx, chatId, kind)`.

### `club_news`
- **Claude reads:** "A club's latest news posts."
- **Input:** `{ clubId: uuid, limit?: 1..10 = 5 }`.
- **Calls:** `readNewsFeed(db, ctx, clubId, { limit })`. Refuses a club the member cannot read.

### `open_polls`
- **Claude reads:** "A club's polls and how the votes stand."
- **Input:** `{ clubId: uuid }`.
- **Calls:** `listPolls`, the function behind `GET /clubs/:id/polls`, then `readPolls` for the
  details. Voter identity follows `readPoll`'s own privacy rules: counts always, names only where
  the app shows them.

### `race_details`
- **Claude reads:** "One race or meet: when, where, the roster, and the car groups with their
  drivers."
- **Input:** `{ raceId: uuid }` (race ids come from `my_calendar`).
- **Calls:** `readRace`, `readCarGroups`, `readRaceRoster` (`domain/races.ts`). Each already
  refuses a race the member cannot see, and car groups have their own rule (`canViewCarGroups`).
- **Returns:** the race, then each car group with its driver and riders. Pending join requests are
  left out.

### `club_members`
- **Claude reads:** "Who is in a club, with their roles."
- **Input:** `{ clubId: uuid }`.
- **Calls:** `readClubRoster(db, ctx, clubId)` (`domain/membership.ts`).
- **Returns:** members and roles. Pending join requests are left out, even for an admin, in stage
  one.

## 3.3 Two refactors the tools need first

Each lands as its own change, with the existing tests green before and after:

1. **`authorizeChannels` in `api/plumbing.ts` takes a `FastifyRequest`** only to read
   `request.access`. Give it an `AccessContext` instead and keep a request-taking wrapper for the
   routes.
2. **The calendar filter-and-sort lives inside the `/calendar` route handler.** Move it into
   `domain/calendar.ts` so the tool calls the same code.
