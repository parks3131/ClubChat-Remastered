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

New capability this unlocks (currently [Roadmap and open questions](../PRD/17-roadmap-and-open-questions.md) "important, not blocking"): **per-user mute
and notification preferences** are now a single check inside the audience function, rather than
something with nowhere to live.
