# Architecture overview

## Why the architecture is changing

The previous build's defects were not random. Read
[Engineering pitfalls](14-engineering-pitfalls.md) as a list and a single
cause appears in almost every entry: **the database was the application server**.

| Symptom (from v1) | Root cause |
|---|---|
| Create-and-return needs a read rule covering the row you just created ([Engineering pitfalls](14-engineering-pitfalls.md) 1) | Authorization expressed as row-level predicates instead of a function call |
| A read rule must never re-query its own table ([Engineering pitfalls](14-engineering-pitfalls.md) 2) | Same |
| "Admin" checks must include Owner - shipped wrong **four** times ([Engineering pitfalls](14-engineering-pitfalls.md) 3) | The predicate was copy-pasted per policy instead of existing once |
| Row-level rules cannot do column-level authority ([Engineering pitfalls](14-engineering-pitfalls.md) 4) | Same |
| Ordering matters in bootstrap triggers ([Engineering pitfalls](14-engineering-pitfalls.md) 7) | Domain effects implemented as DB triggers, so ordering is implicit and untestable |
| Unfiltered subscriptions: every user receives every row ([Roadmap](../PRD/17-roadmap-and-open-questions.md) debt 2) | Realtime bound to table changes, not to domain events with an audience |
| Realtime has no replay after disconnect; a backgrounded phone silently loses messages ([Engineering pitfalls](14-engineering-pitfalls.md) 25) | No sequence numbers, so "what did I miss" is unanswerable |
| Retries can double-post ([Roadmap](../PRD/17-roadmap-and-open-questions.md) debt 4) | No client-generated idempotency key |
| No push notifications at all ([Roadmap](../PRD/17-roadmap-and-open-questions.md), "the single biggest functional gap") | No server to fan out from |

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

## Scale: an honest reckoning

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
| Postgres storage / year | ~40 GB (73M message rows plus indexes) | - | - |
| Object storage / year | ~1 to 2 TB (media dominates, and is not in the database) | 3.6 PB total | - |

**Four to five orders of magnitude smaller.** The consequences:

| Transcript component | ClubChat verdict |
|---|---|
| Cassandra / DynamoDB for messages | **No.** One Postgres primary absorbs 50 writes/sec without noticing. Partition `messages` by channel later if ever. |
| Kafka / RabbitMQ | **Yes, but downstream of the outbox, never instead of it.** The outbox stays as the transactional boundary; a relay publishes it to Kafka, and consumers read from there. See [Effects engine](04-effects-engine.md). |
| Sharding by user ID | **No.** Single database. |
| Multi-region, cross-region replication | **No.** Single region. |
| Per-shard read replicas | **Later.** One read replica when read load justifies it. |
| Service discovery cluster (Consul/Cloud Map) | **No.** The platform's built-in service registry (Fly/Railway/ECS) does this. |
| Redis connection registry | **Yes** - but see [Connection layer](01-connection-layer.md); at one gateway process it is optional, and it becomes required the moment there are two. |
| WebSockets, L4 load balancing | **Yes.** |
| Pre-signed URLs + CDN for media | **Yes.** |
| Push via APNs/FCM | **Yes.** This is the #1 product gap. |

**Rule: build the seams, not the scale.** Every component above that we are skipping has a
named interface in the code (`MessageBus`, `ConnectionRegistry`, `MediaStore`, `PushSender`) so
the swap is a new implementation of an existing port, not a rewrite. We are not, however,
building the scaled implementation now.

---

## System overview

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
    │  · auth handshake     │   │    polls, events, meetups,    │
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
                                            │ polls outbox, 250ms
                                            ▼
                                   ┌──────────────────┐
                                   │  RELAY           │
                                   │  marks published │
                                   └────────┬─────────┘
                                            ▼
                                   ┌──────────────────┐
                                   │  KAFKA           │
                                   │  clubchat.events │
                                   │  partitioned by  │
                                   │  partition_key   │
                                   │  + .dlq          │
                                   └────────┬─────────┘
                                            │ consumer group
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

**Relay.** Polls the outbox and publishes to Kafka, keyed by `partition_key`. Owns no business
logic whatsoever - if it ever needs to know what an event *means*, the split has been drawn in
the wrong place.

**Worker.** A Kafka consumer group. Every server-side effect in [Server event catalogue](12-server-event-catalogue.md) lives here, and
nowhere else. Also runs the one scheduled job (poll closing-soon) and the housekeeping jobs,
which are timer-driven rather than event-driven and so bypass Kafka entirely.

**Redis.** Three jobs: connection registry (`user → gateway`, TTL-refreshed by heartbeat),
pub/sub for cross-gateway delivery, and rate-limit token buckets. **Redis is a cache and a
bus, never a source of truth.** Flushing Redis must degrade the system, not corrupt it.

**Postgres.** The source of truth for everything, including the channel log.
