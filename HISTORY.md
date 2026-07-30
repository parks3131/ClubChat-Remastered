# History

How we got here, bug by bug. The specs stay summary-level because they load into context every
session; the long narrative lives here (`AGENTS.md` section 2.4.2).

Newest first.

---

## 2026-07-29 - Phase 2 (part 2): the command handlers

Races, polls, meetings, calendar, routines and news now have working commands on top of the
schema and authorization that part 1 delivered. 383 tests green, 46 constraint assertions, all
three server processes boot with the scheduler running alongside the drain.

### What the tests pin that the matrix cannot

The permission matrix covers authorization as pure functions. These needed a real database:

**The Incharge asymmetry**, which is the subtlest rule in the phase. If a group's Incharge
leaves, the Incharge is cleared and every club admin is notified that the group needs a new
one - while the rest of the group is untouched and the group is not dissolved. **A plain member
leaving their car is a non-event and notifies nobody.** Mutation-tested in both directions:
making every departure notify fails exactly the silence test, and making none notify fails
exactly the alert test. One test each, no collateral, so the asymmetry is pinned rather than
half-pinned.

**Vote moving.** On a single-choice poll, tapping a different option moves the vote rather than
adding a second - verified as one vote total on the new option, not two. On a multi-select poll
the same gesture adds. The database guarantees the moving part via the composite-FK trick from
part 1, so the handler deletes explicitly rather than relying on an upsert that would race.

**Closed at read time.** A poll created already past its deadline reads as closed and refuses a
vote, with nobody having closed it. And the scheduled job **does not close polls** - there is a
test asserting a poll with a live deadline is still open after a tick, because a job that
flipped a boolean would become a second source of truth for something a comparison answers.

**The closing-soon reminder includes the creator.** That is the single exception to "creation
notifications exclude the actor", and `resolveAudience` knows it from the notification type
rather than from a flag passed at the call site, so the exception lives in one place. Fires once
per poll ever - the second tick sends nothing.

**Private polls leak counts but not identity.** A non-creator sees the count, sees their own
vote, and gets `null` for voters - which is deliberately distinguishable from an empty list.

**The routine silence.** Seven workouts authored in one sitting produce zero notifications and
zero chat cards. The mechanism is the absence of an outbox write, not a flag.

**The completed cascade.** Leaving a club now removes race roster rows and car assignments for
**all** races in it, not just upcoming ones, and clears any Incharge the departing member held.
Part 1 left that as a marked comment; it is now four statements in the same transaction.

### A judgement call worth recording

When someone leaves the whole club while holding an Incharge, the Incharge is cleared but **no
"group needs a new Incharge" notification fires**. Leaving a club is a bigger event than
vacating a car seat, and firing one notification per affected group on top of "X left the club"
would bury the thing admins actually need to see. The groups show as having no Incharge, which
the car-groups screen states plainly. Noted here because it is a deliberate difference from the
single-group departure path, not an inconsistency.

### Bugs found while building

1. **`listPolls` passed `clubId: ''` to the access predicate**, so club-scoped polls would
   never have listed - the club branch checks membership against that id. Caught by reading the
   call rather than by a test, which would not have existed yet. Also restructured: the
   predicate is now checked once before the query rather than per row, since access to a poll
   depends only on its scope and every poll in one scope is visible to the same people.

2. **Six test failures that were fixture leaks, not product bugs.** Adding a club member
   legitimately notifies them, and adding a race member legitimately notifies them - and the
   fixtures drained those effects without clearing them, so every test inherited extra rows and
   the "notifies nobody" assertions looked broken. Fixed with one `settleFixture` helper rather
   than by loosening the assertions, because an unfiltered "no notifications at all" check is
   the stronger form: a filtered query cannot catch a notification sent to the wrong person.

### Still open

Routes for the Phase 2 commands are not wired into the API yet - the handlers and their tests
exist, and exposing them is mechanical. The Expo client has no screens for any of this. Card
removal on delete (`event.deleted`, `poll.deleted`, `meeting.deleted`) logs rather than removing
the chat card, which needs the `linked_*_id` columns on messages that the data model specifies
and Phase 0 did not create.

