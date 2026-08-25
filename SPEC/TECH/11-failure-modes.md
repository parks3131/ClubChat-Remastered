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

---

## How anybody finds out

Every row above describes a failure the system survives. This section is about the ones it does
not, and about the only question that matters when one happens: **who is told, and how do we know
they were told.**

### The three ways a failure leaves the machine

| Path | What it carries | Where it goes |
|---|---|---|
| `monitor.capture(error, where, context)` | Every 5xx, every parked outbox event, every failed drain tick, every dropped socket frame, the rate limiter failing open, an uncaught exception in the worker | The process log ALWAYS, and Sentry when `SENTRY_DSN` is set. `where` is the grouping key, `service` says which of the three roles |
| A trace | How long a request took and what it spent the time on, at `SENTRY_TRACES_SAMPLE_RATE` of requests | Sentry, from the api and the gateway |
| A pino line | Everything else, including the hourly parked-event count | The Fly log stream, which nobody is tailing |

The third row is the one to be suspicious of. A log line inside a machine is not a report.

### What is traced, and what is deliberately never traced

`SENTRY_TRACES_SAMPLE_RATE` (default `0.1`, set explicitly in all three `fly/*.toml`) decides how
many requests are timed. It decides nothing about errors: an error is always sent.

`/health`, `/ready` and `/__parity` are never traced whatever the rate says. Fly polls them every
few seconds for the life of the app and they measure nothing, so at any rate above zero they would
be almost everything recorded. The list is `UNTRACED_PATHS` in `packages/server/src/monitoring.ts`.

**The SDK is started by `packages/server/src/instrument.ts`, which is the first import of all
three entrypoints, and the position is load-bearing.** Sentry instruments a library as it is
loaded, so a client started after `fastify` and `pg` are imported produces a transaction with no
database spans under it. That was measured both ways on `node:24-trixie-slim` before this was
written, and it is the difference between "the request took 400ms" and "here is the query that
spent it". Anything that moves that import down the list breaks tracing silently.

**The worker produces no traces at all today**, because it has no HTTP server and therefore
nothing that starts a root span. Its errors are unaffected. Wrapping `drainOnce` in
`Sentry.startSpan` is what would change that, and it has not been done.

### The two drills, and why a drill exists at all

Nothing above proves a report reaches a human. The code has always captured; nobody has ever
received anything. Everything between `capture` and a phone buzzing - the DSN, egress from the
machine, the project, its alert rule - has never run once.

```
SENTRY_DSN='<from fly/api.toml>' node scripts/drills/forced-5xx.mjs --target production
DATABASE_URL='<the live one>'    node scripts/drills/outbox-park.mjs --target production
DATABASE_URL='<the live one>'    node scripts/drills/outbox-park.mjs --target production --revert
```

Both refuse to run without `--target`, and refuse before reading a credential out of the
environment. Neither adds anything to the production surface:

- **The forced 5xx** builds the real app in the operator's own process and registers a throwing
  route on that instance, the way `test/error-reporting.test.ts` does. There is deliberately no
  route on the live API that raises a 500 on demand: that would be permanent attack surface
  bought for a drill that runs twice a year.
- **The parked event** writes one synthetic row into a partition of its own
  (`drill:monitoring:<uuid>`, where every real partition key is a bare uuid) and lets the RUNNING
  worker park it, so the alarm is the real one from the real process. `--revert` deletes by that
  partition prefix and never by "parked", because deleting parked rows would destroy the evidence
  that a real effect never ran. **Always run the revert**: retention never reduces the parked
  count, so a drill left in place makes that number permanently wrong by one.

### The one an operator would never have found

**Every 5xx reached Sentry with no `where` tag and no `method`, `route` or `userId` context**, for
as long as the api has been deployed. `@sentry/node` 10 captures Fastify 5 errors itself, through
the diagnostics channel, before `app.ts`'s own error handler runs; two captures of one `Error`
means the Dedupe integration keeps the first and drops the second. The event that survived was the
SDK's, which knows nothing about any of those fields, and ours - which is the entire reason the
error handler passes the route PATTERN rather than the URL - was thrown away.

Nothing about it is visible from inside the process. `capture` ran, did not throw, returned an
event id, and an issue appeared in Sentry. Only the tags on the issue were missing, and only
somebody looking at the issue would ever know. It was found by pointing the forced-5xx drill at a
collector and reading the envelope, which is a fair summary of why the drills exist at all.

`monitoring.ts` now passes `fastifyIntegration({ shouldHandleError: () => false })`, which turns
off the SDK's error capture and leaves its tracing instrumentation alone, and
`test/monitoring-sdk.test.ts` asserts the surviving event carries both. **The rule this leaves
behind: a report that arrives is not a report that is useful, and the only way to tell the
difference is to read what came out the other end.**

### The gap this does not close

**The parked-event alarm is edge-triggered and the standing count is not alarmed at all.**
`worker.outbox.parked` fires once, at the moment a row parks. A row that parked while `SENTRY_DSN`
was unset, or before that deploy, was reported to Sentry exactly never, and the only recurring
mention of it is the hourly pino line in `runRetentionSweep` - which is a log line inside a
machine, the row of the table above that does not count. Routing `parkedEventCount` through
`monitor.capture` on the housekeeping tick would turn it into a standing alarm.

**A mobile crash is still unreadable, and it is one secret away from not being.** The client's
half is otherwise complete: `app.json` declares the org and project, CNG generates
`ios/sentry.properties`, the Xcode project carries both the bundle phase and the "Upload Debug
Symbols to Sentry" phase, and Expo 57 already stamps a Debug ID into the bundle and its map
(measured with `npx expo export -p ios --source-maps`). What is missing is `SENTRY_AUTH_TOKEN` in
the EAS build environment, so `sentry-cli` uploads nothing and a production stack trace is
minified line numbers. It is a real secret and must never be in this repository:
`eas secret:create --scope project --name SENTRY_AUTH_TOKEN --type string --value <token>`, with a
token scoped to `project:releases`.

**The server needs no source maps at all**, and that is worth stating so nobody goes looking. There
is no build step: Node runs `.ts` by stripping types, the image ships the source, and a stack trace
already points at real line numbers in a file that is present. `SENTRY_RELEASE` is what ties it to
a commit.
