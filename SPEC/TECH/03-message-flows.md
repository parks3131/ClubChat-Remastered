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
