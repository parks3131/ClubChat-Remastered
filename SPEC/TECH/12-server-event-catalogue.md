# Server-side event catalogue

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

### Message mutations that must reach every open client

A pin, a soft delete, a reaction and now an **edit** all change a row **below** the sequence a
connected client already holds, so none of them can be delivered by "give me what is newer than
my last seq". Each writes an outbox event, and the worker republishes the change as a `msg.update`
frame after **re-reading the row** rather than trusting its own payload - which is what makes a
redelivered event republish current truth instead of an older snapshot.

| Event | Republished as | Notifies |
|---|---|---|
| `message.pinned` | `pinned`, `pinnedAt` | nobody - a pin is reference, not interruption |
| `message.deleted` | `deletedAt`, cleared reactions, `pinned: false` | nobody |
| `message.reacted` | the full reaction set | nobody |
| `message.edited` | `body`, `editedAt` | only somebody the edit **newly** @named |

`message.edited` is the one whose payload carries something that cannot be recovered by re-reading:
**which mentions the edit added**. By the time the worker runs, the previous mention set has
already been replaced, so the diff travels on the event. Notifying everyone named in the final
text instead would buzz the same person again every time the sender fixed a typo.

All four also bump the channel's `rev`, in the same transaction as the change, which is what
carries them to a device that was **offline** when they happened - see
[Channel log](02-channel-log.md).

### Notification fan-out

Every notification in [Notifications](../PRD/12-notifications.md) is written server-side, on the data change,
with its audience computed per the scope rules. Two audience rules have each been fixed
multiple times and are restated as invariants:

1. **Club-role audience filters must match both `admin` and `owner`.** A bare "admin" filter
   means a club whose only admin-tier member is the Owner gets nothing at all.
2. **Race audiences are roster members only, never roster ∪ club admins.** Since chat access
   itself requires a roster row, unioning in admins notifies people about a channel they
   cannot open.
3. **"Who can read this channel" is defined once, and covers every scope.** Added in Phase 3.5,
   after this rule was learned the hard way: the audience function, the accessible-channel list,
   the chat-unread rows and the badge each carried a hand-written copy of the membership join,
   and Phase 2 shipped races without updating **any** of them. A race member's chat therefore
   appeared in no channel list, contributed no unread count and no badge, and an announcement in
   race chat notified nobody. Four self-consistent copies, one missing branch each, and no test
   could see it. There is now one definition and a fifth scope is a branch in it.
4. **A DM audience is its two participants, and blocking does not remove either.** A block
   prevents new messages, so a message that exists was authorized when it was written and its
   recipient is entitled to know about it. The actor is excluded as everywhere else, which leaves
   exactly one recipient without needing a scope-specific branch.
5. **Two audiences resolve to people who are members of nothing.** A report raised in a DM, and
   `user.reported` - a report about a *person*, which has no channel at all
   ([ADR-0035](../decisions/0035-a-person-is-reported-to-platform-moderators.md)). Neither can be
   found by any membership query, which is why `platformModerators` exists beside the per-channel
   audience rather than as a branch inside it. Note what rule 3 asks of this pair: the predicate
   is written **once**, and `channelModerationAudienceById` reads the same column - so a future
   change to who moderates cannot land in one and miss the other.

Also: **an approval must not produce both "your request was approved" and "you were added".**
The approval path suppresses the membership-added notification for that transaction.

And: **one event can produce more than one kind of notification**, so an idempotency key derived
from the outbox id alone is not enough. An announcement that also mentions somebody, in a DM that
also pushes, is three kinds from one event. The key is `eventId * 4 + slot`; see
[Notifications and push](06-notifications-and-push.md) for what the previous scheme collided
with.

### The one scheduled job

**Poll closing-soon** is the only notification with no data change to hang on - nothing
changes when a deadline gets within 10 minutes. A job runs **every 30 seconds** (the cadence
is specified once, in [Effects engine](04-effects-engine.md); this file previously said "every
minute" and the two disagreed), selects polls that are open, have a deadline within the next 10
minutes, and have not been flagged yet, fans out to the poll's full audience **including the
creator**, and stamps them as notified so it fires **at most once per poll, ever**.

Everything else about deadlines is computed live: "is this poll closed" is evaluated at read
time as `closed_manually OR deadline_passed`. **There is no job that closes polls.**
