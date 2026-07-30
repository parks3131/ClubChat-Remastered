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

### Notification fan-out

Every notification in [Notifications](../PRD/12-notifications.md) is written server-side, on the data change,
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
changes when a deadline gets within 10 minutes. A job runs **every 30 seconds** (the cadence
is specified once, in [Effects engine](04-effects-engine.md); this file previously said "every
minute" and the two disagreed), selects polls that are open, have a deadline within the next 10
minutes, and have not been flagged yet, fans out to the poll's full audience **including the
creator**, and stamps them as notified so it fires **at most once per poll, ever**.

Everything else about deadlines is computed live: "is this poll closed" is evaluated at read
time as `closed_manually OR deadline_passed`. **There is no job that closes polls.**
