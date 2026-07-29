# Failure modes and recovery

The transcript's resilience requirement - *"if the server that needs to push a message goes
down, the user must still eventually receive the message"* - is satisfied structurally, because
the channel log is committed before any delivery is attempted.

| Failure | Behaviour | Data loss |
|---|---|---|
| **A gateway crashes** | Sockets drop. Clients reconnect (backoff + jitter) to another gateway, subscribe, sync by `seq`. Stale Redis entries expire by TTL. | **None.** Everything acked was committed. |
| **All gateways down** | No realtime. Clients fall back to REST reads ([Cross-cutting UX](../PRD/16-cross-cutting-ux.md) rule 4). Sends queue in the client outbox. | None. Degraded, not broken. |
| **Redis is wiped or unavailable** | Connection registry empty → cross-gateway publish finds nothing → realtime stops. Clients keep working over REST and recover via sync on reconnect. Rate limiting fails **open** (log and alert). | **None** - Redis holds no source of truth. This property is non-negotiable. |
| **The worker is down** | Kafka retains the events; the consumer group's offset stops advancing. Chat still works (messages commit and deliver). System messages, cards, notifications and pushes are *delayed*, not lost - they resume from the offset on restart. | None. |
| **Kafka is down** | The relay cannot publish, so outbox rows accumulate unpublished. Chat still works, exactly as when the worker is down. On recovery the relay drains in `id` order and nothing is skipped. | None - the outbox is the buffer, which is the second reason it survives [Effects engine](04-effects-engine.md). |
| **Kafka loses a partition / consumer rebalances mid-batch** | Events are redelivered. Every effect is idempotent by construction ([Effects engine](04-effects-engine.md)), so redelivery is a no-op. | None. |
| **Postgres primary fails** | Writes fail. Clients show visible send failure and retry from the outbox. Restore from replica / PITR. | Bounded by replication lag. |
| **A push send fails** | Retried by the worker; the notification row exists regardless, so the in-app inbox is still correct. Dead tokens are marked `invalidated_at`. | None in-app. |
| **A client is offline for a week** | On return: sync by `seq` per channel, batched and paginated. | None. |
| **Duplicate outbox processing** | Every effect is idempotent by construction ([Effects engine](04-effects-engine.md)). | None. |
| **A client retries a send after a timeout** | Unique `(channel_id, sender_id, client_msg_id)` → returns the existing `seq`. | No double-post. |

**The invariant that makes all of this simple: nothing is acknowledged before it is durable, and
nothing durable is ever only in Redis or only in a gateway's memory.**
