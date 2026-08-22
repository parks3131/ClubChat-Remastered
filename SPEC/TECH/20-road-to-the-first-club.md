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

**Status, 2026-08-21: three of the four laptop-side criteria are met and the two Sentry-shaped
ones are blocked on milestone 5, which is a dependency this file did not notice when it ordered
the milestones.** [`TECH/18`](18-mission-backend-cleaning.md) section 7 records everything
measured.

| Criterion | Standing |
|---|---|
| The fixture, and guards on the batch routes and `/sync` | **Done.** 300 members, 20 polls with 3,600 votes, 50 photos, 5,070 messages |
| `pg_stat_statements` queryable | **Done.** Preloaded in development and in the test container |
| The load test at ten times peak, both hot spots | **Done.** Row lock 2.3x headroom and gapless under contention; access context 26x |
| Sentry tracing live, and an error arriving symbolicated | **Blocked on milestone 5** |

**Why the last row is blocked rather than outstanding.** Its obstacle is not configuration. There
is nowhere to send a trace or a symbolicated error FROM, because nothing has ever run outside a
development machine - which is milestone 5's opening sentence. Turning tracing on today produces a
laptop reporting on itself, which is the thing this milestone exists to stop counting as a
measurement. **The sequencing note above therefore has an exception: milestone 3 completes only
after milestone 5's deployment exists**, even though everything else in it is independent and is
now done. The work is one configuration change plus a source-map upload, and it belongs in the
same change that first deploys the three roles.

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

Nothing has ever run anywhere but development machines. This milestone is the
[Stack and hosting](15-stack-and-hosting.md) design made real, plus the release-readiness items
[Build phases](16-build-phases.md) lists beyond Phase 4 - and its exit criteria follow this
repo's own rule that a guarantee is proved, not read.

The work: the three roles deployed with managed Postgres, Redis and object storage; secrets held
outside the repo; backups confirmed by **restoring one**, because a backup nobody has restored is
a hope; monitoring wired so a parked outbox event - the one durable evidence an effect never
ran - and a 5xx each reach a human; the mail domain finished (rotate the Resend key, complete
DMARC, move off the borrowed domain - the
[sending-domain checklist](../templates/sending-domain-checklist.md) exists for this); over-the-air
updates so a fix does not need a store release; TestFlight through the paid developer program so
the roster installs without a cable; and the legal texts real, including the obligation
[ADR-0005](../decisions/0005-no-end-to-end-encryption.md) recorded - without E2E, the Privacy
Policy must state that message content is readable by the service.

*Done when:*

- *The full stack serves the app from production infrastructure, and the founder's phone runs
  against it through a normal day with no laptop involved.*
- *A database restore from a real backup has been performed once.*
- *A deliberately parked outbox event and a deliberately raised 5xx each reached a human through
  the monitoring path - forced, not assumed.*
- *A stranger can install through TestFlight and sign up unassisted.*
- *Mail arrives from the product's own domain, the old key is dead, and DMARC verifies.*
- *The Privacy Policy and Terms are reviewed, state the ADR-0005 obligation, and are reachable
  from where sign-up says they are.*

### Standing, 2026-08-21

Work is on branch `deploy`. **Nothing is deployed yet**, so every exit criterion above is still
open. What has changed is that the two things blocking any deploy at all no longer are.

| Piece | Standing |
|---|---|
| Deployable artifacts | **Done.** `Dockerfile`, `.dockerignore`, `fly/{api,gateway,worker}.toml`. Image built for `linux/amd64` and all three roles booted; `sharp` proved to load libvips and encode inside the container, which matters because it is imported at module top and a wrong binary is a boot crash rather than a first-upload one |
| Health checks | **Done.** `/health` (liveness, cannot fail) and `/ready` (readiness, reaches Postgres) on both ingress roles, built failing-test-first. Fly gates traffic and deploy success on `/ready`. Grading is asymmetric per [Failure modes](11-failure-modes.md): Postgres down is a 503, Redis down stays 200 and is reported |
| Deployable shape | **Decided.** Three Fly apps from one image, [ADR-0043](../decisions/0043-the-three-roles-deploy-as-three-fly-apps.md) |
| Accounts | **Done.** Cloudflare (domain on Cloudflare DNS and the zone now `active`, R2 with both buckets and a scoped Account token, Workers on the paid plan), Fly (`clubchat` org, three apps created, Upstash Redis provisioned), Neon (Launch, `us-east-1`, Postgres 17, always-on), Sentry (`clubchat-ef`, `clubchat-server`) |
| Resend | **DNS done, domain NOT verified.** All four records resolve and there is exactly one `v=spf1` on the apex, but Resend's own status is still `Pending`. It refuses to send from an unverified domain, so **password-reset mail cannot be proved until that badge flips**. An earlier version of this row said "verified", which was the DNS being right being read as the provider being ready |
| The CDN Worker | **Built and adversarially tested, never run against Cloudflare.** `packages/cdn-worker`, the fourth workspace, exercised in real `workerd` against an emulated R2. It did not work first time: 27 of 101 tests failed on the first execution, from Range and partial-content defects that typecheck and a bundle could not see. A red-team pass then failed to get bytes out of either bucket in 400 hostile requests, and found one real routing defect (now fixed) plus a `workers.dev` hostname left open by default (now closed). [ADR-0044](../decisions/0044-the-cdn-is-a-worker-that-validates-before-it-reads.md) |
| Media mode | **Decided: ship `cdn`, deploy `presign` first.** The three Fly apps go out on `presign`, the Worker is proved against the real hostname while nothing depends on it, then `MEDIA_URL_MODE` flips. Two independently green production states, and a one-token rollback to one that has been watched working |
| Config completeness | **Done, and it was not.** `BETTER_AUTH_URL`, `S3_ENDPOINT`, `S3_BUCKET_PUBLIC` and `S3_BUCKET_PRIVATE` are required by the flat schema and were absent from all three tomls, so the first deploy would have failed at boot - silently on the worker, which has no health gate. Found by feeding each `[env]` block through the real `loadConfig` rather than by reading it |
| Secrets on the platform | **Not yet.** Collected but not yet set with `fly secrets set`. Six per app: `DATABASE_URL`, `REDIS_URL`, `BETTER_AUTH_SECRET`, `MEDIA_SIGNING_SECRET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, plus `RESEND_API_KEY` and `MAIL_FROM` on the api, which the schema marks optional and `assertProductionMailer` makes required in practice |
| The five paths proved by hand | **Not started.** Requires the deploy |
| Backup restore, forced alert, symbolicated trace | **Not started.** All require the deploy |
| TestFlight, legal texts, mail domain move | **Not started** |

Two defects were found by connecting to real infrastructure rather than by reading code, and both
are fixed on the branch: Neon silently discards the pool's timeout ceilings when sent as individual
startup parameters, and the test that should have caught the related migration escape hatch could
never fail. See [Deployment](21-deployment.md) and `AGENTS.md` failure mode 37.

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
