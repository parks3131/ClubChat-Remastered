# Deployment

**Deployed for the first time on 2026-08-23.** Three Fly apps in the `clubchat` organization, one
machine each in `iad`, from a single image built once and deployed to all three by digest; the
migration run by the api's `release_command` before any machine took traffic;
`api.clubchatapp.com` and `ws.clubchatapp.com` holding Fly certificates;
`cdn.clubchatapp.com` answering from the Worker; and the api serving media in `cdn` mode.
[Road to the first club](20-road-to-the-first-club.md) milestone 5 holds the standing of what that
did and did not settle, and this document does not restate it. What this document is remains what
it was: the deployment as designed, plus the rules that bind every change.

**The rules below were written *before* that first deploy on purpose, and not one of them changed
when it happened**, which was the point of writing them early. Every one is free to follow from the
first deploy and expensive to retrofit: once a few hundred people hold a build of the app, a compatibility mistake
cannot be un-shipped, only followed by another release.
**This is deployed.** Since 2026-08-23 the three roles run as three Fly apps in the `clubchat`
organization, one machine each in `iad`: `clubchat-api` at `api.clubchatapp.com`,
`clubchat-gateway` at `ws.clubchatapp.com`, and `clubchat-worker` with no ingress. Postgres is
Neon, migrated by the api's Fly `release_command`, and `cdn.clubchatapp.com` is a Cloudflare
Worker. [The first cutover](#the-first-cutover) below is the procedure that was followed, kept
because the next environment will follow it too. Anything in this repo still saying nothing is
deployed is stale.

Most of this document was written *before* that first deploy, on purpose. Every rule below is free
to follow from the first deploy and expensive to retrofit: once a few hundred people hold a build
of the app, a compatibility mistake cannot be un-shipped, only followed by another release.
[The drills](#the-drills) is the part written after, and it covers the three things that are
supposed to protect a live system and had never once been performed.

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
| `cdn-worker` (`packages/cdn-worker`) | Cloudflare Workers, paid plan | The client, over HTTPS, for media bytes |
| Web client | Vercel | Browsers |
| JavaScript bundles | EAS Update | Phones |

**Seven of those nine rows are live as of 2026-08-23; the last two have never run.** The three Fly
apps, Neon, Upstash, both R2 buckets and the Worker all serve today. The web client has never been
deployed to Vercel, and `apps/mobile/app.json` declares no `updates` block and no
`runtimeVersion`, so there is no EAS Update channel for a bundle to reach a phone through. Both are
milestone 5 work rather than rows this table got wrong.

**The CDN row is the one piece here that is not built from the server image**, and it is the only
part of the system that does not run on Node. It is deployed by `wrangler`, and it exists because
`cdn.<domain>` has to validate the `exp`/`sig` pair that [Media pipeline](07-media-pipeline.md)
specifies, which a bucket cannot do. See
[ADR-0044](../decisions/0044-the-cdn-is-a-worker-that-validates-before-it-reads.md), and rule 8
below for why that hostname must never be pointed at a bucket instead.

**It is also outside the error reporting this document otherwise assumes.** [Stack and
hosting](15-stack-and-hosting.md) puts every server failure through Sentry, on the `clubchat-server`
project; a Worker exception reaches neither, and is visible only in Cloudflare's own observability.
Nothing pages on it. This
is an accepted gap recorded in ADR-0044 rather than an oversight, and the Worker is written to turn
its known failure modes into status codes rather than throws because of it.

**What actually puts a server failure through Sentry is `SENTRY_DSN`, which each `fly/<role>.toml`
carries in its `[env]` block** for the reason rule 10 gives. `config.ts` marks it optional and
`initMonitoring` captures to the process logger when it is absent, which is deliberate: it is what
makes every capture path run in development and in CI rather than executing for the first time in
production. It has one consequence worth stating where an operator will meet it. **A role with no
DSN boots, logs, and looks exactly like a role with one**, and `SENTRY_ENVIRONMENT = 'production'`
sitting beside an empty DSN reads as wired from every angle except the Sentry project itself. That
is why milestone 5's exit criterion is a deliberately raised 5xx *arriving*, rather than a config
file that mentions Sentry. **All three roles now carry the DSN and all three are deployed with it,
and no error has yet been seen to arrive**, which is exactly the state that criterion exists to
distinguish from a working one.

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

**How many machines a role runs is a flag, and its default is not one.** `fly deploy` creates spare
machines for every process group that declares a service (`--ha`, which defaults to true), so on an
app that has no machines yet the api and the gateway each come up as two, and the worker, which
declares no service, comes up as one. That is 100 pool connections rather than the 60 above, and 120
while the migration runs. Both fit inside 443, so this is a headroom question rather than a safety
one, but the budget above, `fly/worker.toml`'s own "exactly one machine", and every number in this
document describe one machine per role. **The first cutover therefore passed `--ha=false`**, and
each of the three apps runs exactly one machine today, so the shape that is deployed is the shape
that was reasoned about and a request that fails by hand can only have come from the one machine
you are looking at. A second api or gateway machine afterwards
is `fly scale count`, chosen against socket count or outbox depth rather than inherited from a flag
default. The flag only bites on an app with no machines: a later deploy updates the machines that
already exist.

**Each role pins its machine size in `[[vm]]`, and the api is the role that decides the number.**
Fly's default guest for a config that declares none is the smallest `shared-cpu-1x`, 256 MB.
`media/pipeline.ts` imports `sharp` at module top and `api/routes/media.ts` imports that module, so
the api loads libvips at boot rather than on the first upload; `completeUpload` then reads an object
of up to `MAX_IMAGE_BYTES` (25 MB) into memory, walks every pixel of it to prove it really is an
image, and re-encodes it whenever a crop was chosen. A default-sized machine meets that as an
out-of-memory kill on somebody's photo, on a request that succeeded on every laptop it was ever
tried on.

**A byte cap is not a pixel cap, and reading the 25 MB as the ceiling on that decode is the
misconception that let an unbounded one survive.** `MAX_IMAGE_BYTES` bounds the *compressed* file;
libvips allocates the decompressed surface, which follows from the declared dimensions and has
nothing to do with the file size, so a file well inside 25 MB can demand a far larger bitmap.
Until 2026-08-23 nothing bounded it at all: `DECODE_OPTIONS` set only `failOn`, leaving sharp's
default `limitInputPixels` of 268402689 pixels, which at four bytes a pixel is 1.00 GiB of raw
bitmap for one image - the whole of the api's guest rather than a limit on it. The real bound is
now `MAX_IMAGE_PIXELS` in `media/probe.ts`, `64 * 1024 * 1024`, folded into the shared
`DECODE_OPTIONS` so that both call sites handing bytes to libvips carry it. That is 256 MiB per
decode, chosen so a 50 megapixel Android photograph is still accepted while the 108 and 200
megapixel full-resolution modes are refused.

The values live in `fly/<role>.toml` and are deliberately not restated here.

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
| `cdn.<domain>` | A Cloudflare Worker that validates `exp`/`sig`, per [Media pipeline](07-media-pipeline.md) |

This is what keeps the hosting row in [Stack and hosting](15-stack-and-hosting.md) reversible. A
move to another provider becomes a DNS change that no installed app notices.

**The first two rows are permanent. The third is not, and the reason above does not apply to it.**
Only `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_WS_URL` are inlined into a build. There is no
`EXPO_PUBLIC_CDN_URL` and no client ever constructs a media URL: it learns one from `GET
/media/:id` on every render. `cdn.<domain>` is therefore server-side configuration
(`MEDIA_CDN_BASE_URL`), changeable with a deploy, and the only cost of changing it is that URLs
already memoized on devices stop resolving within at most two hours. Recorded because a document
that overstates permanence makes people slow on a decision that is cheap to reverse.

**Never point `cdn.<domain>` at a bucket.** Cloudflare offers an R2 custom domain in two clicks and
it would serve on this hostname without ever reading `exp` or `sig`, publishing every private chat
photo, document and Eboard image to anyone holding a URL, permanently. The signature is validated
at the edge and nowhere else; a bucket has never heard of it.

### Everything else

**9. Every deploy is of a commit that passed CI on `main`.** Not a local build, not a branch.

**10. Secrets are set on the platform, never in the repo** (`AGENTS.md` non-negotiable 5).
`flyctl` for the server roles, `wrangler secret put` for the CDN Worker, the EAS dashboard for
anything a build needs. The one class safe to commit is a **write-only ingest address**: a Sentry
DSN can send events to a project and can never read one, so it is configuration rather than a
credential, and it is committed on both sides of the system for that reason alone.
`EXPO_PUBLIC_SENTRY_DSN` is inlined into the client bundle, and `SENTRY_DSN` sits in the `[env]`
block of each `fly/<role>.toml`. Neither is an exception to this rule: a value that grants no read
is not a secret. Nothing else in `.env.example` qualifies, and the token that uploads source maps
qualifies least of all.

**Prefer `fly secrets import` over `fly secrets set`.** `set` takes the value as a command
argument, which puts it in shell history and in the process table; `import` reads `NAME=VALUE`
pairs from stdin. The two tools also disagree about newlines, and it matters because
`MEDIA_SIGNING_SECRET` has to be byte-identical on the api and the Worker: `secrets import` is line
oriented, so a trailing `\n` terminates the pair, while `wrangler secret put` takes raw stdin and
would make that `\n` part of the key. **Removing a value is `fly secrets unset NAME`.** Setting
`NAME=` with nothing after it stores an empty secret rather than removing one, which `config.ts`
now reads as absent for the optional values and which for a required one is a boot failure rather
than a revert. `packages/cdn-worker/README.md` carries the exact pair of commands, and `/__parity`
is how you find out you got it right rather than assuming.

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

**The same absence means a worker deploy cannot fail.** `release_command` is declared on
`fly/api.toml` alone and `fly/worker.toml` declares no service, so Fly has nothing to wait for and
nothing to ask: a worker whose configuration will not parse crash-loops on the restart policy while
`fly deploy` reports success. Nothing else in this system will report that, so the worker is
verified by reading its own first log line. Step 1 of the cutover below carries the line to look
for.

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

## The first cutover

The order below exists because the first production state should be one that has already run
somewhere. It is three deploys rather than one, and the extra deploy buys two independently green
production states and a one-token rollback to a state that has been watched working.

**It ran on 2026-08-23, in this order, and it stays here as the procedure rather than becoming a
record of one afternoon.** Each step carries what it actually did, because a runbook that cannot
say which of its steps has been performed is a runbook somebody performs twice. **All six are
done.** Step 4 ran late rather than in the position it sits in here, at 16:46Z and after the five
by-hand proofs, for the reason the step's own prose gives: it needs an account to match, and the
account it matched was the one step 3 created.

Two orderings inside it are load-bearing and neither is visible from the steps themselves.
Migrations run before the code that selects from them, which is rule 1 and is enforced by the api's
`release_command` rather than by memory. And **every hostname resolves, and holds a certificate,
before anything is proved against it**, which is the same reasoning one layer out: the name exists
before a device is asked to call it, and before mail is asked to carry a link to it.

**1. The three Fly apps, on `MEDIA_URL_MODE=presign`.** The only media mode that had ever run
anywhere at the time, which is the whole of the argument for starting there. Build the image ONCE
and deploy that digest to all three, api first because its `release_command` runs the migration
(rule 1).

**Before any of it, the secrets exist on all three apps.** Every role parses the whole flat schema
at startup, so a role missing one does not boot, and the three fail differently: the api's
`release_command` refuses a missing `DATABASE_URL` outright and stops the deploy, the api and the
gateway fail their readiness check and therefore fail the deploy, and the worker fails nothing at
all. `fly secrets import` per rule 10, once per app.

**Six of them are shared and `RESEND_API_KEY` and `MAIL_FROM` go on the api as well, before this
step rather than with the mail proof in step 3.** `config.ts` marks both optional, so the flat
schema does not ask for them, but `assertProductionMailer` throws when `NODE_ENV=production` and no
transport is configured and the image sets `NODE_ENV=production` - so an api without the key does
not boot, fails readiness, and fails this deploy for a reason that never mentions a secret list.
`fly/api.toml` documents both, and `PLATFORM_MODERATORS`, in the block of three values that belong
to the api alone; that third one waits for step 4 because it needs an account to match.

```
# From the repo root, on a CLEAN tree at the commit CI passed.
fly deploy --config fly/api.toml --build-only --push \
  --build-arg SENTRY_RELEASE="$(git rev-parse HEAD)"

# Then the digest that command printed, api FIRST. All three pull the same image
# from the same path: the Fly registry is scoped per organization, which is
# ADR-0043's reason for building once at all.
fly deploy --config fly/api.toml     --image registry.fly.io/clubchat-api@sha256:<digest>
fly deploy --config fly/gateway.toml --image registry.fly.io/clubchat-api@sha256:<digest>
fly deploy --config fly/worker.toml  --image registry.fly.io/clubchat-api@sha256:<digest>
```

**The commit stamp is carried by the first command and inherited by the other three.**
`--build-arg` on an `--image` deploy is accepted and does nothing, because no build happens. That
is the correct outcome rather than a limitation: one build means one `SENTRY_RELEASE`, so all three
roles report the same version and `/__parity` can tell two deploys apart. Confirm it landed with
`curl -s https://clubchat-api.fly.dev/__parity | jq -r .version`, which works before step 2 because
Fly issues a certificate for an app's own `.fly.dev` name; a sha is right, and `unknown` means the
`--build-arg` was missed. Rule 8 is about hostnames inlined into a build, not about a `curl`.

**The tree must be clean and at the commit CI passed** (rule 9), because nothing downstream can
check it. The image ships source rather than a build artifact, and `.dockerignore` excludes `.git`,
so the running process holds no way to compare the sha it reports against the code it is executing.
An uncommitted edit at build time produces production stack traces mapped to the wrong source,
permanently, with nothing anywhere saying so.

Three more things about those commands, none of which announce themselves:

- **All four run from the repo root**, which is what makes `--config fly/<role>.toml` the right
  form. The Docker build context is flyctl's own working directory, and both halves of the image
  definition are written against the repo root: `Dockerfile`'s `COPY` lines name
  `packages/server/src` and `packages/shared/src`, and `.dockerignore` excludes `apps/`, `scripts/`
  and `packages/*/vitest.config.ts` by exactly those paths. Each config's
  `[build] dockerfile = '../Dockerfile'` is the other half of the same assumption, written relative
  to `fly/`. Run from inside `fly/` and every `COPY` misses.
- **Never pass `--local-only`** to the build. The default is `--remote-only` and it is the one that
  works: sharp's binaries are its `optionalDependencies` and npm resolves them by platform during
  `npm ci`, so a build on an Apple Silicon laptop installs `@img/sharp-linux-arm64` into a
  `linux/arm64` image that Fly's x86_64 machines cannot run at all. `.dockerignore`'s first entry
  guards the neighbouring version of this, a host `node_modules` dragging `@img/sharp-darwin-arm64`
  into the image, and nothing guards this one.
- **Pass `--ha=false` on each of the three `--image` deploys**, which are the commands that create
  machines. One machine per role is the shape the connection budget above assumes, and this flag is
  what produces it.

Then read the worker's log, because nothing else will:

```
fly logs --app clubchat-worker
```

A worker that parsed its configuration writes `worker started, draining outbox and running the
scheduler`, at `info`, once, after the pool, the Redis connection and the S3 client have all been
built. It arrived once on 2026-08-23, which is the only boot signal this role has and therefore the
only evidence its deploy meant anything. **Its absence is the failure.** `loadConfig` runs before that line, so a secret missing or
mistyped on this role prints a validation error naming the key it could not read and never reaches
it, on a deploy that reported success because this role has no health gate to fail. The same line
arriving repeatedly, seconds apart, is the other fault: a worker that boots and then dies.

**2. `api.<domain>` and `ws.<domain>`, DNS only, grey cloud, never proxied.** Fly terminates its own
TLS, and proxying it through Cloudflare puts two proxies in series and breaks the WebSocket
gateway. Then `fly certs add` for each, and wait for both to be issued: Fly cannot issue a
certificate for a name that does not already point at it, which is why the record and the
certificate are one step and not two.

**Done 2026-08-23.** Both names carry A and AAAA records with `proxied: false`, and Fly has issued a
certificate for each. That the proxy really is off was checked from outside rather than read off the
dashboard's cloud colour: a response from either name carries `server: Fly/...` and **no `cf-ray`
header at all**, which a proxied record could not produce.

**3. Prove signup, chat, push, upload and mail by hand on a real device**, and report each pass or
fail individually rather than as one verdict.

**This is third rather than first, and the reason is rule 8 plus the way better-auth builds a
link.** The build on the device has `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_WS_URL` inlined at
`api.<domain>` and `ws.<domain>`, so before step 2 there is no name for it to call. Mail fails the
same way one layer down and far less visibly: all three configs set `BETTER_AUTH_URL =
'https://api.clubchatapp.com'`, `api/main.ts` hands that to better-auth as `baseURL`, and
better-auth builds the password-reset link from it. A reset requested before the name resolves and
holds a certificate therefore sends a real mail, to the right person, carrying a link to a host that
does not exist. **That is a different cause from the Resend badge in obligation 4 below**, and the
two are worth keeping apart because they present as opposites: one sends no mail, the other sends
mail that looks correct.

**All five passed on 2026-08-23, individually, and the fifth is where the ordering paid for
itself.** The reset mail arrived from `noreply@clubchatapp.com`, and its link resolved and completed:
`POST /api/auth/request-password-reset`, then `GET /api/auth/reset-password/<token>`, then
`POST /api/auth/reset-password`, then `POST /api/auth/sign-in/email`. Under the original step order
that same mail would have been correct in every other respect and would have carried a link to a
host that did not resolve, which is a failure nobody sending it could see. It also closed obligation
3 below by evidence rather than by looking at a badge: Resend will not send from an unverified
domain, so a mail that arrived from this project's own domain **is** the verification.

**4. `PLATFORM_MODERATORS`, once the first account exists.** It is documented in two places and set
in none: [Road to the first club](20-road-to-the-first-club.md)'s milestone 5 secrets row names it
beside the six shared secrets, and `fly/api.toml` carries it in the block of three values this app
alone needs. What it does not have anywhere is a **value**, which is what this step is for. Setting
it before step 1 is allowed and buys nothing: it is a comma-separated list of **email addresses**,
not account ids, and `reconcilePlatformModerators` matches them against `users.email` at API boot,
so an address named before its account exists is reported in the log as `unmatched`, grants nobody
anything, and is not looked at again until the api restarts.

Nothing about the deploy fails without it. `config.ts` marks it optional and the api warns and
boots: `PLATFORM_MODERATORS is not set, so nobody can read the direct-message report queue. Reports
will be filed and never seen.` That warning is the whole of the enforcement, which is why this is a
step rather than a note. On the api alone, because the api is the one process that reconciles:

```
printf 'PLATFORM_MODERATORS=%s\n' "$EMAILS" | fly secrets import --app clubchat-api
```

Rule 10's preference for `import` over `set` applies here as it does everywhere else. The reconcile
runs at boot and nowhere else, so the machine has to come up with the value already in place, and
the log says whether it did: `platform moderators reconciled` with an empty `unmatched`, rather than
the warning above. Here rather than among the obligations below, because the window in which a DM
report can be filed and never read opens the moment somebody other than the operator signs up.

**Done 2026-08-23 at 16:46Z, later in the day than the order above suggests, and that is this step
working rather than slipping.** It ran after the five by-hand proofs instead of before them, because
the address it names has to match an account that already exists, and the only real account this
deployment had was the one step 3's signup created at 15:05Z. The value reached `clubchat-api`
alone, through `fly secrets import`, which rolled the single machine and brought it back answering
`/ready` with a 200. The boot that followed logged
`{"configured":1,"granted":1,"revoked":0,"unmatched":[],"msg":"platform moderators reconciled"}`.

**The empty `unmatched` is the load-bearing part of that line**, and it is the whole reason to read
the log rather than the exit status of the import. It separates an address that matched an account
from one that named nobody: the second grants zero people, changes nothing, and comes back up
looking exactly as healthy as this did.

**One moderator exists, which is a starting position the founder chose for now and not a finished
roster.** The queue has a reader, which is the window this step exists to close. Adding a second
name is another `fly secrets import` and another restart, because the reconcile runs at boot and
nowhere else.

**5. The Worker, on its real hostname, while nothing depends on it.** Deploy it, attach
`cdn.<domain>` as a Workers Custom Domain, and compare `/__parity` on both sides **before trusting
anything**:

```
diff <(curl -sf https://api.<domain>/__parity | jq -r .parity) \
     <(curl -sf https://cdn.<domain>/__parity | jq -r .parity) && echo 'secrets match'
```

A mismatch means the two hold different `MEDIA_SIGNING_SECRET` values and nothing else is worth
investigating until they do not. It is the likeliest failure in this deployment and it presents as
every photo 403ing, which reads as a broken Worker rather than a wrong key.

**Done 2026-08-23, and it matched: both sides answer `D6NXENh3`.** The Worker was then exercised on
its real hostname while nothing depended on it. It served real bytes off both buckets with the right
content types, and it refused for the right reasons in each direction. **With valid signatures**: an
unknown first path segment answers 404 without touching R2 rather than falling back to the private
bucket, a key with no prefix answers 404, a path traversal answers 403 because normalisation breaks
the signature, and a valid signature for an object that is not there answers 404. **With invalid
signatures**: no signature, a tampered signature, a signature minted for another object, and an
expired one all answer 403. Proving the routing with *valid* signatures is what makes those 404s
mean anything, since a broken signature refuses before the router is reached at all.

**Only `parity` is comparable, and diffing the two whole bodies is a trap.** Both sides answer the
same three fields so that one shape serves both, and two of the three differ by design. `version`
is `SENTRY_RELEASE` on the api, a git commit sha, against `CF_VERSION_METADATA.id` on the Worker, a
Cloudflare version uuid: those can never be equal. `previousParity` is always `null` on the api,
which signs and never verifies and therefore holds no previous key, while on the Worker it is the
key the edge still accepts mid-rotation. So a whole-body `diff` reports a difference at exactly the
moment somebody is trying to establish whether the two secrets match. The command above pipes
through `jq -r .parity` for that reason rather than for brevity.

**6. Flip `MEDIA_URL_MODE=cdn` and redeploy the api.** Re-prove media from the phone, and **watch a
URL survive an hour boundary** before calling it done, because the expiry is hour aligned and a URL
that works for fifty minutes proves nothing about the fifty-first.

**Done 2026-08-23, the hour boundary included.** `fly/api.toml` carries `cdn`, the api was
redeployed on the same image digest so that the flip changed one environment value and nothing else,
and photos render on a physical iPhone through the Worker. **The boundary was then watched being
crossed.** Three URLs minted at 16:05Z - a photo original, its thumb variant, and an avatar display
variant - were fetched again at 17:01Z, after the 17:00Z alignment point they were signed against,
and all three answered 200 with their full byte counts. That was the last piece of `cdn` mode
resting on reasoning rather than on having been seen, and it is now the second kind.

### What was measured once, on the way through

**`cf-cache-status` on a real signed URL**, which is the one thing about this deployment that no
amount of further reading could settle:

```
curl -sI '<a signed media url>' | grep -i cf-cache-status
```

**Measured 2026-08-23 against the live Worker: the header is ABSENT.** Nothing is held at the
Cloudflare edge, so `public, max-age=3600` reaches browsers and downstream caches only, and **N
members opening one photo is N reads of R2**. That closes the open half of roadmap debt 7 by
measurement, and it **confirms** the analysis in
[ADR-0044](../decisions/0044-the-cdn-is-a-worker-that-validates-before-it-reads.md) rather than
contradicting it: `HIT` or `MISS` would have meant that ADR was wrong and needed superseding, and
it is worth saying plainly that this was the outcome that left it standing. The claim had been
asserted in five files before anybody checked, so it is now the one thing here backed by a
response header rather than by a vendor document.

Turning caching on is one key, `"cache": { "enabled": true }` in `wrangler.jsonc`. It stays off, and
the decision is now the founder's rather than the measurement's: ADR-0044 records that a shared cache
would promote the red team's URL-spelling finding from origin load into cache pollution, since one
signed URL has unlimited accepted spellings. It is carried in **Open** below for that reason.

### Obligations that survive the cutover

These are not optional tidying. Each one is a live credential or a live gap. **The standing below
is as of 2026-08-23, the day the cutover ran.**

1. **Four credentials that passed through a chat transcript are still not rotated, and the founder
   deferred all four on 2026-08-23.** Recorded here as a deliberate deferral carrying its date,
   because a deferral with a date is a decision somebody can revisit and an undated one becomes an
   oversight nobody owns. The four: the **R2 secret access key**, the **Cloudflare API token**, the
   **Sentry organization auth token**, and the **older Full-access Resend key**. Each is disclosed
   until it is replaced, not until enough time passes that it feels unlikely. Two details survive
   the deferral. The R2 credential is read **and** write where the Worker only ever reads, so the
   rotation is also the moment to narrow it to read-only. And the R2 key must be rotated with the
   Worker already live rather than before it, or the Worker loses its bucket access part-way
   through the change.
2. **Delete the local secrets file** once every value has reached Fly, Cloudflare and EAS. It exists
   outside the repo precisely so that it can be deleted rather than managed. It cannot go while
   obligation 1 is outstanding, which is the second cost of deferring those rotations.
3. ~~**The Resend domain badge.**~~ **Closed 2026-08-23, by evidence rather than by looking.** The
   password-reset mail in step 3 above arrived from `noreply@clubchatapp.com`, and Resend will not
   send from an unverified domain, so the mail arriving is the badge having flipped. The obligation
   this row leaves behind is not the badge: `_dmarc` publishes `v=DMARC1; p=none`, which is the
   [sending-domain checklist](../templates/sending-domain-checklist.md)'s **starting** point,
   and tightening it to `p=quarantine` and then `p=reject` has not happened.
4. **Nothing reports a Worker error.** Accepted for the first deployment and recorded in ADR-0044,
   and unchanged by having deployed. Workers Logs in the Cloudflare dashboard is the only place an
   exception at the edge is visible, and nothing pages on it. The thing that actually tells you the
   Worker is broken is a member saying no photos are loading, and `/__parity` is the first command
   to run when that happens.
5. ~~**`PLATFORM_MODERATORS` has no value, so the direct-message report queue has no readers.**~~
   **Closed 2026-08-23 at 16:46Z.** Step 4 above carries what was done and the one log line that
   proves the address matched an account rather than merely being spelled into configuration. What
   is left is not a gap but a shape worth knowing: the queue has exactly **one** reader, the
   founder's own address, chosen for now. A second name is a second `fly secrets import` and an api
   restart, since the reconcile runs at boot and nowhere else.

---

## The drills

Three things are supposed to protect this deployment, and as of 2026-08-25 not one of them had
ever been performed: **no backup had ever been restored**, **no machine had ever been rolled
back**, and the sending domain published `v=DMARC1; p=none`, which is the policy that explicitly
tells receivers to do nothing. Each is a [milestone 5](20-road-to-the-first-club.md) exit
criterion. Each has the same shape of failure, which is why none of them got done: from every
angle except the one that matters they look finished, and the angle that matters is only visible
by performing them.

Each drill is a script under `scripts/drills/`, and all three share the same three properties so
that reading one teaches the others:

- **Dry run by default.** They print the plan and change nothing. `--execute` is the only thing
  that makes the first two act, and the DMARC one has no execute mode at all.
- **They refuse rather than guess.** Exit `2` means "I refused and changed nothing". Exit `1`
  means "I tried and it did not work". Exit `0` means it did what it printed.
- **They prove rather than report.** A green API response, a command that exits `0`, and a
  dashboard that says *verified* are all things this system has produced while being broken.

| Drill | Script | What it touches | When to run it |
|---|---|---|---|
| Database restore | `scripts/drills/restore-drill.mjs` | Creates and deletes one Neon branch. Never writes to the production branch | Quarterly, and before any change big enough to make you want the option |
| Machine rollback | `scripts/drills/rollback-drill.sh` | Restarts one machine, twice | After the second image deploy, then quarterly |
| DMARC tightening | `scripts/drills/dmarc-drill.sh` | Nothing at all. Read-only DNS | Before each policy step, and whenever mail is reconfigured |

Neither of the first two reads a secret from a file. `NEON_PROJECT_ID` and `NEON_API_KEY` are
exported into one shell, and `fly` uses whatever `fly auth whoami` reports (non-negotiable 5).

---

### Drill 1: restore the database

**A backup nobody has restored is a hope.** Neon's history is continuous and a restore is a branch
away, which is exactly what makes it easy to never test: the dashboard shows the history, and it
is there, right up until the evening somebody needs it and finds out that the retention window,
the schema or the roles are not what they assumed.

**It restores onto a NEW branch and never onto production.** The script issues exactly two
mutating calls: `POST /branches` to create one, and `DELETE /branches/{id}` on the branch it just
created. It never calls `POST /projects/{id}/branches/{id}/restore`, which is the endpoint that
rewrites an EXISTING branch in place and is what "restore the database" means to most people. That
endpoint does not appear in the file. It also never reads `DATABASE_URL`: the only connection
string it can use is the one Neon returns for the branch this run made, and even that is checked
against the production endpoint hosts before a client is opened.

#### Run it

```
export NEON_PROJECT_ID=<from the Neon console URL>
export NEON_API_KEY=<a personal API key, this shell only>

# 1. Dry run. Prints the real plan and changes nothing.
node scripts/drills/restore-drill.mjs --target restore-drill-2026-08-25

# 2. The drill.
node scripts/drills/restore-drill.mjs --target restore-drill-2026-08-25 --execute
```

`--target` is required, must start with `restore-drill-`, and a production identifier is refused
before a single HTTP call is made. `--at <RFC3339>` picks the moment to restore to and defaults to
one hour ago. `--keep` leaves the branch behind.

#### What the dry run prints

Captured on 2026-08-25 with no key exported, which is the first thing anybody will run:

```
ClubChat restore drill
======================

project        cool-project-12345678
new branch     restore-drill-2026-08-25
restore point  2026-08-25T12:30:55.699Z
mode           dry run (nothing will change)

this repo expects 40 migrations, newest stamped 1787197792141

NEON_API_KEY is not set, so the live checks below were skipped:
  - that the restore point is inside the project history window
  - that the target name is free
  - which endpoint hosts belong to production
```

With a key it goes further, entirely in reads: the project name, the parent branch and its id, the
history window with the oldest restorable moment spelled out as a timestamp, the production
endpoint hosts, and then the numbered plan and the line `dry run complete. Nothing was created,
changed or deleted.`

#### What it proves

`201 Created` proves a branch exists. It says nothing about whether that branch holds the schema,
the rows, or the moment anybody asked for, and all three have the same shape from the API: a green
response. So the drill connects to the restored branch and asks it questions. The checks live in
`scripts/drills/restore-proof.mjs`:

| Check | Rules out |
|---|---|
| `tables-present` | An empty branch, or a branch of the wrong project |
| `migration-ledger` | A schema that is not this repo's. Compares both the row count in `drizzle.__drizzle_migrations` and its newest stamp against `meta/_journal.json` |
| `row-counts` | A correctly migrated database with nothing in it. **This is the one that makes the drill worth running** |
| `point-in-time` | A copy of HEAD rather than of the requested moment |
| `referential-integrity` | A torn restore: rows pointing at parents that are not there |
| `writable` | A branch you can read but could not promote. Proved by committing a transaction |

**`users >= 1` alone would not catch an empty restore, and that is why the gate names five
tables.** Migration `0001_seed_system_actor` inserts a user, so a freshly migrated database with
no usage at all already satisfies it. `clubs`, `club_memberships`, `channels` and `messages` have
no seeded rows and are the ones doing the work.

**`point-in-time` can only ever prove "not newer than".** A restore to a moment when nothing had
been written since is indistinguishable from a copy of HEAD, and no timestamp comparison can fix
that. It is stated here rather than implied.

#### The checks have been watched failing

```
node scripts/drills/restore-proof.selftest.mjs
```

Needs Docker, takes about half a minute, and touches nothing but its own throwaway container. It
drives the proof through four states of one real database and asserts what it says about each:
empty (the table check must fail), migrated with no rows (the schema and ledger checks must pass
and the row gate must fail), seeded (everything passes), and seeded with the restore timestamp set
before the rows were written (the point-in-time check must fail). A gate that has never been seen
to fail has proved nothing, which is AGENTS.md standing instruction 11 applied to a script instead
of a test.

#### What failure looks like

| Symptom | Meaning |
|---|---|
| `REFUSED: "main" reads as a production identifier` | Working as designed. Name a `restore-drill-` branch |
| `ERROR: GET /projects/... -> 401` | The API key is wrong or revoked. Nothing was created |
| `REFUSED: --at ... is outside this project's history window of Ns` | The moment asked for is older than retention. The refusal prints the oldest restorable timestamp |
| `FAIL row-counts   below the gate: clubs=0 ...` | **The real finding.** The restore produced a database with a schema and no data |
| `FAIL migration-ledger  applied=38 expected=40` | The restore point predates the last two migrations. Expected if `--at` is old; alarming if it is not |
| `FAIL point-in-time  rows newer than the restore point` | The branch is not a snapshot of the moment requested |

On any failure the branch is **kept**, not deleted, and the exact `curl -X DELETE` to remove it is
printed. A failed restore is the one you want to look at. On success the branch is deleted unless
`--keep` was passed, and the delete re-reads the branch first and refuses if it comes back marked
default or protected.

A branch that is left behind costs storage for as long as it exists. Delete it when the
investigation is over.

---

### Drill 2: roll a machine back

**Only the machine half is a drill, and the schema half is already decided.** A schema change is
never rolled back, only followed forward: migrations are additive and run as the api app's
`release_command`, on a temporary machine using the newly built image, before any machine is
updated. The previous image therefore runs correctly against the newer schema, and there is
nothing to un-apply. What has never been performed is the machine rollback, against a schema that
stays exactly where it is.

**`fly machine update`, never `fly deploy --image`.** `fly deploy` against `fly/api.toml` runs
`release_command` again, which is a migration, during a rollback drill, which is the one thing
this drill must not do. `fly machine update` changes one machine's image and runs no release
command at all. It is also surgical: it names a machine, so it cannot fan out to the other two
apps.

#### Run it

```
# Dry run against exactly one app.
./scripts/drills/rollback-drill.sh --app clubchat-api

# The drill. Prompts for the app name to be typed before it acts.
./scripts/drills/rollback-drill.sh --app clubchat-api --execute
```

`--app` is required and accepts exactly one of `clubchat-api`, `clubchat-gateway`,
`clubchat-worker`. `--app all` is refused by name, because it is the thing somebody will try.
Giving `--app` twice is refused. An app with more than one machine is refused, because that shape
needs a decision rather than a default. `--to <image>` overrides the image to roll back to.

#### It is not runnable yet, and that is the current answer

Measured on 2026-08-25, read-only, against all three apps:

```
Every one of this app's 3 releases carries the SAME image digest:
  registry.fly.io/clubchat-api@sha256:9f9e58a2c4f1d0aab06847023567503bc9f1af410f6bed84707c1333b3faef0d

A release is created by a secret or config change as well as by a deploy, so several
releases of one image is normal. It also means this app has never run a second image,
and there is therefore nothing to roll back TO.

REFUSED: no previous image exists.
```

`clubchat-api` has three releases, `clubchat-gateway` and `clubchat-worker` one each, and every
one of the five carries that same digest. The cutover built one image and deployed it to all
three, exactly as [the first cutover](#the-first-cutover) describes, and the api's two extra
releases are secret and config changes, which create a release without creating an image.

So **rollback is untested because it is not yet possible**, which is a different statement from
"untested" and worth recording as such. The drill becomes runnable at the next real deploy, which
is the moment a second digest exists. Run it that same day, while the previous image is known
good.

#### What the plan prints

Real output from 2026-08-25, with `--to` supplied so the plan renders:

```
app            clubchat-api
role           api
mode           dry run (nothing will change)
readiness      GET https://api.clubchatapp.com/ready must return 200

machine        080e9036b99048  region iad  state started
running now    registry.fly.io/clubchat-api@sha256:9f9e58a2...
roll back to   registry.fly.io/clubchat-api@sha256:00000000...

plan
----
1. fly machine update 080e9036b99048 --app clubchat-api --image <previous> --yes --wait-timeout 300
2. wait for the role's readiness signal
3. fly machine update 080e9036b99048 --app clubchat-api --image <current> --yes --wait-timeout 300
4. wait for the readiness signal again
5. assert the machine's image is byte-identical to the one it started on
```

**The readiness signal differs by role, and the worker's is not a health check.** The api and the
gateway are polled at `https://api.clubchatapp.com/ready` and `https://ws.clubchatapp.com/ready`
until one returns `200`, up to 40 attempts five seconds apart. The worker has no ingress and
therefore no health gate at all, so its gate is the line it writes once it has built the pool, the
Redis connection and the S3 client: `worker started, draining outbox and running the scheduler`.
The script waits for the machine to reach `started` and then greps `fly logs --no-tail` for
exactly that string. Its absence is the failure, which is the same reasoning the cutover uses.

`--skip-health-checks` is never passed. The check is the instrument.

#### What failure looks like

| Symptom | Meaning |
|---|---|
| `REFUSED: ... is not one of this deployment's three apps` | Typo, or an app that is not part of this drill |
| `REFUSED: <app> has N machines` | Somebody scaled a role. Decide what the other machines should do first |
| `REFUSED: machine ... is 'stopped', not 'started'` | Fix that before drilling a rollback on it |
| `ERROR: <app> did not become ready on the previous image` | **The finding the drill exists for**: the image you would roll back to does not serve traffic. Rollback is not available until that is understood |
| `ERROR: the roll-forward update failed` | The app is still on the PREVIOUS image. The recovery command is printed |
| `ERROR: the machine did NOT come back to the image it started on` | Compare `fly machine list --app <app> --json` against the digest in the output above |

Every failure path prints the exact `fly machine update ... --image <the image it started on>`
needed to put the app back by hand.

The final assertion is not "both commands exited 0". It re-reads the machine's image and requires
it to be byte-identical to the digest recorded before the drill started.

**One flyctl detail that will otherwise cost an afternoon.** `fly releases --json` on flyctl
v0.4.87 marshals Go field names, so the image reference key is `ImageRef`, not `imageRef`.
Published examples show the camelCase form, and reading it yields `null` silently rather than an
error. The script tries `.imageRef // .ImageRef // .image_ref // .image` and refuses with the raw
release table if none of them resolve, rather than picking a wrong image.

---

### Drill 3: tighten DMARC

#### Where it stands today

Measured on 2026-08-25 with `./scripts/drills/dmarc-drill.sh`, against the Cloudflare
nameservers directly and again through `8.8.8.8`:

| Record | Name | Value |
|---|---|---|
| SPF | `send.clubchatapp.com` TXT | `v=spf1 include:amazonses.com ~all` |
| Bounce | `send.clubchatapp.com` MX | `10 feedback-smtp.us-east-1.amazonses.com` |
| DKIM | `resend._domainkey.clubchatapp.com` TXT | a 218 character public key |
| **DMARC** | **`_dmarc.clubchatapp.com` TXT** | **`v=DMARC1; p=none; rua=mailto:dmarc@clubchatapp.com; fo=1`** |

SPF, DKIM and the bounce path are all published and agree between the origin and a public
resolver.

**Corrected later the same day.** The table above first recorded `v=DMARC1; p=none;` with no
`rua=`, so no aggregate reports were being generated anywhere and there was no evidence on which
to tighten anything. An `rua` was added, and adding it exposed a larger problem: **no address at
`clubchatapp.com` could receive mail at all.** The apex MX pointed at `eforward1-5.registrar-servers.com`,
the registrar's forwarding service, which only serves domains using the registrar's own
nameservers - and this domain uses Cloudflare's, because Cloudflare serves the CDN and the apex
site. The records were present, well formed and permanently inert, so nothing looked wrong.
`support@clubchatapp.com` had therefore bounced for its entire life while being published in the
Privacy Policy, the Terms and the Profile screen as the contact Apple's guideline 1.2 requires.

The apex now runs **Cloudflare Email Routing**: MX at `route1/2/3.mx.cloudflare.net`, a
`cf2024-1._domainkey` DKIM record for forwarded mail, and `v=spf1 include:_spf.mx.cloudflare.net ~all`.
`send.clubchatapp.com` is untouched throughout, which is why sending was never affected: Resend's
envelope, SPF and bounce path all live on that subdomain.

**The old apex SPF was deleted BEFORE the replacement was added, not after.** Two `v=spf1` records
on one domain are read by receivers as no SPF at all, and this project has a recorded near-miss on
exactly that. Verify with `dig +short clubchatapp.com TXT | grep -c spf1`, which must return 1.

#### Why `p=none` is there, and why it is not the finish

SPF proves the sending server is authorized for the envelope domain. DKIM proves the message was
signed and unaltered. **Neither looks at the `From:` header, which is the only address a member
ever sees**, so both can pass for an attacker's own domain while ClubChat's name is displayed.
DMARC is the record that requires the domain which passed SPF or DKIM to *align* with the visible
`From:`, and states what a receiver should do when it does not.

`p=none` says "do nothing about it, but tell me". It was the correct first move: it changes no
delivery decision and it clears the `DMARC: FAIL` that an absent record produces. It is not
protection. A spoofed password-reset mail is delivered exactly as it was before, and password
reset is the highest-value phishing target this product will ever send, because a spoofed one is
convincing precisely by looking like the mail members were taught to expect.

#### The warning, which is already recorded and is not hypothetical

**Tightening to `quarantine` before authentication is confirmed working is how real mail gets sent
to spam.** [The sending domain checklist](../templates/sending-domain-checklist.md) opens with the
case that makes it concrete: on 2026-08-07 `parkstechusa.com` read *verified* in the Resend
dashboard while publishing no SPF and no DKIM at all. Every record had been lost in a nameserver
move a month earlier, and mail kept being accepted the whole time. **Delivery is not
authentication.** A `p=reject` published in that window would have sent every password-reset mail
to spam or had it refused outright, while the provider dashboard went on saying `delivered`,
because that word only means a receiving server accepted the bytes.

#### The record edit

One TXT record in Cloudflare DNS for `clubchatapp.com`. Name `_dmarc`, and Cloudflare appends the
domain itself, so do not type the full name. TTL Auto. DNS only; a TXT record cannot be proxied.

**Step 1, now. Add reporting, leave the policy alone.**

```
before  v=DMARC1; p=none;
after   v=DMARC1; p=none; rua=mailto:dmarc@clubchatapp.com; fo=1
```

This changes no delivery decision at all. It starts the evidence.

**`dmarc@clubchatapp.com` has to actually receive mail, or the record looks complete while every
report is thrown away.** The apex publishes MX records pointing at the registrar's forwarding
hosts (`eforward1-5.registrar-servers.com`), so the DNS half is already there, but a forwarding
host still needs a **rule for that exact address**. Confirm one exists before relying on it. An
address on a different domain is dropped entirely unless that domain publishes an authorization
record for it, which is why the address above is on the sending domain.

**Step 2, after at least two weeks of reports.**

```
before  v=DMARC1; p=none; rua=mailto:dmarc@clubchatapp.com; fo=1
after   v=DMARC1; p=quarantine; rua=mailto:dmarc@clubchatapp.com; fo=1
```

**Step 3, after quarantine has run clean.** Same edit again with `p=reject`.

#### Confirm authentication is passing FIRST, and what evidence to look for

The drill script refuses to green-light a tightening while any check fails, and prints
`DO NOT MAKE THAT EDIT YET`. But DNS cannot tell you the thing that actually matters, and neither
can the provider dashboard. Only a receiver can:

1. Trigger a real password reset to a Gmail address, from the live app.
2. Open the message, the per-message three-dot menu, **Show original**.
3. Read all three lines at the top:
   - `SPF: PASS` with domain `send.clubchatapp.com`
   - `DKIM: PASS` with domain `clubchatapp.com`. **The `d=` must be `clubchatapp.com`**, not the
     provider's own domain, or alignment is being carried by SPF alone and anything that changes
     the envelope path later breaks it silently.
   - `DMARC: PASS`
4. Read the aggregate reports for around two weeks and look for legitimate senders a strict policy
   would break. This domain publishes an apex SPF for registrar mail forwarding
   (`v=spf1 include:spf.efwd.registrar-servers.com ~all`) which does **not** include the mail
   provider, so anything sent with an apex envelope is exactly what those reports exist to
   surface.

After the edit, re-check both resolvers and send one more real message:

```
dig +short TXT _dmarc.clubchatapp.com @mona.ns.cloudflare.com
dig +short TXT _dmarc.clubchatapp.com @8.8.8.8
```

**Wait out the negative cache before believing a failure.** Resolvers cache absences as well as
answers, and the window is the SOA minimum, which `dig +short SOA clubchatapp.com` currently
reports as **1800 seconds**. A `FAIL` minutes after publishing a record that `dig` can already see
is that, not a misconfiguration.

#### What failure looks like

| Symptom | Meaning |
|---|---|
| `FAIL  spf` or `FAIL  dkim` | Stop. A policy published now is an instruction to reject your own mail |
| `FAIL  propagation` | The origin and `8.8.8.8` disagree. Wait out the TTL and re-run before doing anything else |
| `FAIL  aggregate reports` | No `rua=`. This is today's state, and step 1 above is the fix |
| `FAIL  rua mailbox` | The reporting address is on a domain with no MX. Reports would go nowhere |
| `DKIM: PASS` with a `d=` that is not `clubchatapp.com` | Alignment is resting on SPF alone. Do not tighten |

#### Why this drill has no `--execute`

The other two act. This one only reads, and has no flag that would change that. The record lives
in Cloudflare and the edit is one field of one TXT record; a script holding a Cloudflare token
able to rewrite the apex zone is a far larger standing risk than the thirty seconds it saves, and
that token is on the list of credentials to revoke rather than keep (obligation 1 above).

---

### What the drills do not cover

Written down so the coverage is not overread.

- **Redis.** Upstash holds ephemeral state and its loss is a documented degrade rather than data
  loss ([Failure modes](11-failure-modes.md)), so there is nothing to restore and no drill. What
  is untested is the degrade itself: nobody has pulled Redis out from under a running client and
  watched sync recover.
- **R2.** Object loss has no drill and no restore path. Media is the one part of this system with
  no second copy anywhere.
- **The Worker.** Still reports no errors anywhere (obligation 5 above), so a rollback drill for
  `cdn.clubchatapp.com` would have nothing to read a failure from.

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
  open is the *machine* rollback drill, which has never been performed. **Still true after
  2026-08-23**: the first cutover went forward three times and was never rolled back, so there is a
  deployment to drill against now and the drill is exactly as unperformed as it was when there was
  nothing to roll back.
- **Whether Workers Caching is turned on.** Only the measurement was blocking this, and the
  measurement has been taken: nothing is cached at the edge today. The remaining question is a
  choice rather than a fact, it belongs to the founder, and ADR-0044 records what it costs to answer
  yes. Recorded here because the switch being absent from `wrangler.jsonc` is indistinguishable
  from nobody having considered it.
- Backup restore and monitoring. These are [milestone 5](20-road-to-the-first-club.md) exit criteria
  rather than open choices, and the deploy did not move either: no backup has been restored, and no
  alert has been forced to reach a human. **The mail domain came off this line on 2026-08-23**, when
  reset mail arrived from the product's own domain; what is left of it is the DMARC tightening in
  obligation 3 above.
- ~~The rollback procedure.~~ **Closed 2026-08-25.** The schema half was already decided: a schema
  change is never rolled back, only followed forward, which is what rules 4 to 7 make safe by
  keeping every migration additive. Migrations run as the api app's `release_command`, on a
  temporary machine using the newly built image, before any machine is updated, and a failure there
  stops the deploy. The machine half is now [drill 2](#drill-2-roll-a-machine-back), written and
  refusing correctly. **It has still never been performed, and right now it cannot be**: all five
  releases across the three apps carry one image digest, so no previous image exists to roll back
  to. That becomes possible at the next deploy.
- Backup restore and the mail domain are now [drill 1](#drill-1-restore-the-database) and
  [drill 3](#drill-3-tighten-dmarc). Both are built, and neither has been executed against
  production: drill 1 needs a Neon API key, drill 3 needs two weeks of aggregate reports that are
  not being collected yet because the DMARC record has no `rua=`. Monitoring remains a
  [milestone 5](20-road-to-the-first-club.md) exit criterion rather than an open choice.
- Kafka still has no hosted provider ([Stack and hosting](15-stack-and-hosting.md)). Managed Kafka
  is the largest single line item in any hosting estimate at this scale, so the provider choice is
  as much a cost decision as a technical one.
- Whether the web client stays on Vercel's free tier, which turns on whether this deployment counts
  as commercial use.
