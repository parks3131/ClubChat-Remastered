# Deployment

**Nothing is deployed yet.** As of 2026-08-21 the three roles have never run anywhere but
development machines, and [Road to the first club](20-road-to-the-first-club.md) milestone 5 is the
work that changes that. This document is the deployment as designed, plus the rules that bind every
change once it exists.

It is written *before* the first deploy on purpose. Every rule below is free to follow from the
first deploy and expensive to retrofit: once a few hundred people hold a build of the app, a
compatibility mistake cannot be un-shipped, only followed by another release.

[Stack and hosting](15-stack-and-hosting.md) owns **which** technology and why. This document owns
**how a change reaches a person**, and does not restate it.

---

## The deployed system

| Piece | Runs on | Reached by |
|---|---|---|
| `api` (`src/api/main.ts`) | Fly.io | The client, over HTTPS |
| `gateway` (`src/gateway/main.ts`) | Fly.io | The client, over WSS |
| `worker` (`src/worker/main.ts`) | Fly.io, no ingress | Nothing. It polls the outbox |
| Postgres 17 | Neon | api, gateway, worker |
| Redis | Upstash | api, gateway, worker |
| Identity and content buckets | Cloudflare R2 | The client for presigned `PUT`, the CDN for reads |
| Web client | Vercel | Browsers |
| JavaScript bundles | EAS Update | Phones |

**One image, three roles.** `packages/server` has three entrypoints over one dependency graph, so a
single image is built and the role is chosen by the start command. This is
[Overview](00-overview.md)'s deployment note made concrete: the boundary that matters is the *code*
boundary, so how many deployables there are stays a deploy-time choice rather than a refactor.

The gateway is a separate deployable from the api because it is the only role whose restart is felt
by every connected client at once. It should be able to hold connections while the api rolls.

**Three Fly apps, not one app with three process groups**, decided 2026-08-21 in
[ADR-0043](../decisions/0043-the-three-roles-deploy-as-three-fly-apps.md). One image is built and
pushed once, then deployed to all three by digest, because the Fly registry is scoped per
organization. Each app's config lives in `fly/<role>.toml`.

****Both timeout ceilings travel as `-c` flags inside the `options` startup parameter, not as `pg`'s
own fields.** Measured against the real project on 2026-08-21: Neon's direct endpoint **silently
discards** `statement_timeout` and `idle_in_transaction_session_timeout` when sent individually, so
a session that asked for `30s` and `2min` came back reporting `0` and `5min`. Not an error, which
would have failed the deploy loudly. `options` is passed through intact. See `AGENTS.md` failure
mode 37, and ask the server with `SHOW` rather than trusting that a setting arrived.

`DATABASE_URL` is Neon's DIRECT endpoint, never the pooled one, and this is not a preference.**
`db/client.ts` sends `statement_timeout` and `idle_in_transaction_session_timeout` as startup
parameters. Neon's pooled endpoint accepts five startup parameters and no others, and fails the
connection outright with `unsupported startup parameter` on anything else; PgBouncer's
`track_extra_parameters` cannot cover them because it can only track parameters Postgres reports
back, and neither timeout is one. So the pooled endpoint was never available while those two
ceilings exist, and the ceilings are the thing stopping a runaway query from holding a connection
forever. The restriction applies only to the pooled endpoint.

That makes connection count a budget rather than an afterthought. Each role opens one pool at
`max: 20`, so one machine per role is 60 connections, and 80 while a migration runs, because
`db/migrate.ts` opens its own pool.

**Neon derives the connection limit from the compute's MAXIMUM autoscale size, not its minimum.**
The provisioned compute autoscales `0.25 - 1 CU`, which allows **443 direct connections**, so the
80-connection deploy window has wide headroom and several machines per role would still fit. Had
the ceiling been left at a fixed 0.25 CU the limit would have been 97, which is why the maximum is
worth checking before assuming a number.

**Scale to zero is disabled deliberately, and the plan pays for that.** The worker polls the outbox
four times a second forever, so the compute never sees the five idle minutes that would suspend it.
On Neon's Free plan that is fatal rather than merely costly: Free caps compute at roughly 400 hours
a month against the 730 a month contains, and on exhaustion Neon suspends the compute until the
next billing period. The database would stop, mid-month, every month. The project therefore runs on
**Launch with scale-to-zero off**, which is a straightforward consequence of the effects engine
polling and not a tuning choice.

---

## How a change reaches a person

Three paths at three different speeds. Knowing which one a change takes is most of release planning
here.

