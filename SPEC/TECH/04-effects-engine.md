# The effects engine

[Server event catalogue](12-server-event-catalogue.md) catalogues ~9 bootstrap/sync effects, 5 system-message emitters, 3 card types, 18
notification types, and 1 scheduled job. In the old build these were database triggers, and
[Engineering pitfalls](14-engineering-pitfalls.md) 7 records the cost: *"Ordering matters in bootstrap triggers. Create the channel before
adding the first member, or the first system message is silently swallowed."*

### Transactional outbox

```sql
CREATE TABLE outbox (
  id            bigserial PRIMARY KEY,
  partition_key text NOT NULL,     -- channel_id or club_id: ordering domain
  event_type    text NOT NULL,
  payload       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz,     -- handed to Kafka, NOT "effect performed". See ADR-0006.
                                 -- Phase 0 ships this column as `processed_at`, because
                                 -- with no Kafka it genuinely does mean "effect
                                 -- performed"; Phase 1.5 renames it. See below.
  attempts      int NOT NULL DEFAULT 0,
  last_error    text
);
CREATE INDEX ON outbox (partition_key, id) WHERE published_at IS NULL;
```

Every command handler writes domain rows **and** outbox events in one transaction. Either both
land or neither does - a guarantee an external queue like Kafka cannot give you, and the reason
we are not adding one.

A relay claims batches with `FOR UPDATE SKIP LOCKED`, publishes them in `id` order within a
partition key, and marks `published_at`. Failures retry with backoff; after N attempts the row
is parked and alerted on.

**The backoff is the load-bearing half of that sentence, and it was missing until 2026-08-04.**
A failed row carries `next_attempt_at`, and the claim query will not take it before that time.
Without it the 250ms poll re-claimed a failing row on every tick, so eight attempts would span
about a second and any outage longer than that parked the row permanently. The delays grow
from a few seconds to an hour, jittered so a recovering provider is not flattened by the whole
herd retrying in the same millisecond, and the budget covers over an hour end to end.

**A failure known to be permanent skips the schedule entirely.** `PermanentEffectError` parks on
the first attempt, because spreading retries over hours makes a hopeless event strictly worse:
the answer is available immediately and nothing would be reported for an hour. An unknown event
type is deliberately **not** in that class - the commonest cause is a rolling deploy, which
heals itself well inside the schedule.

**Parking means an effect never ran, and nothing else may be allowed to mean it.** The retry
path is built for a transient fault; a permanent one produces N identical failures and then an
alarm that can never clear, because the retention sweep deliberately never prunes a parked row.
So an effect that can fail on **bad input** must record that and complete rather than throw -
otherwise the count only ever rises, and a signal that is rare by construction becomes noise.
`media.uploaded` is the case that exists today: an upload whose bytes do not decode is refused
at the boundary and, for anything already stored, recorded in `media_objects.derive_error`.

**The outbox drains by polling - every 250 ms - and uses no `LISTEN`/`NOTIFY` anywhere.** This
is a deliberate constraint, not an oversight: `LISTEN` requires a dedicated session pinned for
the lifetime of the listener, which is incompatible with transaction-mode connection pooling and
would rule out serverless Postgres. Polling at 250 ms costs one trivially-indexed query per tick
and keeps effect latency well inside anything a human perceives. It is also what keeps
[ADR-0004](../decisions/0004-postgres-not-nosql.md)'s Postgres choice free of caveats.

**Delivery is at-least-once, so every effect must be idempotent.** Enforced structurally:

| Effect | Idempotency key |
|---|---|
| Notification row | `UNIQUE (outbox_event_id, recipient_id)` |
| System message / card | `client_msg_id` derived deterministically from the outbox event id, against `UNIQUE (channel_id, sender_id, client_msg_id)` - **relies on `sender_id` being the non-null system actor, see [Message flows](03-message-flows.md)** |
| Push send | Dedupe on `(outbox_event_id, device_id)` |
| Membership cascade | Naturally idempotent (deletes) |

### Explicit ordering, not implicit

The bootstrap sequences [Server event catalogue](12-server-event-catalogue.md) calls out become **explicit ordered steps in one command
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

### 7.4 Kafka, downstream of the outbox

