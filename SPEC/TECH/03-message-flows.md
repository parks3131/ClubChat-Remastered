# Message flows

### 6.1 Send, recipients online

```
Client A                Gateway 1          API            Postgres        Redis      Gateway 2   Client B
   │                       │                │                 │             │            │          │
   │ ws: msg.send          │                │                 │             │            │          │
   │  {client_msg_id,      │                │                 │             │            │          │
   │   channel_id, body}   │                │                 │             │            │          │
   ├──────────────────────►│                │                 │             │            │          │
   │                       │ rate-limit check (token bucket)  │             │            │          │
   │                       ├────────────────────────────────────────────────►│           │          │
   │                       │ appendMessage()│                 │             │            │          │
   │                       ├───────────────►│ authorize       │             │            │          │
   │                       │                │ (policy module) │             │            │          │
   │                       │                ├────────────────►│ BEGIN       │            │          │
   │                       │                │                 │ seq++       │            │          │
   │                       │                │                 │ INSERT msg  │            │          │
   │                       │                │                 │ INSERT outbox            │          │
   │                       │                │                 │ COMMIT      │            │          │
   │                       │                │◄────────────────┤ {seq, ts}   │            │          │
   │ ws: msg.ack           │◄───────────────┤                 │             │            │          │
   │  {client_msg_id, seq} │                │                 │             │            │          │
   │◄──────────────────────┤                │                 │             │            │          │
   │                       │ PUBLISH chan:{id} {seq}          │             │            │          │
   │                       ├─────────────────────────────────────────────────►│          │          │
   │                       │                │                 │             ├───────────►│          │
   │                       │                │                 │             │            │ ws: msg.new
   │                       │                │                 │             │            ├─────────►│
```

Notes:

- **The ack is sent the instant the transaction commits**, before any fan-out. Perceived send
  latency is one round trip plus one Postgres commit.
- The published payload carries `{channel_id, seq}` plus the full envelope. Gateways forward the
  envelope directly - recipients do not re-fetch. ([Engineering pitfalls](14-engineering-pitfalls.md) 24 says *don't diff realtime
  payloads into local state* - that lesson was about reconciling insert/update/delete events
  against a paginated list. With gapless `seq` the client can append safely: if the arriving
  `seq` is exactly `local_max + 1`, append; if it is greater, a gap exists → call sync. That is
  a two-line rule, and it is strictly better than blanket refetch.)
- Sender A's *other devices* receive the message by the same path - they are subscribed to the
  same channel. Multi-device sync is free, with no special casing (contrast the transcript's
  the reference design's "Multi-Device Sync" step, which needs explicit routing to the sender's
  own devices).

### 6.2 Send, recipients offline

The first half is identical - the message is committed to the channel log regardless of who is
online. There is **no separate inbox write**. Then:

```
Worker drains outbox event message.created (seq = N)
   │
   ├─ for announcements / mentions: write discrete notification rows   [immediate]
   │
   └─ schedule push evaluation for T+8s, then:
        audience = channel members
                 − sender
                 − members who muted this channel
                 − members whose read_cursors.last_read_seq >= N     ← the suppression rule
        for each remaining member:
            for each of their devices WHERE invalidated_at IS NULL:
                enqueue push (dedupe key: outbox_event_id + device_id)
```

**Push suppression is decided by the read cursor, never by connection liveness.** This is a
correctness requirement, not a preference:

- `last_read_seq >= N` is a **fact committed to Postgres**: this member demonstrably saw the
  message. Nothing else is proof.
- A live socket is *not* proof of anything. A phone that dies, loses signal, or is force-quit
  leaves a registry entry alive until its TTL expires. Gating push on that entry means every
  message in that window is silently swallowed - in the subsystem [Roadmap](../PRD/17-roadmap-and-open-questions.md) calls the single
  biggest functional gap. **Liveness may only ever accelerate delivery; it may never suppress
  it.**
- It degrades correctly under the failure modes [Failure modes](11-failure-modes.md) already requires. Wipe Redis and push still
  works, because push never consulted Redis.

**The T+8s deferral** exists to lose a race, not to save work. A member with the chat already
open receives the message over the socket and advances their cursor within a few hundred
milliseconds; without the delay the worker could evaluate the audience first and push to
someone actively staring at the message. Eight seconds is far longer than that round trip and
far shorter than a human notices a notification being late. The cursor is re-read at evaluation
time, not captured when the event was enqueued.

**The audience is enumerated over devices, not users.** A member with the web client open on a
laptop and a backgrounded phone has *not* read the message; both devices are pushed, and the
phone rings. Only the cursor suppresses, and it suppresses for that member everywhere at once -
which is the behaviour you want, since reading on the laptop should silence the phone.

When the member returns:

```
Client B                Gateway            API              Postgres
   │ ws: connect + auth    │                 │                  │
   ├──────────────────────►│                 │                  │
   │ ws: subscribe [ch…]   │ authorize each  │                  │
   ├──────────────────────►├────────────────►│                  │
   │ ws: sync {ch: since}  │                 │                  │
   ├──────────────────────►├────────────────►│ WHERE seq > $since│
   │◄──────────────────────┤◄────────────────┤◄─────────────────┤
   │  batched backlog                        │                  │
```

**This is the whole offline story.** No Redis inbox, no inbox table, no pending-message
bookkeeping, no delivery tracking, no cleanup job for delivered messages. The transcript needs
all of that because its server has no durable log. We have one, so "deliver what they missed"
and "page through history" are the *same query* with a different bound.

That single fact removes: the inbox table, the Redis inbox, the inbox-drain-on-connect path,
the delivered-ack path, the delete-after-delivery job, and the 30-day undelivered retention
window.

### 6.3 Group fan-out - the 300-member club