| The change is in | Path | Reaches everyone in |
|---|---|---|
| Schema | `npm run db:migrate` against Neon | Seconds, all at once |
| Server code | `fly deploy` | Minutes, all at once |
| Client JavaScript | `eas update` | Hours to a day, as phones relaunch |
| Client native | `eas build` plus a store submission | Days, and **never everyone** |

That last row is what shapes the rules below. A server deploy replaces every copy of the old code.
A client release does not: it adds a new version *alongside* every older one still installed, and
some of those never update.

A change is native, not JavaScript, if it touches the `plugins` array in `app.json`, adds a native
module, changes a permission, or moves the Expo SDK. Everything under `src/` and `app/` alone is
JavaScript.

---

## The rules

Numbered so they can be cited from a commit, an ADR or a review.

### Order

**1. A deploy runs in one order: schema, then server, then client.** The column exists before code
selects it, and the endpoint exists before the app calls it. Reversed, the gap between two steps is
served to live users as errors, and it is a gap that was chosen rather than suffered.

**2. Removal runs in the reverse order, and it is a separate release.** Stop reading the thing, ship
that, wait for old builds to drain, then drop it. Rule 4 is why.

**3. A native build ships before the JavaScript that imports it, never after.** A JS bundle reaches
every phone the moment `eas update` publishes, while the binary carrying the native module is still
in a build queue. A native import resolves at bundle load, so the mismatch is a launch-time crash no
JavaScript can catch. This took the app down twice in one hour; see `AGENTS.md` failure modes 8
and 32.

### Compatibility

The next four rules exist because **the client is not a version, it is a distribution.** After the
first release every deploy meets several builds of the app at once, including builds written before
the change existed.

**4. Add columns. Never rename or drop one in the same release as the code that stops using it.** A
rename is a drop plus an add, and it breaks every build already installed at the instant it applies.
Expand, migrate, contract: three releases weeks apart, not one.

**5. A response may gain a field. It may never lose one, and it may never keep a name while changing
what the name means.** An older client reads the field it knew, by the name it knew.

**6. A new meaning is a new endpoint or a new frame type, never a changed one.**
[Protocol](10-protocol.md) is a contract with the builds that shipped, not only with the current
one.

**7. A new column is nullable or carries a default.** A `NOT NULL` column with no default fails
against the rows that already exist, and a server that requires it fails against clients that do not
send it. Where the invariant genuinely requires `NOT NULL`, that is a backfill and then a second
migration, not one migration.

Rules 4 to 7 sit on top of the constraint discipline in the
[migration checklist](../templates/migration-checklist.md) and do not relax any of it. In
particular **rule 7 does not license a nullable column inside a unique index**: Postgres treats
`NULL`s as distinct, so one nullable column silently defeats the whole constraint.

### Addressing

**8. The client reaches a hostname this project owns, chosen once, and never changed.**
`EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_WS_URL` are inlined into the bundle when it is built. They
are not configuration a running server can correct: they are baked into every installed copy. A
build that shipped pointing at a provider's own hostname has pinned that provider for the life of
the install.

| Name | Points at |
|---|---|
| `api.<domain>` | Fly, the api role |
| `ws.<domain>` | Fly, the gateway role |
| `cdn.<domain>` | The R2 content bucket, per [Media pipeline](07-media-pipeline.md) |

This is what keeps the hosting row in [Stack and hosting](15-stack-and-hosting.md) reversible. A
move to another provider becomes a DNS change that no installed app notices.

### Everything else

**9. Every deploy is of a commit that passed CI on `main`.** Not a local build, not a branch.

**10. Secrets are set on the platform, never in the repo** (`AGENTS.md` non-negotiable 5).
`fly secrets set` for the server roles, the EAS dashboard for anything a build needs. The only class
safe to inline is an `EXPO_PUBLIC_` value that is write-only in the client's hands, which is why the
Sentry DSN qualifies and nothing else in `.env.example` does.

**11. A rolling deploy redelivers.** `SIGTERM` part-way through a drain is the commonest cause of an
outbox event being handled twice, which is why [Effects engine](04-effects-engine.md) requires every
effect to be idempotent. A deploy is the routine event that tests that requirement, so an effect
idempotent only in theory fails on an ordinary Tuesday.

**12. A migration that has been applied is never edited**, in production exactly as in development.
`AGENTS.md` non-negotiable 2, and the [migration checklist](../templates/migration-checklist.md).

---

## Health checks, and what they gate

Fly gates **both** traffic routing and deploy success on the health check, which makes a check that
cannot fail actively dangerous: a deploy against an unreachable Neon would go green and then take
live traffic. Two endpoints, on the api and the gateway, and the distinction between them is the
whole point.

