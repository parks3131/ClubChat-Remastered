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
| **A push send fails** | Retried by the worker, because the deferred evaluation is **an outbox row of its own** (`push.deferred`, due at `now() + 8s`) rather than a timer - so it takes the same backoff, parking and alarm as every other effect. The notification row exists regardless, so the in-app inbox is still correct. Dead tokens are marked `invalidated_at`. | None in-app. Push is lost only after the full attempt budget, and that parks loudly. |
| **The worker is killed mid-deferral** | Nothing is pending in memory to lose: the eight-second wait is `next_attempt_at` on a durable row, so the next worker to start claims it and evaluates the read cursor then. | None. |
| **A client is offline for a week** | On return: sync by `seq` per channel, batched and paginated. | None. |
| **Duplicate outbox processing** | Every effect is idempotent by construction ([Effects engine](04-effects-engine.md)). | None. |
| **A client retries a send after a timeout** | Unique `(channel_id, sender_id, client_msg_id)` → returns the existing `seq`. | No double-post. |

**The invariant that makes all of this simple: nothing is acknowledged before it is durable, and
nothing durable is ever only in Redis or only in a gateway's memory.**

### Two riders on the push row, both learned the hard way

**The "retried by the worker" claim above was false for the life of the project, and this table
was where the belief lived.** Until 2026-08-19 the eight-second deferral was a
`setTimeout(...).unref()` in `worker/effects.ts`, scheduled and never awaited - so the outbox row
that caused the push was stamped `processed_at` about eight seconds before the push was evaluated.
A transient failure inside that window threw into a `void` and produced a single log line with no
event id, no notification type and no recipients; a `SIGTERM` on any deploy destroyed the pending
timer with the row already closed. For `dm_message` and `chat_message`, which write no notification
row by design, nothing anywhere recorded that a push had ever been attempted. The lesson is not
about push: **a table cell describing a recovery is a claim about code, and this one had no code
behind it.** Compare the same shape in AGENTS.md 5.3 entry 19 - a rule asserted in three documents
and implemented in none.

**The one push that is still not retried** is the poll closing-soon reminder in
`worker/scheduled.ts`. It is timer-driven rather than outbox-driven (nothing changes when a
deadline gets within ten minutes, so there is no event to carry), it stamps
`closing_soon_notified_at` in the claim transaction, and it then calls `dispatchPush` inline. A
provider failure there loses that reminder's buzz - the notification row is written and the inbox
is still correct. Routing it through a `push.deferred` row would close this too.
