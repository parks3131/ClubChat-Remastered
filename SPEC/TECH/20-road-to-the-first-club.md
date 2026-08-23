# Road to the first club

**The destination is the first real club on the app: a pilot whose actual members use it daily.**
Not an App Store release, and not v1 feature parity - both come after a club has trusted the
thing, if they come at all. The destination is chosen because it re-orders the work: a club that
loses one message, or rings nobody about a join request, does not file a bug report. It goes back
to GroupMe. So correctness work is the critical path and features are not on it.

**Milestones, not dates.** This repo has no velocity history, so any date would be an invention
wearing a number. Each milestone instead names what must be **true** to call it done, in terms
someone could check without asking whoever did the work. This is the same lesson
[Build phases](16-build-phases.md) already paid for: a gate that can be met without the thing
actually working will be.

**What this file is not.** [Build phases](16-build-phases.md) stays the record of how the system
got here and the authority on those phases' gates.
[`PRD/17`](../PRD/17-roadmap-and-open-questions.md) stays the authority on product-level gaps and
open questions. `TODO.md` stays the tactical backlog and is not restated here; a milestone claims
one of its items only when the destination depends on it. And the deferred lists -
[`PRD/00`](../PRD/00-overview.md) non-goals, `PRD/17`'s deliberately deferred,
`TODO.md`'s "Deferred on purpose" - bind this file too. Nothing below reopens them. Recurrence in
particular stays deferred until the pilot's own usage argues otherwise, which is the position
those decisions have always wanted to argue from.

**Sequencing.** Milestone 1 is strictly first: its eight branches share one base and decay
against a moving `main`, so every week of delay makes the ordered merge harder. Milestones 2, 3
and 4 are largely independent and can interleave. Milestone 5 must follow 3 and 4, or the pilot
becomes the load test and the device pass at once. Milestone 6 is the destination.

**That ordering took one deliberate exception on 2026-08-23** and it is recorded in milestone 3
rather than argued again here: the deploy went first because milestone 3's last criterion had
nowhere to report FROM without it. What follows 3 and 4 is the *pilot*, not the deployment, and
nothing about the exception moves that.

---

## Milestone 1 - The review lands

On 2026-08-19 a backend review ran eight independent lanes over `packages/server` and produced 34
findings: 5 critical, 9 high, the rest medium and low. The full report, with a per-claim
confidence marking and a section on its own gaps, is published at
<https://claude.ai/code/artifact/e4911936-deee-4975-a05f-cab962957276>. Its summary sentence is
worth carrying whole: the effects engine advertises atomicity, ordering and at-least-once, and
delivers the third cleanly, the first with a hole, and the second not at all once anything
retries. Nearly every critical is a variation of that sentence.

Eight remediation branches are open as draft PRs, all cut from `main` at `192d2ac`. Together they
close **all five criticals and all nine highs**. The merge order below is a dependency graph, not
a preference, and it is the reason this milestone is written down rather than just merged:

| Order | PR | Branch | Why it sits here |
|---|---|---|---|
| 1 | #8 | `boundary-timeouts` | **First: it removes the trigger.** No deadline existed on object storage or push, and both were awaited inside the drain's batch transaction, so a host that accepted the connection and never answered froze every partition's effects with nothing logged. Until this is in, every later merge is being verified on a system that can silently hang. |
| 2-5 | #1 | `ban-disclosure` | Independent of everything. The one authorization defect in an otherwise clean route layer. |
| 2-5 | #3 | `hot-path-indexes` | Independent. Two whole-table scans that every existing instrument reported as healthy. |
| 2-5 | #4 | `club-owner-race` | Independent. Carries **ADR-0042**, so `SPEC/README.md`'s decision index gains its row in this merge - the ADR exists only on this branch today, and a row on `main` before the merge would point at nothing. |
| 2-5 | #6 | `gateway-seams` | Independent. Also closes the publish-on-dedup defect at the gateway's system-message path, which the review had flagged as unconfirmed; the branch confirmed and fixed it in a second commit. |
| 6 | #2 | `mentions-atomicity` | After the independents, before the drain rework. |
| 7 | #7 | `outbox-drain` | **It removes the blast radius**: per-row transactions instead of one spanning fifty claimed rows, attempts counted at claim rather than only on a thrown error, and the per-partition gate the schema's own index was always waiting for. |
| 8 | #5 | `effects-publish` | **Last, and only after both 8 and 7.** It touches thirteen test files, its durable push deferral rides the same lease-and-claim semantics the drain rework changes, and without the timeout an inline push could still hang the very machinery this branch moves the deferral onto. |