| Path | Answers from | Fly points its check at | Purpose |
|---|---|---|---|
| `/health` | Process memory. Touches nothing | **Never** | Liveness. It cannot fail, so it can never gate anything. It exists so a future restart policy has something to ask that does not restart-loop a process whose dependency merely blipped |
| `/ready` | A real round trip to Postgres | **Yes** | Readiness. `200`, or `503` with a body of exactly `{"error":"not_ready"}` |

**Readiness fails on Postgres and deliberately does not fail on Redis.**
[Failure modes](11-failure-modes.md) records Redis being wiped or unavailable as a *degrade* with no
data loss: realtime stops, clients keep working over REST and recover by sync, and the limiter fails
open. Every instance shares one Redis, so failing readiness on it would pull every instance out of
rotation at once and convert a documented degrade into a total outage. Redis failure is logged and
captured instead. Making Redis fatal is a change to [Failure modes](11-failure-modes.md), not a
change to a handler.

**The response body never names the failing dependency.** An unauthenticated caller gets a status
code and nothing else: no driver text, no connection string, no stack. The operator learns which
dependency failed from the log and from Sentry, and the capture fires on *transition* rather than on
every poll, because a check running every fifteen seconds that reports each failure would exhaust
the Sentry quota during exactly the outage it exists to report.

**The worker has no health gate at all**, and that is a property of having no ingress rather than an
omission. A worker that boots, connects, and then silently stops draining looks identical to a
healthy one from outside. The durable evidence that an effect never ran is a **parked outbox event**,
which is why alerting on parked events is the only real signal this role has.

**The gateway's own shutdown depends on this check.** The gateway now owns its HTTP server rather
than letting `ws` create one, and `wss.close()` deliberately does not close a server it did not
create - so `close()` calls `closeAllConnections()` before `server.close()`. The connection that
makes that necessary is one with a request **in flight**, not an idle keep-alive socket: since Node
19 `server.close()` closes idle connections itself, but it still waits for a request being served,
and a readiness request is waiting on a database. Measured at 4.9 seconds without that call against
5 milliseconds with it, on a probe whose dependency merely hangs. Without it `SIGTERM` outlives its
grace period, never reaches the pool, and Fly kills the machine part-way through a deploy, which is
rule 11's redelivery case made routine. The probe those destroyed requests were waiting on still
settles afterwards, so the handler checks the response is alive before writing to it.

## What CI proves, and what it does not

`.github/workflows/ci.yml` runs on every push and pull request, and two of its steps are deployment
safety rather than test hygiene:

- **`db:migrate` from zero against an empty database** catches a migration that cannot replay. It is
  the check a developer with an existing database never performs by hand.
- **`db:prove`** attempts to violate each invariant and watches it be rejected.

Neither says anything about **compatibility with builds already installed**, and nothing in CI can:
it holds one copy of the code, and the problem rules 4 to 7 address is having several at once. Until
something enforces it, that is a review obligation rather than a gate.

---

## Open

Recorded so that silence is not read as a decision.

- ~~Whether the three roles deploy as three Fly apps or as one app with three process groups.~~
  **Decided 2026-08-21: three Fly apps from one image**, pushed once and deployed to all three by
  digest. See [ADR-0043](../decisions/0043-the-three-roles-deploy-as-three-fly-apps.md), which also
  records the argument that was *refuted* rather than accepted: the gateway does not need an L4 path
  on Fly, because Fly's HTTP handler proxies a WebSocket upgrade.
- The rollback procedure. **Half of it is now decided**: a schema change is never rolled back, only
  followed forward, which is what rules 4 to 7 already make safe by keeping every migration
  additive. Migrations run as the api app's `release_command`, on a temporary machine using the
  newly built image, before any machine is updated, and a failure there stops the deploy. That
  gives forward safety only: `fly deploy` rolls machines back and cannot un-apply a migration, and
  it does not need to, because the previous image still runs against the new schema. What remains
  open is the *machine* rollback drill, which has never been performed.
- Backup restore, monitoring, and the mail domain. These are
  [milestone 5](20-road-to-the-first-club.md) exit criteria rather than open choices.
- Kafka still has no hosted provider ([Stack and hosting](15-stack-and-hosting.md)). Managed Kafka
  is the largest single line item in any hosting estimate at this scale, so the provider choice is
  as much a cost decision as a technical one.
- Whether the web client stays on Vercel's free tier, which turns on whether this deployment counts
  as commercial use.
