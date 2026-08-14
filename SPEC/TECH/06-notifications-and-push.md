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
message in a conversation pushes and writes no row at all.** It began as a DM-only rule, on the
reasoning that a group message is addressed to a *room* and the room's unread count is the right
granularity, while a DM is inherently addressed to one person - and
[Direct messages](../PRD/14-direct-messages.md) rule 8 ("muted: no push, unread still accrues")
is a control over nothing unless it buzzes.

**Since 2026-08-14 it covers every chat scope**: an ordinary message in club, race or Eboard chat
pushes everyone else who can read that channel, and still writes no row. The inbox representation
of unread chat stays the computed chat-unread row in every scope, which is what keeps
[Notifications](../PRD/12-notifications.md) rule 8 true - the badge is one per channel, never a
per-message sum, and only the buzz is per message. See
[ADR-0015](../decisions/0015-a-direct-message-pushes-without-an-inbox-row.md) and
[ADR-0032](../decisions/0032-every-chat-message-pushes.md).

**Two consequences worth carrying into any change here.** Mute stopped being close to decorative
and is now the control that makes a loud club bearable, so anything that weakens it is a
regression a member feels immediately. And **the read cursor is what stops this being "buzz
everybody, always"** - it is re-read at evaluation time, eight seconds after the event, so an
open conversation never buzzes. Capturing the cursor when the event is enqueued would defeat the
whole design; see [ADR-0008](../decisions/0008-push-suppression-by-read-cursor.md).

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

**The fourth kind arrived on 2026-08-14 and took slot 3**, which the banding had been holding for
exactly this. It is the ordinary chat message push ([ADR-0032](../decisions/0032-every-chat-message-pushes.md)),
and adding it was a constant rather than a re-keying - which is what the band was bought for. All
four slots are now spoken for, so a fifth kind means raising `NOTIFICATION_SLOTS`; note that
changing it **renumbers every future key** and must not be done while unprocessed events with old
keys are in flight.

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
- An ordinary message pushes everyone else who can read that channel, and writes no row. Which
  message types count is a list (`text`, `photo`, `document`) rather than a condition, so the
  cards - which have already pushed as `poll_created` and friends - cannot ring a second time.
- A member is buzzed at most once per message: the ordinary-message audience subtracts anybody
  mentioned, who gets the more specific "X mentioned you" instead.
- An approval suppresses the "you were added" notification for the same transaction.

New capability this unlocks (formerly [Roadmap and open questions](../PRD/17-roadmap-and-open-questions.md) "important, not blocking"): **per-user mute
and notification preferences** are a single check inside the audience function, rather than
something with nowhere to live.

### The picture beside a row is joined, never stored

[Notifications](../PRD/12-notifications.md) rule 2c gives most inbox rows the face of whatever they
are about. **That subject is resolved when the row is read, and never written into `params`.**

This is ADR-0013's own argument one field further on. `params` is a record of the moment the event
happened; a picture is a fact about the subject *now*. Storing it would freeze a club's old avatar
into every notification ever sent about it, and changing a picture would need a migration over
history - which is exactly the retrofit that ADR closed off for the body and the target. It is the
same reason `sender_name` is joined onto a message rather than stored on it
([Message flows](03-message-flows.md)).

Two things fall out of that, and both are cheap:

- **The conversation tier costs nothing new.** `channelDisplayImage()` already exists, already
  branches per scope, and already carries the fix for the trap that matters here - a race with no
  picture must fall through to **its own initial**, never to the club's face, which a `COALESCE`
  silently gets wrong because the names it coalesces are all `NOT NULL` while the pictures are not.
  The inbox's unread rows already join the name; the picture is the column beside it.
- **The discrete tier resolves per subject kind, batched.** Which kind a type resolves against is
  **one exhaustive mapping in `packages/shared`**, so the server's resolver and the client's
  renderer cannot disagree about it and a new notification type is a compile error rather than a
  row with a blank circle. That is failure mode 9's rule applied before the second copy exists.

**A subject that has been deleted, or that the reader has lost access to, resolves to nothing and
the row draws its fallback.** [Notifications](../PRD/12-notifications.md) rule 6 already requires
tapping such a row to fail gracefully; drawing it must fail the same way, and a missing picture is
not an error state - it is the ordinary case, since most clubs have no picture at all.

**Avatars are identity media on stable public URLs** ([Media pipeline](07-media-pipeline.md)), so
none of this adds an authorization hop. That is the single fact that makes the whole change small.

**Per-conversation mute was built in Phase 3.5** and applies to every scope, not only to DMs.
`channel_mutes` had existed since Phase 1 for exactly this; the mute command is what finally
writes to it. It suppresses the **push only** - the notification row is still written and the
unread count still accrues, because mute is not "mark as read" and conflating the two would
silently mark things read that nobody looked at.