Two documentation obligations merge **with** this milestone, not after it: the decision-index row
for ADR-0042 (above), and two new entries in `AGENTS.md` section 5.3 whose lessons these branches
paid for - the smithy `throwOnRequestTimeout` trap (a request timeout that only logs unless the
flag is set, so the fix typechecks, reads correctly, and changes nothing) and the pg client
`error` event nothing listens to. Their numbers are claimed the way section 2.5 item 6 requires,
at write time, not reserved here.

*Done when:*

- *All eight PRs are merged to `main` in the order above, and after **each** merge the section
  2.3 gate is green on the merge result rather than the branch head: type check, full suite,
  `check:runtime`, and `gate:surface` against a running API.*
- *Each of the review's five criticals and nine highs maps to a merged change, checked against
  the artifact rather than against memory.*
- *The four documents the review caught diverging read true against merged `main`:
  [Failure modes](11-failure-modes.md) on push retry, [Diagrams](17-diagrams.md) on reconnect,
  [Connection layer](01-connection-layer.md) on the heartbeat,
  [Effects engine](04-effects-engine.md) on ordering. The branches correct their own; the check
  is that nobody takes that on faith.*
- *`SPEC/README.md` indexes ADR-0042, and `AGENTS.md` 5.3 carries the two new entries under
  deliberately claimed numbers.*

## Milestone 2 - The known-broken list is empty

The review's roughly twenty medium and low findings, none of which are fixed. They are triaged,
not batch-fixed: the artifact is the inventory (its boundary table is the single most useful
artefact any lane produced), and whichever entries milestone 1's branches already closed come off
the list at merge time. The ones worth naming, because each either continues an existing mission
or blocks the pilot's daily surfaces:

- ~~**The connect path's per-channel round trips**~~ **Done 2026-08-21.** It was the gateway's
  `subscribe` handler awaiting `getChannelRef` once per id, sequentially, over a frame that admits
  200 - so every reconnect serialized up to two hundred round trips inside one frame. Measured at
  21 statements for 20 channels, now 2. The same `getChannelRefs` closed `/sync`'s half.
  `gateway-subscribe-cost.test.ts` guards it.
- ~~**`GET /events?ids=` is still one round trip per id**~~ **Done 2026-08-21.** It was 23
  statements for 20 ids and is now 4. `readEvents` is the primary and `readEvent` delegates,
  matching `readPolls`/`readPoll`, and the characterisation test written the day before was
  inverted into the flat guard milestone 3 asked for.
- **A bulk roster add still loops the pending-request resolution once per added member.**
  Milestone 1's index made each call cheap; it did not make there be one call instead of up to a
  hundred.
- **The silent-failure family**: server faults answered as `malformed`, mail failures bypassing
  monitoring, the scheduler tick with no capture, the Redis clients with no error listener.
- **The client's answer to the new `conflict` refusal.** `club-owner-race` turns a lost
  role-change race into a 409; the mobile client currently renders it as a generic failure. A
  member should be told the club changed underneath them and be shown the fresh state. Small,
  client-side, and it completes ADR-0042's story on the surface.
- **The two entries under "Known broken, or quietly wrong" in `TODO.md`**, including the
  `BadgedIcon` double render, whose *cost* is gone but whose cause is unexplained - and an
  unexplained double render is presumably rendering its siblings twice too.
- **Voting writes no event** (`TECH/18` 3.3), so live poll tallies are a coincidence - and polls
  are a surface a pilot club will use daily.

**Not carried: a notifications retention job.** The review reported the table has no retention
job and grows forever. The repo has had one since 2026-08-03: `worker/retention.ts` prunes read
rows and, later, unread ones from the hourly housekeeping slot, in bounded batches. The repo
wins, so the roadmap does not carry a job that exists. What was real in that finding was the
missing index (merged in milestone 1) and the caller loop (above).

*Done when:*

