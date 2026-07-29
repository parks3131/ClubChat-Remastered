# ADR-0004: Use Postgres, not a NoSQL store, for the system of record

| | |
|---|---|
| Status | Accepted |
| Date | 2026-07-28 |
| Deciders | parks3131 |
| Supersedes | none |

## Context

The reference architecture puts messages in Cassandra or DynamoDB. Its reasoning is sound *for
its own scale*: ~500,000 writes/sec, beyond any single machine, against query patterns that are
genuinely trivial - fetch by user, by conversation, or by timestamp, all key-value lookups by
partition key. Its server is a relay, so it never asks a hard question.

ClubChat's numbers are four to five orders of magnitude smaller (~50 writes/sec at peak,
~40 GB/year of message rows), and its queries are not trivial.

## Decision

We will use a single Postgres primary as the system of record for every domain entity, including
the message log.

## Consequences

| | |
|---|---|
| Positive | Transactions, foreign keys and unique constraints are available, and the architecture depends on all three. The outbox can be atomic with the domain write. `seq` allocation can be a locked read-modify-write. Every invariant in [Domain model](../PRD/01-domain-model.md) is enforceable by the database rather than by application code that races. Joins make the merged calendar feed and the authorization chain expressible directly. |
| Negative | Write throughput is bounded by one machine. Irrelevant at ~50 writes/sec, and the seam is named: partition `messages` by channel first, which is native Postgres and needs no new system. |
| Follow-up needed | None. Revisit only past roughly 100x current projections. |

## Alternatives considered

| Alternative | Why not |
|---|---|
| Cassandra or DynamoDB for messages | No multi-partition transactions, so the transactional outbox (ADR-0006) cannot exist. No locked read-modify-write, so gapless per-channel `seq` (ADR-0003) is effectively unimplementable without an external coordinator. No unique constraints, so the one-owner-per-club invariant - documented as having *no recovery path* if violated - becomes application code under concurrency. |
| A document store for flexibility | Our authorization is a join chain: is this user an admin of the club that owns the race that owns this channel. Denormalising that is exactly the class of drift that ADR-0002 exists to eliminate. |
| Postgres for domain, NoSQL for messages | Splits the transaction boundary precisely where the outbox needs it whole, and buys throughput headroom we are nowhere near needing. |

## Note

This is not a rejection of NoSQL as such. Redis is in the design for the connection registry,
pub/sub and rate-limit buckets - ephemeral, high-churn, non-authoritative data where losing
everything must be survivable, and is (see [Failure modes](../TECH/11-failure-modes.md)). The
rule is narrower than "prefer relational": **data carrying invariants goes somewhere that can
enforce them.**
