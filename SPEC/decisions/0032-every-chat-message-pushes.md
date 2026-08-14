# 32. Every chat message pushes, and still writes no inbox row

Date: 2026-08-14

## Status

Accepted. Extends [ADR-0015](0015-a-direct-message-pushes-without-an-inbox-row.md) from direct
messages to every chat scope.

## Context

An ordinary message in club, race or Eboard chat notified nobody and pushed nobody. Only three
things reached a phone from a conversation: an **announcement**, an **@mention**, and a **direct
message**.

That was a deliberate position, not an oversight, and it was written down in three places -
[PRD/12](../PRD/12-notifications.md)'s catalogue, `dm_message`'s own entry in the shared
catalogue, and the worker's `onMessageCreated`. The reasoning: a message in a group is addressed
to a **room** rather than to a person, so the room's unread count is the right granularity, and
a DM is the one scope where an ordinary message is inherently addressed to one individual.

The reasoning is coherent and the product was wrong anyway. On 2026-08-14 the founder tested
push by signing in as a second person on the web, joining a club his phone was in, and sending a
message. Nothing arrived. The three documents agreed that nothing should have - and every product
ClubChat replaces, GroupMe included, buzzes when somebody talks to your club. **A member who says
"notify me" means messages.** The room-versus-person distinction is real to whoever designed the
notification model and invisible to whoever is holding the phone.

## Decision

**An ordinary message in club, race and Eboard chat pushes everyone else who can read that
channel. It writes no inbox row.**

Concretely:

1. **A new push-only notification type, `chat_message`**, joining `dm_message` as the second type
   that buzzes a phone and never becomes a row. It carries the same params as `announcement`.
2. **No inbox row, ever.** The inbox representation of unread chat stays the computed
   per-channel row. This is ADR-0015's reasoning applied unchanged: one row per message would
   flood the feed with the per-message noise PRD/12 rule 8 rejects.
3. **Rule 8 is untouched.** It governs the badge, which still counts one per channel and never a
   per-message sum. Only the buzz became per message.
4. **At most one push per member per message.** The group-chat audience subtracts anybody
   mentioned, who receives the more specific "X mentioned you" instead.
5. **Which message types buzz is a list, not a condition**: `text`, `photo`, `document`.
   Announcements have their own louder path; `system` lines are the worker's own writing and have
   no author; poll, event and meeting cards have already pushed as `poll_created` and friends.
6. **The deep link carries no `seq`**, unlike an announcement or a mention. Those are about one
   specific message. This one fires on every message, so by the time it is tapped the useful
   destination is the first unread - which is where chat opens on its own.

## Consequences

**What makes it survivable is the two suppressions, and they were already built.**

- **The read cursor.** A member whose cursor has passed the message is not pushed, re-read eight
  seconds after the event rather than captured when it was enqueued ([ADR-0008](0008-push-suppression-by-read-cursor.md)).
  So an open conversation never buzzes, and reading on a laptop silences the phone.
- **Mute.** Per-channel mute silences the buzz while the unread count keeps climbing. It existed
  for DMs and was close to decorative for a club; it is now the control that makes a loud club
  bearable, and the first thing to point somebody at who complains about volume.

**The cost, stated plainly: a busy club buzzes a lot.** Thirty messages in five minutes with the
phone in a pocket is thirty notifications. This was put to the founder as an explicit choice
against a coalescing alternative and the per-message behaviour was chosen, on the grounds that it
is what every comparable product does and what a member expects. If it becomes a complaint, the
answer is **coalescing**, not silence.

**Per-message work in the worker.** Every message now runs an audience query plus the cursor,
mute, device and ledger reads, where previously an ordinary message returned early after two
queries. At this project's honest scale ([TECH/00](../TECH/00-overview.md)) that is
uninteresting; at a scale where it is not, the fix is to coalesce, which reduces the push count
and the query count together.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Leave it silent** | The status quo, and defensible on paper. It is also the reason the founder could not receive a notification from his own club, and it is not what any competing product does |
| **Coalesce: one push per channel per few minutes** | Genuinely quieter, and the right answer if volume becomes a complaint. Rejected for now because it needs a cooldown ledger and a different notification body, and because a message arriving thirty seconds after the last one would land silently - which is the failure mode a member notices |
| **Push only the first unread message per chat, then stay silent until read** | Needs no new table, since the read cursor already carries the state. Rejected as too clever: "why did the second message not buzz" has no answer a member finds reasonable |
| **Write an inbox row per message too** | Floods the feed and contradicts "computed on read, never stored". Explicitly rejected by PRD/12 rule 8 and by ADR-0015 before it |
| **Make it a per-member preference** | A setting is what you build when you cannot decide. The mute control already exists and is per conversation, which is the granularity somebody actually wants - a club is loud, not the app |
| **Push the card messages too** | A poll or event card already pushes as `poll_created` / `event_created`. Pushing the card as well rings twice for one thing somebody made |