- *Every medium and low finding in the review has been walked once against merged `main` and is
  either fixed, or in `TODO.md` with a reason, or written off with the reason stated. None is
  simply unmentioned.*
- *`GET /events?ids=` carries the same flat-statement guard as `/polls` and `/media/urls`.*
  **Met 2026-08-21.**
- *A roster add of N ids resolves pending requests in a bounded number of statements, not N.*
- *The 409 conflict refusal renders as its own message on the client, and the forced-interleaving
  tests from `club-owner-race` are the evidence the state it describes is reachable.*
- *`TODO.md`'s "Known broken, or quietly wrong" section is empty - the file's own rule is delete
  when done, so empty is checkable.*

## Milestone 3 - Measured for real

Everything this project has ever measured is a laptop against a database on the same machine, and
nothing measures production at all - `TECH/18` says so about itself, and the review repeated it
as its own caveat: every cost in it is a round-trip count read from code, not a measurement. A
pilot club will be the first real load this system sees, and it must not also be the first
measured one.

[`TECH/18`](18-mission-backend-cleaning.md) section 6 already surveys the techniques and
recommends the order; this milestone is that order executed. Sentry performance tracing (already
a dependency; its performance half is configuration), `pg_stat_statements`, and the seeded large
fixture - hundreds of members, dozens of cards in one chat, fifty photos in a gallery - that
would have caught both N+1s automatically instead of leaving them to a trace of a lucky account.
Plus the two Phase 4 leftovers this depends on: the load test at ten times projected peak, whose
two first numbers [Build phases](16-build-phases.md) already names (the per-channel `last_seq`
row lock under concurrent sends, and the access-context query), and source maps, without which a
production trace is minified noise.

*Done when:*

- *A production-shaped environment reports per-route latency and query counts with no laptop
  attached: Sentry tracing live, `pg_stat_statements` queryable.*
- *The large seeded fixture exists, and the batch routes and `/sync` run against it in the suite
  with statement-count guards.*
- *The load test has run at ten times projected peak, the two named hot spots have measured
  headroom, and the numbers are recorded in `TECH/18` next to the laptop numbers they replace.*
- *A production error arrives symbolicated.*

**Status, 2026-08-23: three of the four criteria are met, and the fourth stopped being blocked
today without becoming met.** It had been blocked on milestone 5, which is a dependency this file
did not notice when it ordered the milestones.
[`TECH/18`](18-mission-backend-cleaning.md) section 7 records everything measured.

| Criterion | Standing |
|---|---|
| The fixture, and guards on the batch routes and `/sync` | **Done.** 300 members, 20 polls with 3,600 votes, 50 photos, 5,070 messages |
| `pg_stat_statements` queryable | **Done.** Preloaded in development and in the test container |
| The load test at ten times peak, both hot spots | **Done.** Row lock 2.3x headroom and gapless under contention; access context 26x |
| Sentry tracing live, and an error arriving symbolicated | **Unblocked 2026-08-23. Neither half done.** Errors have somewhere to go and none has arrived; tracing is still switched off by a constant |

**What the deployment changed about that last row, and what it did not.** The obstacle was never
configuration: there was nowhere to send a trace or a symbolicated error FROM, and turning tracing
on would have produced a laptop reporting on itself. That obstacle is gone. `SENTRY_DSN` reaches all
three roles through their `[env]` blocks and all three are deployed with it, so a 5xx on the api or
a parked event on the worker now has a project to arrive at. **Nothing has arrived.** Until
something does, this is a configuration file that mentions Sentry, which
[Deployment](21-deployment.md) records as reading identically to a working one from every angle
except the Sentry project itself.

Three things are now separable that used to be one blocked row, and only the first is close to
done:

- **Error reporting** is wired and unproved. One deliberately raised 5xx settles it, and that is
  also a milestone 5 exit criterion, so it gets proved once and counted twice.
- **Performance tracing is not merely unproved, it is off.** `monitoring.ts` sets
  `tracesSampleRate: 0` on both the server and the client, deliberately and with its reason in a
  comment: tracing carries its own quota cost and was left to this audit rather than smuggled in
  with error reporting. Turning it on is a constant, and it has not been turned on, so no
  per-route latency is being reported from production by anything.
