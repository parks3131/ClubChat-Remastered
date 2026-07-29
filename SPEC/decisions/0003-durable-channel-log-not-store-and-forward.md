# ADR-0003: Store messages in a durable channel log, not a per-recipient inbox

| | |
|---|---|
| Status | Accepted |
| Date | 2026-07-28 |
| Deciders | parks3131 |
| Supersedes | none |

## Context

The reference architecture this project is modelled on treats the server as a relay: a message
is stored only until every recipient device acknowledges it, then deleted, with a 30-day
retention window for undelivered messages. Recipients each get an inbox row; delivery drains it.

ClubChat's product bet is the opposite. [Overview](../PRD/00-overview.md) states the goal as
making a race's logistics "survive as durable, revisitable structure instead of a disposable
group chat." History *is* the value, and [Domain model](../PRD/01-domain-model.md) requires that
message deletion be a soft delete with a tombstone, never a removal.

Separately, v1 had no message ordering primitive. Ordering, paging and "have I seen everything"
all rode on timestamps, and a phone that backgrounded and resumed could permanently miss
messages with no error and no indication.

## Decision

We will store each message exactly once in a per-channel log carrying a **gapless monotonic
`seq`**, allocated inside the insert transaction, and track per-user `read_cursors`. Delivery to
online clients is a wake signal; catching up is a query.

## Consequences

| | |
|---|---|
| Positive | "Deliver what you missed" and "page through history" become the same query with a different bound. This removes the inbox table, the Redis inbox, the inbox drain on connect, the delivered-ack path, the delete-after-delivery job and the retention window - an entire subsystem. Gap detection becomes exact rather than heuristic, so silent message loss is not merely fixed but unrepresentable. Unread counts become O(1) arithmetic. |
| Negative | Storage grows without bound, since nothing is deleted on delivery. At ~40 GB/year of message rows this is not a concern for years, and archival is a known later move. Per-channel sends serialize on a row lock, which is irrelevant at single-digit messages/sec per channel. |
| Follow-up needed | The sequence-allocating transaction must never contain I/O, since the row lock is held until commit. Stated as an invariant in [Channel log](../TECH/02-channel-log.md). |

## Alternatives considered

| Alternative | Why not |
|---|---|
| Per-recipient inbox with delete-on-delivery, as in the reference design | Directly contradicts the product: durable, revisitable history is the thing being sold. It also multiplies writes by recipient count, which for a 300-member club is 300x the write amplification for no benefit. |
| Keep the log but order by timestamp | Clock skew is real, and a timestamp cannot answer "have I seen everything up to N". This is the v1 design, and it is why a backgrounded phone lost messages silently. |
| Use a Postgres `SEQUENCE` for `seq` | Sequences are non-transactional and leave gaps on rollback. A gap is indistinguishable from a missing message, so the client would sync forever chasing a hole that does not exist. |