---

## 2026-07-29 - Phase 2 (part 1): the domain schema and the permission-matrix gate

**The Phase 2 gate is met.** `TECH/16` gates this phase on the permission-matrix suite
covering every cell of the three matrices in `PRD/02`, and it now does: 340 tests total, 148
of them in the matrix file alone, with both directions asserted in every cell.

Note the spec says "three matrices" while `PRD/02` has four table sections - Club and Club
content are one matrix split across two tables. Coverage is Club (14 rows, from Phase 0),
Club content (7), Race (14 rows across 5 actor columns), and Eboard (10 rows across 4). A
completeness guard asserts the total cell count so the suite cannot quietly shrink when
someone deletes a row or an actor column.

### Two invariants moved from handler code into the database

Both use the same trick, and the migration checklist already lists it as the house pattern
for this shape: denormalise the parent's discriminator onto the child, then add a **composite
foreign key** back to the parent so the copy cannot drift.

- **A person is in at most one car group per race** (domain invariant 5). Needs `race_id` on
  `car_group_members`, which a generated column cannot supply - Postgres generated columns may
  only reference columns in their own row, and `race_id` lives on `car_groups`. So the value
  is stored and the composite FK to `car_groups (id, race_id)` proves it consistent. Without
  the FK the unique index would be guarding a lie: a handler could write a mismatched
  `race_id` and slip a second group past it. Proved by attempting exactly that.
- **Single-choice polls move a vote rather than adding one.** `allow_multiple` is
  denormalised onto each vote with a composite FK to `polls (id, allow_multiple)`, making the
  partial unique index meaningful. A vote cannot lie about its poll's setting to escape the
  index - also proved by attempting it.

46 constraint assertions now, up from 32.

### A bug in the migration itself

The first generated migration failed to apply: `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN
KEY` ran before the `CREATE UNIQUE INDEX` it referenced, because drizzle-kit emits every
foreign key before every index. The fix was a real UNIQUE **constraint** rather than a unique
index - a table constraint is emitted inline with `CREATE TABLE`, so it exists by the time the
FK is added. Caught by applying the migration rather than by reading it.

Also fixed: several invented UUID literals in the constraint proof contained `g`, `p` and `o`,
which are not hex digits. Postgres rejected them outright, which is the good version of that
mistake.

### The rule the matrix exists to protect

`isRaceMember` reads the roster set and nothing else. Mutating it to fall back on
`isClubAdmin` - the exact v1 substitution that was wrong in five separate places -
fails 7 cells, including the property test asserting that every access-gated race capability
is denied to a manager off the roster while the same manager on the roster is allowed, and the
test stating how Eboard deliberately differs from Race. That asymmetry is the whole design:
for a race, authority and access are separate; for the Eboard they are the same thing.

The converse is tested too, because it is the trap on the other side: a naive "require a
roster row for everything" would cost a manager the management they legitimately hold.

### Scope, honestly

Delivered: the full Phase 2 schema (races with Meet Information, roster, join requests,
personal pins, car groups, meetings, polls with options and votes, calendar events, routine
workouts, news posts and reactions), `raceRoster` populated in the access context so every
race predicate is live, the race/poll/meeting/content predicates, and the gate.

**Not yet delivered: the command handlers and routes for those features.** The schema and the
authorization exist; creating a race, managing car groups, voting in a poll, scheduling a
meeting, and posting news are the next step. The scheduled closing-soon job also waits on the
poll commands, and the membership cascade's race-roster branch is still the marked comment
Phase 1 left.

---

## 2026-07-29 - Phase 1 completion: membership commands and revocation

Closes the gap left open earlier in the phase. 192 tests green, 32 constraint assertions.

**What was added.** Join by policy (open admits instantly, request files a pending row),
invite-link redemption, approve/deny, add directly, promote/demote, transfer ownership,
leave, remove, delete club, and the join-policy flip. Each posts its system message and
notifies the people affected. `club_join_requests` turned out to be documented in `TECH/09`
but never actually created in Phase 0 - confirmed against the live database rather than
assumed - so it arrived with this work.

