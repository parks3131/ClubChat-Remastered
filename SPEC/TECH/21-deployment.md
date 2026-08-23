# Deployment

**Nothing is deployed yet.** As of 2026-08-23 the three roles have never run anywhere but
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
| `cdn-worker` (`packages/cdn-worker`) | Cloudflare Workers, paid plan | The client, over HTTPS, for media bytes |
| Web client | Vercel | Browsers |
| JavaScript bundles | EAS Update | Phones |

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
file that mentions Sentry.

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
document describe one machine per role. **The first cutover therefore passes `--ha=false`**, so the
shape that gets deployed is the shape that was reasoned about, and a request that fails by hand can
only have come from the one machine you are looking at. A second api or gateway machine afterwards
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

Two orderings inside it are load-bearing and neither is visible from the steps themselves.
Migrations run before the code that selects from them, which is rule 1 and is enforced by the api's
`release_command` rather than by memory. And **every hostname resolves, and holds a certificate,
before anything is proved against it**, which is the same reasoning one layer out: the name exists
before a device is asked to call it, and before mail is asked to carry a link to it.

**1. The three Fly apps, on `MEDIA_URL_MODE=presign`.** The only media mode that has ever run
anywhere. Build the image ONCE and deploy that digest to all three, api first because its
`release_command` runs the migration (rule 1).

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
built. **Its absence is the failure.** `loadConfig` runs before that line, so a secret missing or
mistyped on this role prints a validation error naming the key it could not read and never reaches
it, on a deploy that reported success because this role has no health gate to fail. The same line
arriving repeatedly, seconds apart, is the other fault: a worker that boots and then dies.

**2. `api.<domain>` and `ws.<domain>`, DNS only, grey cloud, never proxied.** Fly terminates its own
TLS, and proxying it through Cloudflare puts two proxies in series and breaks the WebSocket
gateway. Then `fly certs add` for each, and wait for both to be issued: Fly cannot issue a
certificate for a name that does not already point at it, which is why the record and the
certificate are one step and not two.

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

### What to measure once, on the way through

**`cf-cache-status` on a real signed URL.** This settles whether Cloudflare holds anything at the
edge, which is the open half of roadmap debt 7:

```
curl -sI '<a signed media url>' | grep -i cf-cache-status
```

`DYNAMIC`, or an absent header, confirms that nothing is cached and that N members opening one
photo is N R2 reads. Turning it on is then one key,
`"cache": { "enabled": true }` in `wrangler.jsonc`, decided against that evidence rather than
against a vendor document. `HIT` or `MISS` would mean the analysis in
[ADR-0044](../decisions/0044-the-cdn-is-a-worker-that-validates-before-it-reads.md) is wrong and
that ADR needs correcting.

### Obligations that survive the cutover

These are not optional tidying. Each one is a live credential or a live gap.

1. **Rotate the R2 key and revoke the Cloudflare API token.** Both were pasted into a chat
   transcript rather than into the secrets file, so both must be treated as disclosed. The R2
   credential is also read AND write where the Worker only ever reads, so the rotation is the
   moment to narrow it to read-only. Do this once the Worker is live, not before, or the Worker
   loses its bucket access mid-cutover.
2. **Delete the local secrets file** once every value has reached Fly and Cloudflare. It exists
   outside the repo precisely so that it can be deleted rather than managed.
3. **Delete the older, Full-access Resend key**, leaving only the sending-only one restricted to
   the sending domain.
4. **The Resend domain badge.** Its DNS is correct and its status may still be `Pending`, and
   Resend refuses to send from an unverified domain, so **password-reset mail is unprovable until
   it flips**. The api boots regardless, because it only requires the key to be present, which
   means this failure is invisible from the outside. Distinct from the ordering reason in step 3:
   this one sends nothing at all, that one sends a mail whose link goes nowhere.
5. **Nothing reports a Worker error.** Accepted for the first deployment and recorded in ADR-0044.
   Workers Logs in the Cloudflare dashboard is the only place an exception at the edge is visible,
   and nothing pages on it. The thing that actually tells you the Worker is broken is a member
   saying no photos are loading, and `/__parity` is the first command to run when that happens.

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
