# Notifications and push

[Roadmap](../PRD/17-roadmap-and-open-questions.md) calls push "the single biggest functional gap", and notes that everything a push
payload needs already exists: each notification carries a fully rendered body and a target
route. So push is a *transport* added to a fan-out that is already specified.

### Two row kinds, unchanged

| | Discrete notification | Chat unread |
|---|---|---|
| Storage | A row, written by the worker | **Not stored** - derived from `last_seq − last_read_seq` |
| Clears | Opening the inbox (most types) | Only by opening that chat |

Both survive as specified in [Notifications](../PRD/12-notifications.md), including the two exceptions: chat-unread rows and
the three pending join-request types are **not** cleared by opening the inbox. ([Notifications](../PRD/12-notifications.md) rule 4 -
"the founder lost real join requests this way".)

**A third row kind arrived with Phase 3.5, and it is the exception to the table above: a
direct message pushes and writes no row at all.** In club, race and Eboard chat an ordinary
message notifies nobody, because it is addressed to a room and the room's unread count is the
right granularity. A DM is the one scope where an ordinary message is addressed to one person, so
it buzzes - and [Direct messages](../PRD/14-direct-messages.md) rule 8 ("muted: no push,
unread still accrues") is a control over nothing unless it does. The inbox representation of an
unread DM stays the computed chat-unread row. See
[ADR-0015](../decisions/0015-a-direct-message-pushes-without-an-inbox-row.md).

### Push pipeline

```
outbox event  →  worker  →  audience (respecting access + mute)
                              │
                              ├─ INSERT notifications (idempotent)          [immediate]
                              │
                              └─ [T+8s] re-read read_cursors, drop members
                                 who have read past this seq, then fan out
                                 per device → Expo Push → APNs / FCM
```

Push targeting is **per device**, suppression is **per member via the read cursor** ([Message flows](03-message-flows.md)). The
connection registry is not consulted.

**Built in Phase 1.** Two details the sketch below does not name, both discovered while
implementing:

- **A `push_deliveries` ledger, keyed `(outbox_event_id, device_id)`.** The spec calls for
  deduping on that pair without saying where the record lives. It needs its own table rather
  than a column, and it must **outlive the outbox row**, which is pruned nightly - otherwise
  pruning makes an already-sent push re-sendable. A duplicated database row can be cleaned
  up; a duplicated push has already buzzed somebody's phone.
- **Both `notifications.outbox_event_id` and the ledger's are plain `bigint`, not
  `bigserial`.** They reference an outbox row rather than generating a value, and a serial
  default would silently hand out sequence numbers to an insert that forgot to supply one -
  defeating the very idempotency index it sits in.

**A third detail, found in Phase 3.5.** Neither key is a raw outbox id. One event can produce more
than one KIND of notification - an announcement that also mentions somebody, and now a direct
message - so the key is `eventId * 4 + slot`, banding each event into its own block of slots. The
previous scheme used the raw id for one kind and `id * 2 + 1` for another, and those sequences
overlap: a mention on event 3 and an announcement on event 7 both key as 7. Since both
`notifications_idempotency` and this ledger are on `(outbox_event_id, recipient/device)`, the
collision reads as "already handled" and silently drops a real notification **and** a real push,
with nothing reporting it. Banding makes the mapping injective by construction, which is the only
version that cannot be got wrong by adding a fourth kind later. Synthetic keys - the poll
closing-soon reminder and the chat-caught-up row - stay negative and unbanded, since real outbox
ids are a positive bigserial and the two spaces cannot meet.

```sql
CREATE TABLE devices (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL,
  push_token    text UNIQUE,        -- Expo push token
  platform      text NOT NULL,      -- ios | android | web
  last_seen_at  timestamptz,
  invalidated_at timestamptz        -- set when the provider reports the token dead
);
```

**Expo Push Service** is the right choice: the client is Expo, and it abstracts APNs and FCM
including receipt polling. It is a thin, replaceable adapter behind a `PushSender` port. Expo
also gives web push, so all three platforms use one path.

Rules carried from [Notifications](../PRD/12-notifications.md) and enforced in the audience function:

- Audience always respects access - a race poll notifies roster members only, never
  roster ∪ club admins ([Server event catalogue](12-server-event-catalogue.md) invariant 2).
- Admin-tier filters match **both** `admin` and `owner` ([Server event catalogue](12-server-event-catalogue.md) invariant 1).
- Creation notifications exclude the actor - except poll closing-soon, which includes them.
- Pinning notifies nobody; announcing notifies everyone in that chat.
- An approval suppresses the "you were added" notification for the same transaction.

New capability this unlocks (formerly [Roadmap and open questions](../PRD/17-roadmap-and-open-questions.md) "important, not blocking"): **per-user mute
and notification preferences** are a single check inside the audience function, rather than
something with nowhere to live.

**Per-conversation mute was built in Phase 3.5** and applies to every scope, not only to DMs.
`channel_mutes` had existed since Phase 1 for exactly this; the mute command is what finally
writes to it. It suppresses the **push only** - the notification row is still written and the
unread count still accrues, because mute is not "mark as read" and conflating the two would
silently mark things read that nobody looked at.