```
command handler ──▶ domain rows + outbox row          [ONE TRANSACTION]
                                │
                          relay, 250ms poll
                          marks published_at
                                ▼
                    ┌───────────────────────┐
                    │  KAFKA                │
                    │  clubchat.events      │  partitioned by partition_key
                    │  clubchat.events.dlq  │
                    └───────────┬───────────┘
                                │  consumer group: effects
                    ┌───────────┴───────────┐
                    ▼           ▼           ▼
                 effects      push       future consumers
                 worker       sender     search, analytics, audit
```

**The outbox does not go away, and this is the whole point.** Kafka cannot participate in the
Postgres transaction that writes the domain rows, so publishing directly from a handler leaves a
window in which the commit succeeds and the publish does not - and the effect is lost with no
error anywhere. The outbox closes that window. Kafka then provides what the outbox does not: a
durable replayable log with independent consumers that can be added without touching the
producer.

Splitting the responsibilities:

| Concern | Owned by |
|---|---|
| Atomicity with the domain write | **Outbox** - it is in the same transaction |
| Durability and replay after a consumer bug | **Kafka** - rewind the offset and reprocess |
| Multiple independent consumers | **Kafka** - a new consumer group, no producer change |
| Ordering within a channel | **Kafka partitioning** - see below |
| Idempotency | **Consumers** - unchanged, see the table above |

**Partition by `partition_key`, which is already `channel_id` or `club_id` on the outbox row.**
Kafka guarantees ordering *within a partition only*. Partitioning by anything else - round
robin, message id, producer default - silently breaks the ordering guarantee [Message flows](03-message-flows.md) depends on,
and the symptom is a system message arriving before the event that caused it. This is the single
most important Kafka configuration decision in the system, and it is the reason `partition_key`
exists on the outbox schema.

Consequences of the relay split:

- `processed_at` on the outbox becomes `published_at`. The outbox now records "handed to Kafka",
  not "effect performed". Effect completion is tracked by the **consumer group offset**.
- Delivery is still at-least-once, now for two reasons rather than one: relay retries and
  consumer rebalances. The idempotency table above is unchanged and is now load-bearing twice
  over.
- A poisoned event goes to `clubchat.events.dlq` after N consumer failures rather than blocking
  its partition forever. Anything in the DLQ is alerted on, because a stuck partition means
  system messages and notifications silently stop for that channel.
- The outbox pruning job (housekeeping, below) keys off `published_at`, and must not prune faster
  than Kafka's own retention, or replay stops being possible.

**Kafka is never on the message send path.** A send commits and acks from the API as described in
[Message flows](03-message-flows.md), with no Kafka hop before the ack. Ack latency is the number a chat app is judged on, and
nothing about the effects pipeline belongs in front of it.

> **Standing note on why this exists.** Kafka is not load-bearing at ClubChat's volume; a
> `FOR UPDATE SKIP LOCKED` worker loop handles this throughput indefinitely. It is here because
> operating a real event log - partitions, consumer groups, offsets, rebalancing, replay, DLQs -
> is an explicit learning goal for this project. That is a legitimate reason, and it is recorded
> honestly rather than dressed up as a scaling requirement. If it ever becomes a burden, the
> relay is the only thing that has to change: the outbox already works without it.

### The one scheduled job

[Server event catalogue](12-server-event-catalogue.md) is emphatic that poll closing-soon is the *only* effect with no data change to hang
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
`closed_at IS NOT NULL OR closes_at < now()`, per [Polls](../PRD/11-polls.md).

### Housekeeping jobs (new, from [Roadmap and open questions](../PRD/17-roadmap-and-open-questions.md))

| Job | Cadence | Fixes |
|---|---|---|
| Orphaned object GC - objects whose owning row is gone | Nightly | Debt 8 ("nothing is ever deleted from object storage") |
| Notification archival - move rows older than 90 days to cold table | Nightly | Debt 10 (unbounded growth) |
| Outbox pruning - delete `published_at < now() − 7 days` | Nightly | New. **Must not prune faster than Kafka's retention**, or replay stops being possible ([ADR-0006](../decisions/0006-kafka-downstream-of-the-outbox.md)) |
| Stale connection sweep | Every 5 min | Belt-and-braces on Redis TTL |