The transcript's group flow, for 50 members: fetch members, check 50 presences in Redis, publish
to 30 per-user channels, write 20 inbox rows, send 20 pushes.

ClubChat's flow, for 300 members:

1. One insert into the channel log.
2. One `PUBLISH chan:{id}`. Gateways with subscribers deliver in-process. **No per-member
   presence lookup on the hot path at all.**
3. Worker computes the push audience asynchronously (one query joining membership against live
   sessions), and batches to Expo Push.

Cost per message: **1 write, 1 publish**, independent of channel size. Push fan-out is
proportional to offline members but happens off the send path.

The transcript's own key insight - "we **store the message once**" - is one we take further:
we also *route* it once.

### 6.4 System messages and cards

[Server event catalogue](12-server-event-catalogue.md) requires that creating a poll posts a card into chat "regardless of which client or
screen triggered it", and that role changes post system messages. These are produced by the
worker, which calls **the same `appendMessage` path** as a user send - same seq allocation,
same publish.

A system message is a message with `type = 'system'` whose `sender_id` is the **system actor**:
a single reserved row in `users` with a fixed UUID, seeded by the first migration.

> **`sender_id` is `NOT NULL`. System messages must not use `NULL`.**
>
> Postgres treats `NULL`s as distinct in a unique index, so
> `UNIQUE (channel_id, sender_id, client_msg_id)` would not fire on
> `(channel, NULL, 'evt-123')` inserted twice. That would leave the *one* class of message the
> worker retries after a crash as precisely the class the constraint fails to protect - a
> redelivered outbox event would post "X was added to the club" twice.
>
> A sentinel actor is preferred over `UNIQUE NULLS NOT DISTINCT` (also valid on PG 17) because
> it additionally removes a `NULL` branch from every render path, roster join, and avatar
> lookup in the client.

Ordering guarantee: the outbox is processed in order **per channel**, so "X was added" cannot
overtake the message that caused it.

### 6.5 Replies, and why the quote is joined rather than stored

A reply stores exactly one integer: `messages.reply_to_seq`, the quoted message's address inside
the same channel. Everything the quote box draws - the sender's name, a truncated preview, the
photo's media id, the document's filename, whether the original has since been deleted - is
**joined on every read** by a self-join on `(channel_id, seq)`, in `domain/reads.ts`.

> **The deciding case is deletion.** A snapshot taken at send time would survive the original
> being deleted, so words an admin removed would live on inside every reply that quoted them,
> visible in the conversation and out of reach of the delete that was supposed to remove them.
> Joining means one delete changes every quote of it at once. A rename propagates for the same
> reason `sender_name` is joined and never stored.

Three consequences worth stating, because each has a way to look correct while being wrong:

1. **The wire carries the resolved quote, not the seq.** `MessageEnvelope.replyTo` is built in
   `appendMessage` as well as in the read path, because `msg.new` is published from the append
   envelope - and a client that received a reply with a bare seq could not draw it without a
   second fetch, which is exactly what the offline-first cache exists to avoid. A field stored on
   the message and never put on the wire is the defect `media_id` and `linked_poll_id` each
   shipped with.
2. **The client cache holds the resolved quote, so a delete has to reach it.** `syncChannel`
   pulls strictly ABOVE the local max, so a row once cached is never fetched again. The
   `MessageStore.patch` contract therefore says that applying a `deletedAt` also strikes that
   message out of every quote of it (`strikeQuotedMessage`), and the SQLite cache keeps
   `reply_to_seq` as its own column purely so that write can find those rows by index.
3. **A reply cannot point outside its channel**, and that is enforced by the composite foreign
   key rather than by the send handler. This is why the reference is a `seq` and not a message
   id: an id reference would need "and it is in this channel" re-checked by every read that
   draws a quote, which is the shape of failure mode 9.

Replies notify nobody. See [Chat](../PRD/05-chat.md) rule 19 for why.

### 6.6 Edits, and the three things they must not become

A correction is a `POST /channels/:id/messages/:seq/body`, and `domain/send-message.ts` writes
`body`, `edited_at` and `rev` in one transaction. **Nothing else is in that `SET`** - not `type`,
not `pinned`, not `seq`, not `sender_id`. See
[ADR-0033](../decisions/0033-a-message-may-be-edited-for-five-minutes.md); the product rules are
[Chat](../PRD/05-chat.md) rule 9a.

Three things it would be easy to let this become, and what stops each:

1. **A second way to post an announcement.** v1's column-level authority trap was a single
   row-level rule over the whole message, which let a member pin their own message and then
   retro-flip its `type`. That is why editing is its own command with its own predicate and its
   own path segment, and why the route's body schema is `.strict()`: a payload carrying `type`
   alongside `body` is refused out loud rather than silently stripped. Asserted against the table
   in `edits.test.ts`, not against the handler.
2. **A change only connected clients see.** A correction mutates a row **below** the client's
   local max, and `syncChannel` pulls strictly above it - the same hole the tombstone had. The
   `rev` bump is inside the transaction, so a correction cannot exist without the revision that
   advertises it, and a device that was offline gets the new text and the "Edited" stamp together
   on its next sync.
3. **A stale quote.** The quote box is joined on read, so a fresh read is already right - but a
   cached reply is never re-fetched, which makes that box the one copy of the text nothing else
   can reach. `MessageStore.patch` therefore restates every quote of an edited message
   (`restateQuotedMessage`), in exactly the place it already strikes every quote of a deleted one.

The window itself is one shared constant asked through one shared function (`withinEditWindow`),
so the client's decision to draw the pencil and the server's decision to refuse are the same rule
rather than two copies of an arithmetic - failure mode 9's shape. The server is the enforcement;
the client's copy only avoids offering an action that is already refused.