**The revocation obligation is now met, and verified over a real gateway.** ADR-0007's cost
is that a subscription is authorized once at subscribe time and never rechecked per message,
so a removed member's socket keeps receiving until they reconnect. The hook existed as a
stub since Phase 0 but nothing called it, and it could not be called: the worker is a
different process from the gateways. It now crosses that boundary over a Redis control topic
that every gateway subscribes to for its whole life - a gateway that only listened while
holding a relevant socket would let a removed member keep reading.

The live test is worth describing, because disabling revocation produced a result that
explains the whole design. With it off, the removed member's socket **received the next
message** while the REST path correctly returned 404. Every request-scoped check was still
right; only the socket leaked. That is exactly the silent failure ADR-0007 warns about, and
it is invisible to anything except watching the socket.

**Ordering rules, mutation-tested rather than trusted.** Inverting the transfer to promote
before demote fails on `club_memberships_one_owner` - the database refuses, which is the
entire argument for enforcing that invariant as a constraint rather than in a handler. Also
verified: an ownership transfer posts ONE system message rather than two (mechanically two
role changes, socially one event, which is why transfer emits its own event type); switching
`request` to `open` auto-approves everyone pending rather than stranding them with no
approval step left in the product; and two admins racing on Approve produce exactly one
membership, with exactly one of them believing they decided it.

**Still deferred to Phase 2, and stated rather than implied.** The cascade currently reaches
Eboard membership and resolves outstanding requests; race rosters and car-group assignments
are two more statements in the same transaction once those tables exist. The remaining
notification types are in the same position - each is one call into machinery that now
exists.

---

## 2026-07-29 - Phase 1: effects, notifications and push

**The gate passes.** An announcement in club chat reaches a backgrounded phone as a push that
deep-links to the right message, asserted through a `RecordingPushSender` that captures the
payload and its target - the only way to check the deep link carries the correct `seq` rather
than merely opening the conversation.

164 tests green across four packages. 28 constraint assertions, all proved by attempting the
violation in SQL.

### Decisions taken

**ADR-0013: notifications store `(type, params)` and render at read time.** `TECH/09` and
`PRD/01` both specified a stored English `body` and a stored `target` route string, inherited
from v1. Two recorded defects trace to that shape: pitfall 8 (a stored route left approvals
permanently unresolved for eight migrations) and debt 11 (a stored body is unlocalizable, and
retrofitting means rewriting every historical row - with an explicit instruction to design it in
now). Dropping both columns closes both, and Phase 1 was the last moment it was cheap. The
rejected alternative worth naming is storing params *and* a rendered body: two representations
of one string, which drift the moment a renderer changes, and which answer "which is
authoritative?" with "whichever the reader used".

Params are a jsonb column, so the contract has no database-level shape. Each type declares a Zod
schema, validated at write time, which is the compensating control for having dropped the
rendered column: a malformed param fails the write rather than surfacing as broken text in
somebody's inbox months later.

**A `push_deliveries` ledger, outliving the outbox.** `TECH/06` says to dedupe on
`(outbox_event_id, device_id)` without saying where that record lives. It needs its own table,
and it must survive the nightly outbox prune - otherwise pruning makes an already-sent push
re-sendable. The asymmetry is the reason: a duplicated database row can be cleaned up, a
duplicated push has already buzzed a phone.

### Bugs hit, with root causes

1. **`bigserial` where a reference belonged.** `notifications.outbox_event_id` and the ledger's
   were declared `bigserial`, which attaches a sequence default - so an insert that forgot to
   supply the id would silently receive a sequence number and defeat the very idempotency index
   it sits in. Caught by reading the generated SQL before applying it. Corrected to `bigint` by
   regenerating, which was legitimate because the migration had not yet been applied; had it
   been, this would have needed a corrective migration instead.