- **Symbolication was only ever a client problem.** The server image ships source and Node runs it,
  so a server stack trace already names the `.ts` file it came from and needs no source map. The
  client's half is now configured rather than proved: `@sentry/react-native` carries the org and
  project in `app.json`, and `SENTRY_AUTH_TOKEN` is a secret EAS environment variable on the
  `production` and `preview` environments, so the upload happens on the next production build. No
  such build has finished.

**What the fixture found on the day it existed, and what happened next.** It reported `/sync`
costing two statements per channel. That was itself understated - it had measured empty channels,
which skip the reaction and mention side loads, and a channel a member actually reads cost four.
The real figure was `3 + 4n`, or 803 statements at the route's 200-entry cap. Fixed on 2026-08-21
along with the two milestone 2 items above, all three by the same batching: `6 + n` now, 206 at
the cap. `TECH/18` 7.2 carries the measurements and 7.5 carries the two defects the work turned up
that no measurement could have seen.

## Milestone 4 - Trusted on the devices the club will hold

The full [Acceptance checklist](../PRD/18-acceptance-checklist.md) run end to end on iOS, Android
and web - the Phase 4 gate that has been blocked since it was written and is now reachable. The
accessibility audit with the four never-audited dimensions (contrast, dynamic type, reduced
motion, screen-reader order). The device passes `TODO.md` still owes: the member card back on the
physical phone, its three newer actions on the Simulator. And every screen entered by direct URL
on a device, which is the class this project has shipped as a bug three times.

One nuance stated rather than smuggled: the pilot itself gates on the platforms its roster
actually holds, which only the roster can decide. The three-platform run stays the standing gate
because it is Phase 4's and because "works on my platform" is how v1's gaps survived - but a
failure on a platform no pilot member holds is recorded and scheduled, not a blocker for
milestone 6.

*Done when:*

- *`PRD/18` has been attempted end to end on all three platforms, and every failure is either
  fixed or recorded as a known gap with the founder's explicit acceptance, item by item.*
- *The accessibility audit has run once, covering the four dimensions above.*
- *No device-pass item remains in `TODO.md`.*

## Milestone 5 - A production that could take them

**The three roles have run in production since 2026-08-23.** This milestone is the
[Stack and hosting](15-stack-and-hosting.md) design made real, plus the release-readiness items
[Build phases](16-build-phases.md) lists beyond Phase 4 - and its exit criteria follow this
repo's own rule that a guarantee is proved, not read. Deploying satisfied several of them outright
and moved none of the rest, which is what the criteria were shaped to distinguish.

The work: the three roles deployed with managed Postgres, Redis and object storage; secrets held
outside the repo; backups confirmed by **restoring one**, because a backup nobody has restored is
a hope; monitoring wired so a parked outbox event - the one durable evidence an effect never
ran - and a 5xx each reach a human; the mail domain finished (the move off the borrowed domain
landed on 2026-08-23; what is left is rotating the older Resend key and tightening DMARC past
`p=none` - the
[sending-domain checklist](../templates/sending-domain-checklist.md) exists for this); over-the-air
updates so a fix does not need a store release; TestFlight through the paid developer program so
the roster installs without a cable; and the legal texts real, including the obligation
[ADR-0005](../decisions/0005-no-end-to-end-encryption.md) recorded - without E2E, the Privacy
Policy must state that message content is readable by the service.

*Done when:*

- *The full stack serves the app from production infrastructure, and the founder's phone runs
  against it through a normal day with no laptop involved.* **Half met 2026-08-23.** The stack
  serves, and the phone signed up, chatted, uploaded a photo and took a push against it with no
  laptop involved. A normal *day* has not happened, and that is the half this criterion is about.
- *A database restore from a real backup has been performed once.* **Open.** No backup has ever
  been restored.
- *A deliberately parked outbox event and a deliberately raised 5xx each reached a human through
  the monitoring path - forced, not assumed.* **Open.** Neither has been forced, and Sentry has
  received no production error of any kind. Milestone 3 above has the shape of what is wired.
- *A stranger can install through TestFlight and sign up unassisted.* **Open.** A production EAS
  build is being started; nothing is submitted and nobody has installed anything. External
  TestFlight also needs Apple's Beta App Review, which is a queue rather than a step.
