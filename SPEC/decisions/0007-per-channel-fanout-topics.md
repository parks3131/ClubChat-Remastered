# ADR-0007: Fan out over per-channel topics, not per-user topics

| | |
|---|---|
| Status | Accepted |
| Date | 2026-07-28 |
| Deciders | parks3131 |
| Supersedes | none |

## Context

The reference architecture publishes each message to the **per-user** pub/sub channel of every
recipient: for a 50-person group, up to 50 publishes and 50 subscriber authorizations per
message.

v1 had the same shape in a worse form - three project-wide subscriptions with no filter.
[Roadmap and open questions](../PRD/17-roadmap-and-open-questions.md) records the measured cost:
with 200 concurrent users, one message insert cost roughly 200 authorizations, 200 billed
realtime messages, and 200 full refetches.

ClubChat's largest channel is a ~300-member club, three times the reference design's stated
group cap.

## Decision

We will publish once to a per-channel topic, `chan:{channel_id}`, and authorize a subscription
**once at subscribe time** rather than once per message per recipient.

## Consequences

| | |
|---|---|
| Positive | Cost per message is one write and one publish, independent of channel size. Fan-out reaches gateways (a handful) rather than users (hundreds), and each gateway then fans out in-process, which is cheap. Authorization moves off the hot path entirely. |
| Negative | A membership change must invalidate an existing subscription, since access was checked at subscribe time and is not rechecked per message. Removal from a club or race has to force-unsubscribe that user's sockets. |
| Follow-up needed | The membership-cascade effects must drop affected subscriptions, not only the database rows. |

## Alternatives considered

| Alternative | Why not |
|---|---|
| Per-user topics, as in the reference design | Authorizes once per message per recipient, which is the exact cost v1 measured and the debt item this ADR closes. For a 300-member club it is 300 publishes where one suffices. |
| Per-user topics with a cached authorization result | Keeps the publish amplification and adds a cache invalidation problem, which is the same invalidation work as the chosen design plus the fan-out cost. |
| Unfiltered subscriptions, as in v1 | Every user receives every row in the project. Not a real option; it is the defect being fixed. |