2. **`db.execute` does not apply Drizzle's column type coercion.** A typed `select()` returns a
   `Date` for a timestamptz; raw `execute()` returns the driver's **string**. The hand-written
   row type said `Date`, TypeScript agreed, and the failure surfaced as
   `row.created_at.toISOString is not a function` at the call site rather than at the lie.
   Probed the actual runtime type rather than patching defensively, then made the types say
   `string`. Grepped for the same mistake elsewhere: contained to the one file. Recorded as
   `AGENTS.md` 5.3 entry 7.

3. **Test isolation, not a product bug.** Four gate tests failed with 27 rows where 1 was
   expected, because they share one container and several assertions query `notifications`
   unfiltered. The unfiltered form is the stronger assertion - a filtered query cannot catch a
   notification sent to the *wrong* person - so the fix was to truncate between tests rather
   than to weaken them.

### Verification worth noting

Three behaviours were mutation-tested, on the standing principle that a check which cannot fail
is worse than no check:

- **Cursor suppression** (ADR-0008). Disabling it - reverting to the liveness-based design that
  ADR rejects - fails exactly the three suppression tests and nothing else.
- **The pending-request clearing exception.** Replacing the filter with the naive "opening the
  inbox marks everything read" - one line of SQL that passes any badge-only test - fails exactly
  the exception-1 test. This is the rule the founder lost real join requests to.
- **The notification renderer.** Exhaustive over the type union and swept by iterating
  `notificationTypes` rather than a hand-written list, with a guard asserting the fixture map
  covers every type. A hand-written list is precisely what would omit the next type someone adds.

Worth recording that **exception 2 survives the mutation**, and that is not a gap. Chat-unread
rows are *derived* from `last_seq - last_read_seq` rather than stored, so there is nothing for
`markInboxRead` to clear even if it tried. That exception is enforced by the data model rather
than by a filter, which is the stronger of the two.

### Scope, honestly

Delivered: the notification catalogue as typed contracts, the audience function (with the
admin-tier and race-roster invariants enforced by construction), announcements and pinning with
the column-level authority split, mentions, the push pipeline with cursor suppression and the
8-second deferral, the device registry, the inbox with its merged feed and badge, and both
clearing exceptions.

**Not delivered: the membership commands.** Join by policy, approve/deny, add, remove,
promote/demote, transfer ownership, leave and delete-club are the triggers most of the remaining
catalogue hangs off, along with the cascades and the force-unsubscribe that ADR-0007 obliges.
The machinery they need now exists; they are the next task rather than a redesign.

**A spec ordering inconsistency was found and recorded rather than silently worked around.**
`TECH/16` listed "the scheduled job" in Phase 1, but that job is poll closing-soon and polls
arrive in Phase 2, so it had nothing to select. Most of the 18 notification types are in the
same position - a race-created notification needs races. Phase 1 therefore delivers the
mechanism plus the events Phase 0's surface can actually raise. `TECH/16` now says so.

---

## 2026-07-29 - Phase 0: skeleton and the vertical slice

Built the monorepo, the channel log, the policy module, the API, the gateway, the worker, the
Expo client, and the Phase 0 exit drill. The phase is complete and verified end to end.

**What exists.** `packages/shared` (wire contract and domain vocabulary, imported by both
sides so neither can drift), `packages/client-core` (local store, send outbox, sync engine),
`packages/server` (three entrypoints in one codebase: api, gateway, worker), `apps/mobile`.
Postgres 17 and Redis 8 in Docker for development. All tests green; every package typechecks
clean under strict TypeScript 6.

**The exit drill passes.** Gateway killed mid-send with both clients forced to reconnect:
41 server messages (40 acked sends plus the `club.created` system message), both clients hold
all 41, zero holes on the server or on either client, 12 syncs run. The drill drives the real
`@clubchat/client-core` rather than a stand-in, so what it proves is what ships.

### Decisions taken

**TypeScript pinned to 6.0.3, not 7.** TS 7 is npm `latest` and is the native Go compiler, and
the TS team recommends it for new projects. Rejected anyway: Expo 57's own TypeScript template
pins `~6.0.3`, and running two TS majors across one workspace to save nothing was not worth it.
TS 6 is also explicitly the release designed to prepare a codebase for 7, so the eventual move
is a version bump rather than a migration. Recorded in `AGENTS.md` 5.1 rather than as an ADR:
it is a tooling pin, not an architectural decision.