- *Mail arrives from the product's own domain, the old key is dead, and DMARC verifies.* **One of
  three met 2026-08-23.** Mail arrives from `noreply@clubchatapp.com`, which is also what verified
  the Resend domain. The old Full-access key is not dead, and `_dmarc` publishes `p=none`, which is
  the [sending-domain checklist](../templates/sending-domain-checklist.md)'s starting point rather
  than its end.
- *The Privacy Policy and Terms are reviewed, state the ADR-0005 obligation, and are reachable
  from where sign-up says they are.* **Open.** The legal texts are not written.
- *Media is served in `cdn` mode from the Worker, `/__parity` answers the same `parity` on both
  sides, and a signed URL has been watched surviving an hour boundary.* **All three met
  2026-08-23**: `cdn` mode serves, both sides answer `D6NXENh3`, and signed URLs minted before the
  17:00Z alignment point were watched still answering in full after it, which is the part that
  fifty minutes of working could never have proved. Only `parity` is comparable: `version` and
  `previousParity` differ by design on the two sides. [Deployment](21-deployment.md) step 6 carries
  what was fetched and when.
- *`cf-cache-status` has been read off a real signed URL*, settling the open half of roadmap debt 7
  rather than leaving it as an inference. **Met 2026-08-23: the header is absent**, so nothing is
  held at the Cloudflare edge and N members opening one photo is N reads of R2. That confirms
  [ADR-0044](../decisions/0044-the-cdn-is-a-worker-that-validates-before-it-reads.md) rather than
  contradicting it; [Deployment](21-deployment.md) carries the measurement and what is left to
  decide from it.
- *The R2 key is rotated, the Cloudflare API token is revoked, the older Full-access Resend key is
  deleted, and the local secrets file is gone.* **Deferred by the founder on 2026-08-23, deliberately
  and with a fourth credential added**: the Sentry organization auth token went through a transcript
  too. None of the four is hygiene. Each was disclosed the moment it was pasted and stays disclosed
  until it is replaced, and the R2 credential is read AND write where the Worker only reads.
  [Deployment](21-deployment.md)'s obligation 1 is the standing record.

### Standing, 2026-08-23

Work is on branch `deploy`. **The first deployment in the project's history ran on 2026-08-23**:
three Fly apps in `iad`, one machine each, from one image built once and deployed to all three by
digest, with the Neon migration run by the api's `release_command` before any machine took traffic.
[Deployment](21-deployment.md) owns the procedure and which of its steps have been performed; this
table owns where the milestone stands.

