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

## Exit ramp

This decision is deliberately cheap to reverse, and the reversal is defined here so it is a
choice rather than a defeat.

**Drop Kafka if, during or after Phase 1.5, any of these is true:**

- Operating it is consuming time that Phase 2 needs, and the learning goal has already been met.
- A production incident traces to Kafka itself - a rebalance storm, a stuck partition, a
  misconfigured retention - rather than to our own consumer logic.
- The hosted provider situation turns out to be expensive or awkward enough that self-hosting a
  broker becomes the path of least resistance. Running a broker to serve 50 writes/sec is not a
  trade worth making.

**What reversal costs, in full:**

| Change | Size |
|---|---|
| Merge the relay back into the worker, reading the outbox directly with `FOR UPDATE SKIP LOCKED` | One file |
| Rename `outbox.published_at` back to `processed_at`, since it would again mean "effect performed" | One migration |
| Delete the DLQ topic and its alerting | Config |
| Update [Effects engine](../TECH/04-effects-engine.md), [Failure modes](../TECH/11-failure-modes.md) and the system diagram | Docs |

Nothing in the domain model, the channel log, the policy module, the protocol, or the client is
affected. **The outbox already works without Kafka** - that is the property that makes this
decision safe to take, and it must not be traded away by letting business logic drift into the
relay or by making any consumer depend on Kafka-specific semantics.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Kafka replacing the outbox, producing straight from handlers | A publish cannot be atomic with the domain write. A crash between commit and publish loses the effect with no error anywhere - which is the precise failure the outbox exists to prevent. |
| Kafka on the message send path | Adds a hop before the ack. Ack latency is the number a chat app is judged on. |
| Outbox only, no Kafka | Technically sufficient, and was the design before this ADR. Rejected because it does not serve the stated learning goal, and because independent consumers (search, analytics, audit) would each need bespoke plumbing later. |
| Partition Kafka by message id or round-robin | Kafka guarantees ordering *within a partition only*. Any key other than the channel silently breaks per-channel ordering, and the symptom is a system message arriving before the event that caused it. |
| Database triggers, as in v1 | Implicit ordering, untestable, and the documented source of the v1 bootstrap bugs. |
