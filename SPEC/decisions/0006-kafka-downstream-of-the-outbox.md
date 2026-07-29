# ADR-0006: Put Kafka downstream of a transactional outbox, never in place of it

| | |
|---|---|
| Status | Accepted |
| Date | 2026-07-28 |
| Deciders | parks3131 |
| Supersedes | none |

## Context

Every server-side effect in [Server event catalogue](../TECH/12-server-event-catalogue.md) must
happen automatically, regardless of which client triggered it. In v1 these were database
triggers, and [Engineering pitfalls](../TECH/14-engineering-pitfalls.md) records the cost:
ordering between triggers was implicit, untestable, and wrong - create the channel before adding
the first member, or the first system message is silently swallowed.

Separately, operating a real event log - partitions, consumer groups, offsets, rebalancing,
replay, dead-letter queues - is an **explicit learning goal for this project**. That is recorded
here honestly rather than dressed up as a scaling requirement: at ~50 writes/sec a
`FOR UPDATE SKIP LOCKED` worker loop would serve indefinitely.

The two goals are not in tension, because the outbox and Kafka solve different problems.

## Decision

We will write domain rows and outbox events in one transaction; a relay will poll the outbox and
publish to Kafka; consumers will read from Kafka. Kafka will be **partitioned by the outbox
row's `partition_key`** and will never sit on the message send path.

## Consequences

| | |
|---|---|
| Positive | Atomicity is kept by the outbox, which is in the transaction. Durability, replay and independent consumer groups are gained from Kafka. A new consumer needs no producer change. Ack latency is untouched, since Kafka is nowhere near the send path. The learning goal is met on a real pipeline rather than a toy. |
| Negative | A system to operate that the throughput does not require. Accepted knowingly. At-least-once delivery now has two causes rather than one - relay retries and consumer rebalances - so consumer idempotency becomes load-bearing twice over. |
| Follow-up needed | Outbox pruning must not outpace Kafka retention, or replay stops being possible. A hosted Kafka provider is still undecided; verify current offerings rather than trusting memory, as this market has shifted. |

## Alternatives considered

| Alternative | Why not |
|---|---|
| Kafka replacing the outbox, producing straight from handlers | A publish cannot be atomic with the domain write. A crash between commit and publish loses the effect with no error anywhere - which is the precise failure the outbox exists to prevent. |
| Kafka on the message send path | Adds a hop before the ack. Ack latency is the number a chat app is judged on. |
| Outbox only, no Kafka | Technically sufficient, and was the design before this ADR. Rejected because it does not serve the stated learning goal, and because independent consumers (search, analytics, audit) would each need bespoke plumbing later. |
| Partition Kafka by message id or round-robin | Kafka guarantees ordering *within a partition only*. Any key other than the channel silently breaks per-channel ordering, and the symptom is a system message arriving before the event that caused it. |
| Database triggers, as in v1 | Implicit ordering, untestable, and the documented source of the v1 bootstrap bugs. |