| Piece | Standing |
|---|---|
| Deployable artifacts | **Done, and now the thing that is running.** `Dockerfile`, `.dockerignore`, `fly/{api,gateway,worker}.toml`. One image serves all three apps in production, built once and stamped `SENTRY_RELEASE=73a9ee3d6c7eb204dd0f550f0477f674ddffb67a`, which is what the api's `/__parity` answers as `version`. Image built for `linux/amd64` and all three roles booted; `sharp` proved to load libvips and encode inside the container, which matters because it is imported at module top and a wrong binary is a boot crash rather than a first-upload one. The guest is now pinned on all three: `api.toml` and `gateway.toml` carried no `[[vm]]` block until 2026-08-23, so the two roles serving every request were the two taking Fly's 256 MB default while the worker was explicit. The api holds a top-level `import sharp` and decodes uploads of up to 25 MB in memory, so 256 MB there is an OOM kill - which presents as a machine restart rather than as an error, and would read as instability long before it read as a memory ceiling |
| Health checks | **Done.** `/health` (liveness, cannot fail) and `/ready` (readiness, reaches Postgres) on both ingress roles, built failing-test-first. Fly gates traffic and deploy success on `/ready`. Grading is asymmetric per [Failure modes](11-failure-modes.md): Postgres down is a 503, Redis down stays 200 and is reported |
| Deployable shape | **Decided, and built that way on 2026-08-23.** Three Fly apps from one image, one machine each because the cutover passed `--ha=false`, [ADR-0043](../decisions/0043-the-three-roles-deploy-as-three-fly-apps.md) |
| Accounts | **Done.** Cloudflare (domain on Cloudflare DNS and the zone now `active`, R2 with both buckets and a scoped Account token, Workers on the paid plan), Fly (`clubchat` org, three apps created, Upstash Redis provisioned), Neon (Launch, `us-east-1`, Postgres 17, always-on), Sentry (`clubchat-ef`, `clubchat-server`) |
| Resend, and the mail domain | **Verified 2026-08-23, by a mail rather than by a badge.** The password-reset mail arrived from `noreply@clubchatapp.com`, and Resend will not send from an unverified domain, so the arrival is the verification. Two earlier readings of this row are worth keeping visible: it once said "verified" from the DNS being right, and then "NOT verified" from the badge still saying `Pending`, and neither was evidence in either direction. **The domain move is not finished**: `_dmarc` is at `p=none` and the older Full-access key is still alive |
| The CDN Worker | **Deployed 2026-08-23 on `cdn.clubchatapp.com`**, as a Workers Custom Domain declared in `wrangler.jsonc` as a `routes` entry with `custom_domain: true`, bundle 6.89 KiB. It serves real bytes off both buckets with the right content types and refuses correctly in both directions, including the routing case proved with **valid** signatures: an unknown first path segment answers 404 without touching R2 rather than falling back to the private bucket. Before that: **built and adversarially tested.** `packages/cdn-worker`, the fourth workspace, exercised in real `workerd` against an emulated R2. It did not work first time: 27 of 101 tests failed on the first execution, from Range and partial-content defects that typecheck and a bundle could not see. A red-team pass then failed to get bytes out of either bucket in 400 hostile requests, and found one real routing defect (now fixed) plus a `workers.dev` hostname left open by default (now closed). [ADR-0044](../decisions/0044-the-cdn-is-a-worker-that-validates-before-it-reads.md) |
| Media mode | **Done 2026-08-23, and it went in that order.** The three Fly apps went out on `presign`, the Worker was proved on the real hostname while nothing depended on it, then `MEDIA_URL_MODE` flipped to `cdn` on the api and it was redeployed on the same image digest, so the flip changed one environment value and nothing else. `fly/api.toml` carries `cdn`. Photos render on a physical iPhone through the Worker. Both production states were green independently, which was the whole argument for the extra deploy |
| Config completeness | **Done, three times, and it was not.** `BETTER_AUTH_URL`, `S3_ENDPOINT`, `S3_BUCKET_PUBLIC` and `S3_BUCKET_PRIVATE` are required by the flat schema and were absent from all three tomls, so the first deploy would have failed at boot - silently on the worker, which has no health gate. Found by feeding each `[env]` block through the real `loadConfig` rather than by reading it. The same shape again on 2026-08-23: all three set `SENTRY_ENVIRONMENT` and none set `SENTRY_DSN`, and `monitoring.ts` reports nothing anywhere without the DSN - so the files read as though Sentry was wired while every 5xx, parked outbox event and failed drain tick would have reached a log inside a Fly machine and reached nobody. It is now in all three `[env]` blocks, which is where a write-only ingest address belongs under [Deployment](21-deployment.md) rule 10. And a third shape on the same day, underneath both: an optional value supplied as an empty string arrived as `''` rather than `undefined`, so every `??` fallback in the codebase was dead and `/__parity` answered `version: ""`. Three separate producers feed it, so it is normalised once in `config.ts` |
| Secrets on the platform | **Done 2026-08-23, `PLATFORM_MODERATORS` included.** Set with `fly secrets import --stage` on all three apps, and checked by digest rather than by having typed them carefully: `BETTER_AUTH_SECRET` matches across all three, and `MEDIA_SIGNING_SECRET` deliberately does not. **`PLATFORM_MODERATORS` was the last of them, at 16:46Z and on the api alone**, once an account existed for it to match; the boot that followed reported it granted with nothing unmatched, so the direct-message report queue has a reader. Exactly **one**, the founder's own address, chosen for now rather than settled as a roster. [Deployment](21-deployment.md) step 4 carries the ordering and the log line that proves the address matched. The rest of this row is the reasoning that got it right and stays worth reading: `fly secrets import` and never `fly secrets set`, per [Deployment](21-deployment.md) rule 10. Six on **each of the three apps**, because every role parses the whole flat schema and refuses to boot on a value it never reads: `DATABASE_URL`, `REDIS_URL`, `BETTER_AUTH_SECRET`, `MEDIA_SIGNING_SECRET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`. Only the api's `MEDIA_SIGNING_SECRET` is the real one - the other two take throwaways that clear the schema's 16 character floor, so three different digests is correct rather than drift, and `fly/api.toml` says so at length. Then on the api alone: `RESEND_API_KEY` and `MAIL_FROM`, which the schema marks optional and `assertProductionMailer` makes required in practice; and **`PLATFORM_MODERATORS`, which nothing fails without and which this row omitted until 2026-08-23.** It is a comma-separated list of **email addresses**, not account ids, and `reconcilePlatformModerators` matches them against `users.email` when the api boots and at no other time - so it may be set before the first deploy, but an address whose account does not exist yet is logged `unmatched`, grants nobody, and needs the api restarted once that account exists. Left unset, the api warns that nobody can read the direct-message report queue and boots normally: reports are filed and never seen, and that warning is the whole of the enforcement, which is why it was carried as a cutover step rather than as a note |
| The five paths proved by hand | **Done 2026-08-23.** Signup, chat, photo upload, push and password-reset mail, each reported individually. Push reached a real iOS device with the sender correctly excluded from the recipient list, and exactly one `push_deliveries` row was written because exactly one device is registered. The reset link resolved and completed, which it could only do because DNS moved ahead of this step; [Deployment](21-deployment.md) step 3 carries that ordering and why it is load-bearing |
| The outbox, in production | **Drained clean.** Everything processed, zero unprocessed and zero errors, across `message.created`, `media.uploaded`, `message.reacted`, `push.deferred`, `club.created`, `poll.created` and `message.pinned`. The worker logged `worker started, draining outbox and running the scheduler` exactly once, which is the only boot signal this role has |
| Backup restore, forced alert, symbolicated trace | **Not started, and no longer blocked.** The deploy was the dependency and it exists. No backup has been restored, no alert has been forced to reach a human, and Sentry has received no production error. Milestone 3 above separates the three things "symbolicated trace" was hiding |
| TestFlight, over-the-air updates, legal texts | **Not started.** A production EAS build is being started now; nothing is submitted and no stranger has installed anything, and external TestFlight additionally needs Apple's Beta App Review. `apps/mobile/app.json` declares no `updates` block and no `runtimeVersion`, so there is no EAS Update channel and a fix still needs a build. The legal texts are not written |
| Credential rotations | **Deferred by the founder on 2026-08-23**, deliberately and with a date, which is the only form this should ever take. Four credentials passed through a chat transcript and are disclosed until replaced: the R2 secret access key, the Cloudflare API token, the Sentry organization auth token, and the older Full-access Resend key. [Deployment](21-deployment.md)'s obligation 1 is the standing record and carries the two details that survive the deferral |

