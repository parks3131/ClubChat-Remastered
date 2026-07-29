# ClubChat - Architecture Plan

**Companion to `Old.md`.** `Old.md` is the product truth: what ClubChat does, who may do it, and
every behaviour that must survive. This document is the *how*: the system architecture the
remaster is built on.

Where `Old.md` says "the current build has no application server: the client talks to the
database directly and row-level security is the only access control that exists" - this
document is the answer to that sentence.

**Modelled on WhatsApp's architecture**, with deliberate, enumerated departures. Section 12
lists everything we consciously do *not* take, and why. Read that section before assuming a
WhatsApp behaviour carries over.

---

## Table of contents

1. [Why the architecture is changing](#1-why-the-architecture-is-changing)
2. [Scale: an honest reckoning](#2-scale-an-honest-reckoning)
3. [System overview](#3-system-overview)
4. [The connection layer](#4-the-connection-layer)
5. [The channel log - the core data structure](#5-the-channel-log--the-core-data-structure)
6. [Message flows](#6-message-flows)
7. [The effects engine](#7-the-effects-engine)
8. [Authorization](#8-authorization)
9. [Notifications and push](#9-notifications-and-push)
10. [Media pipeline](#10-media-pipeline)
11. [Client architecture](#11-client-architecture)
12. [What we deliberately do NOT take from WhatsApp](#12-what-we-deliberately-do-not-take-from-whatsapp)
13. [Failure modes and recovery](#13-failure-modes-and-recovery)
14. [Data model](#14-data-model)
15. [Protocol specification](#15-protocol-specification)
16. [Stack decisions](#16-stack-decisions)
17. [Debt paid off by this design](#17-debt-paid-off-by-this-design)
18. [Build phases](#18-build-phases)
19. [Open architectural questions](#19-open-architectural-questions)

---

## 1. Why the architecture is changing

The previous build's defects were not random. Read `Old.md` section 10 as a list and a single
cause appears in almost every entry: **the database was the application server**.

| Symptom (from `Old.md`) | Root cause |
|---|---|
| Create-and-return needs a read rule covering the row you just created (§10.1) | Authorization expressed as row-level predicates instead of a function call |
| A read rule must never re-query its own table (§10.2) | Same |
| "Admin" checks must include Owner - shipped wrong **four** times (§10.3) | The predicate was copy-pasted per policy instead of existing once |
| Row-level rules cannot do column-level authority (§10.4) | Same |
| Ordering matters in bootstrap triggers (§10.7) | Domain effects implemented as DB triggers, so ordering is implicit and untestable |
| Unfiltered subscriptions: every user receives every row (§11 debt 2) | Realtime bound to table changes, not to domain events with an audience |
| Realtime has no replay after disconnect; a backgrounded phone silently loses messages (§10.25) | No sequence numbers, so "what did I miss" is unanswerable |
| Retries can double-post (§11 debt 4) | No client-generated idempotency key |
| No push notifications at all (§11, "the single biggest functional gap") | No server to fan out from |

Every one of those is fixed by the same move: **put a real application server in the middle**,
and give the message log a monotonic sequence number.

Two things worth saying plainly so they are not re-litigated later:

- **The problem was never "a vendor did the heavy lifting."** Managed Postgres, managed object
  storage, and a managed auth provider are all still good ideas. The problem was that
  *authorization and domain logic* lived in the database, and *the client talked to the
  database directly*. That is the specific thing that ends.
- **This is more code than the old build.** That is the trade. In exchange, the permission
  matrix becomes unit-testable, effects become ordered and replayable, and "what did I miss"
  becomes a single integer comparison.

---

## 2. Scale: an honest reckoning

The transcript sizes for 1 billion users, 10 billion messages/day, 500 GB/s. ClubChat is a
university club app. Being clear-eyed about this is the difference between a system that ships
and a system that is a science project.

### Realistic targets

| Metric | Design target | WhatsApp (transcript) | Ratio |
|---|---|---|---|
| Registered users | 50,000 | 1,000,000,000 | 1 : 20,000 |
| Concurrent connections at peak | 3,000 | 50,000,000 | 1 : 16,000 |
| Messages / day | 200,000 | 10,000,000,000 | 1 : 50,000 |
| Message writes / sec (peak) | ~50 | ~500,000 | 1 : 10,000 |
| Largest channel | ~300 members | 100 | 3 : 1 |
| Storage / year | ~5 GB text + media | 3.6 PB | - |

**Four to five orders of magnitude smaller.** The consequences:

| Transcript component | ClubChat verdict |
|---|---|
| Cassandra / DynamoDB for messages | **No.** One Postgres primary absorbs 50 writes/sec without noticing. Partition `messages` by channel later if ever. |
| Kafka / RabbitMQ | **No.** A Postgres transactional outbox table + a worker loop. Same guarantees, one less system, and it is *transactional with the domain write* - which Kafka is not. |
| Sharding by user ID | **No.** Single database. |
| Multi-region, cross-region replication | **No.** Single region. |
| Per-shard read replicas | **Later.** One read replica when read load justifies it. |
| Service discovery cluster (Consul/Cloud Map) | **No.** The platform's built-in service registry (Fly/Railway/ECS) does this. |
| Redis connection registry | **Yes** - but see §4; at one gateway process it is optional, and it becomes required the moment there are two. |
| WebSockets, L4 load balancing | **Yes.** |
| Pre-signed URLs + CDN for media | **Yes.** |
| Push via APNs/FCM | **Yes.** This is the #1 product gap. |

**Rule: build the seams, not the scale.** Every component above that we are skipping has a
named interface in the code (`MessageBus`, `ConnectionRegistry`, `MediaStore`, `PushSender`) so
the swap is a new implementation of an existing port, not a rewrite. We are not, however,
building the scaled implementation now.

---

## 3. System overview

```
┌─────────────────────────────────────────────────────────────────┐
│  CLIENTS                                                        │
│  Expo app (iOS / Android / Web)                                 │
│  · local SQLite message cache, keyed by (channel_id, seq)       │
│  · send outbox with client-generated message ids                │
│  · sync engine: reconnect / foreground → "since_seq"            │
└───────────────┬──────────────────────────┬──────────────────────┘
                │ WebSocket (realtime)     │ HTTPS (everything else)
                ▼                          ▼
        ┌───────────────┐          ┌───────────────┐
        │ L4 load bal.  │          │ L7 load bal.  │
        └───────┬───────┘          └───────┬───────┘
                ▼                          ▼
    ┌───────────────────────┐   ┌───────────────────────────────┐
    │  GATEWAY              │   │  API                          │
    │  · WS termination     │   │  · REST: clubs, races, eboard,│
    │  · auth handshake     │   │    polls, events, routines,   │
    │  · channel subscribe  │   │    news, members, media       │
    │    (authorized once)  │   │  · chat history + sync reads  │
    │  · fan-out to sockets │   │  · every command handler      │
    │  · heartbeat / reaper │   │    writes domain + outbox     │
    └───────┬───────────────┘   └───────────┬───────────────────┘
            │                               │
            │   ┌───────────────────────────┴──────────┐
            │   │  POLICY MODULE (shared, in-process)  │
            │   │  is_club_member, is_club_admin,      │
            │   │  is_race_member, can_access_poll, …  │
            │   └───────────────────────────┬──────────┘
            │                               │
            ▼                               ▼
    ┌───────────────┐              ┌──────────────────┐
    │  REDIS        │◄─────────────┤  POSTGRES        │
    │  · connection │   pub/sub    │  · all domain    │
    │    registry   │   per-channel│    tables        │
    │  · pub/sub    │   topics     │  · channel log   │
    │  · rate limit │              │    with seq      │
    │    buckets    │              │  · outbox        │
    └───────────────┘              └────────┬─────────┘
                                            │ polls outbox
                                            ▼
                                   ┌──────────────────┐
                                   │  WORKER          │
                                   │  · system msgs   │
                                   │  · chat cards    │
                                   │  · notif fan-out │
                                   │  · push send     │
                                   │  · cascades      │
                                   │  · media derive  │
                                   │  · scheduled job │
                                   └────────┬─────────┘
                                            │
                          ┌─────────────────┼──────────────┐
                          ▼                 ▼              ▼
                   ┌────────────┐   ┌────────────┐  ┌────────────┐
                   │ OBJECT     │   │ CDN        │  │ EXPO PUSH  │
                   │ STORAGE    │──▶│            │  │ → APNs/FCM │
                   │ (S3-compat)│   │            │  │            │
                   └────────────┘   └────────────┘  └────────────┘
```

### Component responsibilities

**Gateway.** Owns WebSocket connections and nothing else durable. Authenticates the socket,
authorizes channel subscriptions *once at subscribe time*, holds `socket → {user, subscribed
channels}` in process memory, mirrors `user → gateway` into Redis, and forwards published
envelopes to the right sockets. It is the only stateful process, and its state is fully
reconstructible by clients reconnecting. **A gateway can be killed at any time with zero data
loss** - that property is load-bearing and must not be traded away.

**API.** All commands and all queries. Every mutation is a command handler that (a) loads an
access context, (b) asks the policy module, (c) writes domain rows and outbox events in one
transaction. Chat sends go through the API path too, invoked from the gateway - the gateway
does not contain business logic.

> **Deployment note:** Gateway, API and Worker are three *roles*, not necessarily three
> deployables. Start as one codebase with three entrypoints, deployed as two services (gateway
> + api-and-worker) or three. The boundary that matters is the *code* boundary, so splitting
> later is a deploy change, not a refactor.

**Worker.** Drains the outbox. Every server-side effect in `Old.md` §6 lives here, and nowhere
else. Also runs the one scheduled job (poll closing-soon) and the housekeeping jobs.

**Redis.** Three jobs: connection registry (`user → gateway`, TTL-refreshed by heartbeat),
pub/sub for cross-gateway delivery, and rate-limit token buckets. **Redis is a cache and a
bus, never a source of truth.** Flushing Redis must degrade the system, not corrupt it.

**Postgres.** The source of truth for everything, including the channel log.

---

## 4. The connection layer

### WebSockets - confirmed

The transcript's reasoning holds unchanged for ClubChat. Polling wastes bandwidth and adds
latency; long polling burns a handshake per message. We need server-initiated push (a message
from another member arrives with no client action), so a persistent bidirectional socket is
correct.

**Consequence: L4 load balancing for the gateway.** L7 balancers that terminate HTTP break the
upgrade or add proxy hops. The REST API keeps an ordinary L7 balancer.

### Connection registry

Redis, exactly as the transcript describes, with one simplification.

```
key:   conn:{user_id}
type:  hash of session_id → { gateway_id, device_id, platform, connected_at }
TTL:   90s, refreshed on every heartbeat (client pings every 30s)
```

**The registry has exactly one job: routing a publish to the gateways that hold sockets.** It is
never consulted to decide whether someone needs a push notification - see §6.2 for why that
would be a correctness bug rather than an optimization.

**The TTL must never exceed the reaper window** (both are 90s). An entry that outlives the socket
it describes causes a publish to a gateway that no longer holds the connection, which is a
harmless no-op. An entry that outlived the socket while *also* gating push delivery would cause
silent missed notifications, which is why that coupling does not exist.

**Simplification vs. WhatsApp:** the transcript's presence service exists largely to power
*user-visible* online/offline and "last seen". `Old.md` §4.3 puts presence, typing indicators
and read receipts explicitly **out of scope**. So:

> **Decision.** There is no presence *service* and no presence *feature*. The connection
> registry exists solely for message routing and to decide whether a member needs a push
> notification. No online/offline state is ever rendered in the UI.

This removes an entire subsystem, its fan-out, and its subscription bookkeeping. If presence is
ever wanted as a product feature, it is added on top of the registry that already exists.

### Heartbeats and the reaper

Client → server ping every 30s; server closes a socket silent for 90s. A gateway that dies
without closing sockets leaves stale Redis entries which expire by TTL. A publish to a stale
entry is a no-op - and it does not matter, because the message is already durable in the
channel log and the client will sync on reconnect.

### Fan-out topology - a deliberate improvement on the transcript

The transcript publishes to **per-user** Redis channels: for a 50-person group, up to 50
publishes and 50 subscriber authorizations per message. `Old.md` §11 debt 2 records exactly
this cost in the old build ("with 200 concurrent users, one message insert costs ~200
authorizations, ~200 billed messages, and ~200 full refetches").

We publish to **per-channel** topics instead:

```
publish  →  chan:{channel_id}   payload: { channel_id, seq, kind }
subscribe←  every gateway holding ≥1 socket subscribed to that channel
```

- Authorization happens **once, at subscribe time**, not once per message per recipient.
- One publish per message regardless of channel size.
- Fan-out is to *gateways* (a handful), which then fan out in-process to sockets (cheap).
- A gateway holding no member of that channel receives nothing.

This is strictly better than the transcript's design for a group-only product, and it is the
direct fix for `Old.md` debt item 2.

---

## 5. The channel log - the core data structure

**This is the single most important decision in the document.**

WhatsApp treats the server as a relay: a message is stored only until every recipient device
acknowledges it, then deleted (the transcript's 30-day retention is for *undelivered*
messages). ClubChat's entire product bet is the opposite - durable, revisitable history is the
value (`Old.md` §1: "Make a race's logistics survive as durable, revisitable structure instead
of a disposable group chat").

So we invert the storage model:

| | WhatsApp | ClubChat |
|---|---|---|
| Authoritative store | The recipient's device | **The server's channel log** |
| Server role | Relay + temporary inbox | **System of record** |
| Per-recipient copy | Yes - one inbox row per recipient | **No - one row per message, ever** |
| Delivery model | Fan-out on write to N inboxes | **Fan-out on write of a wake signal; fan-out on read from the log** |
| "What did I miss?" | Replay my undelivered inbox | **`SELECT … WHERE seq > my_cursor`** |
| Deletion | On delivery | Soft delete with tombstone, never removed (`Old.md` invariant 7) |

### Sequence numbers

Every channel carries `last_seq`. Every message gets `seq = last_seq + 1`, allocated inside the
insert transaction:

```sql
BEGIN;
  UPDATE channels SET last_seq = last_seq + 1
   WHERE id = $channel RETURNING last_seq;      -- row lock, serializes this channel
  INSERT INTO messages (channel_id, seq, …) VALUES ($channel, $seq, …);
  INSERT INTO outbox (…) VALUES (…);            -- same transaction
COMMIT;
```

> **Invariant: the sequence-allocating transaction performs no I/O.**
>
> The `UPDATE channels SET last_seq = last_seq + 1` takes a row lock that is held **until
> commit**, serializing every send to that channel for the duration. No network call, object-
> storage `HEAD`, push dispatch, or external HTTP may appear inside this transaction, ever.
> Media is validated at `/media/:id/complete` (§10), *before* the message referencing it is
> sent. Everything else goes through the outbox.
>
> This is stated explicitly because the lock is invisible at the call site, and a well-meaning
> "just verify the attachment exists before we commit" is exactly the change that would
> serialize an entire channel behind a network round trip.

- **Gapless.** A rollback undoes the counter, so `seq` has no holes. (A Postgres `SEQUENCE`
  would leave gaps - it is non-transactional. Do not use one here.)
- **Strictly ordered per channel.** The row lock serializes concurrent sends to one channel.
  At ClubChat's volume (a busy channel sees single-digit messages/sec) this contention is
  irrelevant; across channels there is none.
- **Not global.** `seq` is meaningful only within its channel. Never compare across channels.

This one column is `Old.md` debt item 3, and it makes the following free:

| Problem in the old build | Solution with `seq` |
|---|---|
| "What did I miss after backgrounding?" (§10.25, unfixed, silent message loss) | `GET /channels/:id/sync?since=<seq>` |
| Paging backward without losing scroll position (§10.9) | `WHERE seq < $cursor ORDER BY seq DESC LIMIT 40` |
| Open on the first unread message (§4.3 rule 3) | `first_unread = read_cursor + 1`, fetch a window around it |
| Unread count, computed not stored (§8 perf) | `channel.last_seq − cursor.last_read_seq` - O(1), no row scan |
| Jump-to-message window (§4.3 edge case) | `WHERE seq BETWEEN $target−20 AND $target+20` |
| Highlights silently losing pins past the loaded window (§11 debt 6) | Server-side `WHERE pinned` over the whole channel, not a client slice |
| Ordering by timestamp with clock skew | Order by `seq`. Timestamps are for display only. |

### Read cursors

```
read_cursors(user_id, channel_id) → last_read_seq
```

Opening a chat sets `last_read_seq = channel.last_seq`. That is the only thing that clears an
unread count (`Old.md` §4.10 rule 3). The notification badge is
`count(discrete unread) + count(channels where last_seq > last_read_seq)` - one per channel,
never a per-message sum, exactly as the brief requires.

### Idempotency

Every send carries a client-generated `client_msg_id` (UUID v7, generated on device *before*
the first attempt).

```sql
UNIQUE (channel_id, sender_id, client_msg_id)
```

A retry after a flaky network hits the unique index; the handler returns the existing row's
`seq` instead of erroring. This is `Old.md` debt item 4, and it is what makes the client's send
outbox safe to retry aggressively.

### Acknowledgement protocol - narrowed on purpose

The transcript specifies sent → delivered → read, with per-recipient tracking and receipts
forwarded back to the sender. `Old.md` §4.3 puts **read receipts and delivery receipts out of
scope**. So ClubChat implements exactly one ack:

| State | Meaning | Who tracks it |
|---|---|---|
| **pending** | In the client's outbox, not yet acknowledged | Client only |
| **sent** | Server assigned a `seq` and committed it | Server ack → client replaces optimistic row |
| **failed** | Server rejected, or retries exhausted | Client only, rendered visibly |

No `delivered`, no `read`, no per-recipient status rows. This removes a per-recipient write
amplification of N per message - the largest single cost in the transcript's design - and it
costs the product nothing, because the product never displayed those states.

Read cursors still exist, but they are *per-user unread bookkeeping*, not receipts: they are
never shown to the sender.

---

## 6. Message flows

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
  envelope directly - recipients do not re-fetch. (`Old.md` §10.24 says *don't diff realtime
  payloads into local state* - that lesson was about reconciling insert/update/delete events
  against a paginated list. With gapless `seq` the client can append safely: if the arriving
  `seq` is exactly `local_max + 1`, append; if it is greater, a gap exists → call sync. That is
  a two-line rule, and it is strictly better than blanket refetch.)
- Sender A's *other devices* receive the message by the same path - they are subscribed to the
  same channel. Multi-device sync is free, with no special casing (contrast the transcript's
  §"Multi-Device Sync", which needs explicit routing to the sender's own devices).

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
  message in that window is silently swallowed - in the subsystem `Old.md` calls the single
  biggest functional gap. **Liveness may only ever accelerate delivery; it may never suppress
  it.**
- It degrades correctly under the failure modes §13 already requires. Wipe Redis and push still
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

`Old.md` §6 requires that creating a poll posts a card into chat "regardless of which client or
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

---

## 7. The effects engine

`Old.md` §6 catalogues ~9 bootstrap/sync effects, 5 system-message emitters, 3 card types, 18
notification types, and 1 scheduled job. In the old build these were database triggers, and
§10.7 records the cost: *"Ordering matters in bootstrap triggers. Create the channel before
adding the first member, or the first system message is silently swallowed."*

### Transactional outbox

```sql
CREATE TABLE outbox (
  id            bigserial PRIMARY KEY,
  partition_key text NOT NULL,     -- channel_id or club_id: ordering domain
  event_type    text NOT NULL,
  payload       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  attempts      int NOT NULL DEFAULT 0,
  last_error    text
);
CREATE INDEX ON outbox (partition_key, id) WHERE processed_at IS NULL;
```

Every command handler writes domain rows **and** outbox events in one transaction. Either both
land or neither does - a guarantee an external queue like Kafka cannot give you, and the reason
we are not adding one.

The worker claims batches with `FOR UPDATE SKIP LOCKED`, processes in `id` order within a
partition key, and marks `processed_at`. Failures retry with backoff; after N attempts the row
is parked and alerted on.

**The outbox drains by polling - every 250 ms - and uses no `LISTEN`/`NOTIFY` anywhere.** This
is a deliberate constraint, not an oversight: `LISTEN` requires a dedicated session pinned for
the lifetime of the listener, which is incompatible with transaction-mode connection pooling and
would rule out serverless Postgres. Polling at 250 ms costs one trivially-indexed query per tick
and keeps effect latency well inside anything a human perceives. It is also what makes §19's
Postgres choice free of caveats.

**Delivery is at-least-once, so every effect must be idempotent.** Enforced structurally:

| Effect | Idempotency key |
|---|---|
| Notification row | `UNIQUE (outbox_event_id, recipient_id)` |
| System message / card | `client_msg_id` derived deterministically from the outbox event id, against `UNIQUE (channel_id, sender_id, client_msg_id)` - **relies on `sender_id` being the non-null system actor, see §6.4** |
| Push send | Dedupe on `(outbox_event_id, device_id)` |
| Membership cascade | Naturally idempotent (deletes) |

### Explicit ordering, not implicit

The bootstrap sequences `Old.md` §6 calls out become **explicit ordered steps in one command
handler**, not a chain of triggers firing each other:

```
createClub(name, sport, policy, creator):
  BEGIN
    club     ← insert clubs
             ← insert club_memberships (creator, role='owner')
    channel  ← insert channels (scope='club')            -- before any member effect
    eboard   ← insert eboard_channels
             ← insert channels (scope='eboard')
             ← insert eboard_memberships (creator)
             ← insert outbox('club.created')
  COMMIT
```

The ordering is now readable in one function, in one file, and covered by one test.

### The one scheduled job

`Old.md` §6 is emphatic that poll closing-soon is the *only* effect with no data change to hang
on. A worker tick every 30 seconds:

```sql
SELECT id FROM polls
 WHERE closed_at IS NULL
   AND closing_soon_notified_at IS NULL
   AND closes_at BETWEEN now() AND now() + interval '10 minutes'
   FOR UPDATE SKIP LOCKED;
```

Stamp `closing_soon_notified_at` in the same transaction as the fan-out → fires at most once
per poll, ever. **No job closes polls**; closed-ness is evaluated at read time as
`closed_at IS NOT NULL OR closes_at < now()`, per `Old.md`.

### Housekeeping jobs (new, from `Old.md` §11)

| Job | Cadence | Fixes |
|---|---|---|
| Orphaned object GC - objects whose owning row is gone | Nightly | Debt 8 ("nothing is ever deleted from object storage") |
| Notification archival - move rows older than 90 days to cold table | Nightly | Debt 10 (unbounded growth) |
| Outbox pruning - delete `processed_at < now() − 7 days` | Nightly | New |
| Stale connection sweep | Every 5 min | Belt-and-braces on Redis TTL |

---

## 8. Authorization

**This is the section that pays off the largest share of `Old.md` §10.**

### The guarantee is unchanged

> Every read and every write is access-checked on the server, not in the UI. Client-side gates
> are UX, never enforcement. A member who types a URL for a race chat, an Eboard poll, or
> another club's roster gets **nothing back**.

What changes is *where* it is enforced.

### One policy module

The predicate catalogue from `Old.md` §7.1 stops being row-level SQL policies and becomes pure
functions over a loaded access context:

```ts
// Loaded once per request. One query, not one per predicate.
type AccessContext = {
  userId: string
  clubRole: Map<ClubId, 'owner' | 'admin' | 'member'>
  raceRoster: Set<RaceId>
  eboardMember: Set<EboardId>
}

const isClubMember  = (ctx, club) => ctx.clubRole.has(club)
const isClubAdmin   = (ctx, club) => ['owner','admin'].includes(ctx.clubRole.get(club))
const isClubOwner   = (ctx, club) => ctx.clubRole.get(club) === 'owner'
const isRaceMember  = (ctx, race) => ctx.raceRoster.has(race)          // roster row ONLY
const isRaceManager = (ctx, race) => isClubAdmin(ctx, race.clubId)     // authority ≠ access
const canPostInRace = (ctx, race) => isRaceMember(ctx, race)
const canPinInRace  = (ctx, race) => isRaceMember(ctx, race) && isClubAdmin(ctx, race.clubId)
const isEboardMember= (ctx, eb)   => ctx.eboardMember.has(eb)
const canAccessPoll = (ctx, poll) => …scope switch…
```

Properties that the old build could not have:

1. **`isClubAdmin` exists exactly once.** The "admin must also mean owner" bug (`Old.md` §10.3,
   shipped **four** times, plus a fifth in a helper) becomes structurally impossible - there is
   one definition and one test for it.
2. **No recursion trap.** `Old.md` §10.2 ("a read rule must never call a helper that re-queries
   the same table") was an artifact of policies evaluating inside queries. Functions over a
   pre-loaded context cannot recurse into a policy.
3. **No create-and-read-back trap.** `Old.md` §10.1 - the repo's longest debugging session -
   disappears entirely. The handler authorized the write; it may obviously return what it wrote.
4. **Column-level authority is trivial.** `Old.md` §10.4 needed a separate before-write trigger
   to stop a member pinning their own message and retro-flipping it into an announcement. Here
   it is an `if` in the update handler.
5. **The permission matrix becomes a test file.** `Old.md` §11 records that the matrix is
   "verified by hand" today. Every cell of the three matrices in `Old.md` §3 becomes a test
   case - a table-driven test asserting allow/deny for each (actor role, action, scope).

### Where authority stops - encoded, not remembered

The most-misunderstood rule in the product (`Old.md` §3: club admin → race chat) gets its own
named, documented predicates so the distinction cannot be accidentally collapsed:

```
isRaceManager  - may approve, add, remove, edit Meet Info, delete the race
isRaceMember   - may read/post chat, vote in race polls, be assigned to a car group
```

Nothing in the codebase is allowed to write `isClubAdmin(ctx, race.clubId)` where race *access*
is meant. Lint rule candidate; test coverage minimum.

### Defense in depth

**Decided: deny-by-default at the role level, no per-row policies.**

Postgres RLS is not the enforcement layer any more. Concretely:

- The API connects as an application role. Every other role - including any future service,
  analytics job, or leaked credential - is denied by default at the grant level.
- **No per-row policies exist.** Enforcement lives in one layer, in one place, fully tested.

The rejected alternative was mirroring the app-layer predicates as RLS policies "for defence in
depth". That means two definitions of every rule that must be kept in sync - and drift between
two definitions of `isClubAdmin` is *literally how the original bugs happened*. A
half-maintained second enforcement layer is a liability, not a safety net.

The remaining backstop is the grant level, which needs no per-rule maintenance and therefore
cannot drift.

### Rate limiting

`Old.md` §7.12: token bucket, burst 30, refill 1/sec per sender, enforced before the insert.
Preserved, moved to the gateway (Redis `INCR` + TTL), and **extended to the endpoints the old
build left unthrottled**: reports, reactions, join requests, media presign requests.

---

## 9. Notifications and push

`Old.md` calls push "the single biggest functional gap", and notes that everything a push
payload needs already exists: each notification carries a fully rendered body and a target
route. So push is a *transport* added to a fan-out that is already specified.

### Two row kinds, unchanged

| | Discrete notification | Chat unread |
|---|---|---|
| Storage | A row, written by the worker | **Not stored** - derived from `last_seq − last_read_seq` |
| Clears | Opening the inbox (most types) | Only by opening that chat |

Both survive as specified in `Old.md` §4.10, including the two exceptions: chat-unread rows and
the three pending join-request types are **not** cleared by opening the inbox. (§4.10 rule 4 -
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

Push targeting is **per device**, suppression is **per member via the read cursor** (§6.2). The
connection registry is not consulted.

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

Rules carried from `Old.md` §4.10 and enforced in the audience function:

- Audience always respects access - a race poll notifies roster members only, never
  roster ∪ club admins (§6 invariant 2).
- Admin-tier filters match **both** `admin` and `owner` (§6 invariant 1).
- Creation notifications exclude the actor - except poll closing-soon, which includes them.
- Pinning notifies nobody; announcing notifies everyone in that chat.
- An approval suppresses the "you were added" notification for the same transaction.

New capability this unlocks (currently `Old.md` §11 "important, not blocking"): **per-user mute
and notification preferences** are now a single check inside the audience function, rather than
something with nowhere to live.

---

## 10. Media pipeline

### Two classes, as specified

| Class | Examples | Bucket | Serving |
|---|---|---|---|
| **Identity** | user/club/race/eboard avatars | public | CDN, stable path, `?v=` cache-bust on replace |
| **Content** | chat photos, documents, news photos | **private** | authorized redirect → CDN (below) |

### Upload - pre-signed, as the transcript describes

```
POST /media/upload-intent { kind, mime, size, scope }
  → authorize the scope (same predicate that protects the messages)
  → validate mime allowlist + size cap        ← fixes Old.md debt 9
  → insert media_objects (status='pending')
  → 200 { media_id, upload_url (presigned PUT, 5 min), max_bytes }

client PUTs directly to object storage

POST /media/:id/complete
  → HEAD the object, verify size/type actually match what was declared
  → status='ready'; enqueue outbox('media.uploaded') → worker derives thumbnails
```

The chat server never touches file bytes. This is the transcript's point and it stands.

### Download - the stable-URL problem, solved

`Old.md` §4.11 rule 5 and debt item 7 describe a real, specific failure: a signed URL minted per
fetch changes its query string every time, and the query string is part of every cache key -
so every layer misses, and N viewers means N origin downloads.

**Design:**

```
GET /media/:id                     ← authenticated, authorized (same membership predicate)
  → 302 to
    https://cdn.clubchat.app/o/{object_key}?exp={hour_aligned}&sig={hmac}
```

- The signature expiry is **aligned to the top of the hour** (`exp = ceil(now, 1h) + 1h`), so
  every viewer in that window is issued the *byte-identical* URL. One CDN cache entry serves all
  300 members instead of 300 origin fetches.
- Authorization happens at the `/media/:id` hop, on every request, using the same predicate that
  protects the message - so a private Eboard photo is never reachable by a guessable URL
  (`Old.md` §4.11 rule 1).
- The redirect itself is `Cache-Control: private, max-age=600` so a client re-uses it briefly
  without re-authorizing on every render.
- Clients render from `/media/:id` - a **stable, permanent** URL. Image cache keys are stable by
  construction; the memoization gymnastics `Old.md` §4.11 rule 5 describes are no longer needed
  anywhere in the client.
- Sign-out clears the redirect cache, so a second account on a shared device cannot inherit
  access.

### Also fixed here

| `Old.md` gap | Fix |
|---|---|
| Debt 8 - nothing ever deleted from storage | `media_objects` has an owner reference; deleting the owner enqueues `media.orphaned`; nightly GC job |
| Debt 9 - no size or MIME limits | Enforced at upload-intent *and* re-verified at complete |
| No image resizing; full-resolution originals served | Worker derives `thumb` (400px) and `display` (1600px) variants; chat renders `display`, gallery grid renders `thumb` |
| Gallery signs an entire photo history in one unpaginated call | Gallery pages like anything else; URLs are stable so there is nothing to "sign in batches" |

---

## 11. Client architecture

Keep Expo + Expo Router. The screen map, navigation rules and design system in `Old.md` §5 and
§9 are all still correct and represent real shipped work - the remaster is a backend and
data-flow change, not a UI rewrite.

Four things are new:

### 1. Local persistence

SQLite (`expo-sqlite`, with OPFS on web) storing `messages` keyed by `(channel_id, seq)`, plus
channel metadata and cursors. This is what makes `Old.md` §8's offline gap addressable: chat
becomes readable offline instead of a spinner.

### 2. Send outbox

```
enqueue(client_msg_id, channel_id, body, media_id?)
  → render optimistically as "pending"
  → attempt send over WS; on ack, replace with the server row at its seq
  → on failure: retry with backoff while the app is alive; surface "failed" with a retry
    affordance after N attempts
```

`client_msg_id` is generated **once**, at enqueue, so retries are free of double-post risk
(§5, idempotency). This closes `Old.md` §8's "no queued sends, no optimistic send" gap and
keeps its rule that a failed send fails *visibly*.

### 3. Sync engine - the fix for silent message loss

`Old.md` §10.25 is the most dangerous open bug in the old build: *"A phone that backgrounds and
resumes can permanently miss messages with no error and no indication."*

```
on( socket connect | app foreground | network regained ):
    for each channel with local state:
        GET /sync?channels[]={id}:{local_max_seq}
        apply returned messages + updated cursors

on( msg.new with seq ) OR ( msg.ack with seq ):        ← both, identically
    if seq == local_max + 1  → append
    if seq >  local_max + 1  → append, then run sync for that channel
    if seq <= local_max      → duplicate, ignore
```

> **The gap rule applies to the client's own `msg.ack`, not only to `msg.new`.**
>
> Consider: A's `local_max` is 3. It missed seq 4 from another member while the socket was
> flapping. A sends, and receives `msg.ack {seq: 5}`. If the ack path skips the gap check, A
> appends its own message at 5, sets `local_max = 5`, and now holds a **permanent** hole at 4 -
> permanent because every future `msg.new` at 6 satisfies `local_max + 1` and never triggers
> a sync. The client believes it is caught up and is not, which is the exact state this
> section exists to make impossible.
>
> Note the asymmetry with `msg.new`: on a gap the client still **appends** its own message
> (the send succeeded and must not disappear from the UI) and syncs to backfill the hole
> behind it.

Gapless sequence numbers make gap detection *exact*, not heuristic. There is no state in which
the client silently believes it is caught up when it is not.

### 4. Realtime remains an enhancement

`Old.md` §8 rule 4 stands: every screen also loads its data over REST, so a dropped socket
degrades to stale-until-refresh rather than broken. The socket is an accelerator, never a
dependency.

---

## 12. What we deliberately do NOT take from WhatsApp

Each of these is a considered rejection. Do not re-litigate without new information.

| WhatsApp / transcript design | ClubChat decision | Why |
|---|---|---|
| **End-to-end encryption** | **No.** TLS in transit, encryption at rest. | The server *must* read and write message content: it composes system messages, posts poll/event/meeting cards, renders notification bodies, and surfaces reported messages to admins. E2E is architecturally incompatible with `Old.md` §6 in its entirety. **This has a privacy consequence that the Privacy Policy must state plainly.** |
| **Delete-on-delivery; 30-day retention** | **No.** Messages are permanent; soft delete leaves a tombstone. | Durable history is the product (`Old.md` §1). |
| **Per-recipient inbox / store-and-forward** | **No.** One channel log + per-user cursors. | Removes N-way write amplification and an entire subsystem. §5. |
| **delivered / read receipts** | **No.** Only `sent`. | Explicitly out of scope in `Old.md` §4.3, and the single largest cost in the transcript's design. |
| **Presence, "last seen", typing indicators** | **No** as a feature. Connection registry is internal routing only. | Out of scope in `Old.md` §4.3. Removes the presence service entirely. |
| **Per-user Redis pub/sub channels** | **No.** Per-*channel* topics. | Authorizes once at subscribe instead of once per message per recipient; fixes `Old.md` debt 2. |
| **Cassandra / DynamoDB** | **No.** Postgres. | 50 writes/sec. We need joins, transactions and constraints far more than we need write throughput. |
| **Kafka / RabbitMQ** | **No.** Postgres outbox. | An external queue cannot be transactional with the domain write - which is the exact property we need. §7. |
| **Sharding by user id; multi-region; per-shard replicas; DR Kafka cluster** | **No.** Single region, single primary, PITR backups. | Four orders of magnitude premature. Seams are named so it is addable. |
| **Service discovery cluster (Consul)** | **No.** Platform-native service registry. | Solved by the host. |
| **1:1 direct messages** | **No.** | `Old.md` non-goal: every conversation is scoped to a club, race, or Eboard. |
| **Phone-number identity** | **No.** Email + password. | `Old.md` §4.1. |
| **Group cap of 100** | **No cap at 100.** Design for ~300. | A university club roster exceeds 100 routinely. |

Two places we go **further** than the transcript, restated so they are not lost:

- **Fan-out to gateways, not to users** (§4). Cost per message is independent of channel size.
- **Sync-by-sequence replaces the offline inbox entirely** (§6.2). "Deliver what you missed" and
  "page through history" become the same query.

---

## 13. Failure modes and recovery

The transcript's resilience requirement - *"if the server that needs to push a message goes
down, the user must still eventually receive the message"* - is satisfied structurally, because
the channel log is committed before any delivery is attempted.

| Failure | Behaviour | Data loss |
|---|---|---|
| **A gateway crashes** | Sockets drop. Clients reconnect (backoff + jitter) to another gateway, subscribe, sync by `seq`. Stale Redis entries expire by TTL. | **None.** Everything acked was committed. |
| **All gateways down** | No realtime. Clients fall back to REST reads (`Old.md` §8 rule 4). Sends queue in the client outbox. | None. Degraded, not broken. |
| **Redis is wiped or unavailable** | Connection registry empty → cross-gateway publish finds nothing → realtime stops. Clients keep working over REST and recover via sync on reconnect. Rate limiting fails **open** (log and alert). | **None** - Redis holds no source of truth. This property is non-negotiable. |
| **The worker is down** | Outbox backs up. Chat still works (messages commit and deliver). System messages, cards, notifications and pushes are *delayed*, not lost - they replay in order on restart. | None. |
| **Postgres primary fails** | Writes fail. Clients show visible send failure and retry from the outbox. Restore from replica / PITR. | Bounded by replication lag. |
| **A push send fails** | Retried by the worker; the notification row exists regardless, so the in-app inbox is still correct. Dead tokens are marked `invalidated_at`. | None in-app. |
| **A client is offline for a week** | On return: sync by `seq` per channel, batched and paginated. | None. |
| **Duplicate outbox processing** | Every effect is idempotent by construction (§7). | None. |
| **A client retries a send after a timeout** | Unique `(channel_id, sender_id, client_msg_id)` → returns the existing `seq`. | No double-post. |

**The invariant that makes all of this simple: nothing is acknowledged before it is durable, and
nothing durable is ever only in Redis or only in a gateway's memory.**

---

## 14. Data model

Postgres throughout. Grouped by concern; `Old.md` §2 is the authority on semantics.

### Identity
```
users                 id, email, full_name, avatar_media_id, bio, city, dob, school,
                      created_at, anonymized_at, blocked_at
devices               id, user_id, push_token, platform, last_seen_at, invalidated_at
sessions              id, user_id, device_id, refresh_token_hash, expires_at
```

### Clubs and membership
```
clubs                 id, name, sport, description, avatar_media_id, join_policy, invite_code,
                      created_at
club_memberships      club_id, user_id, role ∈ {owner,admin,member}, joined_at
                      PK (club_id, user_id)
                      UNIQUE (club_id) WHERE role='owner'      ← invariant 1, at the data layer
club_join_requests    id, club_id, user_id, status, decided_by, decided_at
                      UNIQUE (club_id, user_id) WHERE status='pending'   ← idempotent decisions
```

### The channel abstraction - one concept, three scopes
```
channels              id, club_id, scope ∈ {club,race,eboard}, scope_id, last_seq
                      UNIQUE (club_id) WHERE scope='club'      ← invariant 2
                      UNIQUE (scope, scope_id)
messages              id, channel_id, seq, sender_id NOT NULL, type, body, media_id,
                      document_name, document_size, pinned, deleted_at,
                      client_msg_id NOT NULL,
                      linked_poll_id, linked_event_id, linked_meeting_id, created_at
                      UNIQUE (channel_id, seq)
                      UNIQUE (channel_id, sender_id, client_msg_id)
                      -- both columns NOT NULL is load-bearing: Postgres treats NULLs as
                      -- distinct in a unique index, so a nullable sender_id or
                      -- client_msg_id silently defeats this constraint. System messages
                      -- use the reserved system-actor UUID, never NULL. See §6.4.
                      INDEX (channel_id, seq DESC)
                      INDEX (channel_id, seq) WHERE pinned           ← Highlights, unbounded
                      INDEX (channel_id, seq) WHERE type='announcement'
                      INDEX (channel_id, seq) WHERE media_id IS NOT NULL   ← Gallery
message_reactions     message_id, user_id, emoji     PK (message_id, user_id, emoji)
message_mentions      message_id, user_id
message_reports       message_id, reporter_id, created_at, dismissed_at
                      UNIQUE (message_id, reporter_id)               ← reporting twice is a no-op
read_cursors          user_id, channel_id, last_read_seq, updated_at  PK (user_id, channel_id)
```

### Races
```
races                 id, club_id, name, race_date, avatar_media_id, channel_id,
                      meet_description, meet_location_url, meet_hotel_url,
                      meet_photos_url, meet_results_url
race_memberships      race_id, user_id, joined_at    PK (race_id, user_id)   ← sole access truth
race_join_requests    id, race_id, user_id, status, decided_by, decided_at
race_pins             race_id, user_id               PK (race_id, user_id)   ← personal
car_groups            id, race_id, number, incharge_user_id
                      UNIQUE (id, race_id)          -- redundant, but see below
car_group_members     car_group_id, race_id, user_id
                      UNIQUE (race_id, user_id)                             ← invariant 5
                      FOREIGN KEY (car_group_id, race_id)
                          REFERENCES car_groups (id, race_id)
                      -- race_id is denormalized onto this table on purpose. A generated
                      -- column cannot be used: Postgres generated columns may only
                      -- reference columns in their own row, and race_id lives on
                      -- car_groups. The composite FK above makes the denormalized value
                      -- provably consistent with the group's race, so the invariant is
                      -- enforced by the database rather than trusted from the handler.
```

### Eboard
```
eboard_channels       id, club_id UNIQUE, name, description, avatar_media_id, channel_id
eboard_memberships    eboard_id, user_id             PK (eboard_id, user_id)
eboard_join_requests  id, eboard_id, user_id, status, decided_by, decided_at
meetings              id, eboard_id, creator_id, title, description, starts_at, link
```

### Content
```
polls                 id, club_id, scope, scope_id, creator_id, question, allow_multiple,
                      is_private, closed_at, closes_at, closing_soon_notified_at
poll_options          id, poll_id, label, position, vote_count    ← counts public (invariant 6)
poll_votes            poll_id, option_id, user_id                 ← identity gated
calendar_events       id, club_id, type, title, starts_at, ends_at, location, description
routine_workouts      id, club_id, workout_date, activity_type, title, description
news_posts            id, club_id, author_id, body, media_id, created_at
news_reactions        post_id, user_id, emoji
```

### Infrastructure
```
media_objects         id, owner_type, owner_id, bucket, object_key, mime, bytes, status,
                      variants jsonb, created_at
notifications         id, recipient_id, actor_id, club_id, type, body, target, outbox_event_id,
                      read_at, created_at
                      UNIQUE (outbox_event_id, recipient_id)       ← at-least-once safety
outbox                id, partition_key, event_type, payload, processed_at, attempts, last_error
```

Notes:

- Vote counts live on `poll_options` as a column, updated in the vote transaction. In an
  app-server world the RLS-driven reason for this is gone, but it stays for O(1) reads and
  because `Old.md` invariant 6 makes counts and identity independently visible.
- `meet_information` remains five columns on `races` (`Old.md` §4.7: "edited together as one
  form").
- Every unique partial index above encodes an invariant from `Old.md` §2 **at the data layer**,
  per that section's instruction that these are enforced by data, not by UI.

---

## 15. Protocol specification

### WebSocket

Envelope: `{ "t": <type>, "id": <correlation id>, "d": <payload> }`

**Client → server**

| Type | Payload | Notes |
|---|---|---|
| `auth` | `{ token, device_id, platform }` | First frame. Socket closed if absent within 5s. |
| `subscribe` | `{ channel_ids: [] }` | **Authorized here, once.** Rejected ids returned in the reply. |
| `unsubscribe` | `{ channel_ids: [] }` | |
| `msg.send` | `{ client_msg_id, channel_id, type, body?, media_id?, mentions? }` | |
| `msg.read` | `{ channel_id, up_to_seq }` | Advances the read cursor. |
| `ping` | `{}` | Every 30s. |

**Server → client**

| Type | Payload | Notes |
|---|---|---|
| `auth.ok` | `{ session_id, server_time, channels: [{id, last_seq, last_read_seq}] }` | The client immediately knows every channel with a gap. |
| `auth.err` | `{ code }` | Socket closed. |
| `msg.ack` | `{ client_msg_id, message_id, seq, created_at }` | **Gap-checked exactly like `msg.new`** - a skipped `seq` here leaves a permanent hole. See §11. |
| `msg.err` | `{ client_msg_id, code }` | `rate_limited`, `forbidden`, `channel_gone` |
| `msg.new` | full message envelope incl. `seq` | Append if `seq == local_max + 1`, else sync. |
| `msg.update` | `{ channel_id, seq, pinned?, deleted_at?, reactions? }` | |
| `notif.new` | `{ notification }` | Drives the badge live. |
| `pong` | `{}` | |

### REST (sketch)

```
POST   /auth/register | /auth/login | /auth/refresh | /auth/logout
DELETE /me                                   ← anonymize + block future sign-in

GET    /sync?channels[]={id}:{since_seq}     ← the reconnect / foreground path
GET    /channels/:id/messages?before={seq}&limit=40
GET    /channels/:id/messages?around={seq}   ← jump-to-message window
GET    /channels/:id/pinned | /announcements | /reports | /gallery

GET    /clubs/search?q=                      ← safe projection, non-members only
POST   /clubs · GET/PATCH/DELETE /clubs/:id
POST   /clubs/:id/join | /join-requests/:id/approve | /deny
POST   /clubs/:id/members · PATCH /members/:uid/role · DELETE /members/:uid
POST   /clubs/:id/transfer-ownership

POST   /clubs/:id/races · GET/PATCH/DELETE /races/:id
POST   /races/:id/join-requests · /members · /pin
POST   /races/:id/car-groups · /car-groups/:id/members · PATCH /incharge

GET    /clubs/:id/eboard · POST /eboard/:id/members · /meetings

POST   /polls · POST /polls/:id/votes · POST /polls/:id/close | /reopen
POST   /clubs/:id/events | /routines | /news
GET    /calendar?club=:id                    ← merged feed; omit club for cross-club

POST   /media/upload-intent · POST /media/:id/complete · GET /media/:id
GET    /notifications?cursor=                · POST /notifications/read
POST   /devices                              ← register push token
```

Every mutation returns the created/updated resource - legal and trivial now, and the direct
counter-example to `Old.md` §10.1.

---

## 16. Stack decisions

| Layer | Decision | Rationale |
|---|---|---|
| **Client** | Expo (React Native) + Expo Router, iOS / Android / web | Unchanged. `Old.md` §5 and §9 are real shipped work worth keeping. |
| **Local store** | `expo-sqlite` (OPFS on web) | Offline reads, outbox, cursors. |
| **Server language** | **TypeScript / Node 24** - *decided* | Shared types with the Expo client end-to-end. Node handles thousands of sockets comfortably at this scale. Elixir/Phoenix was the honest alternative (better under connection churn, the runtime WhatsApp itself uses); rejected because the transport we need is modest and the shared-contract win is daily. Revisit only if a load test disappoints. |
| **HTTP + WS** | Fastify (or Hono) + `ws` | Small, fast, no framework opinions to fight. |
| **Validation / contract** | Zod schemas shared between client and server | One definition per payload; the client cannot drift from the wire format. |
| **DB access** | Drizzle | SQL-shaped, typed, migrations as files. **A migration is never edited after being applied** (`Old.md` §10.29). |
| **Database** | Postgres 17, managed (Neon / RDS / Fly Postgres) | Managed hosting was never the problem; putting logic in the DB was. |
| **Cache / bus** | Redis (Upstash or a managed instance) | Registry, pub/sub, rate limits. Never a source of truth. |
| **Object storage** | S3-compatible (Cloudflare R2 recommended - zero egress) + CDN | Media egress is the dominant variable cost. |
| **Auth** | `better-auth`, self-hosted, in our Postgres - *decided* | Email/password only. Identity in our own Postgres keeps the entire domain in one transactional store, which matters most for account deletion: anonymise + block future sign-in becomes one transaction rather than a two-system dance. We own password reset and email deliverability (transactional email provider needed - see §19.3). |
| **Push** | Expo Push Service → APNs / FCM | One adapter, three platforms. |
| **Error monitoring** | Sentry, wired into the error path **from day one** | `Old.md` §11 lists its absence as release-blocking. |
| **Hosting** | Gateway + API + Worker on **Fly.io**; web client on Vercel - *decided* | The gateway holds long-lived connections and needs a long-running process. Postgres colocated on Fly (or Neon in the same region); Redis via Upstash. |
| **Testing** | Vitest; a table-driven permission-matrix suite; Testcontainers Postgres for handler tests | `Old.md` §11: the matrix is hand-verified today. That ends. |

---

## 17. Debt paid off by this design

Mapping `Old.md` §11 "architectural debt worth designing away" to where it is handled:

| # | Debt | Resolved by |
|---|---|---|
| 1 | Realtime reconciliation on reconnect and foreground | §11 sync engine + §5 sequence numbers |
| 2 | Filtered subscriptions | §4 per-channel topics, authorized once at subscribe |
| 3 | Message sequence numbers | §5 - the core of the design |
| 4 | Client-generated idempotency keys | §5 `client_msg_id` unique index |
| 5 | Denormalized/capped unread counts; collapsed calendar feed | §5 O(1) cursor arithmetic; a single merged calendar endpoint replaces per-club-per-feature reads |
| 6 | Highlights losing pins past the loaded window | §14 partial indexes; server-side query over the whole channel |
| 7 | Media cost - N viewers = N origin downloads | §10 hour-aligned signed URLs → one shared CDN cache entry |
| 8 | Storage cleanup | §7 nightly GC job driven by `media_objects` ownership |
| 9 | File size and MIME limits | §10 enforced at intent and re-verified at complete |
| 10 | Notification retention | §7 nightly archival job |
| 11 | Localisation of notification bodies | Store `type` + structured `params`; render at read time. *(Design it in now - retrofitting means rewriting every historical row.)* |
| 12 | Rate limiting beyond messages | §8 extended to reports, reactions, join requests, presign |
| 13 | Backups and dev/prod parity | Managed Postgres PITR; migrations from one source of truth |

And from `Old.md` §11 "blocking a real release":

| Gap | Resolved by |
|---|---|
| Push notifications | §9 - designed into the fan-out from day one, as the brief instructs |
| Error monitoring | §16 - Sentry in the error path from the first commit |
| Accessibility | Not architectural. Client work, tracked separately, started early rather than retrofitted |
| Legal review | Not architectural. **Note the new obligation from §12: without E2E, the Privacy Policy must state that message content is readable by the service.** |

---

## 18. Build phases

Each phase ends with something demonstrably working end-to-end. No phase is "backend only".

**Phase 0 - Skeleton and the vertical slice.**
Auth, users. Clubs + memberships + the one-owner constraint. Channels. The channel log with
sequence numbers, idempotency, and cursors. Gateway with subscribe/send/ack/sync. The policy
module with `isClubMember` / `isClubAdmin` / `isClubOwner` and their tests. Outbox + worker with
one effect (club bootstrap). Expo client: sign in, club list, club chat with optimistic send,
offline outbox, reconnect sync.
*Done when, with the gateway killed **mid-send** (not merely mid-conversation) and both clients
forced to reconnect:*

- ***Nothing lost.** Every message either appears on every device or was never acked.*
- ***Nothing twice.** No message appears more than once on any device, including retried sends
  and replayed outbox events. Verified by asserting the message count, not by eyeballing the
  transcript.*
- ***Identical order.** Both devices render the same `seq` sequence, with no holes.*

The second and third conditions are the point. Sequence numbers and `client_msg_id` exist to
prevent duplicates and misordering, and a gate that only proves delivery would pass a build with
both the system-message duplication bug (§6.4) and the `msg.ack` gap bug (§11) still in it. A
delivery-only gate is half a test.

**Phase 1 - Effects, notifications, push.**
The full `Old.md` §6 catalogue in the worker. Notification rows, the inbox, the badge, and the
clearing rules including the two exceptions. Device registry and Expo Push. The scheduled job.
*Done when: an announcement in club chat reaches a backgrounded phone as a push that deep-links
to the right message.*

**Phase 2 - Breadth across the domain.**
Races (roster, Meet Information, car groups, pins), Eboard (auto-membership sync, meetings),
polls in all three scopes, calendar, routines, news. Every one reuses the channel abstraction -
if any of them forks chat, the abstraction has been broken (`Old.md` §2 rule).
*Done when: the permission-matrix test suite covers every cell of the three matrices in
`Old.md` §3.*

**Phase 3 - Media and offline.**
Upload intent, presigned PUT, thumbnail derivation, the `/media/:id` authorized-redirect path,
galleries. Local SQLite cache for offline chat reads.
*Done when: a private Eboard photo is provably unreachable without membership, and chat is
readable in airplane mode.*

**Phase 4 - Hardening.**
Rate limits everywhere. Retention and GC jobs. Accessibility pass on every icon-only control.
Sentry dashboards. Load test at 10× projected peak. The `Old.md` §12 parity checklist, run on
all three platforms.

---

## 19. Decisions taken, and questions still open

### Settled (2026-07-28)

| Fork | Decision | Rejected |
|---|---|---|
| Server runtime | **TypeScript / Node 24** | Elixir/Phoenix, Go |
| Hosting | **Fly.io** for gateway/API/worker; Vercel for the web client | Railway/Render, all-on-Vercel |
| Auth | **`better-auth`, self-hosted** in our Postgres | Clerk, hand-rolled |
| RLS | **Deny-by-default at the role level, no per-row policies** | Per-row RLS as defence in depth |
| Encryption | **TLS + at rest, no E2E** (§12) | End-to-end encryption |
| Postgres | **Neon** | Fly Postgres (unmanaged VM you operate) |

On Neon specifically: the usual objection is that transaction-mode pooling breaks
`LISTEN`/`NOTIFY`. §7 commits to a polling outbox and no `LISTEN` anywhere in the system, so
that conflict does not arise, and Neon's managed PITR closes `Old.md` debt 13 (backups) for
free. One network hop of extra latency is irrelevant against a 250 ms poll interval.

### Still open

1. **Transactional email provider.** A consequence of choosing self-hosted auth: we now own
   password reset, email verification, and their deliverability. Resend or Postmark; needs a
   verified sending domain. Blocks Phase 0 sign-up.

2. **Archiving.** `Old.md` asks whether a finished race or a dormant club should become
   read-only rather than only deletable. Architecturally near-free *if designed now*
   (`archived_at` on clubs/races, one predicate in the policy module) and expensive to
   retrofit. *Recommendation: add the column and the predicate in Phase 0, expose the feature
   whenever the product wants it.*

3. **Localisation of notification bodies** (`Old.md` debt 11). Storing structured params
   instead of rendered English costs little now and **cannot** be retrofitted to historical
   rows. *Recommendation: store `type` + `params`, render at read time, from Phase 1.*

4. **Group size ceiling.** §12 designs for ~300 members per channel against WhatsApp's 100.
   Is there a real upper bound for a university club, or should the largest channel be treated
   as unbounded? Affects whether roster reads and push fan-out need pagination in Phase 2.

---

*This document describes the system. `Old.md` describes the product. Where they conflict on
behaviour, `Old.md` wins. Where a running implementation conflicts with this document, the
implementation is the fact and this document is the bug - fix it here in the same change.*