**The outbox column is `processed_at` in Phase 0, not `published_at`.** ADR-0006 defines
`published_at` as meaning "handed to Kafka, NOT effect performed". Phase 0 has no Kafka - the
worker drains the outbox directly with `FOR UPDATE SKIP LOCKED` - so there the column genuinely
does mean "effect performed", and using the Kafka-era name for a non-Kafka meaning is exactly
the drift that ADR warns about. Phase 1.5 renames it, which is one migration and is already
budgeted in the ADR's own exit ramp.

**Kafka deferred to Phase 1.5 as planned, not skipped.** The drain loop's shape is deliberately
the same one ADR-0006's exit ramp describes as the fallback if Kafka is ever dropped. That is
the property which keeps the decision cheap to reverse: the outbox already works without it.

### Bugs hit, with root causes

Seven, and the split matters: the first four were caught by tests, the last three only by
running the real thing.

1. **The idempotent-retry path never fired.** A concurrent double-send of the same
   `client_msg_id` surfaced as an unhandled unique-violation instead of returning the original
   `seq`. Root cause: Drizzle wraps driver errors, so the pg error code `23505` is on `.cause`
   and not on the thrown object; `error.code === '23505'` matched nothing, silently. Found by
   the concurrency test, not by reading the function - which is the whole point, because the
   check looked correct. Fixed by walking the cause chain. Recorded as `AGENTS.md` 5.3 entry 1.

2. **Sign-up died on `null value in column "id"`.** better-auth's Drizzle adapter emits
   `default` for `id` columns and relies on the database to produce one; its
   `advanced.database.generateId: 'uuid'` setting does not fill these in. Fixed with a new
   migration (`0002`, never an edit to the applied `0000`) giving all four better-auth-owned
   tables `DEFAULT gen_random_uuid()`, which works regardless of the library's id strategy.
   Recorded as `AGENTS.md` 5.3 entry 2.

3. **Client gap detection was racy.** Two in-order messages delivered in the same tick caused a
   spurious sync: `applyIncoming` reads the local max then writes it, and both frames read the
   pre-write value, so the second concluded a hole existed. Harmless in effect but corrosive in
   principle - a gap signal has to *mean* a gap. Fixed by serializing frame application per
   channel. Recorded as `AGENTS.md` 5.3 entry 3.

4. **`TS6059 not under rootDir`,** because TypeScript 6 stopped inferring `rootDir` from the
   source files and `drizzle.config.ts` sits at a package root. Also had to state `types`
   explicitly, since 6.0 stopped auto-discovering `@types`. Recorded as `AGENTS.md` 5.3 entry 4.

### The live smoke test, and what only it could find

The four bugs above were found by tests. The three below were found only by starting the real
processes and driving the real app in a real browser, and every one of them was invisible to
both typecheck and the full suite:

5. **All three server processes died at startup** with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`,
   on a **parameter property** (`constructor(readonly x: T)`). Vitest transforms with esbuild,
   which accepts the full TypeScript grammar; Node runs `.ts` by stripping types, which accepts
   strictly less. A green suite was therefore not evidence the server could boot. Fixed, and
   closed permanently with `npm run check:runtime`, which imports every module the way
   production does - verified to exit 1 with the bug present while the suite still passed 16/16,
   which is the whole argument for its existence.

6. **Sync silently failed on web** with "Failed to execute 'fetch' on 'Window': Illegal
   invocation". A getter returned the bare global `fetch`, so calling `this.fetch(...)` invoked
   it with `this` set to the ChatClient. Node's fetch does not check its receiver; a browser
   does. Doubly quiet because the caller logs and continues on the principle that realtime is
   an enhancement, so the app looked fine while its reconciliation path was dead.

7. **The web app hung forever on a spinner** after sign-up, because `expo-sqlite`'s web build
   imports a `.wasm` binary Metro does not resolve by default and the entire bundle failed. The
   in-memory fallback inside `openMessageStore` could never have helped: a static import fails
   before any of our code runs. Fixed with `metro.config.js`. Worth noting the symptom is
   exactly the one `SPEC/PRD/03` calls out - a hung check reads as an app that never loads.

Also fixed on sight, per the pixel-perfection standard: messages were top-anchored, leaving a
screen of empty space above the composer instead of sitting just above it.

**better-auth's CSRF check needed a real answer rather than a switch.** Sign-up from a native
client failed with `MISSING_OR_NULL_ORIGIN`, because a native client sends no `Origin` and
better-auth treats that as a CSRF risk. `advanced.disableCSRFCheck` would have silenced it by
removing the protection for every caller including browsers. Instead the app's own scheme is
listed in `trustedOrigins` and the client sends it explicitly. Verified both directions:
`Origin: clubchat://` returns 200, `Origin: http://evil.example` returns `INVALID_ORIGIN`.