Two defects were found by connecting to real infrastructure rather than by reading code, and both
are fixed on the branch: Neon silently discards the pool's timeout ceilings when sent as individual
startup parameters, and the test that should have caught the related migration escape hatch could
never fail. See [Deployment](21-deployment.md) and `AGENTS.md` failure mode 37. **Nine more were
found on 2026-08-23 by auditing the configuration, the image and the mobile build against what the
code actually does**, four of which would have deployed green; `HISTORY.md` carries them.

## Milestone 6 - The first club

Onboard one real club, realistically one the founder can sit inside. Everything before this
milestone was about not being wrong; this one is about being useful, so its exit criteria are
observed facts about usage, not work items.

*Done when:*

- *The club's own officers created the club and its races, meetups and polls themselves, without
  the founder driving.*
- *Fourteen consecutive days in which members send messages daily, and at least one poll, one
  meetup and one join request complete their whole lifecycle inside the app.*
- *Zero lost, duplicated or misordered messages over the window - the Phase 0 exit drill's three
  conditions, now measured on strangers' phones instead of in the drill.*
- *Every push that should have arrived did, checked against the delivery ledger rather than
  against memory.*
- *Nothing found during the window lost member-visible work, and whatever was found is in
  `TODO.md` under the standing triage.*
- *At the end of the window, the club chooses to keep using it. That is the criterion underneath
  all the others.*

---

## What is deliberately not on this road

An App Store release. v1 parity beyond what `PRD/18` already requires. Recurrence, and everything
else in the deferred lists. When the pilot's lived usage argues for one of them, the argument
arrives with data - which is the position `PRD/17` has always wanted these calls made from, and
the reason the pilot comes first.
