# History

How we got here, bug by bug. The specs stay summary-level because they load into context every
session; the long narrative lives here (`AGENTS.md` section 2.4.2).

Newest first.

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
