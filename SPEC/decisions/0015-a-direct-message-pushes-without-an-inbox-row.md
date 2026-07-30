# ADR-0015: A direct message pushes, and writes no inbox row

| | |
|---|---|
| Status | Accepted |
| Date | 2026-07-30 |
| Deciders | parks3131 |
| Supersedes | none |

## Context

Two requirements collided while building Phase 3.5, and neither one names the other.

[Notifications](../PRD/12-notifications.md) draws a hard line between the two kinds of row in
the inbox. A **discrete notification** is a recorded event and is written when it happens; a
**chat unread** is a live count, computed on read and never stored. Under that model an ordinary
text message notifies nobody at all: it produces no row, and its unread count is derived from
`channel.last_seq - cursor.last_read_seq`. Only announcements and mentions write rows and push.
The catalogue's 18 types contain nothing for "somebody messaged you".

[Direct messages](../PRD/14-direct-messages.md) rule 8 then says a conversation can be muted:
"no push notifications, unread count still accrues". [Build phases](../TECH/16-build-phases.md)
makes that the Phase 3.5 exit gate: *"a muted conversation produces no push while still
incrementing its unread count."*

**A mute is only meaningful if something was going to buzz.** Read the group-chat rule across to
DMs unchanged and an ordinary direct message pushes nothing, so muting one is a no-op with a
test that can never fail. Read it the other way and every DM writes an inbox row per message,
which floods the feed with exactly the per-message noise the computed-unread design exists to
avoid - and contradicts [Notifications](../PRD/12-notifications.md)'s own table.

The underlying asymmetry is real rather than an oversight in either document. In club, race and
Eboard chat a message is addressed to a room, and the room's unread count is the right
granularity. **A DM is the one scope where an ordinary message is inherently addressed to one
person**, and the coordination exchanges the feature exists for - "can you pick me up on the
way" - are worthless if they arrive silently.

## Decision

**A direct message dispatches a push and writes no notification row.**

The catalogue gains a nineteenth type, `dm_message`, which is **push-only**. It renders and
routes like any other type, because the push payload needs both, but nothing ever inserts it
into `notifications`. The inbox representation of an unread DM is the same computed chat-unread
row every other scope gets.

Its parameters fix `clubId` at `z.null()` rather than nullable, so a handler that invented a
club for a DM fails the write. `channelName` carries the **sender's** name, since a conversation
has no name of its own and the recipient is always the other participant. Its target carries no
`seq`: chat already opens on the first unread message, and pinning the deep link to the seq the
push was built from would land above anything that arrived in between.

Both existing suppressions apply unchanged and neither needed a DM-specific branch: the read
cursor silences a recipient who is already looking at the conversation, and `channel_mutes`
silences the buzz while the unread count keeps climbing.

## Consequences

| | |
|---|---|
| Positive | Mute becomes a real feature with a falsifiable test, which is what the exit gate asks for. The push path, the audience function, the deferral and the cursor suppression are reused exactly - the whole change is one `case` in the audience switch and one branch in the message effect. The inbox stays free of per-message rows, so [Notifications](../PRD/12-notifications.md)'s two-kinds-of-row model survives intact. |
| Negative | One type in the catalogue behaves unlike the other eighteen, and a reader who assumes every type becomes a row will be wrong about this one. Mitigated by saying so at the declaration, in [Notifications](../PRD/12-notifications.md), and in the test that asserts no row is written. A push-only type also means a DM that arrives while the recipient's device token is dead leaves no trace in the inbox - correctly, because the unread count is the trace. |
| Follow-up needed | None. If per-type notification preferences arrive, `dm_message` is a preference like any other. |

## Alternatives considered

| Alternative | Why not |
|---|---|
| Write an inbox row per direct message | Floods the feed with one row per message, which is precisely the per-message noise [Notifications](../PRD/12-notifications.md) rule 8 rejects for the badge ("never a per-message sum") and which the computed chat-unread row exists to replace. It would also make the DM half of the inbox behave unlike the other three scopes. |
| Do not push direct messages at all | Internally consistent with group chat and wrong for the product. It makes mute a control over nothing, makes the exit gate unfalsifiable, and leaves the small coordination exchanges DMs exist for arriving silently - which is the failure that keeps them in SMS, the thing [Direct messages](../PRD/14-direct-messages.md) is trying to fix. |
| Reuse `announcement` for DM pushes | The rendered text is wrong ("Riley: ..." under a channel title that is a person's name), and it would make an announcement's audience rule and a DM's the same rule, which they are not. Worse, `isChannelAdmin` is deliberately false for the scope, so nothing in a DM can legitimately BE an announcement. |
| Reuse `mentioned` by treating every DM as an implicit mention | Would work mechanically and lies in the data: `message_mentions` rows that nobody typed, which then surface in any future "where was I mentioned" view. A stored fact that was never true is worse than a new type. |
| Push from the send path instead of the effect | Skips the eight-second deferral, so a recipient with the chat open gets buzzed for a message they are looking at. The deferral exists to lose that race (ADR-0008). |

## Note

The nineteenth type is the honest shape of a requirement collision, not a workaround. Both
documents were right about their own scope; what neither said is that "an ordinary message
notifies nobody" was a statement about **rooms**, and a DM is not a room.