### What was verified live, end to end

With Postgres, Redis, the API, the gateway, the worker and the Expo web client all running:

- Sign-up, then session persistence across a reload, with `/` routing an authenticated user
  into the app and an unauthenticated one to sign-in.
- Club creation producing, in one transaction: one club channel, one Eboard channel, one Eboard
  space, exactly one owner, and the owner inside the Eboard. Confirmed by querying Postgres.
- The worker's `club.created` effect posting "Riley Parks created Hillside Running Club" as
  seq 1, authored by the seeded system actor rather than `NULL`.
- A message sent from the UI committing at seq 2 and surviving a page refresh.
- **Realtime cross-user delivery:** a second club member sending over a separate socket, whose
  message appeared in the browser at seq 3 with no refresh.
- **Idempotency under live conditions:** 30 sends of one `client_msg_id` produced exactly one
  row. The rate limiter then fired at exactly burst 30, as configured.
- Direct URL entry into chat with no history, where the back control renders and works.
- An unauthorized channel returning 404 (nothing back, not even confirmation it exists), and an
  unauthenticated request returning 401.

### Verification worth noting

Three checks were themselves verified to be capable of failing, on the principle that a check
which cannot fail is worse than no check because it reports success:

- **`db:prove`** attempts to violate all 20 domain constraints in SQL and asserts each is
  rejected. Confirmed to exit 3 when handed an assertion that should not hold, and 0 otherwise.
- **The permission matrix** was mutation-tested by reintroducing the v1 "admin excludes owner"
  bug. 10 tests failed, including the property test asserting that anything an Admin may do the
  Owner may also do. Restored to green.
- **The `msg.ack` gap test** was mutation-tested by bypassing the gap check on the ack path,
  which is the exact defect `SPEC/TECH/08` warns about. Exactly that one test failed.

A weakness in the first draft of the exit drill was also found and fixed: an unconditional
`syncAll()` at the end would have backfilled any hole, turning the drill into a test of "sync
works" rather than of the state reconnect actually leaves behind.

### Spec repairs made in the same change

The 2026-07-28 split of `Old.md` and `ARCHITECTURE.md` into `SPEC/` left a systematic defect:
its cross-reference rewriter mapped section-number citations onto files by number, so roughly a
dozen links pointed at the wrong document. Nine resolved to `07-media-pipeline.md` for content
that lives in `14-engineering-pitfalls.md`. Every link *target* existed, which is why a plain
link checker passed them - they were silently wrong rather than broken. All corrected, along
with six dead intra-document anchors, `17-diagrams.md` still framing itself as an annex to the
deleted `ARCHITECTURE.md`, and a 30s-versus-60s contradiction about the poll closing-soon job
between `TECH/04` and `TECH/12` (settled at 30s, specified once).

`TECH/09-data-model.md` was updated to match what got built rather than what was planned: the
`users` table carries better-auth's required columns, `sessions` has better-auth's shape rather
than the drafted `(device_id, refresh_token_hash)`, and `accounts`/`verifications` exist. Per
the standing rule, the implementation is the fact and the spec was the bug.

`AGENTS.md` section 5 was entirely placeholder and is now filled in: real commands, the repo
map, the branch policy (recorded from observed practice - every commit in this repo is on
`main`), and the four failure modes above.
